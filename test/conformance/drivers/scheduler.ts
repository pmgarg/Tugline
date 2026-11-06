/**
 * V0.1 driver: the scheduler (H1). The schedule is added and fired through the `tug schedule` command, as a user
 * would (`tug schedule add --cron … --prompt … --mode …` then `tug schedule run-now <id>`): an unattended run, so no
 * human answers and the sandbox is required (markUnattended).
 */
import { getCliCommand } from '../../../src/core/commands.js';
import { loadConfig } from '../../../src/core/config.js';
import '../../../src/core/tools/providers.js';
import type { SurfaceDriver } from '../types.js';

export const driver: SurfaceDriver = {
  id: 'scheduler',
  label: 'Scheduler (tug schedule run-now)',
  async run(ctx) {
    const config = loadConfig({ workspace: ctx.workspace });
    const cmd = getCliCommand('schedule');
    if (!cmd) throw new Error('the schedule command is not registered');
    const out: string[] = [];
    const write = (t: string) => out.push(t);
    const mode = String(ctx.userConfig.permissionMode ?? 'ask');
    const added = await cmd.run(['add', '--cron', '0 3 * * *', '--prompt', ctx.prompt, '--workspace', ctx.workspace, '--mode', mode, '--name', 'conformance'], { config, workspace: ctx.workspace, write });
    const id = out.join('\n').match(/added (\S+)/)?.[1];
    if (added !== 0 && added !== undefined) throw new Error(`schedule add failed: ${out.join('\n')}`);
    if (!id) throw new Error(`no schedule id in: ${out.join('\n')}`);
    out.length = 0;
    await cmd.run(['run-now', id], { config, workspace: ctx.workspace, write });
    const text = out.join('\n');
    const stop = text.match(/^\w+ \((\w+)\)/m)?.[1];
    return { stopReason: stop, output: text, prompts: [] };
  },
};
