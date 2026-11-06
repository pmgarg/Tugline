/**
 * `tug serve` (G2) and `tug remote run` (H5), registered through the S0.6 CLI registry.
 *
 *   tug serve [--port N] [--stdio] [--remote] [--allow-local-repos]
 *   tug remote run --server ws://127.0.0.1:7878 [--token T | TUG_SERVER_TOKEN] [--repo URL] [--branch B]
 *                 [--mode acceptEdits] [--yes | --no-apply] [--patch-file f] "<prompt>"
 *
 * `tug serve` prints the token to stderr and writes {url, token, pid} to
 * <homeDir>/server.json (0600) so local clients (the VS Code extension with
 * a server-mode client) can find it; the file is removed on exit.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { registerCliCommand } from '../core/commands.js';
import { bundledDirs } from '../core/agent/agent.js';
import type { PermissionAnswer } from '../core/types.js';
import { TokenStore } from './tokens.js';

function opt(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}
const has = (argv: string[], name: string) => argv.includes(`--${name}`);

function agentDirs(): { bundledSkillsDir?: string; bundledAgentsDir?: string } {
  try {
    const d = bundledDirs(fileURLToPath(import.meta.url));
    return { bundledSkillsDir: d.skills, bundledAgentsDir: d.agents };
  } catch {
    return {};
  }
}

registerCliCommand({
  name: 'serve',
  description: 'run the agent as a local server (JSON-RPC over WebSocket on 127.0.0.1, or --stdio)',
  usage: '[--port N] [--stdio] [--remote] [--allow-local-repos] [--with-daemon] | tokens add <label> | tokens list | tokens revoke <id|label>',
  async run(argv, ctx) {
    const config = ctx.config;
    if (argv[0] === 'tokens') {
      // R16: per-client tokens; each client sees only the sessions it created
      const store = TokenStore.forHome(config.homeDir);
      const [, sub, arg] = argv;
      if (sub === 'add') {
        const t = store.issue(arg ?? '');
        ctx.write(`client token ${t.id} (${t.label}):\n${t.token}\nIt is shown once (stored hashed in ${store.file}). The client sees only the sessions it creates.\n`);
        return 0;
      }
      if (sub === 'list') {
        const all = store.list();
        ctx.write(all.length ? all.map((t) => `${t.id}  ${t.label}  ${t.createdAt}`).join('\n') + '\n' : 'no client tokens\n');
        return 0;
      }
      if (sub === 'revoke' && arg) {
        const ok = store.revoke(arg);
        ctx.write(ok ? `revoked ${arg} (a running server refuses it at the next auth)\n` : `no client token ${arg}\n`);
        return ok ? 0 : 1;
      }
      ctx.write('usage: tug serve tokens add <label> | list | revoke <id|label>\n');
      return 2;
    }
    if (has(argv, 'remote') || has(argv, 'allow-local-repos')) config.server = { ...(config.server ?? {}), remote: { ...(config.server?.remote ?? {}), enabled: true, ...(has(argv, 'allow-local-repos') ? { allowLocalRepos: true } : {}) } };
    const { startServer, serveStdio } = await import('./server.js'); // ws is loaded only when serving
    const base = { workspace: ctx.workspace, config, agentOptions: agentDirs() };
    if (has(argv, 'stdio')) {
      await serveStdio(base);
      return 0;
    }
    const portArg = opt(argv, 'port');
    // --with-daemon: run the scheduler (H1) in this process and serve its /hooks/<id> routes on the server port.
    let daemon: { stop(): Promise<void> } | undefined;
    const httpHandlers: import('./server.js').HttpHandler[] = [];
    if (has(argv, 'with-daemon')) {
      const { Daemon } = await import('../core/schedule/daemon.js');
      const { createHookHandler } = await import('../core/schedule/webhook.js');
      const d = new Daemon({ config, log: (s) => process.stderr.write(`[daemon] ${s}\n`) });
      await d.start({ listen: false });
      httpHandlers.push(createHookHandler({ config, intake: d.intake }));
      daemon = d;
    }
    const srv = await startServer({ ...base, httpHandlers, port: portArg !== undefined ? Number(portArg) : undefined, token: process.env.TUG_SERVER_TOKEN || undefined, log: (s) => process.stderr.write(s + '\n') });
    const info = path.join(config.homeDir, 'server.json');
    fs.mkdirSync(config.homeDir, { recursive: true });
    fs.writeFileSync(info, JSON.stringify({ url: srv.url, token: srv.token, pid: process.pid, workspace: ctx.workspace }, null, 2), { mode: 0o600 });
    process.stderr.write(`token: ${srv.token}\n(clients: TUG_SERVER_TOKEN=<token>; also saved in ${info}, mode 0600)\n${config.server?.remote?.enabled ? 'remote runs: enabled\n' : ''}`);
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    fs.rmSync(info, { force: true });
    await srv.close();
    await daemon?.stop();
    return 0;
  },
});

async function askTty(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

registerCliCommand({
  name: 'remote',
  description: 'run a prompt on a remote tug serve in a server-side clone; apply the returned patch locally',
  usage: 'run --server <ws-url> [--token T] [--repo URL] [--branch B] [--mode M] [--yes|--no-apply] "<prompt>"',
  async run(argv, ctx) {
    const [sub, ...rest] = argv;
    if (sub !== 'run') return void ctx.write('usage: tug remote run --server <ws-url> [--token T] "<prompt>"'), 1;
    const valueFlags = new Set(['server', 'token', 'repo', 'branch', 'mode', 'patch-file']);
    const words: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a.startsWith('--')) {
        if (valueFlags.has(a.slice(2))) i++;
        continue;
      }
      words.push(a);
    }
    const server = opt(rest, 'server');
    const token = opt(rest, 'token') ?? process.env.TUG_SERVER_TOKEN;
    const prompt = words.join(' ').trim();
    if (!server || !token || !prompt) return void ctx.write('tug remote run needs --server, a token (--token or TUG_SERVER_TOKEN) and a prompt'), 1;
    const tty = !!process.stdin.isTTY;
    const { runRemoteClient } = await import('./remote.js');
    try {
      const r = await runRemoteClient({
        server,
        token,
        prompt,
        cwd: ctx.workspace,
        repo: opt(rest, 'repo'),
        branch: opt(rest, 'branch'),
        mode: opt(rest, 'mode'),
        apply: has(rest, 'no-apply') ? 'no' : has(rest, 'yes') ? 'yes' : 'ask',
        patchFile: opt(rest, 'patch-file'),
        confirm: tty ? async (q) => /^y/i.test(await askTty(`${q} [y/N] `)) : undefined,
        handlers: {
          onEvent: (_s, e) => {
            if (e.type === 'tool_start') process.stderr.write(`  ⏺ ${e.title}\n`);
            else if (e.type === 'refusal') process.stderr.write(`  ⛔ refused ${e.tool}: ${e.reason}\n`);
          },
          // Without a terminal nobody can approve: deny (the server records the refusal).
          onPermission: tty
            ? async (_s, req): Promise<PermissionAnswer> => (/^y/i.test(await askTty(`  ⚠ remote agent wants: ${req.title}${req.reason ? ` (${req.reason})` : ''}. Allow? [y/N] `)) ? { decision: 'allow' } : { decision: 'deny' })
            : undefined,
          onAsk: tty ? async (_s, q, o) => askTty(`  ? ${q}${o?.length ? ` (${o.join('/')})` : ''} > `) : undefined,
        },
        log: (s) => process.stderr.write(s + '\n'),
      });
      ctx.write(r.applied ? `applied ${r.result.files.length} file(s)` : `patch not applied: ${r.reason}`);
      return r.applied || r.reason === 'no changes' || r.reason?.startsWith('not applied') ? 0 : 1;
    } catch (e) {
      ctx.write(`remote run failed: ${(e as Error).message}`);
      return 1;
    }
  },
});
