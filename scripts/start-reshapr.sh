#!/usr/bin/env bash
# Starts reShapr locally and exposes the Microcks Georisques mock as an MCP endpoint.
#
#   scripts/start-reshapr.sh        (needs docker compose v2.24+, node, curl, jq; Microcks must run on 8080)
#
# What it does, idempotently:
#   1. installs the reShapr CLI in tools/reshapr (no global install) if missing;
#   2. downloads the release compose file into tools/reshapr, as `reshapr run --release <r>` would, and starts it
#      with tools/reshapr/docker-compose.demo.yml on top (MCP gateway published on RESHAPR_MCP_PORT, default 7778,
#      because 7777 is already used on this machine; backend timeout raised to 15 s);
#   3. logs the CLI in (admin/password, the release defaults);
#   4. imports contracts/georisques.openapi.yaml with --backendEndpoint pointing at the Microcks mock. reShapr
#      1.1.0 upserts the Service by name and version and reuses its `default` Plan and Exposition.
# Only the reshapr-* containers are touched. `reshapr run` itself is not used because it cannot remap ports.
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="${DEMO_DIR}/tools/reshapr"
RELEASE="${RESHAPR_RELEASE:-1.1.0}"
export RESHAPR_MCP_PORT="${RESHAPR_MCP_PORT:-7778}"
CTRL_URL="http://localhost:5555"
MCP_BASE="http://localhost:${RESHAPR_MCP_PORT}"
# Seen from the reShapr containers, Microcks on the host is host.docker.internal.
BACKEND="${RESHAPR_BACKEND:-http://host.docker.internal:8080/rest/Georisques/1.0.0}"
CONTRACT="${DEMO_DIR}/contracts/georisques.openapi.yaml"
BASE_COMPOSE="${TOOLS_DIR}/docker-compose-${RELEASE}.yml"
DEMO_COMPOSE="${TOOLS_DIR}/docker-compose.demo.yml"
RESHAPR="${TOOLS_DIR}/node_modules/.bin/reshapr"

wait_ready() { # label, url
  local i
  for i in $(seq 1 90); do
    if curl -sf "$2" >/dev/null 2>&1; then echo "ok      $1 ready"; return 0; fi
    sleep 2
  done
  echo "FAILED  $1 not ready after 180 s ($2)" >&2
  return 1
}

# 1. CLI
if [[ ! -x "$RESHAPR" ]]; then
  (cd "$TOOLS_DIR" && npm install --no-fund --no-audit "@reshapr/reshapr-cli@${RELEASE}")
fi

# 2. Platform
if [[ ! -f "$BASE_COMPOSE" ]]; then
  echo "...     downloading the reShapr ${RELEASE} compose file"
  curl -sSfL "https://raw.githubusercontent.com/reshaprio/reshapr/refs/tags/${RELEASE}/install/docker-compose-all-in-one.yml" \
    | sed -E "s#(registry\.reshapr\.io/reshapr/[^:]+):[A-Za-z0-9._-]+#\1:${RELEASE}#g" > "${BASE_COMPOSE}.tmp"
  mv "${BASE_COMPOSE}.tmp" "$BASE_COMPOSE"
fi
docker compose -p reshapr -f "$BASE_COMPOSE" -f "$DEMO_COMPOSE" up -d
wait_ready "control plane ${CTRL_URL}" "${CTRL_URL}/q/health/ready"
wait_ready "MCP gateway ${MCP_BASE}" "${MCP_BASE}/q/health/ready"

# 3. Login (writes ~/.reshapr/config, the only place the CLI keeps its context)
"$RESHAPR" login -s "$CTRL_URL" -u admin -p password >/dev/null
echo "ok      logged in to ${CTRL_URL} as admin"

# 4. Import (idempotent) and expose the Georisques mock
if ! curl -sf -o /dev/null "${BACKEND/host.docker.internal/localhost}/resultats_rapport_risque?code_insee=17300&latlon=-1.152,46.1591"; then
  echo "WARNING the Microcks Georisques mock does not answer on the host; import it with scripts/import-contracts.sh" >&2
fi
IMPORT_LOG="$(mktemp)"
"$RESHAPR" import -f "$CONTRACT" --backendEndpoint "$BACKEND" | tee "$IMPORT_LOG"
# The CLI prints "Endpoints : localhost:<port>/mcp/<expositionId>, localhost:<port>/mcp/reshapr/georisques-1-0-0-default".
ENDPOINT="$(grep -o 'localhost:[0-9]*/mcp/reshapr/[A-Za-z0-9._-]*' "$IMPORT_LOG" | head -1)"
rm -f "$IMPORT_LOG"
if [[ -z "$ENDPOINT" ]]; then
  echo "FAILED  the import did not report an MCP endpoint" >&2
  exit 1
fi

echo
echo "MCP endpoint (Mcp:Georisques:Endpoint of the orchestrator): http://${ENDPOINT}"
echo "  backend: ${BACKEND}"
