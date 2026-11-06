/** V0.1 driver: `tug -p "<prompt>"` (CLI headless), spawned as a user would run it. No human: asks are denied and recorded. */
import { spawn } from 'node:child_process';
import { CLI, TSX } from '../harness.js';
import type { SurfaceDriver } from '../types.js';

export const driver: SurfaceDriver = {
  id: 'cli-headless',
  label: 'CLI headless (tug -p)',
  async run(ctx) {
    const child = spawn(process.execPath, ['--import', TSX, CLI, '-p', ctx.prompt, '--no-mcp'], { cwd: ctx.workspace, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
    ctx.defer(() => child.exitCode === null && child.kill('SIGKILL'));
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    await new Promise<void>((r) => child.on('close', () => r()));
    return { output: out, prompts: [] };
  },
};
