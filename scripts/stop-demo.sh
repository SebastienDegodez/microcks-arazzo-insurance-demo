#!/usr/bin/env bash
# Stops the orchestrator and the UI of the insurance demo; --all also stops reShapr. Microcks is left running.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for port in 5180 5190; do
  for pid in $(lsof -tiTCP:"$port" -sTCP:LISTEN); do kill "$pid" && echo "Arrêté $pid sur :$port"; done
done
[ "${1:-}" = "--all" ] && "$ROOT/scripts/stop-reshapr.sh"
true
