/** WS12 test helpers: a small fixture repository and a scripted "documentation model". */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();

const f = (lines: string[]) => lines.join('\n') + '\n';

/** 6 modules × 2 files, plus a secret file, an ignored file and docs. */
export const FIXTURE: Record<string, string> = {
  'src/agent/loop.ts': f([
    "import { complete } from '../llm/client.js';",
    "import { runTool } from './tools.js';",
    '',
    '/** Runs the agent loop until the model stops calling tools. */',
    'export async function runLoop(prompt: string): Promise<string> {',
    '  let reply = await complete(prompt);',
    '  while (reply.startsWith("tool:")) reply = await complete(await runTool(reply.slice(5)));',
    '  return reply;',
    '}',
  ]),
  'src/agent/tools.ts': f([
    "import { readText } from '../fs/read.js';",
    '',
    '/** Executes one tool call by name. */',
    'export async function runTool(call: string): Promise<string> {',
    '  return readText(call);',
    '}',
  ]),
  'src/llm/client.ts': f([
    "import { withRetry } from './retry.js';",
    '',
    '/** Sends a prompt to the OpenAI-compatible server. */',
    'export async function complete(prompt: string): Promise<string> {',
    '  return withRetry(async () => `echo ${prompt}`);',
    '}',
  ]),
  'src/llm/retry.ts': f([
    '/** Retries a call up to three times. */',
    'export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {',
    '  for (let i = 0; ; i++) {',
    '    try { return await fn(); } catch (e) { if (i >= 2) throw e; }',
    '  }',
    '}',
  ]),
  'src/fs/read.ts': f(['import fs from "node:fs";', '', '/** Reads a text file. */', 'export function readText(p: string): string {', '  return fs.readFileSync(p, "utf8");', '}']),
  'src/fs/write.ts': f(['import fs from "node:fs";', '', '/** Writes a text file atomically. */', 'export function writeText(p: string, s: string): void {', '  fs.writeFileSync(p + ".tmp", s);', '  fs.renameSync(p + ".tmp", p);', '}']),
  'src/cli/main.ts': f(["import { runLoop } from '../agent/loop.js';", "import { parseArgs } from './args.js';", '', 'export async function main(argv: string[]): Promise<void> {', '  const a = parseArgs(argv);', '  console.log(await runLoop(a.prompt));', '}']),
  'src/cli/args.ts': f(['/** Parses --prompt and --verbose. */', 'export function parseArgs(argv: string[]): { prompt: string; verbose: boolean } {', "  return { prompt: argv[argv.indexOf('--prompt') + 1] ?? '', verbose: argv.includes('--verbose') };", '}']),
  'src/config/load.ts': f(["import { defaults } from './defaults.js';", '', '/** Loads the config file over the defaults. */', 'export function loadConfig(): Record<string, unknown> {', '  return { ...defaults };', '}']),
  'src/config/defaults.ts': f(['/** Default settings. */', 'export const defaults = { model: "qwen3", contextWindow: 16384 };']),
  'py/tool/greet.py': f(['"""Greeting helpers."""', '', '', 'def greet(name):', '    return f"hello {name}"', '', '', 'def shout(name):', '    return greet(name).upper()']),
  'py/tool/util.py': f(['from .greet import greet', '', '', 'def greet_all(names):', '    """Greets every name."""', '    return [greet(n) for n in names]']),
  'src/private/keys.ts': f(['export const KEY = "sk-live-not-for-docs-0123456789abcdef";']),
  '.env': 'OPENAI_API_KEY=sk-secret-env-0123456789abcdef\n',
  '.tuglineignore': 'src/private/\n',
  'README.md': f(['# Fixture', '', 'Run `tug run --prompt hi`. See [the guide](docs/guide.md).']),
  'docs/guide.md': f(['# Guide', '', 'The loop lives in `src/agent/loop.ts` and calls `runLoop()`.']),
};

export function fixtureRepo(extra: Record<string, string> = {}): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-docs-')));
  for (const [rel, text] of Object.entries({ ...FIXTURE, ...extra })) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), text);
  }
  git(ws, 'init', '-q', '-b', 'main');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'init');
  return ws;
}

/** All user-message text of a chat request body. */
export const promptOf = (body: any): string => (body.messages ?? []).filter((m: any) => m.role === 'user').map((m: any) => (typeof m.content === 'string' ? m.content : '')).join('\n');

/** Citations that appear in a prompt (`path:a-b`), in order. */
export const citesIn = (s: string): string[] => [...s.matchAll(/`((?:[\w.-]+\/)*[\w.-]+\.\w+:\d+(?:-\d+)?)`/g)].map((m) => m[1]);
