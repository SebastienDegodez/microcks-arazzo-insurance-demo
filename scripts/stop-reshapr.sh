#!/usr/bin/env bash
# Stops the local reShapr started by scripts/start-reshapr.sh (only the reshapr-* containers and their network).
#
#   scripts/stop-reshapr.sh           keeps the reShapr database (volume reshapr-demo-pgdata): the next start
#                                     finds the Georisques Service and its Exposition again
#   scripts/stop-reshapr.sh --purge   also deletes that volume
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="${DEMO_DIR}/tools/reshapr"
RELEASE="${RESHAPR_RELEASE:-1.1.0}"
BASE_COMPOSE="${TOOLS_DIR}/docker-compose-${RELEASE}.yml"
DEMO_COMPOSE="${TOOLS_DIR}/docker-compose.demo.yml"

if [[ ! -f "$BASE_COMPOSE" ]]; then
  echo "Nothing to stop: ${BASE_COMPOSE} is missing (reShapr was never started by scripts/start-reshapr.sh)."
  exit 0
fi

ARGS=(down)
if [[ "${1:-}" == "--purge" ]]; then
  ARGS+=(--volumes)
fi
docker compose -p reshapr -f "$BASE_COMPOSE" -f "$DEMO_COMPOSE" "${ARGS[@]}"
echo "ok      reShapr stopped"
