/**
 * V0.1 driver: the Python SDK (sdk/python), talking to `tug serve` the way a Python program would. The server runs
 * in this process with its default config path (loadConfig); the Python client relays approval prompts to ctx.human.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { startServer } from '../../../src/server/server.js';
import { loadConfig } from '../../../src/core/config.js';
import { ROOT } from '../harness.js';
import type { HumanPrompt, SurfaceDriver } from '../types.js';

const hasPython = spawnSync('python3', ['--version']).status === 0;

export const driver: SurfaceDriver = {
  id: 'sdk-python',
  label: 'Python SDK (sdk/python → tug serve)',
  skip: () => (hasPython ? false : 'python3 is not installed'),
  async run(ctx) {
    const config = loadConfig({ workspace: ctx.workspace });
    const srv = await startServer({ workspace: ctx.workspace, config, port: 0 });
    ctx.defer(() => srv.close());
    const py = spawn('python3', ['-I', path.join(ROOT, 'test/conformance/sdk_python_driver.py'), path.join(ROOT, 'sdk/python'), srv.url, ctx.workspace, ctx.prompt], { env: { ...ctx.env, TUG_SERVER_TOKEN: srv.token }, stdio: ['pipe', 'pipe', 'pipe'] });
    ctx.defer(() => py.exitCode === null && py.kill('SIGKILL'));
    const out: string[] = [];
    const prompts: HumanPrompt[] = [];
    let result: any;
    let buf = '';
    let err = '';
    py.stderr.on('data', (d) => (err += d));
    py.stdout.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith('PERMISSION ')) {
          const req = JSON.parse(line.slice(11));
          const p = { tool: req.tool, title: req.title, detail: req.detail, reason: req.reason };
          prompts.push(p);
          void ctx.human(p).then((a) => py.stdin.write(`${a}\n`));
        } else if (line.startsWith('EVENT ')) {
          const e = JSON.parse(line.slice(6));
          if (e.type === 'text_delta') out.push(e.text);
          else if (e.type === 'tool_end') out.push(String(e.output ?? ''));
          else if (e.type === 'notice') out.push(e.message);
        } else if (line.startsWith('RESULT ')) result = JSON.parse(line.slice(7));
        else out.push(line);
      }
    });
    const code = await new Promise<number | null>((r) => py.on('close', r));
    if (code !== 0) throw new Error(`python client exited ${code}: ${err.slice(-500)}`);
    out.push(result?.finalText ?? '', err);
    return { stopReason: result?.stopReason, finalText: result?.finalText, output: out.join('\n'), prompts };
  },
};
