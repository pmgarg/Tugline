/**
 * V0.1 driver: a remote job (H5). The workspace is a git checkout; `runRemoteClient` asks an in-process `tug serve`
 * (remote runs enabled, local repos allowed) to run the prompt in a server-side clone; the patch comes back and is
 * applied to the checkout, so the judge sees its effects. Approval prompts reach the remote client (ctx.human).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../../../src/server/server.js';
import { runRemoteClient } from '../../../src/server/remote.js';
import { loadConfig } from '../../../src/core/config.js';
import type { HumanPrompt, SurfaceDriver } from '../types.js';

export const driver: SurfaceDriver = {
  id: 'remote-job',
  label: 'Remote job (H5: tug serve remote/run)',
  async run(ctx) {
    const genv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const g = (...a: string[]) => execFileSync('git', a, { cwd: ctx.workspace, stdio: 'ignore', env: genv });
    g('init', '-q', '-b', 'main');
    g('add', '-A');
    g('-c', 'user.email=c@c', '-c', 'user.name=c', 'commit', '-qm', 'fixture');
    // the server operator turns remote runs on (user scope)
    const cfgFile = path.join(ctx.ohHome, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ ...ctx.userConfig, server: { remote: { enabled: true, allowLocalRepos: true } } }, null, 2));
    const serverWs = fs.mkdtempSync(path.join(path.dirname(ctx.workspace), 'server-'));
    const config = loadConfig({ workspace: serverWs });
    const srv = await startServer({ workspace: serverWs, config, port: 0 });
    ctx.defer(() => srv.close());
    const out: string[] = [];
    const prompts: HumanPrompt[] = [];
    const r = await runRemoteClient({
      server: srv.url,
      token: srv.token,
      prompt: ctx.prompt,
      cwd: ctx.workspace,
      repo: ctx.workspace,
      mode: String(ctx.userConfig.permissionMode ?? 'ask'),
      apply: 'yes',
      log: (s) => out.push(s),
      handlers: {
        onEvent: (_s, e) => {
          if (e.type === 'text_delta') out.push(e.text);
          else if (e.type === 'tool_end') out.push(String(e.output ?? ''));
        },
        onPermission: async (_s, req) => {
          const p = { tool: req.tool, title: req.title, detail: req.detail, reason: req.reason };
          prompts.push(p);
          return { decision: await ctx.human(p) };
        },
      },
    });
    out.push(r.result.finalText ?? '', r.reason ?? '');
    return { stopReason: r.result.stopReason, finalText: r.result.finalText, output: out.join('\n'), prompts };
  },
};
