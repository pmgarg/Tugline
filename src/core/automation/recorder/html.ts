/**
 * Static HTML replay report (SPEC E7 viewer; `tug replay <run> --html`): goal,
 * per-turn path, actions, outcomes and diffs, matching the S9 replay view.
 * Everything from the page is escaped; the report has no scripts.
 */
import { formatPathStats, pathStats, type TrajectoryMeta, type TrajectoryStep } from './trajectory.js';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderReplayHtml(meta: TrajectoryMeta | undefined, steps: TrajectoryStep[]): string {
  const stats = formatPathStats(pathStats(steps));
  const rows = steps
    .map((s) => {
      const target = s.target ? `${s.target.role}${s.target.name ? ` "${s.target.name}"` : ''}` : '';
      const args = JSON.stringify(s.args);
      return `<tr class="${esc(s.outcome)}"><td>${esc(s.seq)}</td><td>${esc(s.turn)}</td><td>${esc(s.path)}</td><td>${esc(s.tool)}</td><td>${esc(target)}</td><td><code>${esc(args.length > 200 ? args.slice(0, 200) + '…' : args)}</code></td><td>${esc(s.outcome)}${s.errorCode ? ` <b>${esc(s.errorCode)}</b>` : ''}</td><td>${s.diff ? `<details><summary>diff</summary><pre>${esc(s.diff)}</pre></details>` : ''}</td></tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Replay ${esc(meta?.session ?? '')}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
:root { --bg:#fff; --fg:#1d1d1f; --muted:#666; --line:#ddd; --bad:#c62828; --ok:#2e7d32; }
@media (prefers-color-scheme: dark) { :root { --bg:#161618; --fg:#eee; --muted:#aaa; --line:#333; --bad:#ef9a9a; --ok:#a5d6a7; } }
body { font: 14px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--fg); margin: 16px; }
table { border-collapse: collapse; width: 100%; } td, th { border-bottom: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
tr.failed td, tr.refused td { color: var(--bad); } tr.confirmed td:nth-child(7) { color: var(--ok); }
pre { white-space: pre-wrap; margin: 0; } .muted { color: var(--muted); }
</style></head><body>
<h1>Browser run ${esc(meta?.session ?? '')}</h1>
<p class="muted">${esc(meta?.goal ?? '')} · model ${esc(meta?.model ?? '?')} · started ${esc(meta?.startedAt ?? '')} · ${steps.length} steps</p>
<p><b>path:</b> ${esc(stats)}</p>
<table><thead><tr><th>#</th><th>turn</th><th>path</th><th>tool</th><th>target</th><th>args</th><th>outcome</th><th>diff</th></tr></thead>
<tbody>
${rows}
</tbody></table>
</body></html>
`;
}
