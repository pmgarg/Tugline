/**
 * `/lsp` (every chat surface) and `tug lsp` (v1.2 N46; Qwen Code has `/lsp` status): which language servers are
 * configured, from where, running or not (pid, restarts, open documents, why one failed or was refused), what
 * auto-detection would enable, and restarting a server.
 */
import type { HarnessConfig } from '../config.js';
import { registerCliCommand, registerSlashCommand } from '../commands.js';
import { listFiles } from '../context/index/files.js';
import { detectServers, lspConfig, LSP_PRESETS } from './config.js';
import { restartServers, serverStatus, whichBin } from './servers.js';

export function lspStatusText(cfg: HarnessConfig, workspace: string, sessionId: string): string {
  const st = serverStatus(cfg, workspace, sessionId);
  const l = lspConfig(cfg);
  const head = `language servers (lsp.enabled ${JSON.stringify(l.enabled)}, autoDetect ${l.autoDetect}, diagnostics after edits ${l.diagnostics}):`;
  if (!st.length) return `${head}\n  none configured. Add "lsp": {"servers": {"typescript": true}} to ~/.tugline/config.json, or "autoDetect": true (see tug lsp detect).`;
  return [head, ...st.map((s) => `  ${s.name} [${s.source}] ${s.state}${s.pid ? ` pid ${s.pid}` : ''}${s.restarts ? ` · ${s.restarts} restart(s)` : ''}${s.open ? ` · ${s.open} open doc(s)` : ''}\n    ${s.command}${s.error ? `\n    ${s.error}` : ''}`)].join('\n');
}

export function lspDetectText(workspace: string): string {
  const rows = detectServers(workspace, (ext) => listFiles(workspace, { extensions: new Set(ext), max: 1 }).length > 0, (b) => whichBin(b));
  return [
    'auto-detection (lsp.autoDetect) would enable:',
    ...rows.map((r) => `  ${r.name.padEnd(11)} ${r.present ? 'language present' : 'no files      '}  ${r.binary ? `binary ${r.binary}` : `not installed (${LSP_PRESETS[r.name].install})`}${r.present && r.binary ? '  → enabled' : ''}`),
  ].join('\n');
}

registerSlashCommand({
  name: 'lsp',
  description: 'language servers: status, what auto-detection finds, restart',
  usage: '[status|detect|restart [name]]',
  async run(args, ctx) {
    const [sub = 'status', name] = args.trim().split(/\s+/);
    const sid = ctx.agent?.sessionId ?? 'default';
    if (sub === 'detect') return void ctx.write(lspDetectText(ctx.workspace));
    if (sub === 'restart') {
      const r = await restartServers(sid, ctx.workspace, name);
      return void ctx.write(r.length ? `stopped ${r.join(', ')}; the next request starts ${r.length > 1 ? 'them' : 'it'} again` : 'no running server to restart');
    }
    ctx.write(lspStatusText(ctx.config, ctx.workspace, sid));
  },
});

registerCliCommand({
  name: 'lsp',
  description: 'language servers: configured servers and their source, what auto-detection would enable',
  usage: '[status|detect]',
  run(argv, ctx) {
    ctx.write(argv[0] === 'detect' ? lspDetectText(ctx.workspace) : lspStatusText(ctx.config, ctx.workspace, 'cli'));
    return 0;
  },
});
