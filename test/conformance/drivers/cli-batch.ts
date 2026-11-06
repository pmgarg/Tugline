/**
 * V0.1 driver (v1.2 N49, review F13/F16): `tug batch run <plan.json>`, spawned as a user would run it. The plan has one
 * item whose prompt is the scenario's prompt; the item runs as a headless session in the workspace (no human: asks
 * are denied and recorded), like `tug -p`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { SurfaceDriver } from '../types.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const TSX = path.join(ROOT, 'node_modules/tsx/dist/esm/index.mjs');
const CLI = path.join(ROOT, 'src/cli/main.ts');

/** Any regular file of the workspace (a batch item needs a source inside it). */
function someFile(dir: string, depth = 0): string | undefined {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && !e.isSymbolicLink()) return p;
  }
  if (depth > 3) return undefined;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink() && e.name !== '.git') {
    const f = someFile(path.join(dir, e.name), depth + 1);
    if (f) return f;
  }
  return undefined;
}

export const driver: SurfaceDriver = {
  id: 'cli-batch',
  label: 'CLI batch (tug batch run)',
  async run(ctx) {
    let src = someFile(ctx.workspace);
    if (!src) {
      src = path.join(ctx.workspace, 'README.md');
      fs.writeFileSync(src, '# workspace\n');
    }
    const plan = path.join(ctx.home, 'conformance-batch-plan.json');
    fs.writeFileSync(plan, JSON.stringify({ prompt: ctx.prompt, items: [{ id: 'scenario', source: path.relative(ctx.workspace, src), target: 'batch-conformance-out.txt' }], parallel: 1 }));
    const child = spawn(process.execPath, ['--import', TSX, CLI, '--no-mcp', 'batch', 'run', plan], { cwd: ctx.workspace, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
    ctx.defer(() => child.exitCode === null && child.kill('SIGKILL'));
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    await new Promise<void>((r) => child.on('close', () => r()));
    return { output: out, prompts: [] };
  },
};
