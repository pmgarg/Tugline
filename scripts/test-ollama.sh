#!/usr/bin/env bash
# Run the Tugline evaluation suites against every chat model in your local Ollama,
# and compare the models.
#
#   ./scripts/test-ollama.sh                       # all chat models, all suites + benchmark samples
#   ./scripts/test-ollama.sh --models qwen3.5:9b,qwen3:14b
#   ./scripts/test-ollama.sh --suites coding-basics,editing --ctx 16384
#   ./scripts/test-ollama.sh --quick               # doctor + 1 task per suite + 1 benchmark task
#   ./scripts/test-ollama.sh --timeout-scale 3     # give slow/large models 3x the per-task time
#   ./scripts/test-ollama.sh --price 0.15,0.60     # also show $ as if billed at $/1M input,output
#
# What it does, per model:
#   1. Reads capabilities from Ollama (/api/show): skips embedding-only models,
#      notes tools / vision / thinking support.
#   2. Ollama's OpenAI endpoint ignores per-request context size, and its default
#      context (often 4096) is too small for an agent prompt. So it creates a tiny
#      derived tag  oh-<model>  with PARAMETER num_ctx <ctx>. It shares the weights
#      with the original model, so no extra disk is used. --no-derive skips this
#      (then start Ollama with OLLAMA_CONTEXT_LENGTH=<ctx>). --cleanup removes the
#      derived tags at the end.
#   3. Runs `tug doctor`, then `tug eval` for each suite (every evals/<suite>/suite.json
#      by default: coding-basics, editing, browser, desktop when present).
#   4. Runs the bundled benchmark samples (`tug bench terminal-bench|swe-bench`) with
#      both arms: the full tool set and the bash-only baseline. --no-bench skips it.
#      Each task runs in its own container when Docker is reachable (TUG_BENCH_ISOLATION=host
#      runs them on this machine instead).
#   5. Vision models (capability "vision", e.g. qwen2.5vl, llava, gemma3): a vision
#      check reads evals/vision/check.png (a red square and the number 42).
# Then it writes ollama-results/<timestamp>/REPORT.md: a per-model comparison with
# resolved tasks, cost and tokens per resolved task, tool mode (native/text), the
# bash-only vs full-tools arms, unparseable replies and tool errors.
#
# Requirements: Node >= 20, Ollama running, and this repository (npm install is done for you).
# Works with macOS's default bash 3.2.
set -u

OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
MODELS=""
SUITES=""
CTX=16384
DERIVE=1
CLEANUP=0
QUICK=0
REPEATS=1
BENCH=1
BENCH_SUBSET=""
VISION=1
PRICE=""
OUT_BASE=""
EXTRA_ARGS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --models) MODELS="$2"; shift 2 ;;
    --suites) SUITES="$2"; shift 2 ;;
    --ctx) CTX="$2"; shift 2 ;;
    --repeats) REPEATS="$2"; shift 2 ;;
    --no-derive) DERIVE=0; shift ;;
    --cleanup) CLEANUP=1; shift ;;
    --quick) QUICK=1; shift ;;
    --timeout-scale) export TUG_EVAL_TIMEOUT_SCALE="$2"; shift 2 ;;
    --no-bench) BENCH=0; shift ;;
    --bench-subset) BENCH_SUBSET="$2"; shift 2 ;;
    --no-vision) VISION=0; shift ;;
    --price) PRICE="$2"; shift 2 ;;
    --out) OUT_BASE="$2"; shift 2 ;;
    --url) OLLAMA_URL="$2"; shift 2 ;;
    --) shift; EXTRA_ARGS="$*"; break ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (see --help)"; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }

# ---- prerequisites
if ! command -v node >/dev/null 2>&1; then echo "Node.js >= 20 is required (macOS: brew install node)"; exit 1; fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then echo "Node.js >= 20 is required (found $(node -v))"; exit 1; fi
if ! curl -sf "$OLLAMA_URL/api/tags" >/dev/null; then echo "Ollama is not reachable at $OLLAMA_URL (is the Ollama app running?)"; exit 1; fi
if [ ! -d node_modules ]; then say "Installing dependencies…"; npm install --no-audit --no-fund || exit 1; fi
# TUG_BIN overrides the CLI command (e.g. "node --import tsx src/cli/main.ts" from a checkout without a build).
if [ -n "${TUG_BIN:-}" ]; then
  OH="$TUG_BIN"
else
  if [ ! -f dist/cli/main.js ]; then say "Building…"; npm run build || exit 1; fi
  OH="node $ROOT/dist/cli/main.js"
fi

# ---- default suites: every evals/<name>/suite.json
if [ -z "$SUITES" ]; then
  for f in evals/*/suite.json; do
    [ -f "$f" ] || continue
    d=$(basename "$(dirname "$f")")
    if [ -z "$SUITES" ]; then SUITES="$d"; else SUITES="$SUITES,$d"; fi
  done
fi
if [ "$QUICK" = 1 ] && [ -z "$BENCH_SUBSET" ]; then BENCH_SUBSET=1; fi

# ---- model list (name|caps) via the Ollama API
MODEL_LINES=$(OLLAMA_URL="$OLLAMA_URL" WANT="$MODELS" node -e '
const url = process.env.OLLAMA_URL, want = (process.env.WANT || "").split(",").filter(Boolean);
(async () => {
  const tags = await (await fetch(url + "/api/tags")).json();
  for (const m of tags.models || []) {
    if (want.length && !want.includes(m.name)) continue;
    let caps = [];
    try {
      const s = await (await fetch(url + "/api/show", { method: "POST", body: JSON.stringify({ model: m.name }) })).json();
      caps = s.capabilities || [];
    } catch {}
    if (!caps.length) caps = /embed|bge|nomic/i.test(m.name) ? ["embedding"] : ["completion"];
    console.log(m.name + "|" + caps.join(","));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
') || exit 1

if [ -z "$MODEL_LINES" ]; then echo "No matching models in Ollama."; exit 1; fi

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="${OUT_BASE:-$ROOT/ollama-results/$STAMP}"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.tsv"
printf 'model\tcaps\tdoctor\tsuite\tdir\ttoolmode\tvision\n' > "$SUMMARY"

say "Models:"; echo "$MODEL_LINES" | sed 's/^/  /'
say "Suites: $SUITES   benchmark samples: $( [ "$BENCH" = 1 ] && echo yes || echo no )   context: $CTX   results: $OUT"

# vision_check <model> → prints pass|fail|error and writes the answer to stdout of the node script
vision_check() {
  OLLAMA_URL="$OLLAMA_URL" MODEL="$1" IMG="$ROOT/evals/vision/check.png" node -e '
const fs = require("fs");
(async () => {
  const b64 = fs.readFileSync(process.env.IMG).toString("base64");
  const r = await fetch(process.env.OLLAMA_URL + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer ollama" },
    body: JSON.stringify({ model: process.env.MODEL, temperature: 0, max_tokens: 200, messages: [{ role: "user", content: [
      { type: "text", text: "Look at the image. What number is written in it, and what colour is the square? Reply in the form: <number> <colour>" },
      { type: "image_url", image_url: { url: "data:image/png;base64," + b64 } } ] }] }) });
  const j = await r.json();
  const a = String(j.choices?.[0]?.message?.content ?? j.error?.message ?? "").trim();
  const ok = /\b42\b/.test(a) && /red/i.test(a);
  console.log((ok ? "pass" : "fail") + "\t" + a.replace(/\s+/g, " ").slice(0, 200));
})().catch((e) => console.log("error\t" + e.message));
'
}

echo "$MODEL_LINES" | while IFS='|' read -r NAME CAPS; do
  case ",$CAPS," in
    *,completion,*) ;;
    *) warn "skip $NAME (embedding-only)"; printf '%s\t%s\tskipped\t-\t-\t-\t-\n' "$NAME" "$CAPS" >> "$SUMMARY"; continue ;;
  esac
  SAFE=$(echo "$NAME" | tr ':/' '__')
  RUN_MODEL="$NAME"
  if [ "$DERIVE" = 1 ]; then
    RUN_MODEL="oh-$SAFE"
    printf 'FROM %s\nPARAMETER num_ctx %s\n' "$NAME" "$CTX" > "$OUT/$SAFE.Modelfile"
    if curl -sf "$OLLAMA_URL/api/create" -d "{\"model\":\"$RUN_MODEL\",\"from\":\"$NAME\",\"parameters\":{\"num_ctx\":$CTX}}" >/dev/null 2>&1 \
       || ollama create "$RUN_MODEL" -f "$OUT/$SAFE.Modelfile" >/dev/null 2>&1; then
      echo "$RUN_MODEL" >> "$OUT/.derived"
    else
      warn "could not create $RUN_MODEL; using $NAME as is (context may be too small)"
      RUN_MODEL="$NAME"
    fi
  fi
  HAS_VISION=0; case ",$CAPS," in *,vision,*) HAS_VISION=1 ;; esac
  TOOLMODE=auto; case ",$CAPS," in *,tools,*) TOOLMODE=native ;; *) TOOLMODE=text ;; esac
  say "== $NAME  (caps: $CAPS, tool mode: $TOOLMODE)"
  DOC="ok"
  mkdir -p "$OUT/$SAFE"
  # shellcheck disable=SC2086
  $OH doctor --base-url "$OLLAMA_URL/v1" --api-key ollama --model "$RUN_MODEL" --ctx "$CTX" > "$OUT/$SAFE/doctor.txt" 2>&1 || DOC="fail"
  tail -n 12 "$OUT/$SAFE/doctor.txt" | sed 's/^/   /'

  VIS="-"
  if [ "$HAS_VISION" = 1 ] && [ "$VISION" = 1 ]; then
    VLINE=$(vision_check "$RUN_MODEL")
    VIS=$(printf '%s' "$VLINE" | cut -f1)
    printf '%s\n' "$VLINE" > "$OUT/$SAFE/vision.txt"
    echo "   vision check: $VLINE"
  fi
  TM_FLAG="--native-tools"; [ "$TOOLMODE" = text ] && TM_FLAG="--text-tools"

  OLD_IFS=$IFS; IFS=','
  for SUITE in $SUITES; do
    IFS=$OLD_IFS
    if [ ! -f "evals/$SUITE/suite.json" ]; then warn "   suite evals/$SUITE not found, skipped"; IFS=','; continue; fi
    ARGS="--repeats $REPEATS"
    if node -e 'const s=require(process.argv[1]); process.exit(s.arms && s.arms.guarded ? 0 : 1)' "$ROOT/evals/$SUITE/suite.json"; then ARGS="--arms guarded $ARGS"; fi
    if [ "$QUICK" = 1 ]; then ARGS="$ARGS --tasks $(ls "evals/$SUITE/tasks" | head -1)"; fi
    SOUT="$OUT/$SAFE/$SUITE"
    say "   suite $SUITE"
    # shellcheck disable=SC2086
    $OH eval "evals/$SUITE" $ARGS --out "$SOUT" --base-url "$OLLAMA_URL/v1" --api-key ollama --model "$RUN_MODEL" --ctx "$CTX" $TM_FLAG $EXTRA_ARGS > "$SOUT.log" 2>&1
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$NAME" "$CAPS" "$DOC" "$SUITE" "$SOUT" "$TOOLMODE" "$VIS" >> "$SUMMARY"
    IFS=','
  done
  IFS=$OLD_IFS

  if [ "$BENCH" = 1 ]; then
    for FMT in terminal-bench swe-bench; do
      BOUT="$OUT/$SAFE/bench-$FMT"
      BARGS="--arm all --repeats $REPEATS"
      [ -n "$BENCH_SUBSET" ] && BARGS="$BARGS --subset $BENCH_SUBSET"
      say "   bench $FMT (full tools vs bash-only)"
      # shellcheck disable=SC2086
      $OH bench "$FMT" $BARGS --out "$BOUT" --base-url "$OLLAMA_URL/v1" --api-key ollama --model "$RUN_MODEL" --ctx "$CTX" $TM_FLAG $EXTRA_ARGS > "$BOUT.log" 2>&1
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$NAME" "$CAPS" "$DOC" "bench:$FMT" "$BOUT" "$TOOLMODE" "$VIS" >> "$SUMMARY"
    done
  fi
done

# ---- report: per-model comparison
PRICE="$PRICE" node -e '
const fs = require("fs"), path = require("path");
const [sum, out] = process.argv.slice(1);
const price = (process.env.PRICE || "").split(",").map(Number);
const priced = price.length === 2 && price.every((x) => Number.isFinite(x));
const rows = fs.readFileSync(sum, "utf8").trim().split("\n").slice(1).map((l) => l.split("\t"));
const models = new Map();
const detail = [];
for (const [model, caps, doctor, suite, dir, toolMode, vision] of rows) {
  const m = models.get(model) || { model, caps, doctor, toolMode, vision, runs: 0, evaluable: 0, resolved: 0, usd: 0, priced: 0, tokens: 0, unparseable: 0, toolErrors: 0, toolCalls: 0, modes: {}, arms: {} };
  models.set(model, m);
  if (doctor === "skipped") continue;
  let scores = [], raws = [];
  try { scores = JSON.parse(fs.readFileSync(path.join(dir, "scores.json"), "utf8")); } catch {}
  try { raws = fs.readdirSync(path.join(dir, "runs")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, "runs", f), "utf8"))); } catch {}
  const byArm = {};
  for (const s of scores) {
    const r = raws.find((x) => x.runId === s.runId) || { stats: {}, manifest: {} };
    const a = (byArm[s.arm] = byArm[s.arm] || { runs: 0, evaluable: 0, resolved: 0, usd: 0, priced: 0, tokens: 0, unparseable: 0, toolErrors: 0, toolCalls: 0 });
    const st = r.stats || {};
    const p = priced ? ((st.promptTokens || 0) * price[0] + (st.completionTokens || 0) * price[1]) / 1e6 : 0;
    for (const t of [a, m]) {
      t.runs++;
      if (s.outcome !== "not_evaluable") t.evaluable++;
      if (s.outcome === "pass") t.resolved++;
      t.usd += s.cost.usd || 0; t.priced += p; t.tokens += s.cost.tokens || 0;
      t.unparseable += s.cost.unparseable || 0; t.toolErrors += st.toolErrors || 0; t.toolCalls += st.toolCalls || 0;
    }
    const mode = (r.manifest && r.manifest.toolMode) || toolMode;
    m.modes[mode] = (m.modes[mode] || 0) + 1;
    if (suite.startsWith("bench:")) { const k = s.arm; const b = (m.arms[k] = m.arms[k] || { runs: 0, resolved: 0, tokens: 0 }); b.runs++; if (s.outcome === "pass") b.resolved++; b.tokens += s.cost.tokens || 0; }
  }
  for (const [arm, a] of Object.entries(byArm)) detail.push({ model, suite, arm, ...a });
  if (!scores.length) detail.push({ model, suite, arm: "-", runs: 0, evaluable: 0, resolved: 0, usd: 0, priced: 0, tokens: 0, unparseable: 0, toolErrors: 0, toolCalls: 0, error: true });
}
const per = (x, n, d = 4) => (n ? (x / n).toFixed(d) : "n/a");
const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "n/a");
let md = "# Tugline × Ollama: model comparison\n\n";
md += "| Model | Capabilities | Doctor | Vision | Tool mode | Resolved | Rate | $ / resolved | " + (priced ? "$ / resolved at --price | " : "") + "Tokens / resolved | Unparseable | Tool errors / calls | bash-only vs full (bench) |\n";
md += "|---|---|---|---|---|---|---|---|" + (priced ? "---|" : "") + "---|---|---|---|\n";
const ranked = [...models.values()].sort((a, b) => b.resolved - a.resolved || a.tokens / (a.resolved || 1e-9) - b.tokens / (b.resolved || 1e-9));
for (const m of ranked) {
  if (m.doctor === "skipped") { md += "| " + m.model + " | " + m.caps + " | skipped | - | - | - | - | - | " + (priced ? "- | " : "") + "- | - | - | - |\n"; continue; }
  const modes = Object.entries(m.modes).map(([k, v]) => k + "×" + v).join(", ") || m.toolMode;
  const bo = m.arms["bash-only"], full = m.arms["default"];
  const arms = bo || full ? (bo ? bo.resolved + "/" + bo.runs : "-") + " vs " + (full ? full.resolved + "/" + full.runs : "-") : "-";
  md += "| " + [m.model, m.caps, m.doctor, m.vision, modes, m.resolved + "/" + m.evaluable, pct(m.resolved, m.evaluable), per(m.usd, m.resolved)].concat(priced ? [per(m.priced, m.resolved)] : []).concat([per(m.tokens, m.resolved, 0), m.unparseable, m.toolErrors + "/" + m.toolCalls, arms]).join(" | ") + " |\n";
}
md += "\nResolved = runs whose acceptance commands passed (EAG S18 scorer; not_evaluable runs, e.g. a crashed endpoint, are excluded). $ / resolved is spend divided by resolved tasks (EAG S15); local models cost $0 unless the profile has pricing, so tokens / resolved and --price give the comparison. Tool mode counts runs by the tool-calling dialect used (native = OpenAI tools API, text = tool calls parsed from text).\n\n";
md += "## Per suite\n\n| Model | Suite | Arm | Runs | Resolved | Tokens | Unparseable | Tool errors |\n|---|---|---|---|---|---|---|---|\n";
for (const d of detail) md += "| " + [d.model, d.suite, d.arm, d.runs, d.error ? "error (see log)" : d.resolved + "/" + d.evaluable, d.tokens, d.unparseable, d.toolErrors].join(" | ") + " |\n";
md += "\nRaw runs and per-suite report.md are in the model folders; vision answers in <model>/vision.txt.\n";
fs.writeFileSync(out + "/REPORT.md", md); console.log(md);
' "$SUMMARY" "$OUT"

if [ "$CLEANUP" = 1 ] && [ -f "$OUT/.derived" ]; then
  while read -r M; do ollama rm "$M" >/dev/null 2>&1 && echo "removed $M"; done < "$OUT/.derived"
fi
say "Done. Report: $OUT/REPORT.md"
