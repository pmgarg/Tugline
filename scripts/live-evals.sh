#!/usr/bin/env bash
# Live evidence in one command (v1.1 R19): the editing and coding suites, run live against any
# OpenAI-compatible endpoint (Ollama, llama.cpp, vLLM …) for one or more models, with ≥3 repeats,
# then one paired report with 95% Wilson intervals per model and suite.
#
#   scripts/live-evals.sh --url http://localhost:11434/v1 --models qwen3.6:27b
#   scripts/live-evals.sh --ollama                          # every chat model `ollama list` shows
#   scripts/live-evals.sh --url http://127.0.0.1:8080/v1 --models qwen3.6-27b --ctx 32768 --gpu-share 1
#
# Options: --url URL  --models a,b  --api-key KEY  --ollama  --suites editing,coding-basics
#          --repeats 3  --ctx 32768  --gpu-share 1  --arm default  --tasks t1,t2  --quick (1 repeat, 3 tasks per suite)
#          --condition quiet|shared  --load N  --out DIR
# Output:  DIR/<model>/<suite>/ (raw runs, report.md, compare.md), DIR/<suite>.md per suite, DIR/REPORT.md overall.
# TUG_BIN overrides the CLI (default: `tug` on PATH, else this checkout's dist/cli/main.js, built if needed). Needs bash ≥ 3.2 (macOS).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# The CLI: TUG_BIN, else `tug` on PATH, else this checkout's build (so a fresh clone works without `npm link`).
if [ -n "${TUG_BIN:-}" ]; then oh_cli() { $TUG_BIN "$@"; }
elif command -v tug >/dev/null 2>&1; then oh_cli() { tug "$@"; }
else
  if [ ! -f "$ROOT/dist/cli/main.js" ] || [ -n "$(find "$ROOT/src" -newer "$ROOT/dist/cli/main.js" -name '*.ts' -print -quit 2>/dev/null)" ]; then
    echo "building Tugline (no 'tug' on PATH; dist/ missing or older than src/)…"
    (cd "$ROOT" && npm run build >/dev/null) || { echo "build failed: run 'npm ci && npm run build' in $ROOT" >&2; exit 1; }
  fi
  oh_cli() { node "$ROOT/dist/cli/main.js" "$@"; }
fi
oh_cli --version >/dev/null 2>&1 || { echo "the Tugline CLI does not start here. In $ROOT run:  rm -rf node_modules && npm ci && npm run build" >&2; exit 1; }
URL=""; MODELS=""; KEY="${TUG_API_KEY:-}"; OLLAMA=0; SUITES="editing,coding-basics"; REPEATS=3; CTX=""; SHARE=""; ARM=""; TASKS=""; QUICK=0; COND=""; LOAD=""
OUT="live-results/$(date +%Y%m%d-%H%M%S)"
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --models) MODELS="$2"; shift 2 ;;
    --api-key) KEY="$2"; shift 2 ;;
    --ollama) OLLAMA=1; shift ;;
    --suites) SUITES="$2"; shift 2 ;;
    --repeats) REPEATS="$2"; shift 2 ;;
    --ctx) CTX="$2"; shift 2 ;;
    --gpu-share) SHARE="$2"; shift 2 ;;
    --arm) ARM="$2"; shift 2 ;;
    --tasks) TASKS="$2"; shift 2 ;;
    --quick) QUICK=1; shift ;;
    --condition) COND="$2"; shift 2 ;;
    --load) LOAD="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
if [ "$OLLAMA" = 1 ]; then
  [ -n "$URL" ] || URL="http://localhost:11434/v1"
  if [ -z "$MODELS" ]; then
    base=${URL%/v1}
    MODELS=$(curl -fsS "$base/api/tags" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s).models||[];console.log(m.map(x=>x.name).filter(n=>!/embed|bge|nomic|minilm/i.test(n)).join(","))})')
  fi
fi
if [ -z "$URL" ] && curl -fsS -m 3 http://localhost:11434/api/version >/dev/null 2>&1; then
  URL="http://localhost:11434/v1"; echo "no --url given: using the local Ollama at $URL"
fi
[ -n "$URL" ] || { echo "give --url <OpenAI-compatible base URL>, or --ollama for a local Ollama" >&2; exit 2; }
[ -n "$MODELS" ] || { echo "give --models a,b (or --ollama to use every local model)" >&2; exit 2; }
if [ "$QUICK" = 1 ]; then REPEATS=1; fi
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
echo "live evals → $OUT"
echo "endpoint $URL; models $MODELS; suites $SUITES; repeats $REPEATS"
all_dirs=""
IFS=',' read -r -a MODEL_LIST <<< "$MODELS"
IFS=',' read -r -a SUITE_LIST <<< "$SUITES"
for model in "${MODEL_LIST[@]}"; do
  safe=$(printf '%s' "$model" | tr -c 'A-Za-z0-9._-' '_')
  for suite in "${SUITE_LIST[@]}"; do
    dir="$OUT/$safe/$suite"
    args=(bench suite --data "$ROOT/evals/$suite" --repeats "$REPEATS" --out "$dir")
    [ -n "$ARM" ] && args+=(--arm "$ARM")
    [ -n "$SHARE" ] && args+=(--gpu-share "$SHARE")
    [ -n "$COND" ] && args+=(--condition "$COND")
    [ -n "$LOAD" ] && args+=(--load "$LOAD")
    if [ -n "$TASKS" ]; then args+=(--tasks "$TASKS")
    elif [ "$QUICK" = 1 ]; then
      first=$(ls "$ROOT/evals/$suite/tasks" | head -3 | tr '\n' ',' | sed 's/,$//')
      args+=(--tasks "$first")
    fi
    echo "== $model · $suite"
    mkdir -p "$OUT/$safe"
    ( export TUG_BASE_URL="$URL" TUG_MODEL="$model" TUG_API_KEY="$KEY"; [ -n "$CTX" ] && export TUG_CONTEXT_WINDOW="$CTX"; oh_cli "${args[@]}" ) > "$dir.log" 2>&1 || echo "   (exit $?; see $dir.log)"
    tail -n 2 "$dir.log" 2>/dev/null | sed 's/^/   /' || true
    [ -d "$dir/runs" ] && all_dirs="$all_dirs,$dir"
  done
done
all_dirs=${all_dirs#,}
[ -n "$all_dirs" ] || { echo "no run produced results" >&2; exit 1; }
for suite in "${SUITE_LIST[@]}"; do
  dirs=$(printf '%s' "$all_dirs" | tr ',' '\n' | grep "/$suite\$" | tr '\n' ',' | sed 's/,$//')
  [ -n "$dirs" ] && oh_cli bench --compare "$dirs" ${SHARE:+--gpu-share "$SHARE"} --out "$OUT/$suite.md" > /dev/null
done
oh_cli bench --compare "$all_dirs" ${SHARE:+--gpu-share "$SHARE"} --out "$OUT/REPORT.md" > /dev/null
{
  echo
  echo "## Runs"
  echo
  echo "Endpoint \`$URL\`, models \`$MODELS\`, suites \`$SUITES\`, $REPEATS repeat(s)${COND:+, condition $COND}${LOAD:+ with $LOAD load clients}. Per-suite reports: $(for s in "${SUITE_LIST[@]}"; do printf '`%s.md` ' "$s"; done)"
  echo "Re-score without a model: \`tug rescore <dir>\` then \`tug bench --compare <dirs>\`."
} >> "$OUT/REPORT.md"
echo "report: $OUT/REPORT.md"
