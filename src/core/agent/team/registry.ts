/**
 * v1.2 WS17: tools get a ToolContext, not the agent. Team and workflow tools need the agent that calls
 * them (to start children narrowed to it), so a global extension records session id → agent when a run
 * starts. Weak references: a disposed agent is never kept alive by this map.
 */
import { registerAgentExtension } from '../extensions.js';
import type { Agent } from '../agent.js';

const bySession = new Map<string, WeakRef<Agent>>();

export function agentForSession(sessionId: string): Agent | undefined {
  return bySession.get(sessionId)?.deref();
}

export function rememberAgent(a: Agent): void {
  for (const [k, v] of bySession) if (!v.deref()) bySession.delete(k);
  bySession.set(a.sessionId, new WeakRef(a));
}

registerAgentExtension({
  id: 'ws17-agent-registry',
  onSessionStart: (api) => rememberAgent(api.agent as Agent),
  onRunStart: (api) => rememberAgent(api.agent as Agent),
});
