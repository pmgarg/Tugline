/**
 * Auto-approve settings (v1.2 N45, Cline's auto-approve categories) as permission-engine configuration.
 *
 * There is no separate allow path (N45 SAC2): each category is translated into the user config the permission
 * engine already reads (`permissionMode`, `permissions.allow` rules, `approver.enabled`), and everything else
 * (deny rules, protected paths, secret files, managed policy, the sandbox, taint / Rule of Two) still decides.
 * The rules this module adds are listed under `ide.autoApprove` so unticking a category removes exactly them.
 *
 * Integration point for N43 (WS23 auto mode v2): the `autoMode` category sets `approver.enabled` (today's C3
 * classifier approver); when N43 lands it maps to the new `auto` mode instead (one line in `apply`).
 * Review F1/F2: no category writes a wildcard rule. "Run read-only commands" sets `permissions.readOnlyCommands`,
 * which the engine answers with N43's read-only fast path (`src/core/approver/readonly.ts`: WS23's reader list and
 * per-program rules; `find -exec/-delete/-fprint`, `git --output`, redirections, expansions and any path outside the
 * workspace are not read-only) AFTER its own secret-file, outside-root, danger and deny checks. "Trusted MCP servers"
 * writes one `mcp__<server>__*` rule per server the user names, never `mcp__*`.
 * Not offered (security): Cline's "read files outside the workspace" category. As a rule (`Read(/**)`) it would
 * also cover ~/.ssh, ~/.aws and other credential stores, which a prompt-injected agent could then read without
 * asking (S5). Reads outside the workspace keep asking; "Always" on one prompt adds a rule for that path only.
 * No `vscode` import: unit-tested with node.
 */
export interface AutoApproveCategory {
  id: string;
  label: string;
  detail: string;
  /** allow rules this category adds */
  rules?: string[];
  /** the permission mode this category needs (the highest selected wins) */
  mode?: 'acceptEdits' | 'auto' | 'yolo';
  /** the classifier approver (C3 today, N43 auto mode) */
  approver?: boolean;
  /** `permissions.readOnlyCommands` (N43's read-only fast path) */
  readOnlyCommands?: boolean;
  /** one `mcp__<server>__*` rule per server the user names (review F2) */
  perServer?: boolean;
}

/** A server name that may appear in a rule (no glob characters). */
export const MCP_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Wildcard rules earlier versions of this module wrote (removed on the next apply; review F1/F2). */
export const LEGACY_RULES = ['Bash(ls*)', 'Bash(pwd)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)', 'Bash(grep *)', 'Bash(rg *)', 'Bash(find *)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'mcp__*'];

export function mcpServerRule(name: string): string {
  if (!MCP_SERVER_NAME.test(name)) throw new Error(`not a valid MCP server name: ${JSON.stringify(name)}`);
  return `mcp__${name}__*`;
}

export const AUTO_APPROVE: AutoApproveCategory[] = [
  { id: 'editWorkspace', label: 'Edit files in the workspace', detail: 'permission mode acceptEdits (protected paths and agent-control files still ask or refuse)', mode: 'acceptEdits' },
  { id: 'safeCommands', label: 'Run read-only commands', detail: 'ls, cat, grep, git status/diff/log … on files inside the workspace (no -exec/-delete, no output files, no redirection; secrets and outside paths still ask)', readOnlyCommands: true },
  { id: 'web', label: 'Fetch web pages and search', detail: 'web_fetch / web_search within the network policy (after untrusted content they ask again)', rules: ['web_fetch', 'web_search'] },
  { id: 'browser', label: 'Use the browser', detail: 'browser_* tools (when the browser is enabled)', rules: ['browser_*'] },
  { id: 'mcp', label: 'Use tools of these MCP servers', detail: 'the tools of the servers you pick (one rule per server; other servers still ask)', perServer: true },
  { id: 'autoMode', label: 'Auto mode with the safety classifier', detail: 'permission mode auto: a classifier settles the remaining asks; its deterministic prefilter cannot be overridden (N43)', approver: true, mode: 'auto' },
  { id: 'allCommands', label: 'Run any command without asking (yolo)', detail: 'permission mode yolo (no classifier): deny rules, protected paths, the sandbox and taint still apply', mode: 'yolo' },
];

/** The categories currently in force, read back from a user config. */
export function readAutoApprove(cfg: any): string[] {
  const ids = cfg?.ide?.autoApprove;
  return Array.isArray(ids) ? ids.filter((x: unknown) => typeof x === 'string' && AUTO_APPROVE.some((c) => c.id === x)) : [];
}

/** The MCP servers whose tools the "mcp" category allows, read back from a user config. */
export function readAutoApproveServers(cfg: any): string[] {
  const s = cfg?.ide?.autoApproveMcpServers;
  return Array.isArray(s) ? s.filter((x: unknown): x is string => typeof x === 'string' && MCP_SERVER_NAME.test(x)) : [];
}

/**
 * A new user config with exactly the selected categories' rules, mode, approver and read-only setting; other user
 * rules untouched. `mcpServers`: the servers the "mcp" category covers (default: the ones it covered before).
 */
export function applyAutoApprove(cfg: any, selected: string[], opts: { mcpServers?: string[] } = {}): any {
  const next = JSON.parse(JSON.stringify(cfg ?? {}));
  const prev = AUTO_APPROVE.filter((c) => readAutoApprove(cfg).includes(c.id));
  const sel = AUTO_APPROVE.filter((c) => selected.includes(c.id));
  const prevServers = prev.some((c) => c.perServer) ? readAutoApproveServers(cfg) : [];
  const servers = sel.some((c) => c.perServer) ? (opts.mcpServers ?? readAutoApproveServers(cfg)).map((n) => (mcpServerRule(n), n)) : [];
  // rules this module wrote before (including the wildcard rules of earlier versions, which are removed)
  const ours = new Set([...prev.flatMap((c) => c.rules ?? []), ...prevServers.map(mcpServerRule), ...LEGACY_RULES]);
  const allow: string[] = (next.permissions?.allow ?? []).filter((r: string) => !ours.has(r));
  for (const r of [...sel.flatMap((c) => c.rules ?? []), ...servers.map(mcpServerRule)]) if (!allow.includes(r)) allow.push(r);
  next.permissions = { ...(next.permissions ?? {}), allow };
  if (sel.some((c) => c.readOnlyCommands)) next.permissions.readOnlyCommands = true;
  else delete next.permissions.readOnlyCommands;
  // N43: yolo is the loosest; auto (classifier) before acceptEdits (it runs safe edits too)
  const mode = sel.some((c) => c.mode === 'yolo') ? 'yolo' : sel.some((c) => c.mode === 'auto') ? 'auto' : sel.some((c) => c.mode === 'acceptEdits') ? 'acceptEdits' : prev.some((c) => c.mode) ? 'ask' : next.permissionMode;
  if (mode) next.permissionMode = mode;
  if (sel.some((c) => c.approver)) next.approver = { ...(next.approver ?? {}), enabled: true };
  else if (prev.some((c) => c.approver) && next.approver) next.approver.enabled = false;
  next.ide = { ...(next.ide ?? {}), autoApprove: sel.map((c) => c.id) };
  if (servers.length) next.ide.autoApproveMcpServers = servers;
  else delete next.ide.autoApproveMcpServers;
  return next;
}
