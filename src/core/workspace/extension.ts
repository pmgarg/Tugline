/**
 * The workspace lease for every agent (v1.1 R9): CLI and `tug serve` sessions,
 * VS Code chats and scheduled runs all go through Agent, so one extension
 * covers them. A top-level run takes the workspace lease when it starts and
 * gives it back when it ends, unless the session still has running background
 * jobs, which keep it until the last one exits.
 *
 * - A scheduled run inherits its schedule's lease (`workspaceLease.token`),
 *   so it re-enters instead of conflicting with itself.
 * - Interactive sessions never get blocked by default (`interactive: 'warn'`):
 *   they run, with a notice naming the other writer. `'wait'` waits up to
 *   `waitMs`, then stops the run with a budget-style stop and a message.
 */
import { listJobs } from '../jobs/manager.js';
import { registerAgentExtension, type AgentApi } from '../agent/extensions.js';
import { acquireWorkspaceLease, describeHolder, keepAlive, leaseConfig, newLeaseToken, releaseWorkspaceLease, type WorkspaceLease } from './lease.js';

interface Held {
  token: string;
  reentered: boolean;
  stop: () => void;
  releasing?: boolean;
}

const held = new WeakMap<object, Held>();
const blocked = new WeakMap<object, string>();
const tokens = new WeakMap<object, string>();

function keyOf(a: AgentApi): object {
  return (a.agent as object) ?? a;
}

function release(a: AgentApi, h: Held): void {
  h.stop();
  if (!h.reentered) releaseWorkspaceLease(a.config.homeDir, a.workspace, h.token);
  held.delete(keyOf(a));
}

/** Release once the session's last background job ends (or now, if none is running). */
function releaseWhenIdle(a: AgentApi): void {
  const h = held.get(keyOf(a));
  if (!h || h.releasing) return;
  const running = listJobs(a.sessionId).filter((j) => j.status === 'running');
  if (!running.length) return release(a, h);
  h.releasing = true;
  let left = running.length;
  for (const j of running)
    j.onEnd.push(() => {
      if (--left === 0) release(a, h);
    });
}

registerAgentExtension({
  id: 'ws8-workspace-lease',
  depths: [0],
  async onRunStart(a) {
    const lc = leaseConfig(a.config);
    const key = keyOf(a);
    blocked.delete(key);
    if (!lc.enabled || held.has(key)) return;
    if (lc.interactive === 'off' && !lc.token) return;
    let token = lc.token ?? tokens.get(key);
    if (!token) tokens.set(key, (token = newLeaseToken()));
    const holder = { kind: lc.holderKind ?? 'session', id: a.sessionId, token, sessionId: a.sessionId } as const;
    const wait = lc.interactive === 'wait' && !lc.token ? lc.waitMs : 0;
    const r = await acquireWorkspaceLease(a.config.homeDir, a.workspace, holder, {
      waitMs: wait,
      staleMs: lc.staleMs,
      signal: a.signal,
      onWait: (l: WorkspaceLease) => a.notice('info', `Waiting for the workspace: ${describeHolder(l)} is writing here (workspaceLease.interactive = wait).`),
    });
    if (r.ok) {
      held.set(key, { token, reentered: r.reentered, stop: r.reentered ? () => undefined : keepAlive(a.config.homeDir, a.workspace, token, lc.heartbeatMs) });
      return;
    }
    const who = describeHolder(r.heldBy);
    if (wait) blocked.set(key, `The workspace is still in use by ${who} after waiting ${Math.round(wait / 1000)}s; this run did not start. Try again later, or set workspaceLease.interactive to "warn".`);
    else a.notice('warn', `Another writer holds this workspace: ${who}. Your changes and theirs may collide; check \`tug lease status\`.`);
  },
  beforeTurn(a) {
    const why = blocked.get(keyOf(a));
    if (why) return { stop: 'aborted', message: why };
  },
  onRunEnd(a) {
    releaseWhenIdle(a);
  },
  onSessionEnd(a) {
    const h = held.get(keyOf(a));
    if (h && !h.releasing) release(a, h);
  },
});
