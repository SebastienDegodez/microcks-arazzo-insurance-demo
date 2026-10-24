#!/usr/bin/env bash
# Imports the demo contracts into Microcks (no authentication).
#
#   scripts/import-contracts.sh [only-file...]
#
# Idempotent: Microcks upserts a service by name and version, and an Arazzo document by title and version, so
# re-running the script replaces what it imported before and touches nothing else. The OpenAPI contracts and the
# Arazzo document are main artifacts; the ArazzoSources overlay is a secondary artifact, imported last.
set -euo pipefail

MICROCKS_URL="${MICROCKS_URL:-http://localhost:8080}"
CONTRACTS_DIR="$(cd "$(dirname "$0")/../contracts" && pwd)"

MAIN_ARTIFACTS=(
  customer-accounts.openapi.yaml
  sirene.openapi.yaml
  bodacc.openapi.yaml
  georisques.openapi.yaml
  company-financials.openapi.yaml
  claims-and-contracts.openapi.yaml
  llm-gateway.openapi.yaml
  underwriting-cases.openapi.yaml
  underwriting.arazzo.yaml
  underwriting-guards.arazzo.yaml
)
SECONDARY_ARTIFACTS=(
  underwriting.arazzo-sources.yaml
  underwriting-guards.arazzo-sources.yaml
)

upload() {
  local file="$1" main="$2" out code
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' -X POST \
    "${MICROCKS_URL}/api/artifact/upload?mainArtifact=${main}" \
    -F "file=@${CONTRACTS_DIR}/${file}")"
  if [[ "$code" != 2* ]]; then
    echo "FAILED  ${file} (HTTP ${code}): $(cat "$out")" >&2
    rm -f "$out"
    return 1
  fi
  echo "ok      ${file} -> $(cat "$out")"
  rm -f "$out"
}

selected() {
  [[ $# -eq 1 ]] && return 0
  local file="$1"; shift
  for wanted in "$@"; do [[ "$wanted" == "$file" ]] && return 0; done
  return 1
}

curl -sSf -o /dev/null "${MICROCKS_URL}/api/health" || { echo "Microcks is not reachable at ${MICROCKS_URL}" >&2; exit 1; }

for file in "${MAIN_ARTIFACTS[@]}"; do
  selected "$file" "$@" && upload "$file" true
done
for file in "${SECONDARY_ARTIFACTS[@]}"; do
  selected "$file" "$@" && upload "$file" false
done
