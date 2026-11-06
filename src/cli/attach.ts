/**
 * v1.2 N49 (review F13, Qwen `qwen attach`): `tug attach [<session>]` attaches this terminal to a session running in
 * `tug serve`: it streams the session's events, sends what you type as prompts (as a steer while a run is going), and
 * answers the session's approval questions here. Detaching (Ctrl+D) leaves the session running. The server and its
 * token come from `--server`/`--token`, TUG_SERVER_URL/TUG_SERVER_TOKEN, or `<home>/server.json` written by `tug serve`;
 * the server's per-client tokens still decide which sessions this client may see.
 */
import fs from 'node:fs';
import path from 'node:path';
import { OhClient } from '../server/client.js';
import type { AgentEvent, PermissionAnswer, PermissionRequest } from '../core/types.js';
import type { SessionInfo } from '../server/protocol.js';

export interface AttachIo {
  write: (t: string) => void;
  /** lines the user types (ends when the user detaches) */
  lines: AsyncIterable<string>;
  /** a yes/no question to the person at this terminal; undefined = no terminal (approvals are denied) */
  ask?: (q: string) => Promise<boolean>;
}

export function serverFromHome(homeDir: string, env: NodeJS.ProcessEnv = process.env): { url?: string; token?: string } {
  let j: { url?: string; token?: string } = {};
  try {
    j = JSON.parse(fs.readFileSync(path.join(homeDir, 'server.json'), 'utf8'));
  } catch {
    /* no local server */
  }
  return { url: env.TUG_SERVER_URL ?? j.url, token: env.TUG_SERVER_TOKEN ?? j.token };
}

/** Remote text is untrusted: control characters (escape sequences) never reach the terminal. */
export const sanitizeTerminal = (t: string): string => t.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

function eventText(e: AgentEvent): string | undefined {
  switch (e.type) {
    case 'text_delta':
      return e.text;
    case 'tool_start':
      return `\n⏺ ${e.title}\n`;
    case 'refusal':
      return `\n⛔ ${e.tool}: ${e.reason}\n`;
    case 'notice':
      return `\n[${e.level}] ${e.message}\n`;
    case 'run_end':
      return `\n■ ${e.stopReason}\n`;
    default:
      return undefined;
  }
}

export async function attach(o: { url: string; token: string; session?: string; io: AttachIo }): Promise<number> {
  const { io } = o;
  let running = false;
  const client = await OhClient.connect(o.url, o.token, {
    onEvent: (sid, e) => {
      if (sid !== target) return;
      if (e.type === 'run_start') running = true;
      if (e.type === 'run_end') running = false;
      const t = eventText(e);
      if (t) io.write(sanitizeTerminal(t));
    },
    onPermission: async (sid, r: PermissionRequest): Promise<PermissionAnswer> => {
      if (sid !== target || !io.ask) return { decision: 'deny', feedback: 'the attached terminal cannot answer approvals' };
      return (await io.ask(`[${sid}] ${r.title}${r.reason ? ` (${r.reason})` : ''}\n${(r.detail ?? '').split('\n').slice(0, 12).join('\n')}\nAllow?`)) ? { decision: 'allow' } : { decision: 'deny' };
    },
  });
  let target = o.session ?? '';
  try {
    const list = await client.request<{ live: SessionInfo[] }>('session/list', {});
    if (!target) {
      if (list.live.length !== 1) {
        io.write(list.live.length ? `several sessions are running; name one:\n${list.live.map((s) => `  ${s.sessionId}  ${s.workspace}${s.running ? '  (running)' : ''}`).join('\n')}\n` : 'no session is running in this server (start one with `tug serve` clients, or `tug attach <saved-session>` after loading it)\n');
        return 2;
      }
      target = list.live[0]!.sessionId;
    }
    const s = list.live.find((x) => x.sessionId === target);
    if (!s) {
      io.write(`no live session ${target} in this server (tug attach without a name lists them)\n`);
      return 2;
    }
    running = s.running;
    await client.request('session/subscribe', { sessionId: target });
    io.write(`attached to ${target} (${s.workspace}, ${s.model}, mode ${s.mode}); type a message, Ctrl+D to detach\n`);
    const pending: Promise<unknown>[] = [];
    for await (const line of io.lines) {
      const text = line.trim();
      if (!text) continue;
      if (running) await client.steer(target, text);
      else pending.push(client.prompt(target, text).catch((e: Error) => io.write(`\nerror: ${e.message}\n`)));
    }
    await Promise.all(pending);
    await client.request('session/unsubscribe', { sessionId: target }).catch(() => undefined);
    io.write(`\ndetached from ${target} (it keeps running in the server)\n`);
    return 0;
  } finally {
    client.close();
  }
}
