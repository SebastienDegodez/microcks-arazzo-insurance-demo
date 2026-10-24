#!/usr/bin/env bash
# Replays the recorded examples of the Commercial underwriting workflows against the Microcks mock of Underwriting
# cases (target mocks), with schema validation (validateSchema: true). Needs curl and jq.
#
#   scripts/run-arazzo.sh                 every workflow, in 4 waves
#   scripts/run-arazzo.sh <workflowId>... only these workflows, one after the other
#
# A case is case-<siren>: two runs on the same SIREN at the same time would share it. The waves run in parallel the
# workflows whose examples use different SIRENs. A case lasts about 2 to 3 minutes (latencies drawn as in Microcks).
set -uo pipefail

M="${MICROCKS_URL:-http://localhost:8080}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

doc_id() { curl -s "$M/api/arazzo/documents" | jq -r --arg t "$1" '.[] | select(.title==$t and .version=="1.0.0") | .id'; }
DOC_ID="$(doc_id "Commercial underwriting")"
GUARDS_ID="$(doc_id "Commercial underwriting guards")"
[[ -n "$DOC_ID" && -n "$GUARDS_ID" ]] || { echo "Commercial underwriting (and guards) 1.0.0 must be imported" >&2; exit 1; }
echo "Arazzo documents: $DOC_ID (Commercial underwriting), $GUARDS_ID (guards)"

wait_run() { # runId, label
  local run status verdict
  for _ in $(seq 1 240); do
    run="$(curl -s "$M/api/arazzo/runs/$1")"
    status="$(printf "%s" "$run" | jq -r '.status')"
    [[ "$status" != "IN_PROGRESS" && "$status" != "null" ]] && break
    sleep 2
  done
  verdict="$(printf "%s" "$run" | jq -r '.example.verdict // "MATCHES"')"
  if [[ "$status" == "SUCCESS" && "$verdict" == "MATCHES" ]]; then
    echo "ok    $2 -> SUCCESS, example $verdict, $(printf "%s" "$run" | jq -r '.elapsedTime / 1000 | floor') s $(printf "%s" "$run" | jq -c '.outputs // {}')"
  else
    echo "FAIL  $2 -> $status, example $verdict"
    printf "%s" "$run" | jq -c '{message, example: .example, failed: [.steps[]? | select(.status != "PASSED") | {stepId, statusCode, message}] | .[-3:]}'
  fi
}

examples() { # workflowId [documentId]
  local launches
  # 70 s per step: Company financials answers in 30 to 60 s (the orchestrator mock answers at once).
  launches="$(curl -s -X POST "$M/api/arazzo/documents/${2:-$DOC_ID}/workflows/$1/examples/runs" \
    -H 'Content-Type: application/json' -d '{"validateSchema":true,"timeout":70000}')"
  for row in $(printf '%s' "$launches" | jq -r '.[] | "\(.runId)|\(.example)"'); do
    wait_run "${row%%|*}" "$1 example ${row#*|} (run ${row%%|*})" &
  done
  wait
}

wave() { # workflowIds...
  for wf in "$@"; do
    if [[ "$wf" == collectiveProcedureStopsTheAnalyses ]]; then examples "$wf" "$GUARDS_ID"; else examples "$wf"; fi \
      > "$OUT/$wf.log" &
  done
  wait
  for wf in "$@"; do cat "$OUT/$wf.log"; done
}

if [[ $# -gt 0 ]]; then
  for wf in "$@"; do
    if [[ "$wf" == collectiveProcedureStopsTheAnalyses ]]; then examples "$wf" "$GUARDS_ID"; else examples "$wf"; fi
  done | tee "$OUT/all.log"
else
  {
    # SIRENs per wave: 1, 2, 999999999, 4, 3 | 1, 2 | 2, 1
    wave advisorValidatesThenDecides unknownCustomerNeedsNoAnalysis highRiskRequiresReinforcedDecision \
      collectiveProcedureSkipsAnalyses
    wave advisorOverridesSuggestion
    wave decisionWithoutCommentIsRefused noDecisionBeforeDataReview
    # The consumer view, played on the API mocks (no orchestrator case involved)
    wave orchestratorCollectsCompanyData customerUnknownStopsTheCase collectiveProcedureStopsTheAnalyses
  } | tee "$OUT/all.log"
fi
! grep -q '^FAIL' "$OUT/all.log"
