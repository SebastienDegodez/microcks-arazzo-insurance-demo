#!/usr/bin/env bash
# Starts the whole insurance demo: reShapr (MCP), the contracts in Microcks, the .NET orchestrator and the UI.
# Microcks (8080) and its Arazzo minion (8082) must already run: they belong to the Arazzo demo stack.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/.run/logs"
mkdir -p "$LOGS"

wait_for() { # url, label, seconds
  for _ in $(seq 1 "$3"); do curl -s -o /dev/null --max-time 2 "$1" && { echo "✓ $2"; return 0; }; sleep 1; done
  echo "✗ $2 ne répond pas ($1)"; return 1
}
free_port() {
  for pid in $(lsof -tiTCP:"$1" -sTCP:LISTEN); do kill "$pid"; done
  for _ in $(seq 1 20); do [ -z "$(lsof -tiTCP:"$1" -sTCP:LISTEN)" ] && return 0; sleep 0.5; done
}

echo "== Microcks"
wait_for http://localhost:8080/api/health "Microcks sur :8080" 5 || { echo "Démarre d'abord la stack Arazzo."; exit 1; }
wait_for http://localhost:8082/q/health "Minion Arazzo sur :8082" 5 || echo "  → les runs Arazzo ne marcheront pas sans le minion."

echo "== reShapr (MCP sur :7778)"
if curl -s -o /dev/null --max-time 2 http://localhost:5555; then echo "✓ reShapr déjà démarré"; else "$ROOT/scripts/start-reshapr.sh" > "$LOGS/reshapr.log" 2>&1 && echo "✓ reShapr démarré" || echo "✗ reShapr : voir $LOGS/reshapr.log"; fi

echo "== Contrats dans Microcks"
"$ROOT/scripts/import-contracts.sh" > "$LOGS/import.log" 2>&1 && echo "✓ contrats, Arazzo et overlay importés" || echo "✗ import : voir $LOGS/import.log"

echo "== Orchestrateur .NET (:5180)"
free_port 5180
if (cd "$ROOT/orchestrator" && dotnet build -nologo -v q > "$LOGS/orchestrator-build.log" 2>&1); then
  (cd "$ROOT/orchestrator" && nohup dotnet run --no-build > "$LOGS/orchestrator.log" 2>&1 < /dev/null &) > /dev/null 2>&1
else echo "✗ build orchestrator : voir $LOGS/orchestrator-build.log"; fi
wait_for http://localhost:5180/underwriting-cases/none "Orchestrateur sur :5180" 90

echo "== IHM (:5190)"
free_port 5190
if (cd "$ROOT/ui" && dotnet build -nologo -v q > "$LOGS/ui-build.log" 2>&1); then
  (cd "$ROOT/ui" && nohup dotnet run --no-build > "$LOGS/ui.log" 2>&1 < /dev/null &) > /dev/null 2>&1
else echo "✗ build ui : voir $LOGS/ui-build.log"; fi
wait_for http://localhost:5190/ "IHM sur :5190" 90

echo
echo "IHM         http://localhost:5190"
echo "Microcks    http://localhost:8080/#/workflows   (document « Commercial underwriting »)"
echo "reShapr     http://localhost:5555   (MCP : http://localhost:7778/mcp/reshapr/georisques-1-0-0-default)"
