// evals/browser setup (suite.json "setup"): serve the test site and add cascade path statistics to report.md.
import fs from 'node:fs';
import path from 'node:path';
import { startSiteServer } from './serve.mjs';

export async function start() {
  const site = await startSiteServer();
  return {
    vars: { SITE: site.url },
    stop: () => site.close(),
    report: (outDir) => pathReport(path.join(outDir, 'runs')),
  };
}

/** Per-run and total counts of the cascade layer (`path`) of every browser step, from the raw records. */
export function pathReport(runsDir) {
  if (!fs.existsSync(runsDir)) return undefined;
  const total = {};
  const rows = [];
  for (const f of fs.readdirSync(runsDir).filter((x) => x.endsWith('.json')).sort()) {
    const r = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
    const counts = {};
    const codes = new Set();
    for (const e of r.events ?? []) {
      if (e.type !== 'automation') continue;
      if (e.path) {
        counts[e.path] = (counts[e.path] ?? 0) + 1;
        total[e.path] = (total[e.path] ?? 0) + 1;
      }
      if (e.errorCode) codes.add(e.errorCode);
    }
    const fmt = Object.keys(counts).sort().map((k) => `${k}×${counts[k]}`).join(' ') || '-';
    rows.push(`| ${r.runId} | ${fmt} | ${[...codes].join(', ') || '-'} |`);
  }
  const tot = Object.keys(total).sort().map((k) => `${k}×${total[k]}`).join(' ') || '(no browser steps)';
  return `## Automation path statistics (S9 \`path\`)\n\nTotal: ${tot}\n\n| run | path | error codes |\n|---|---|---|\n${rows.join('\n')}\n`;
}
