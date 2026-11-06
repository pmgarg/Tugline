/**
 * WS12 registrations: `tug wiki`, `tug docs`, `tug ask`, `tug changelog`, the
 * `/doc` and `/wiki` slash commands and the `ask_codebase` tool. Imported once
 * from src/core/tools/providers.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerCliCommand } from '../commands.js';
import { registerAgentExtension } from '../agent/extensions.js';
import type { PermissionPolicy } from '../permissions/policy.js';
import { parseFlags } from '../schedule/cli.js';
import { buildWiki, wikiCitations, wikiDir } from './wiki.js';
import { serveWiki } from './render.js';
import { judgeReport, judgeWiki } from './judge.js';
import { buildInventory } from './inventory.js';
import { docsCheck, formatFindings } from './check.js';
import { runDocsSyncCli } from './sync.js';
import { ask, formatAsk } from './ask.js';
import { docsConfig } from './config.js';
import { docsModel } from './llm.js';
import { registerSlashCommand } from '../commands.js';
import { registerToolProvider } from '../tools/registry.js';
import type { ToolDef } from '../tools/types.js';
import { buildChangelog, coverage, formatChangelog } from './changelog.js';
import { generateDocs, onlyDocsChanged, parseDocArgs, type DocEdit } from './docstring.js';
import { langOf } from './inventory.js';
import type { HarnessConfig } from '../config.js';
import type { LLMClient } from '../llm/client.js';

registerCliCommand({
  name: 'wiki',
  description: 'generate a cited codebase wiki with the configured (local) model: build | update | serve | check',
  usage: 'build [--force] [--out dir] | update | serve [--port 8765] [--mermaid <script-url>] | check | judge [--judge profile] [--min 4] [--pages N] [--report f.md]',
  needsModel: true,
  async run(argv, ctx) {
    const f = parseFlags(argv, ['force', 'build']);
    const sub = f._[0] ?? 'build';
    const out = typeof f.out === 'string' ? f.out : undefined;
    if (sub === 'build' || sub === 'update') {
      const r = await buildWiki({ config: ctx.config, workspace: ctx.workspace, force: sub === 'build' && !!f.force, outDir: out, log: (m) => process.stderr.write(`  ${m}\n`) });
      ctx.write(`${r.written.length ? `wrote ${r.written.length} file(s): ${r.written.join(', ')}` : 'wiki is up to date'}\n${r.pages.length} pages in ${path.relative(ctx.workspace, r.outDir) || r.outDir} · citations: ${r.stats.valid} valid, ${r.stats.repaired} repaired, ${r.stats.dropped} dropped (${r.stats.droppedClaims} unsupported statements removed) · ${r.mermaidRemoved} invalid diagram(s) removed · ${r.modelCalls} model call(s)`);
      return 0;
    }
    const dir = wikiDir(ctx.config, ctx.workspace, out);
    if (sub === 'serve') {
      if (f.build || !fs.existsSync(path.join(dir, 'index.md'))) await buildWiki({ config: ctx.config, workspace: ctx.workspace, outDir: out, log: (m) => process.stderr.write(`  ${m}\n`) });
      const s = await serveWiki(ctx.workspace, dir, { port: typeof f.port === 'string' ? Number(f.port) : 8765, mermaidScript: typeof f.mermaid === 'string' ? f.mermaid : undefined });
      ctx.write(`wiki at ${s.url} (127.0.0.1 only; Ctrl+C to stop)`);
      await new Promise<void>((resolve) => process.once('SIGINT', () => void s.close().then(resolve)));
      return 0;
    }
    if (sub === 'judge') {
      const j = await judgeWiki({ config: ctx.config, workspace: ctx.workspace, outDir: out, judge: typeof f.judge === 'string' ? f.judge : undefined, min: typeof f.min === 'string' ? Number(f.min) : undefined, pages: typeof f.pages === 'string' ? Number(f.pages) : undefined });
      const rep = judgeReport(j);
      if (typeof f.report === 'string') fs.writeFileSync(path.resolve(ctx.workspace, f.report), rep + '\n');
      ctx.write(rep);
      return j.pass ? 0 : 1;
    }
    if (sub === 'check') {
      const inv = buildInventory(ctx.workspace);
      const bad = wikiCitations(dir).filter((c) => {
        const file = inv.byRel.get(c.path);
        return !file || c.start < 1 || c.end > file.lines || c.start > c.end;
      });
      for (const b of bad) ctx.write(`${b.page}: ${b.path}:${b.start}-${b.end} does not resolve`);
      ctx.write(bad.length ? `${bad.length} stale citation(s): run tug wiki update` : 'all wiki citations resolve');
      return bad.length ? 1 : 0;
    }
    ctx.write('usage: tug wiki build|update|serve|check|judge');
    return 2;
  },
});

registerCliCommand({
  name: 'docs',
  description: 'docs-as-code: check (links, stale code refs, CLI flags, snippets; exit 1 on problems) | sync (doc-sync agent for a git range)',
  usage: 'check [--format text|github|json] [--cli "<help argv>"] [files…] | sync [--range base..head] [--patch out.patch | --pr] [--dry-run]',
  needsModel: false,
  async run(argv, ctx) {
    const f = parseFlags(argv, ['pr', 'dry-run']);
    const sub = f._[0];
    if (sub === 'check') {
      const format = typeof f.format === 'string' ? f.format : 'text';
      if (!['text', 'github', 'json'].includes(format)) {
        ctx.write('--format must be text, github or json');
        return 2;
      }
      const r = await docsCheck({ config: ctx.config, workspace: ctx.workspace, files: f._.length > 1 ? f._.slice(1) : undefined, cli: typeof f.cli === 'string' ? f.cli.split(/\s+/).filter(Boolean) : undefined });
      ctx.write(formatFindings(r, format as 'text' | 'github' | 'json'));
      return r.findings.length ? 1 : 0;
    }
    if (sub === 'sync') return runDocsSyncCli(f, ctx);
    ctx.write('usage: tug docs check | tug docs sync');
    return 2;
  },
});

/** `permissions.writeOnly` in config → the policy (agent.ts builds the policy from the v0.1 keys only). */
registerAgentExtension({
  id: 'ws12-write-only',
  onRunStart(a) {
    const w = (a.config.permissions as { writeOnly?: unknown }).writeOnly;
    const pol = (a.agent as { policy?: PermissionPolicy }).policy;
    if (pol && Array.isArray(w) && w.length && w.every((x) => typeof x === 'string')) pol.opts.writeOnly = w as string[];
  },
});

registerCliCommand({
  name: 'ask',
  description: 'answer a question about this repository from its code, docs and wiki, with validated citations (or "not found")',
  usage: '"<question>" [--json] [--k 8]',
  needsModel: true,
  async run(argv, ctx) {
    const f = parseFlags(argv, ['json']);
    const question = f._.join(' ').trim();
    if (!question) {
      ctx.write('usage: tug ask "<question>"');
      return 2;
    }
    const r = await ask({ config: ctx.config, workspace: ctx.workspace, question, k: typeof f.k === 'string' ? Number(f.k) : undefined });
    ctx.write(f.json ? JSON.stringify({ found: r.found, answer: r.answer, citations: r.citations, reason: r.reason, dropped: r.dropped }, null, 2) : formatAsk(r));
    return r.found ? 0 : 3;
  },
});

registerSlashCommand({
  name: 'ask',
  description: 'answer from the code, docs and wiki with validated citations (no guessing)',
  usage: '/ask <question>',
  async run(args, ctx) {
    if (!args.trim()) return void ctx.write('usage: /ask <question>');
    const r = await ask({ config: ctx.config, workspace: ctx.workspace, question: args.trim(), model: ctx.agent?.llm ? await docsModel(ctx.config, { client: ctx.agent.llm }) : undefined });
    ctx.write(formatAsk(r));
  },
});

const askTool: ToolDef<{ question: string }> = {
  name: 'ask_codebase',
  description: 'Answer a question about this repository from its code, docs and generated wiki. Returns an answer whose every sentence cites file:line ranges that were checked to exist, or "Not found" when the repository does not answer it. Use it for "where/how is X done" questions before reading many files.',
  parameters: { type: 'object', properties: { question: { type: 'string', description: 'the question, in natural language' } }, required: ['question'] },
  kind: 'read',
  readOnly: true,
  title: (a) => `Ask the codebase: ${String(a.question ?? '').slice(0, 80)}`,
  async run(a, ctx) {
    const canRead = (abs: string) => ctx.policy.check({ tool: 'read_file', kind: 'read', paths: [{ path: abs, write: false }] }).decision === 'allow';
    const r = await ask({ config: ctx.config, workspace: ctx.workspace, question: String(a.question ?? ''), canRead, model: await docsModel(ctx.config, { client: ctx.smallLlm ?? ctx.llm }) });
    return { output: formatAsk(r), meta: { found: r.found, citations: r.citations } };
  },
};

registerToolProvider({ id: 'ws12-ask', tools: (cfg) => (docsConfig(cfg).ask.tool ? [askTool] : []) });

registerCliCommand({
  name: 'changelog',
  description: 'release notes from git history: Keep-a-Changelog or GitHub sections, breaking changes from the diff, every bullet linked to its commits, a coverage list of commits left out',
  usage: '--since <tag> [--until HEAD] [--format keepachangelog|github] [--version X] [--summarize] [--repo-url https://…] [--out CHANGELOG.md]',
  needsModel: false,
  async run(argv, ctx) {
    const f = parseFlags(argv, ['summarize']);
    if (typeof f.since !== 'string') {
      ctx.write('usage: tug changelog --since <tag>');
      return 2;
    }
    const format = f.format === 'github' ? 'github' : 'keepachangelog';
    const c = await buildChangelog({ config: ctx.config, workspace: ctx.workspace, since: f.since, until: typeof f.until === 'string' ? f.until : undefined, summarize: !!f.summarize, repoUrl: typeof f['repo-url'] === 'string' ? f['repo-url'] : undefined });
    const text = formatChangelog(c, format, typeof f.version === 'string' ? f.version : 'Unreleased');
    const miss = coverage(c).missing;
    if (typeof f.out === 'string') {
      const file = path.resolve(ctx.workspace, f.out);
      const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Changelog\n\nAll notable changes to this project are documented here (format: Keep a Changelog).\n';
      const at = prev.search(/^## /m);
      fs.writeFileSync(file, at >= 0 ? `${prev.slice(0, at)}${text}\n\n${prev.slice(at)}` : `${prev.replace(/\s*$/, '')}\n\n${text}\n`);
      ctx.write(`wrote ${f.out}`);
    } else ctx.write(text);
    if (miss.length) ctx.write(`coverage: ${miss.length} commit(s) neither in a bullet nor listed: ${miss.map((m) => m.short).join(', ')}`);
    return miss.length ? 1 : 0;
  },
});

/** `/doc` and `tug doc`: shared body. `approve` decides about the edit (permission engine first). */
async function docCommand(args: string, o: { config: HarnessConfig; workspace: string; write: (t: string) => void; client?: LLMClient; policy?: PermissionPolicy; host?: { readText(abs: string): Promise<{ text: string } | undefined>; writeText(abs: string, text: string, opts?: { label?: string }): Promise<unknown> }; approve: (question: string) => Promise<boolean>; dryRun?: boolean }): Promise<DocEdit | undefined> {
  const sel = parseDocArgs(args, o.workspace);
  if (!sel) {
    o.write('usage: /doc <file>[:<line>|#<symbol>] [--all]');
    return undefined;
  }
  const abs = path.join(o.workspace, sel.rel);
  const text = o.host ? (await o.host.readText(abs))?.text : fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
  if (text === undefined) {
    o.write(`${sel.rel}: not found`);
    return undefined;
  }
  const lang = langOf(sel.rel);
  if (!lang) {
    o.write(`${sel.rel}: unsupported language`);
    return undefined;
  }
  const decision = o.policy?.check({ tool: 'doc', kind: 'edit', paths: [{ path: abs, write: true }] });
  if (decision?.decision === 'deny') {
    o.write(`refused: ${decision.reason}`);
    return undefined;
  }
  const edit = await generateDocs(await docsModel(o.config, { client: o.client }), sel.rel, text, sel);
  if ('error' in edit) {
    o.write(edit.error);
    return undefined;
  }
  if (!onlyDocsChanged(lang, edit)) {
    o.write('refused: the generated edit would change more than docstrings and comments');
    return undefined;
  }
  const preview = edit.after.split(/\r?\n/).filter((_, i) => edit.blocks.some(([a, b]) => i >= a && i < b)).map((l) => `+ ${l}`).join('\n');
  if (o.dryRun) {
    o.write(`${sel.rel}: docstrings for ${edit.symbols.join(', ')} (dry run)\n${preview}`);
    return edit;
  }
  if (decision?.decision === 'ask' && !(await o.approve(`Add docstrings for ${edit.symbols.join(', ')} to ${sel.rel}?\n${preview}`))) {
    o.write('cancelled');
    return undefined;
  }
  if (o.host) await o.host.writeText(abs, edit.after, { label: '/doc' });
  else fs.writeFileSync(abs, edit.after);
  o.write(`${sel.rel}: added/refreshed docstrings for ${edit.symbols.join(', ')}\n${preview}`);
  return edit;
}

registerSlashCommand({
  name: 'doc',
  description: 'add or refresh docstrings in the native style (only comments/docstrings change; reviewable edit)',
  usage: '/doc <file>[:<line>|#<symbol>] [--all] [--dry-run]',
  async run(args, ctx) {
    const a = ctx.agent;
    await docCommand(args.replace(/\s--dry-run\b/, ''), {
      config: ctx.config,
      workspace: ctx.workspace,
      write: ctx.write,
      client: a?.llm,
      policy: a?.policy,
      host: a?.host,
      dryRun: /\s--dry-run\b/.test(` ${args}`),
      approve: async (q) => (ctx.ask ? /^(apply|yes|y)/i.test(await ctx.ask(q, ['Apply', 'Cancel'])) : false),
    });
  },
});

registerCliCommand({
  name: 'doc',
  description: 'add or refresh docstrings for a file, a line or a symbol (only comments/docstrings change)',
  usage: '<file>[:<line>|#<symbol>] [--all] [--dry-run] [-y]',
  needsModel: true,
  async run(argv, ctx) {
    const yes = argv.includes('-y') || argv.includes('--yes');
    const dry = argv.includes('--dry-run');
    const rest = argv.filter((x) => !['-y', '--yes', '--dry-run'].includes(x)).join(' ');
    const { PermissionPolicy: Policy } = await import('../permissions/policy.js');
    const policy = new Policy({ workspace: ctx.workspace, mode: yes ? 'acceptEdits' : ctx.config.permissionMode, allow: ctx.config.permissions.allow, deny: ctx.config.permissions.deny, protectedPaths: ctx.config.permissions.protectedPaths, additionalDirectories: ctx.config.permissions.additionalDirectories });
    const e = await docCommand(rest, { config: ctx.config, workspace: ctx.workspace, write: ctx.write, policy, dryRun: dry, approve: async () => (yes || (ctx.write('(not applied: run with -y to apply, or --dry-run to preview)'), false)) });
    return e ? 0 : 1;
  },
});
