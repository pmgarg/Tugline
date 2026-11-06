/**
 * `tug replay` (SPEC E7, I3): replay, check, heal, export or report a recorded
 * browser run without a model.
 *
 *   tug replay <runDir>                     strict replay, prints the result
 *   tug replay <runDir> --check             exit 0 if it passes, 1 if not (CI)
 *   tug replay <runDir> --heal              selector → semantic key healing; writes trajectory.healed.jsonl
 *   tug replay <runDir> --export f.spec.ts  write a Playwright test
 *   tug replay <runDir> --recipe <name> [--match <urlPrefix>]   save as an L2a recipe
 *   tug replay <runDir> --html [out.html]   static report
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerCliCommand } from '../../commands.js';
import { deepMerge, type HarnessConfig } from '../../config.js';
import { BrowserSession } from '../browser/session.js';
import { browserConfig } from '../browser/config.js';
import { readTrajectory } from './trajectory.js';
import { replayTrajectory, saveRecipe } from './replay.js';
import { exportPlaywrightSpec } from './export.js';
import { renderReplayHtml } from './html.js';

function flag(argv: string[], name: string): string | true | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

/** Replay a run directory headlessly; used by the CLI and tests. */
export async function replayRun(runDir: string, config: HarnessConfig, workspace: string, mode: 'strict' | 'heal' = 'strict', log?: (s: string) => void) {
  const { steps } = readTrajectory(runDir);
  if (!steps.length) throw new Error(`no trajectory in ${runDir}`);
  const cfg = deepMerge(config, { browser: { record: false } }) as HarnessConfig;
  const s = new BrowserSession({ sessionId: `replay-${Date.now()}`, workspace, config: cfg });
  try {
    return await replayTrajectory(s.driver, steps, { mode, guard: s.replayGuard, log });
  } finally {
    await s.dispose();
  }
}

registerCliCommand({
  name: 'replay',
  description: 'replay, check, heal, export (Playwright) or report a recorded browser run',
  usage: '<runDir> [--check] [--heal] [--export f.spec.ts] [--recipe name [--match urlPrefix]] [--html [out.html]]',
  needsModel: false,
  async run(argv, ctx) {
    const dir = argv.find((a) => !a.startsWith('--'));
    if (!dir) {
      ctx.write('usage: tug replay <runDir> [--check] [--heal] [--export f.spec.ts] [--recipe name] [--html [out.html]]\n');
      return 2;
    }
    const runDir = path.resolve(ctx.workspace, dir);
    const { meta, steps } = readTrajectory(runDir);
    const html = flag(argv, '--html');
    if (html) {
      const out = html === true ? path.join(runDir, 'report.html') : path.resolve(html);
      fs.writeFileSync(out, renderReplayHtml(meta, steps));
      ctx.write(`wrote ${out}\n`);
      return 0;
    }
    const exp = flag(argv, '--export');
    if (typeof exp === 'string') {
      fs.writeFileSync(path.resolve(exp), exportPlaywrightSpec(steps, { name: meta?.goal ?? path.basename(runDir), goal: meta?.goal }));
      ctx.write(`wrote ${exp}\n`);
      return 0;
    }
    const recipe = flag(argv, '--recipe');
    if (typeof recipe === 'string') {
      const first = steps.find((s) => s.tool === 'browser_open' || s.tool === 'browser_navigate');
      const match = flag(argv, '--match');
      const file = saveRecipe(browserConfig(ctx.config).recipesDir ?? path.join(ctx.config.homeDir, 'recipes'), { name: recipe, match: { url: typeof match === 'string' ? match : String((first?.args as any)?.url ?? '') }, steps });
      ctx.write(`wrote ${file}\n`);
      return 0;
    }
    const heal = !!flag(argv, '--heal');
    const r = await replayRun(runDir, ctx.config, ctx.workspace, heal ? 'heal' : 'strict', (l) => ctx.write(`${l}\n`));
    if (heal && r.healed.length) fs.writeFileSync(path.join(runDir, 'trajectory.healed.jsonl'), r.patched.map((s) => JSON.stringify(s)).join('\n') + '\n');
    ctx.write(`${r.ok ? 'PASS' : 'FAIL'}: ${r.steps} steps replayed${r.failure ? ` · ${r.failure}` : ''}${r.healed.length ? ` · healed ${r.healed.map((h) => `#${h.seq} via ${h.how}`).join(', ')}` : ''}\n`);
    return r.ok ? 0 : 1;
  },
});
