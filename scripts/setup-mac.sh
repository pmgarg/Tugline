#!/usr/bin/env bash
# One-time setup of Tugline on a Mac (also works on Linux) with a local Ollama.
#
#   bash scripts/setup-mac.sh                 # install, build, configure, install VS Code extension, quick eval
#   bash scripts/setup-mac.sh --model qwen3:14b --ctx 32768
#   bash scripts/setup-mac.sh --no-eval       # skip the quick eval
#   bash scripts/setup-mac.sh --full-eval     # run the full Ollama comparison afterwards (takes hours)
#
# It is safe to re-run. It never overwrites an existing ~/.tugline/config.json:
# it writes ~/.tugline/config.ollama.json next to it and tells you what to merge.
# Works with macOS's default bash 3.2.
set -u

MODEL=""
CTX=""
EVAL=quick
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --ctx) CTX="$2"; shift 2 ;;
    --no-eval) EVAL=none; shift ;;
    --full-eval) EVAL=full; shift ;;
    --url) OLLAMA_URL="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (see --help)"; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*"; exit 1; }

step "1/6 Node.js"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js with Homebrew…"; brew install node || die "brew install node failed"
  else
    die "Node.js 20+ is required. Install it from https://nodejs.org (or Homebrew: https://brew.sh, then 'brew install node'), then re-run this script."
  fi
fi
ok "node $(node -v)"
command -v rg >/dev/null 2>&1 && ok "ripgrep found" || warn "ripgrep not found (optional, faster search): brew install ripgrep"

step "2/6 Ollama"
curl -sf "$OLLAMA_URL/api/version" >/dev/null || die "Ollama is not reachable at $OLLAMA_URL. Start the Ollama app and re-run."
ok "Ollama $(curl -s "$OLLAMA_URL/api/version" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("?")}})')"
# Pick the best installed tool-capable chat model unless --model was given.
PICK=$(OLLAMA_URL="$OLLAMA_URL" WANT="$MODEL" node -e '
const url = process.env.OLLAMA_URL, want = process.env.WANT;
(async () => {
  const tags = (await (await fetch(url + "/api/tags")).json()).models || [];
  const rows = [];
  for (const m of tags) {
    let caps = [], ctx = 0;
    try {
      const s = await (await fetch(url + "/api/show", { method: "POST", body: JSON.stringify({ model: m.name }) })).json();
      caps = s.capabilities || [];
      for (const [k, v] of Object.entries(s.model_info || {})) if (k.endsWith(".context_length")) ctx = Number(v);
    } catch {}
    if (!caps.length) caps = /embed|bge|nomic/i.test(m.name) ? ["embedding"] : ["completion"];
    rows.push({ name: m.name, caps, ctx, size: m.size || 0 });
  }
  const chat = rows.filter((r) => r.caps.includes("completion"));
  if (want) { const r = chat.find((x) => x.name === want); if (!r) { console.error("model " + want + " is not installed in Ollama"); process.exit(3); } console.log([r.name, r.caps.join(","), r.ctx].join("|")); return; }
  // Prefer tool-capable coder models, then tool-capable general models; within a group prefer mid-size (8–16 GB) models.
  const score = (r) => (r.caps.includes("tools") ? 100 : 0) + (/coder|qwen3|qwen3\.5|devstral|gpt-oss|glm/i.test(r.name) ? 20 : 0) + (r.size > 4e9 && r.size < 16e9 ? 10 : 0) - (r.caps.includes("vision") ? 5 : 0);
  chat.sort((a, b) => score(b) - score(a));
  if (!chat.length) { console.error("no chat models installed (ollama pull qwen3.5:9b)"); process.exit(4); }
  console.log([chat[0].name, chat[0].caps.join(","), chat[0].ctx].join("|"));
})().catch((e) => { console.error(e.message); process.exit(1); });
') || die "could not choose a model"
MODEL=$(echo "$PICK" | cut -d'|' -f1); CAPS=$(echo "$PICK" | cut -d'|' -f2)
ok "model: $MODEL  (capabilities: $CAPS)"
TOOLMODE=text; case ",$CAPS," in *,tools,*) TOOLMODE=native ;; esac
VISION=false; case ",$CAPS," in *,vision,*) VISION=true ;; esac
if [ -z "$CTX" ]; then CTX=16384; fi
echo "  context window: $CTX tokens. Make sure Ollama → Settings → Context length is at least $(($CTX / 1024))k."

step "3/6 Install and build Tugline"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund || npm install --no-audit --no-fund || die "npm install failed"; else npm install --no-audit --no-fund || die "npm install failed"; fi
npm run build || die "build failed"
if npm link >/dev/null 2>&1; then ok "'tug' command installed ($(command -v tug || echo 'open a new terminal'))"; else
  warn "npm link failed (permissions). Use: alias tug='node $ROOT/dist/cli/main.js'  (add it to ~/.zshrc)"
fi
OH="node $ROOT/dist/cli/main.js"

step "4/6 Configure ~/.tugline"
mkdir -p "$HOME/.tugline"
CFG="$HOME/.tugline/config.json"
TARGET="$CFG"; [ -f "$CFG" ] && TARGET="$HOME/.tugline/config.ollama.json"
cat > "$TARGET" <<JSON
{
  "profile": "ollama",
  "profiles": {
    "ollama": {
      "baseUrl": "$OLLAMA_URL/v1",
      "apiKey": "",
      "model": "$MODEL",
      "contextWindow": $CTX,
      "maxOutputTokens": 4096,
      "toolMode": "$TOOLMODE",
      "vision": $VISION,
      "pricing": { "inputPerM": 0, "outputPerM": 0 }
    }
  },
  "permissionMode": "ask"
}
JSON
if [ "$TARGET" = "$CFG" ]; then ok "wrote $CFG"; else warn "kept your existing $CFG; the Ollama profile is in $TARGET (copy its \"profiles.ollama\" into your config and set \"profile\": \"ollama\")"; fi

step "5/6 VS Code extension"
CODE=""
command -v code >/dev/null 2>&1 && CODE=code
[ -z "$CODE" ] && [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ] && CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
VSIX=$(ls -t release/tugline-*.vsix 2>/dev/null | head -1)
if [ -z "$VSIX" ]; then (cd vscode && npm install --no-audit --no-fund >/dev/null && npm run package) && VSIX=$(ls -t vscode/tugline-*.vsix | head -1); fi
if [ -n "$CODE" ] && [ -n "$VSIX" ]; then
  "$CODE" --install-extension "$VSIX" --force && ok "installed $VSIX"
  # The extension reads ~/.tugline/config.json; set the model explicitly too, so its UI shows it.
  "$CODE" --list-extensions 2>/dev/null | grep -qi tugline && ok "Tugline is in VS Code: open the Tugline view in the activity bar"
else
  warn "VS Code CLI not found. In VS Code: Extensions → ⋯ → Install from VSIX… → $ROOT/${VSIX:-release/tugline-*.vsix}"
fi

step "6/6 Check"
$OH doctor --base-url "$OLLAMA_URL/v1" --model "$MODEL" --ctx "$CTX" || warn "doctor reported problems (see above)"
case "$EVAL" in
  quick) echo; echo "Quick eval (one task per suite; a few minutes per model)…"; bash scripts/test-ollama.sh --quick --models "$MODEL" ;;
  full) bash scripts/test-ollama.sh ;;
  *) ;;
esac

cat <<EOF

Done. Try it:
  cd ~/some/project && tug "explain this repository"          # CLI (ask mode: you approve actions)
  tug -y -p "fix the failing test and run the tests"           # headless, auto-approve inside the workspace
  VS Code: Tugline icon in the activity bar → chat. Ctrl+Shift+K = inline edit on a selection.
Compare all your models:  bash scripts/test-ollama.sh   (report in ollama-results/)
EOF
