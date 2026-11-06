/**
 * N3 AC5: in the CLI, a configured language server feeds A6 post-edit
 * verification. `verifyHost(ctx)` returns the context's host, extended with a
 * `diagnostics()` backed by the server when the host has none (DiskHost) and a
 * server handles the file. A6's contract is unchanged: one call without
 * `waitMs` before the write (snapshot), one with it after (fresh publish), and
 * only problems that are new are reported (verify.ts newDiagnostics).
 *
 * If the server cannot start, diagnostics() throws; A6 then treats the host as
 * having none and runs its syntax check, as before.
 */
import fs from 'node:fs';
import type { Diagnostic, WorkspaceHost } from '../host/workspace.js';
import { diskHost } from '../host/workspace.js';
import type { HarnessConfig } from '../config.js';
import { lspConfig, resolvedServers, serverFor } from './config.js';
import { clientFor } from './servers.js';
import { toUri, type LspDiagnostic } from './lsp.js';

export interface VerifyTarget {
  host?: WorkspaceHost;
  config: HarnessConfig;
  workspace: string;
  sessionId?: string;
}

function toDiag(abs: string, d: LspDiagnostic): Diagnostic | undefined {
  const sev = d.severity ?? 1;
  if (sev > 2) return undefined; // information / hint
  return { path: abs, line: d.range.start.line + 1, col: d.range.start.character + 1, severity: sev === 1 ? 'error' : 'warning', message: d.message, source: d.source ?? 'lsp' };
}

/** The host A6 should use for `abs`'s edit. */
export function verifyHost(ctx: VerifyTarget): WorkspaceHost {
  const host: WorkspaceHost = ctx.host ?? diskHost;
  if (host.diagnostics || !lspConfig(ctx.config).diagnostics || !resolvedServers(ctx.config, ctx.workspace).length) return host;
  const target = { config: ctx.config, workspace: ctx.workspace, sessionId: ctx.sessionId ?? 'default' };
  const diagnostics = async (abs?: string, opts?: { waitMs?: number }): Promise<Diagnostic[]> => {
    if (!abs) return [];
    const s = serverFor(ctx.config, abs, ctx.workspace);
    if (!s) throw new Error('no language server for this file');
    const c = await clientFor(target, s);
    // the pre-edit snapshot of a file the server has not seen yet waits for project
    // loading (startTimeoutMs): an incomplete "before" set would make old errors look new
    const firstOpen = !c.isOpen(abs);
    const wait = opts?.waitMs ?? (firstOpen ? lspConfig(ctx.config).startTimeoutMs : Math.min(lspConfig(ctx.config).requestTimeoutMs, 8000));
    let text = '';
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      /* new file: empty */
    }
    const { seq, sent } = c.syncInfo(abs, text);
    const known = c.diagnostics.get(toUri(abs));
    // unchanged and already published: the known set is current
    const items = !sent && known ? known.items : await c.waitDiagnostics(abs, seq, wait, firstOpen ? 800 : 500);
    // nothing published in time (a slow server): use the last known set
    const latest = items ?? c.diagnostics.get(toUri(abs))?.items ?? [];
    return latest.map((d) => toDiag(abs, d)).filter((d): d is Diagnostic => !!d);
  };
  // Only files with a server get LSP diagnostics; others keep A6's syntax check.
  return new Proxy(host, {
    get(t, k, r) {
      if (k === 'diagnostics') return diagnostics;
      return Reflect.get(t, k, r);
    },
  });
}

/** Whether `verifyHost` would use a language server for this file. */
export function lspVerifies(cfg: HarnessConfig, abs: string, workspace?: string): boolean {
  return lspConfig(cfg).diagnostics && !!serverFor(cfg, abs, workspace);
}
