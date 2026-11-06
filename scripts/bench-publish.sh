#!/usr/bin/env bash
# Publish benchmark results as evidence, and re-run any published row (v1.1 N1 AC4).
#
#   scripts/bench-publish.sh <results-dir> [<results-dir> …]   copy each run's report, paired report, scores and
#                                                                exact command into docs/evidence/bench/<date>/<name>/
#                                                                and add a row to docs/evidence/bench/README.md
#   scripts/bench-publish.sh --rerun <published-dir>            run that row's recorded command again (TUG_BIN overrides `tug`)
#
# Every `tug bench` run writes command.txt (the exact invocation) next to report.md. Model, endpoint and
# tool versions are in runs/*.json → manifest; they are summarised into the row.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST=${BENCH_EVIDENCE_DIR:-$ROOT/docs/evidence/bench}
if [ "${1:-}" = "--rerun" ]; then
  dir=${2:?usage: bench-publish.sh --rerun <published-dir>}
  [ -f "$dir/command.txt" ] || { echo "no command.txt in $dir" >&2; exit 1; }
  cmd=$(cat "$dir/command.txt")
  tug=${TUG_BIN:-tug}
  echo "re-running: $cmd"
  eval "$tug ${cmd#tug }"
  exit $?
fi
[ $# -ge 1 ] || { sed -n '2,12p' "$0"; exit 2; }
day=$(date +%F)
mkdir -p "$DEST/$day"
[ -f "$DEST/README.md" ] || printf '# Published benchmark results\n\n| date | run | format | arms | resolved | model | command |\n|---|---|---|---|---|---|---|\n' > "$DEST/README.md"
for src in "$@"; do
  [ -f "$src/report.md" ] || { echo "skip $src: no report.md" >&2; continue; }
  name=$(basename "$src")
  out="$DEST/$day/$name"
  mkdir -p "$out"
  for f in report.md compare.md scores.json command.txt swe-bench-pro-predictions.json; do [ -f "$src/$f" ] && cp "$src/$f" "$out/"; done
  summary=$(node -e '
    const fs = require("fs"), path = require("path");
    const d = process.argv[1];
    const runs = fs.existsSync(path.join(d, "runs")) ? fs.readdirSync(path.join(d, "runs")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(d, "runs", f), "utf8"))) : [];
    const scores = fs.existsSync(path.join(d, "scores.json")) ? JSON.parse(fs.readFileSync(path.join(d, "scores.json"), "utf8")) : [];
    const arms = [...new Set(scores.map((s) => s.arm))].join(", ");
    const pass = scores.filter((s) => s.outcome === "pass").length;
    const m = runs[0]?.manifest ?? {};
    const ext = [...new Set(runs.map((r) => r.manifest.external ? `${r.manifest.external.name} ${r.manifest.external.version ?? ""}`.trim() : ""))].filter(Boolean).join("; ");
    fs.writeFileSync(path.join(process.argv[2], "manifest-summary.json"), JSON.stringify({ model: m.model, baseUrl: m.baseUrl, harnessVersion: m.harnessVersion, isolation: m.isolation, external: ext || undefined, runs: runs.length }, null, 2));
    process.stdout.write(`${arms || "-"}\t${pass}/${scores.length}\t${m.model ?? "-"}${ext ? ` (+ ${ext})` : ""}`);
  ' "$src" "$out")
  arms=$(printf '%s' "$summary" | cut -f1); resolved=$(printf '%s' "$summary" | cut -f2); model=$(printf '%s' "$summary" | cut -f3)
  fmt=$(sed -n 's/^tug bench \([a-z-]*\).*/\1/p' "$src/command.txt" 2>/dev/null || true)
  cmd=$(tr -d '\n' < "$src/command.txt" 2>/dev/null || echo '-')
  printf '| %s | [%s](%s/%s/) | %s | %s | %s | %s | `%s` |\n' "$day" "$name" "$day" "$name" "${fmt:--}" "$arms" "$resolved" "$model" "$cmd" >> "$DEST/README.md"
  echo "published $src → $out"
done
