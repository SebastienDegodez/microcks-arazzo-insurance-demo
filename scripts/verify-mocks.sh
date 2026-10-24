#!/usr/bin/env bash
# Checks that every Microcks mock of the demo answers for every SIREN, MCP included, with the latency of its contract,
# then drives the mock of the orchestrator like an advisor for every SIREN.
#   scripts/verify-mocks.sh            (needs curl and jq; about 3 minutes, the checks run in parallel)
set -uo pipefail

M="${MICROCKS_URL:-http://localhost:8080}"
U="$M/rest/Underwriting+cases/1.0.0/underwriting-cases"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

# label, expected, actual, detail -> one line in its own file (the checks run in parallel)
check() {
  local f="$OUT/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"
  if [[ "$2" == "$3" ]]; then echo "ok    $1 -> $3 $4" > "$f"; else echo "FAIL  $1 -> $3 (expected $2) $4" > "$f"; fi
}

# label, expected status, jq filter, curl arguments...
call() {
  local label="$1" expected="$2" filter="$3" body meta
  shift 3
  body="$(mktemp)"
  meta="$(curl -s -o "$body" -w '%{http_code} %{time_total}' "$@")"
  check "$label" "$expected" "${meta%% *}" "in ${meta#* }s $(jq -c "$filter" "$body" 2>/dev/null)"
  rm -f "$body"
}

siren_checks() { # siren customerId insee latlon
  call "Customer accounts $1" 200 '{customerId,name}' "$M/rest/Customer+accounts/1.0.0/customers/by-siren/$1" &
  call "Sirene $1" 200 '{denomination,insee:.address.inseeCityCode}' "$M/rest/Sirene/1.0.0/siren/$1" &
  call "BODACC $1" 200 '{total,types:[.records[].type]}' "$M/rest/BODACC/1.0.0/annonces?siren=$1" &
  call "Company financials $1" 200 '{revenue,netIncome}' "$M/rest/Company+financials/1.0.0/companies/$1/financials" &
  call "Claims and contracts $1" 200 '{customerId,claims:(.openClaims|length)}' \
    "$M/rest/Claims+and+contracts/1.0.0/customers/$2/open-items" &
  call "Georisques REST $1" 200 '{commune}' "$M/rest/Georisques/1.0.0/resultats_rapport_risque?code_insee=$3&latlon=$4" &
  call "Georisques MCP tools/call $1" 200 '{isError:.result.isError,commune:(.result.content[0].text|fromjson|.commune)}' \
    -X POST "$M/mcp/Georisques/1.0.0" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"get_resultats_rapport_risque\",\"arguments\":{\"code_insee\":\"$3\",\"latlon\":\"$4\"}}}" &
  local tool='{"role":"tool","tool_call_id":"call_georisques","content":"{}"}'
  for agent in data-quality climate-risk financial-health open-items verdict; do
    [[ "$1" == 100000003 ]] && break
    call "LLM $agent-$1" 200 '.choices[0].message.content|fromjson|del(.rationale,.drivers,.issues)' \
      -X POST "$M/rest/LLM+gateway/1.0.0/v1/chat/completions" -H 'Content-Type: application/json' \
      -d "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"...\"}$([[ $agent == climate-risk ]] && echo ",$tool")],\"metadata\":{\"agent\":\"$agent\",\"siren\":\"$1\"}}" &
  done
  [[ "$1" != 100000003 ]] && call "LLM climate-risk-$1-tool-call" 200 \
    '.choices[0] | {finish_reason, tool: .message.tool_calls[0].function}' \
    -X POST "$M/rest/LLM+gateway/1.0.0/v1/chat/completions" -H 'Content-Type: application/json' \
    -d "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"...\"}],\"metadata\":{\"agent\":\"climate-risk\",\"siren\":\"$1\"}}" &
  wait
}

# Drives one case like the advisor: 409 before its time, data review, then the decision rules.
drive_case() { # siren
  local s="$1" c pa line t0 codes reco other
  local post=(-X POST -H 'Content-Type: application/json')
  t0=$(date +%s)
  call "Orchestrator POST case-$s" 202 '.' "${post[@]}" "$U" -d "{\"siren\":\"$s\",\"product\":\"MULTIRISQUE_PRO\"}"
  call "Orchestrator decision before its time case-$s" 409 '.code' "${post[@]}" "$U/case-$s/advisor-decision" \
    -d '{"finalDecision":"ACCEPT","comment":"trop tôt"}'
  for _ in $(seq 1 150); do
    c="$(curl -s "$U/case-$s")"
    pa="$(printf '%s' "$c" | jq -r '.pendingAction // ""')"
    if [[ "$pa" == DATA_REVIEW ]]; then
      line="$(printf '%s' "$c" | jq -c '{status, steps: (.stepOrder|length), financialHealth: .steps.financialHealth.status, dataQuality: .steps.dataQuality.status}')"
      check "Orchestrator DATA_REVIEW case-$s after $(( $(date +%s) - t0 )) s" PENDING \
        "$(printf '%s' "$c" | jq -r .steps.financialHealth.status)" "$line"
      call "Orchestrator data-review case-$s" 200 '{status, dataReview: .steps.dataReview.status}' "${post[@]}" \
        "$U/case-$s/data-review" -d '{"confirmed":true,"corrections":{},"comment":"Données vérifiées."}'
    elif [[ "$pa" == DECISION ]]; then
      reco="$(printf '%s' "$c" | jq -r .recommendation.decision)"
      codes="$(printf '%s' "$c" | jq -c '[.escalation.reasons[].code]')"
      check "Orchestrator DECISION case-$s after $(( $(date +%s) - t0 )) s" WAITING_ADVISOR \
        "$(printf '%s' "$c" | jq -r .status)" "$(printf '%s' "$c" | jq -c '{suggestion: .recommendation.decision, source: .recommendation.source, escalation: .escalation.level, reasons: [.escalation.reasons[].code], climateCalls: [.steps.climateRisk.calls[].via], naturalRisks: (.steps.climateRisk.result.naturalRisks.commune)}')"
      if [[ "$(printf '%s' "$c" | jq -r .escalation.level)" == REINFORCED ]]; then
        call "Orchestrator reinforced decision without acknowledging case-$s" 400 '.code' "${post[@]}" \
          "$U/case-$s/advisor-decision" -d "{\"finalDecision\":\"$reco\",\"comment\":\"vu\"}"
      fi
      other=REFUSE; [[ "$reco" == REFUSE ]] && other=REVIEW
      call "Orchestrator decision overriding without comment case-$s" 400 '.code' "${post[@]}" \
        "$U/case-$s/advisor-decision" -d "{\"finalDecision\":\"$other\",\"comment\":\"\",\"acknowledgedReasons\":$codes}"
      call "Orchestrator decision case-$s" 200 '{status, pendingAction, advisorDecision: (.advisorDecision|{finalDecision,followsRecommendation})}' \
        "${post[@]}" "$U/case-$s/advisor-decision" \
        -d "{\"finalDecision\":\"$reco\",\"comment\":\"Je suis la suggestion.\",\"acknowledgedReasons\":$codes}"
      return
    fi
    sleep 2
  done
  check "Orchestrator case-$s reaches DECISION" DECISION "$pa" "timeout"
}

siren_checks 100000001 C-1001 17300 -1.1520,46.1591 &
siren_checks 100000002 C-1002 63113 3.0870,45.7772 &
siren_checks 100000003 C-1003 59350 3.0573,50.6292 &
siren_checks 100000004 C-1004 84007 4.8055,43.9493 &
call "Customer accounts 999999999" 404 '.code' "$M/rest/Customer+accounts/1.0.0/customers/by-siren/999999999" &
call "LLM unsupported agent" 400 '.error.code' -X POST "$M/rest/LLM+gateway/1.0.0/v1/chat/completions" \
  -H 'Content-Type: application/json' -d '{"model":"gpt-4o-mini","messages":[],"metadata":{"agent":"x","siren":"1"}}' &
call "Orchestrator unknown case" 404 '.code' "$U/case-000000000" &
call "Orchestrator invalid SIREN" 400 '.code' -X POST "$U" -H 'Content-Type: application/json' -d '{"siren":"12"}' &
for s in 100000001 100000002 100000003 100000004 999999999; do drive_case "$s" & done
wait

cat "$OUT"/* | sort
! grep -q '^FAIL' "$OUT"/*
