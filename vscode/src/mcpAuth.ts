/**
 * MCP OAuth login from the manager view (B11, using G3's core flow). Pure: the
 * browser opener is injected (the extension passes `vscode.env.openExternal`),
 * so it is unit-tested against a mock OAuth server.
 */
import type { McpServerConfig } from '../../src/core/config.js';
import { mcpLogin, mcpLogout } from '../../src/core/mcp/oauth.js';
import { updateConfig } from './configEdit.js';

export interface McpLoginDeps {
  homeDir: string;
  /** the user config file (oauth: true is added there for user-level servers) */
  userFile: string;
  openUrl(url: URL): Promise<void> | void;
  log?(s: string): void;
  timeoutMs?: number;
}

export interface McpLoginResult {
  tokenFile: string;
  /** "oauth": true was written to the user config so sessions use the tokens */
  enabledOAuth: boolean;
  message: string;
}

/** Run the browser login for a remote server; tokens land in <homeDir>/mcp-oauth (0600). */
export async function loginMcpServer(name: string, servers: Record<string, McpServerConfig>, source: 'user' | 'project' | undefined, d: McpLoginDeps): Promise<McpLoginResult> {
  const s = servers[name];
  if (!s) throw new Error(`unknown MCP server "${name}"`);
  if (!s.url) throw new Error(`"${name}" is a stdio server; OAuth applies to remote (url) servers`);
  const r = await mcpLogin(name, { ...s, oauth: s.oauth ?? true }, { homeDir: d.homeDir, openUrl: d.openUrl, log: d.log, timeoutMs: d.timeoutMs });
  let enabledOAuth = false;
  if (!s.oauth && source === 'user') {
    updateConfig(d.userFile, (c) => {
      if (c.mcpServers?.[name]) {
        c.mcpServers[name] = { ...c.mcpServers[name], oauth: true };
        enabledOAuth = true;
      }
    });
  }
  const hint = s.oauth || enabledOAuth ? '' : ` Add "oauth": true to the "${name}" server config so sessions use the tokens.`;
  return { tokenFile: r.tokenFile, enabledOAuth, message: `Logged in to ${name}; tokens stored in ${r.tokenFile} (mode 0600).${hint}` };
}

export function logoutMcpServer(name: string, homeDir: string): string {
  return mcpLogout(name, homeDir) ? `Removed the stored tokens for ${name}.` : `No stored tokens for ${name}.`;
}
