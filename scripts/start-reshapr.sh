#!/usr/bin/env bash
# Starts reShapr locally and exposes the Microcks Georisques and BODACC mocks as MCP endpoints (the tools of the
# climate agent).
#
#   scripts/start-reshapr.sh        (needs docker compose v2.24+, node, curl, jq; Microcks must run on 8080)
#
# What it does, idempotently:
#   1. installs the reShapr CLI in tools/reshapr (no global install) if missing;
#   2. downloads the release compose file into tools/reshapr, as `reshapr run --release <r>` would, and starts it
#      with tools/reshapr/docker-compose.demo.yml on top (MCP gateway published on RESHAPR_MCP_PORT, default 7778,
#      because 7777 is already used on this machine; backend timeout raised to 35 s);
#   3. logs the CLI in (admin/password, the release defaults);
#   4. imports contracts/georisques.openapi.yaml and contracts/bodacc.openapi.yaml with --backendEndpoint pointing
#      at the Microcks mocks. reShapr 1.1.0 upserts a Service by name and version and reuses its `default` Plan and
#      Exposition. reShapr forwards the incoming headers to the backend: x-microcks-delay and x-microcks-session
#      reach Microcks, so an Arazzo session sees the tool calls.
# Only the reshapr-* containers are touched. `reshapr run` itself is not used because it cannot remap ports.
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="${DEMO_DIR}/tools/reshapr"
RELEASE="${RESHAPR_RELEASE:-1.1.0}"
export RESHAPR_MCP_PORT="${RESHAPR_MCP_PORT:-7778}"
CTRL_URL="http://localhost:5555"
MCP_BASE="http://localhost:${RESHAPR_MCP_PORT}"
# Seen from the reShapr containers, Microcks on the host is host.docker.internal.
MICROCKS_BACKEND="${RESHAPR_MICROCKS_URL:-http://host.docker.internal:8080}"
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

# 4. Import (idempotent) and expose the Georisques and BODACC mocks
expose() { # contract file, Microcks API name (URL-encoded), probe path, orchestrator setting
  local backend="${MICROCKS_BACKEND}/rest/$2/1.0.0" log endpoint
  if ! curl -sf -o /dev/null -H 'x-microcks-delay: 0' "${backend/host.docker.internal/localhost}$3"; then
    echo "WARNING the Microcks $2 mock does not answer on the host; import it with scripts/import-contracts.sh" >&2
  fi
  log="$(mktemp)"
  "$RESHAPR" import -f "${DEMO_DIR}/contracts/$1" --backendEndpoint "$backend" | tee "$log"
  # The CLI prints "Endpoints : localhost:<port>/mcp/<expositionId>, localhost:<port>/mcp/reshapr/<name>-1-0-0-default".
  endpoint="$(grep -o 'localhost:[0-9]*/mcp/reshapr/[A-Za-z0-9._-]*' "$log" | head -1)"
  rm -f "$log"
  if [[ -z "$endpoint" ]]; then
    echo "FAILED  the import of $1 did not report an MCP endpoint" >&2
    exit 1
  fi
  SUMMARY+=$'\n'"  $4: http://${endpoint}   (backend ${backend})"
}
SUMMARY=""
expose georisques.openapi.yaml Georisques "/resultats_rapport_risque?code_insee=17300&latlon=-1.152,46.1591" Mcp:Georisques
expose bodacc.openapi.yaml BODACC "/annonces?siren=100000001" Mcp:Bodacc

echo
echo "MCP endpoints of the climate agent (settings of the orchestrator):${SUMMARY}"
