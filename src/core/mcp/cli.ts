/**
 * `tug mcp search|login|logout|list` (SPEC G3).
 * Registered through the S0.6 registries; no CLI edit.
 */
import { registerCliCommand } from '../commands.js';
import { formatRegistryResults, searchRegistry } from './registry.js';
import { mcpLogin, mcpLogout, oauthStoreFile } from './oauth.js';
import fs from 'node:fs';

registerCliCommand({
  name: 'mcp',
  description: 'MCP servers: search the registry, log in (OAuth), list',
  usage: 'search <query> | login <server> | logout <server> | list',
  async run(argv, ctx) {
    const [sub, ...rest] = argv;
    if (sub === 'search') {
      const q = rest.filter((a) => !a.startsWith('--')).join(' ');
      if (!q) return void ctx.write('usage: tug mcp search <query>');
      try {
        ctx.write(formatRegistryResults(await searchRegistry(q)));
      } catch (e) {
        ctx.write(`registry search failed: ${(e as Error).message}`);
        return 1;
      }
      return 0;
    }
    if (sub === 'login') {
      const name = rest[0];
      const s = name ? ctx.config.mcpServers[name] : undefined;
      if (!s) return void ctx.write(`unknown MCP server "${name ?? ''}". Configured: ${Object.keys(ctx.config.mcpServers).join(', ') || '(none)'}`), 1;
      if (!s.url) return void ctx.write(`"${name}" is a stdio server; OAuth applies to remote (url) servers`), 1;
      try {
        const r = await mcpLogin(name, { ...s, oauth: s.oauth ?? true }, { homeDir: ctx.config.homeDir, log: ctx.write });
        ctx.write(`logged in to ${name}; tokens stored in ${r.tokenFile} (mode 0600)${s.oauth ? '' : `\nAdd "oauth": true to the "${name}" server config so sessions use them.`}`);
        return 0;
      } catch (e) {
        ctx.write(`login failed: ${(e as Error).message}`);
        return 1;
      }
    }
    if (sub === 'logout') {
      const name = rest[0] ?? '';
      ctx.write(mcpLogout(name, ctx.config.homeDir) ? `removed stored tokens for ${name}` : `no stored tokens for ${name}`);
      return 0;
    }
    if (sub === 'list' || !sub) {
      const lines = Object.entries(ctx.config.mcpServers).map(([n, s]) => `${n}: ${s.command ? [s.command, ...(s.args ?? [])].join(' ') : s.url}${s.disabled ? ' (disabled)' : ''}${s.trusted ? ' (trusted)' : ''}${s.oauth ? (fs.existsSync(oauthStoreFile(ctx.config.homeDir, n)) ? ' (oauth: logged in)' : ' (oauth: not logged in)') : ''}`);
      ctx.write(lines.join('\n') || '(no MCP servers configured)');
      if (ctx.config.trust?.ignored.some((x) => x.startsWith('.mcp.json'))) ctx.write('(.mcp.json servers are ignored until the workspace is trusted)');
      return 0;
    }
    ctx.write('usage: tug mcp search <query> | login <server> | logout <server> | list');
    return 1;
  },
});
