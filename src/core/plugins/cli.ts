/**
 * `tug plugin …` (SPEC G4), registered through the S0.6 CLI registry.
 *
 *   tug plugin install <path|git-url|marketplace:name|name@marketplace> [--trust] [--ref <branch>]
 *   tug plugin list | info <name> | remove <name> | enable <name> | disable <name>
 *   tug plugin trust <name> [--yes] | untrust <name>
 *   tug plugin marketplace add <path|git-url|https://…/marketplace.json> | list | remove <name>
 */
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { registerCliCommand, registerSlashCommand } from '../commands.js';
import { addMarketplace, describeCode, describePlugin, installPlugin, isTrusted, readMarketplaceIndex, readState, removePlugin, setEnabled, trustPlugin, untrustPlugin, writeState } from './store.js';
import { readManifest, runsCode } from './manifest.js';
import { pluginDir } from './store.js';

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
function opt(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function positional(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref') i++;
    else if (!argv[i].startsWith('--')) out.push(argv[i]);
  }
  return out;
}

export function listPlugins(homeDir: string): string {
  const s = readState(homeDir);
  const rows = Object.values(s.plugins).map((p) => {
    let code = '';
    try {
      const m = readManifest(pluginDir(homeDir, p.name));
      code = runsCode(m) ? ` · ${describeCode(m)} · ${isTrusted(homeDir, p) ? 'trusted' : 'NOT trusted (code does not run)'}` : '';
    } catch (e) {
      code = ` · broken: ${(e as Error).message}`;
    }
    return `${p.name}${p.version ? ` ${p.version}` : ''} [${p.enabled ? 'enabled' : 'disabled'}] from ${p.source}${code}`;
  });
  return rows.join('\n') || '(no plugins installed)';
}

registerCliCommand({
  name: 'plugin',
  description: 'install and manage plugins (skills, agents, commands, hooks, MCP servers)',
  usage: 'install <src> [--trust] [--ref <branch>] | list | info|remove|enable|disable|trust|untrust <name> | marketplace add|list|remove',
  async run(argv, ctx) {
    const home = ctx.config.homeDir;
    const [sub, ...rest] = argv;
    const pos = positional(rest);
    try {
      switch (sub) {
        case 'install': {
          if (!pos[0]) return void ctx.write('usage: tug plugin install <path|git-url|marketplace:name> [--trust]'), 1;
          const r = await installPlugin(home, pos[0], { trust: flag(rest, 'trust'), ref: opt(rest, 'ref') });
          const m = r.manifest;
          ctx.write(`installed ${m.name}${m.version ? ` ${m.version}` : ''} (${m.format} layout): ${m.skillDirs.length ? 'skills ' : ''}${m.agentDirs.length ? 'agents ' : ''}${m.commandDirs.length ? 'commands ' : ''}${runsCode(m) ? describeCode(m) : ''}`.trim());
          if (r.trusted) ctx.write(`trusted (local path, --trust): its ${describeCode(m)} will run`);
          for (const n of r.notes) ctx.write(n);
          return 0;
        }
        case 'list':
        case undefined:
          ctx.write(listPlugins(home));
          return 0;
        case 'info':
          ctx.write(describePlugin(home, pos[0] ?? ''));
          return 0;
        case 'remove':
        case 'uninstall':
          ctx.write(removePlugin(home, pos[0] ?? '') ? `removed ${pos[0]}` : `plugin "${pos[0] ?? ''}" is not installed`);
          return 0;
        case 'enable':
        case 'disable':
          setEnabled(home, pos[0] ?? '', sub === 'enable');
          ctx.write(`${sub}d ${pos[0]}`);
          return 0;
        case 'trust': {
          const name = pos[0] ?? '';
          ctx.write(describePlugin(home, name));
          let yes = flag(rest, 'yes');
          if (!yes && process.stdin.isTTY) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
            yes = /^y/i.test((await rl.question('Trust this plugin? Its hooks and MCP servers will run as you. [y/N] ')).trim());
            rl.close();
          }
          if (!yes) return void ctx.write('not trusted (re-run with --yes after reviewing the list above)'), 1;
          trustPlugin(home, name);
          ctx.write(`trusted ${name}; if it changes, it must be trusted again`);
          return 0;
        }
        case 'untrust':
          untrustPlugin(home, pos[0] ?? '');
          ctx.write(`${pos[0]} is no longer trusted; its hooks and MCP servers will not run`);
          return 0;
        case 'marketplace': {
          const [msub, src] = pos;
          if (msub === 'add' && src) {
            const m = await addMarketplace(home, src);
            ctx.write(`added marketplace ${m.name} (${readMarketplaceIndex(m.dir).plugins.length} plugins)`);
            return 0;
          }
          if (msub === 'remove' && src) {
            const s = readState(home);
            const m = s.marketplaces[src];
            if (m) fs.rmSync(m.dir, { recursive: true, force: true });
            delete s.marketplaces[src];
            writeState(home, s);
            ctx.write(m ? `removed marketplace ${src}` : `no marketplace ${src}`);
            return 0;
          }
          const s = readState(home);
          const lines: string[] = [];
          for (const m of Object.values(s.marketplaces)) {
            lines.push(`${m.name} (${m.source})`);
            try {
              for (const p of readMarketplaceIndex(m.dir).plugins) lines.push(`  ${p.name}${p.version ? ` ${p.version}` : ''}${p.description ? ` — ${String(p.description).slice(0, 100)}` : ''}`);
            } catch (e) {
              lines.push(`  (unreadable: ${(e as Error).message})`);
            }
          }
          ctx.write(lines.join('\n') || '(no marketplaces; tug plugin marketplace add <path|url>)');
          return 0;
        }
        default:
          ctx.write('usage: tug plugin install|list|info|remove|enable|disable|trust|untrust|marketplace');
          return 1;
      }
    } catch (e) {
      ctx.write(`plugin ${sub}: ${(e as Error).message}`);
      return 1;
    }
  },
});

registerSlashCommand({
  name: 'plugins',
  description: 'list installed plugins and their trust state',
  run(_args, ctx) {
    ctx.write(
      listPlugins(ctx.config.homeDir)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  },
});
