/**
 * `tug record-skill` (SPEC v1.1 N32): teach the agent a workflow by doing it once.
 *
 *   tug record-skill <name> --url <start>   open a browser, record what you do, press Enter when done
 *       [--profile persistent:<p>|isolated] (default persistent:demo: logins you make there persist)
 *       [--user]          save to ~/.tugline/skills (default: <workspace>/.tugline/skills)
 *       [--no-verify]     skip the strict replay check
 *       [--yes]           save without the review prompt (CI)
 *   tug record-skill <name> --from <runDir>  generalise an existing browser or desktop recording
 *
 * Passwords, one-time codes and card fields are masked at capture and become
 * secret:// refs; other typed text becomes a parameter whose value is never saved.
 */
import path from 'node:path';
import readline from 'node:readline/promises';
import { registerCliCommand } from '../../commands.js';
import { browserConfig } from '../browser/config.js';
import { readTrajectory } from './trajectory.js';
import { generalise, recordSkill, renderReview, saveDraft, verifyDraft, type SkillDraft } from './demo.js';

function opt(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

async function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}

registerCliCommand({
  name: 'record-skill',
  description: 'record a browser workflow you demonstrate (or generalise a recording) into an editable SKILL.md plus a no-model recipe',
  usage: '<name> --url <start> [--profile p] [--user] [--no-verify] [--yes] | <name> --from <runDir>',
  needsModel: false,
  async run(argv, ctx) {
    const name = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--url' && argv[argv.indexOf(a) - 1] !== '--from' && argv[argv.indexOf(a) - 1] !== '--profile');
    const url = opt(argv, '--url');
    const from = opt(argv, '--from');
    if (!name || (!url && !from)) {
      ctx.write('usage: tug record-skill <name> --url <start> [--profile p] [--user] [--no-verify] [--yes] | <name> --from <runDir>\n');
      return 2;
    }
    const yes = argv.includes('--yes');
    const review = async (text: string): Promise<boolean> => {
      ctx.write(`\n${text}\n\nNothing has been saved yet. Typed values are not stored; secrets are refs only.\n`);
      if (yes) return true;
      return /^y(es)?$/i.test((await prompt('Save this skill? [y/N] ')).trim());
    };
    const bc = browserConfig(ctx.config);
    const dirs = {
      skillsDir: argv.includes('--user') ? path.join(ctx.config.homeDir, 'skills') : path.join(ctx.workspace, '.tugline', 'skills'),
      recipesDir: bc.recipesDir ?? path.join(ctx.config.homeDir, 'recipes'),
      runsDir: path.join(ctx.workspace, '.tugline', 'runs'),
    };
    const report = (d: SkillDraft, saved?: { skillFile: string; recipeFile?: string; trajectoryDir: string }) => {
      if (!saved) {
        ctx.write('not saved\n');
        return 1;
      }
      ctx.write(`wrote ${saved.skillFile}\n${saved.recipeFile ? `wrote ${saved.recipeFile}\n` : ''}trajectory ${saved.trajectoryDir}\n`);
      for (const s of d.secrets) ctx.write(`store the secret once: /browser secret ${s.slice('secret://'.length)}\n`);
      return 0;
    };
    if (from) {
      const { meta, steps } = readTrajectory(path.resolve(ctx.workspace, from));
      if (!steps.length) {
        ctx.write(`no trajectory in ${from}\n`);
        return 1;
      }
      const d = generalise(name, steps, { surface: meta?.surface });
      const v = argv.includes('--no-verify') ? undefined : await verifyDraft(d, ctx.config, ctx.workspace).catch((e) => ({ skipped: (e as Error).message }));
      if (!(await review(renderReview(d, v)))) return report(d);
      return report(d, saveDraft(d, dirs));
    }
    const r = await recordSkill({
      name,
      url: url!,
      config: ctx.config,
      workspace: ctx.workspace,
      profile: opt(argv, '--profile'),
      userScope: argv.includes('--user'),
      verify: !argv.includes('--no-verify'),
      demonstrate: async () => {
        ctx.write(`Recording in the browser window. Do the task once, then come back here.\n`);
        await prompt('Press Enter when you are done… ');
      },
      review,
    });
    return report(r.draft, r.saved);
  },
});
