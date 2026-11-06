#!/usr/bin/env bash
# WS17 live acceptance (N34 AC5, N35 AC4) against a local model, with evidence written to docs/evidence/.
#
#   scripts/live-ws17.sh --url http://localhost:11434/v1 --model qwen3.5:9b
#
# N34 AC5: a 3-member team fixes the 3-file bug fixture (evals/live/n34-team-bugfix); the HARNESS then runs
#          `python3 -m pytest -q` itself (the verdict). The same fixture is run by a single agent for comparison;
#          wall-clock model time (GPU-seconds proxy on a dedicated GPU) and tokens are recorded for both.
# N35 AC4: `tug goal` without a check on evals/live/n35-goal ends "judged met (independent verifier)", and an
#          impossible goal on evals/live/n35-goal/impossible ends "not met" within --max-turns.
# Output: docs/evidence/N34/<stamp>/ and docs/evidence/N35/<stamp>/ (logs, JSON, summary.md).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
URL="http://localhost:11434/v1"; MODEL="qwen3.5:9b"; CTX="${TUG_CTX:-32768}"
while [ $# -gt 0 ]; do case "$1" in --url) URL="$2"; shift 2;; --model) MODEL="$2"; shift 2;; --ctx) CTX="$2"; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
if [ -n "${TUG_BIN:-}" ]; then oh_cli() { $TUG_BIN "$@"; }; else
  [ -f "$ROOT/dist/cli/main.js" ] || (cd "$ROOT" && npm run build >/dev/null)
  oh_cli() { node "$ROOT/dist/cli/main.js" "$@"; }
fi
STAMP=$(date +%Y%m%d-%H%M%S)
COMMON=(--base-url "$URL" --model "$MODEL" --ctx "$CTX" --trust)
fresh() { local d; d=$(mktemp -d); cp -R "$1"/. "$d"/; (cd "$d" && git init -q && git add -A && git -c user.email=e@e -c user.name=e commit -qm fixture); echo "$d"; }

# ---------------------------------------------------------------- N34 AC5
E34="$ROOT/docs/evidence/N34/$STAMP"; mkdir -p "$E34"
T=$(fresh "$ROOT/evals/live/n34-team-bugfix/repo"); cp "$ROOT/evals/live/n34-team-bugfix/team.json" "$T/team.json"
s=$(date +%s); set +e
oh_cli --cwd "$T" "${COMMON[@]}" --mode yolo team run team.json >"$E34/team.log" 2>&1; team_exit=$?
e=$(date +%s); (cd "$T" && python3 -m pytest -q >"$E34/team-check.txt" 2>&1); team_check=$?; set -e
team_secs=$((e - s)); (cd "$T" && git diff -- tests) >"$E34/team-tests-diff.txt"
S=$(fresh "$ROOT/evals/live/n34-team-bugfix/repo")
s=$(date +%s); set +e
oh_cli --cwd "$S" "${COMMON[@]}" --mode yolo -p "Make \`python3 -m pytest -q\` pass. Each of inventory/parse.py, inventory/stock.py and inventory/report.py has one bug; fix the code, never the tests." >"$E34/single.log" 2>&1
e=$(date +%s); (cd "$S" && python3 -m pytest -q >"$E34/single-check.txt" 2>&1); single_check=$?; set -e
single_secs=$((e - s))
cat >"$E34/summary.md" <<MD
# N34 AC5 live: 3-member team on $MODEL ($STAMP)
| run | harness check (pytest) | wall-clock s | tests changed |
|---|---|---|---|
| team (lead + 3) | exit $team_check | $team_secs | $( [ -s "$E34/team-tests-diff.txt" ] && echo yes || echo no ) |
| single agent | exit $single_check | $single_secs | - |
\`tug team run\` exit $team_exit. Expected: harness check exit 0 for the team, tests unchanged. Logs: team.log, single.log.
MD
cat "$E34/summary.md"

# ---------------------------------------------------------------- N35 AC4
E35="$ROOT/docs/evidence/N35/$STAMP"; mkdir -p "$E35"
G=$(fresh "$ROOT/evals/live/n35-goal/repo"); set +e
oh_cli --cwd "$G" "${COMMON[@]}" --mode yolo goal "greet(name) in greet.py returns 'Hello, <name>!' and test_greet.py passes" --max-turns 5 --json >"$E35/met.json" 2>"$E35/met.log"; met_exit=$?
I=$(fresh "$ROOT/evals/live/n35-goal/impossible")
oh_cli --cwd "$I" "${COMMON[@]}" --mode yolo goal "greet.py fetches the greeting from https://example.invalid/greeting at import time and the fetched text is returned" --max-turns 3 --json >"$E35/impossible.json" 2>"$E35/impossible.log"; imp_exit=$?; set -e
cat >"$E35/summary.md" <<MD
# N35 AC4 live: goals judged by the independent verifier on $MODEL ($STAMP)
- achievable goal: exit $met_exit, $(grep -o '"label": "[^"]*"' "$E35/met.json" | head -1) (expected: judged met (independent verifier), exit 0)
- impossible goal: exit $imp_exit, $(grep -o '"status": "[^"]*"' "$E35/impossible.json" | head -1), $(grep -o '"label": "[^"]*"' "$E35/impossible.json" | head -1) (expected: not met / impossible within 3 iterations, exit 1)
MD
cat "$E35/summary.md"
