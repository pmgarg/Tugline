/**
 * External-agent arms (v1.1 R10): run another agent's CLI (Cline, Aider,
 * OpenHands, Codex, mini-swe-agent) on the same task workspace, with the same
 * model endpoint, and score it with the same scorer and integrity checks.
 *
 *   suite.json arms: { "cline": { "external": { "preset": "cline" } },
 *                      "mine":  { "external": { "command": "my-agent --cwd {{workspace}} {{prompt}}", "version": "my-agent --version", "timeout_s": 900, "env": { "MY_KEY": "{{api_key}}" } } } }
 *
 * Placeholders (substituted shell-quoted in commands, raw in env values):
 *   {{workspace}} {{prompt}} {{prompt_file}} {{base_url}} {{model}} {{api_key}} {{timeout_s}} {{state}}
 * `{{base_url}}` is NOT the real endpoint: it is a local metering proxy that
 * forwards to it and counts requests, tokens and latency, so every arm is
 * measured the same way (an external tool's own token report is not needed).
 * `{{state}}` is a per-run scratch directory outside the workspace, for the
 * tool's config and trajectories.
 *
 * The external process runs on the host (its CLI is installed there), in the
 * workspace, with the scrubbed environment plus the arm's `env`. Its stdout is
 * kept as the run's final text (for the false-success check) and its full log
 * next to the raw record.
 */
import { buildUpstreamTarget, isAllowedMethod } from '../util/upstream.js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import net from 'node:net';
import { commandWrapperFor, scrubbedEnv, type CommandWrap } from '../tools/shell.js';
import { readUserConfigFile, type HarnessConfig } from '../config.js';
import { BRIDGE_JS, sandboxConfig, sandboxStatus } from '../sandbox/index.js';

export interface ExternalArm {
  /** A preset name (see EXTERNAL_PRESETS); the fields below override it. */
  preset?: string;
  /** Shell command; placeholders are substituted shell-quoted. */
  command?: string;
  /** Run once per run before `command` (e.g. writing the tool's provider config into {{state}}). */
  setup?: string;
  /** Prints the tool's version (recorded in the manifest). */
  version?: string;
  timeout_s?: number;
  env?: Record<string, string>;
  /** Model name as the tool wants it (default: the profile's model); e.g. "openai/{{model}}" for litellm tools. */
  model?: string;
  /** A version to pin (`{{pin}}` in commands), e.g. the cline-pinned preset's release. */
  pin?: string;
}

export interface ExternalPreset extends ExternalArm {
  title: string;
  install: string;
  docs: string;
  notes?: string;
}

/**
 * Non-interactive invocations, from each tool's documentation (October 2026).
 * They are user-run: the tools are not installed by Tugline. Verify the
 * flags against `<tool> --help` for your installed version.
 */
/**
 * R18: the pinned current Cline CLI release for the paired pilot (npm `cline`, released 2026-10-26),
 * next to whatever the company has installed (`cline` on PATH). Override per arm with `"pin"`.
 */
export const CLINE_PINNED = '3.0.74';

export const EXTERNAL_PRESETS: Record<string, ExternalPreset> = {
  cline: {
    title: 'Cline CLI (installed)',
    install: 'npm install -g cline',
    docs: 'https://docs.cline.bot/cli/cli-reference',
    // Cline 3.x (live runs 31 Oct; docs.cline.bot/cli/cli-reference):
    //  - provider settings live in the DATA dir (<data>/settings/providers.json), so `auth` and the run share one
    //    isolated config + data dir (flags and CLINE_DIR / CLINE_DATA_DIR), never the user's ~/.cline;
    //  - `cline auth -p openai -b <url>` configures the provider "openai-compatible";
    //  - the run's -P defaults to "cline" (Cline's cloud account), so it must name openai-compatible: `-P openai`
    //    is the built-in OpenAI provider (it called api.openai.com), and no -P used the cloud default;
    //  - there is no -y flag: auto-approve is on by default (--auto-approve true).
    env: { CLINE_DIR: '{{state}}/cline', CLINE_DATA_DIR: '{{state}}/cline/data' },
    setup: 'cline auth --config {{state}}/cline --data-dir {{state}}/cline/data -p openai -k {{api_key}} -m {{model}} -b {{base_url}}',
    command: 'cline --json --auto-approve true --config {{state}}/cline --data-dir {{state}}/cline/data -c {{workspace}} -t {{timeout_s}} -P openai-compatible -m {{model}} -k {{api_key}} {{prompt}}',
    version: 'cline --version',
    notes: 'If your Cline names the OpenAI-compatible provider differently, `cline auth --help` lists the ids; the metering guard reports a run that never reaches the endpoint as not_evaluable.',
  },
  'cline-pinned': {
    title: `Cline CLI (pinned ${CLINE_PINNED})`,
    install: 'none: run through npx (needs npm and network on first use; cached afterwards)',
    docs: 'https://docs.cline.bot/cli/cli-reference',
    pin: CLINE_PINNED,
    env: { CLINE_DIR: '{{state}}/cline', CLINE_DATA_DIR: '{{state}}/cline/data' },
    setup: 'npx -y cline@{{pin}} auth --config {{state}}/cline --data-dir {{state}}/cline/data -p openai -k {{api_key}} -m {{model}} -b {{base_url}}',
    command: 'npx -y cline@{{pin}} --json --auto-approve true --config {{state}}/cline --data-dir {{state}}/cline/data -c {{workspace}} -t {{timeout_s}} -P openai-compatible -m {{model}} -k {{api_key}} {{prompt}}',
    version: 'npx -y cline@{{pin}} --version',
    notes: 'The same CLI as the `cline` preset at a fixed release, so a pilot compares the installed Cline and a known current one.',
  },
  aider: {
    title: 'Aider',
    install: 'python -m pip install aider-install && aider-install',
    docs: 'https://aider.chat/docs/scripting.html',
    model: 'openai/{{model}}',
    command: 'aider --model {{model}} --yes-always --no-auto-commits --no-stream --no-pretty --no-check-update --no-show-model-warnings --message {{prompt}}',
    env: { OPENAI_API_BASE: '{{base_url}}', OPENAI_API_KEY: '{{api_key}}' },
    version: 'aider --version',
    notes: 'Aider edits files it is told about or finds through its repo map; it does not run tests unless asked.',
  },
  openhands: {
    title: 'OpenHands CLI',
    install: 'uv tool install openhands --python 3.12',
    docs: 'https://docs.openhands.dev/openhands/usage/cli/command-reference',
    model: 'openai/{{model}}',
    // Headless mode always auto-approves; it works in the current directory (the runner's cwd is the workspace).
    command: 'openhands --headless --json --override-with-envs --exit-without-confirmation -t {{prompt}}',
    env: { LLM_MODEL: '{{model}}', LLM_BASE_URL: '{{base_url}}', LLM_API_KEY: '{{api_key}}' },
    version: 'openhands --version',
  },
  codex: {
    title: 'Codex CLI (custom OSS provider)',
    install: 'npm install -g @openai/codex',
    docs: 'https://developers.openai.com/codex/config-advanced',
    // A custom provider defined per run with -c overrides (TOML values); the key comes from the env var it names.
    command:
      'codex exec --skip-git-repo-check --full-auto --ephemeral --cd {{workspace}} --model {{model}} ' +
      '-c model_provider=\'"ohbench"\' -c model_providers.ohbench.name=\'"ohbench"\' -c model_providers.ohbench.base_url={{base_url_toml}} ' +
      '-c model_providers.ohbench.env_key=\'"TUG_EXTERNAL_API_KEY"\' -c model_providers.ohbench.wire_api=\'"responses"\' {{prompt}}',
    env: { TUG_EXTERNAL_API_KEY: '{{api_key}}', CODEX_HOME: '{{state}}/codex' },
    version: 'codex --version',
    notes: 'wire_api "responses" needs an endpoint with /v1/responses (recent llama.cpp, vLLM); older Codex versions also accept "chat". For Ollama or LM Studio use `codex exec --oss --local-provider ollama` instead.',
  },
  'mini-swe-agent': {
    title: 'mini-swe-agent (control)',
    install: 'pip install mini-swe-agent',
    docs: 'https://mini-swe-agent.com/latest/usage/mini/',
    model: 'openai/{{model}}',
    command: 'mini -y --exit-immediately -l 0 -c mini.yaml -c model.model_kwargs.api_base={{base_url}} -c model.model_kwargs.api_key={{api_key}} -m {{model}} -o {{state}}/trajectory.json -t {{prompt}}',
    version: 'mini --version',
    notes: 'The bash-only control; `-c model.model_kwargs.api_base=…` is litellm\'s per-model base URL (verify the key path for your version).',
  },
};

export function resolveExternal(a: ExternalArm | string): ExternalArm {
  const spec = typeof a === 'string' ? { preset: a } : a;
  const base = spec.preset ? EXTERNAL_PRESETS[spec.preset] : undefined;
  if (spec.preset && !base) throw new Error(`unknown external preset "${spec.preset}" (${Object.keys(EXTERNAL_PRESETS).join(', ')})`);
  const out: ExternalArm = { ...(base ?? {}), ...spec, env: { ...(base?.env ?? {}), ...(spec.env ?? {}) } };
  if (!out.command) throw new Error('external arm needs a command or a preset');
  return out;
}

export const shq = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Substitute placeholders: shell-quoted for commands, raw for env values. */
export function substitute(template: string, vars: Record<string, string>, quote: boolean): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? (quote ? shq(vars[k]) : vars[k]) : m));
}

// ------------------------------------------------------------ metering proxy

export interface Meter {
  requests: number;
  ok: number;
  promptTokens: number;
  completionTokens: number;
  /** True when some response had no usage block and tokens were estimated (chars / 4). */
  estimated: boolean;
  latenciesMs: number[];
  /** R18: the external agent's own system prompt (first one seen), so the harness prompt is recorded for every arm. */
  systemPrompt?: string;
  systemPromptSha?: string;
}

function usageFrom(text: string): { prompt: number; completion: number } | undefined {
  // JSON body, or the last SSE chunk that carries usage.
  const candidates = text.trim().startsWith('{') ? [text] : text.split('\n').filter((l) => l.startsWith('data:') && l.includes('usage')).map((l) => l.slice(5));
  for (const c of candidates.reverse()) {
    try {
      const u = JSON.parse(c).usage ?? JSON.parse(c).response?.usage;
      if (u) return { prompt: Number(u.prompt_tokens ?? u.input_tokens ?? 0), completion: Number(u.completion_tokens ?? u.output_tokens ?? 0) };
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

/** A pass-through proxy in front of the real endpoint that meters every model request. */
/**
 * v1.2 N34: a gate in front of the upstream for agents whose model calls must be admitted (an external CLI as a
 * team member): `admit` may refuse a model call (answered 429, never forwarded); `settle` gets the usage after it.
 */
export interface ProxyGate {
  admit(body: Buffer): string | undefined;
  /** F11: headers the proxy sets on every forwarded request (the real credentials; the agent only ever had a dummy key) */
  headers?: Record<string, string>;
  settle(usage: { prompt: number; completion: number; estimated: boolean } | undefined): void;
}

/**
 * G4: the one upstream URL a proxied request may go to, by WS18's shared `buildUpstreamTarget` (S1: the container
 * relay and this proxy behave the same): the configured origin and base path plus a model API path; anything else
 * (absolute, protocol-relative, backslash, dot segments, encoded separators, other paths) is refused.
 */
export function proxyTarget(up: URL, rawUrl: string | undefined): URL | undefined {
  // the proxy URL ends in /v1 like the profile's: /v1/chat/completions here → <base path>/chat/completions upstream
  const sub = (rawUrl ?? '').replace(/^\/v1(?=[/?]|$)/, '');
  const base = up.pathname.replace(/\/+$/, '');
  const t = buildUpstreamTarget({ origin: up.origin, basePath: base || '/' }, base + sub);
  return t.ok ? t.url : undefined;
}

/** Request headers never forwarded: the client's cookies and hop-by-hop headers (its credentials too, when the proxy adds the real ones). */
const HOP_BY_HOP = ['host', 'proxy-authorization', 'cookie', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length'];

export async function startMeteringProxy(upstreamBase: string, gate?: ProxyGate): Promise<{ url: string; meter: Meter; close: () => Promise<void> }> {
  const up = new URL(upstreamBase.replace(/\/+$/, ''));
  const meter: Meter = { requests: 0, ok: 0, promptTokens: 0, completionTokens: 0, estimated: false, latenciesMs: [] };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      // /v1/chat/completions on the proxy → <upstream path>/chat/completions (the proxy URL ends in /v1 like the profile's).
      // G4: only to the upstream's origin, only an allowed API path; anything else is refused before any header is added
      // only the methods a model client uses (the shared upstream.ts allowlist: GET, HEAD, POST)
      if (!isAllowedMethod(req.method)) {
        res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, POST, HEAD' });
        res.end(JSON.stringify({ error: { message: `metering proxy: method ${req.method} is not forwarded`, type: 'invalid_request' } }));
        return;
      }
      const target = proxyTarget(up, req.url);
      if (!target) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'metering proxy: refused request target (only the model API paths of the configured endpoint)', type: 'invalid_request' } }));
        return;
      }
      const isModelCall = /\/(chat\/completions|completions|responses|messages)$/.test(target.pathname);
      if (isModelCall && !meter.systemPrompt) {
        try {
          const j = JSON.parse(body.toString('utf8'));
          const sys = j.system ?? j.instructions ?? (j.messages ?? j.input ?? []).find?.((m: { role?: string }) => m.role === 'system' || m.role === 'developer')?.content;
          if (sys) {
            meter.systemPrompt = typeof sys === 'string' ? sys : JSON.stringify(sys);
            meter.systemPromptSha = crypto.createHash('sha256').update(meter.systemPrompt).digest('hex').slice(0, 16);
          }
        } catch {
          /* not JSON */
        }
      }
      if (isModelCall && gate) {
        const why = gate.admit(body);
        if (why) {
          meter.requests++;
          meter.latenciesMs.push(0);
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: why, type: 'budget' } }));
          return;
        }
      }
      const started = Date.now();
      // G4: the client's cookies and hop-by-hop headers are dropped; with a gate (team members) its credentials too,
      // and the real ones are added last, only for a target buildUpstreamTarget accepted
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.includes(k) && !(gate?.headers && ['authorization', 'x-api-key', 'api-key'].includes(k))) headers[k] = v;
      headers.host = target.host;
      if (gate?.headers && target.origin === up.origin) for (const [k, v] of Object.entries(gate.headers)) headers[k.toLowerCase()] = v;
      const mod = target.protocol === 'https:' ? https : http;
      const out = mod.request(target, { method: req.method, headers: { ...headers, 'content-length': String(body.length) } }, (r) => {
        // G4: never follow (or pass on) a redirect from the upstream
        if ((r.statusCode ?? 0) >= 300 && (r.statusCode ?? 0) < 400) {
          r.resume();
          if (isModelCall) gate?.settle(undefined);
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'metering proxy: the model endpoint answered with a redirect, which the proxy does not follow' } }));
          return;
        }
        res.writeHead(r.statusCode ?? 502, r.headers);
        const seen: Buffer[] = [];
        r.on('data', (c) => {
          seen.push(c);
          res.write(c);
        });
        r.on('end', () => {
          res.end();
          if (!isModelCall) return;
          meter.requests++;
          meter.latenciesMs.push(Date.now() - started);
          if ((r.statusCode ?? 500) < 400) meter.ok++;
          const text = Buffer.concat(seen).toString('utf8');
          const u = usageFrom(text);
          if (u) {
            meter.promptTokens += u.prompt;
            meter.completionTokens += u.completion;
          } else {
            meter.estimated = true;
            meter.promptTokens += Math.ceil(body.length / 4);
            meter.completionTokens += Math.ceil(text.length / 4);
          }
          gate?.settle(u ? { ...u, estimated: false } : { prompt: Math.ceil(body.length / 4), completion: Math.ceil(text.length / 4), estimated: true });
        });
      });
      out.on('error', (e) => {
        if (isModelCall) gate?.settle(undefined);
        if (isModelCall) {
          meter.requests++;
          meter.latenciesMs.push(Date.now() - started);
        }
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `metering proxy: upstream failed: ${e.message}` } }));
      });
      out.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    meter,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

// ------------------------------------------------------------ running one external run

export interface ExternalRunResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
  version?: string;
  meter: Meter;
  /** The command as recorded (the API key replaced). */
  recordedCommand: string;
}

/**
 * WS24 re-check RC2: the one gate every external agent passes (arena contestants, task-board cards, WS17 team
 * members). External agents run with their own auto-approve, so:
 *   - managed `disableAutoMode` / `disableYoloMode` refuse them;
 *   - they run in the OS sandbox: refused when `shell.sandbox` is "none" or no runner is available, unless the user
 *     opts in at user scope (`"external": {"allowUnsandboxed": true}` in ~/.tugline/config.json; never when a
 *     sandbox is required). `ownSandbox`: the caller confines the agent itself (team members: their own bwrap/Seatbelt).
 */
export class ExternalAgentRefusal extends Error {
  constructor(readonly code: 'forbidden_by_managed_policy' | 'sandbox_unavailable', message: string) {
    super(message);
  }
}

export function externalAgentGate(cfg: HarnessConfig, name: string, o: { ownSandbox?: boolean } = {}): { sandboxed: boolean; runner: string } {
  const mp = cfg.managed?.policy as { disableAutoMode?: boolean; disableYoloMode?: boolean } | undefined;
  if (mp?.disableAutoMode || mp?.disableYoloMode) throw new ExternalAgentRefusal('forbidden_by_managed_policy', `external agent ${name} approves its own actions (auto mode), which your organisation's managed policy forbids (${mp.disableAutoMode ? 'disableAutoMode' : 'disableYoloMode'}); use Tugline's own agent`);
  if (o.ownSandbox) return { sandboxed: true, runner: 'own' };
  const st = sandboxStatus(cfg);
  const requested = String((cfg as { shell?: { sandbox?: string } }).shell?.sandbox ?? 'none');
  if (requested !== 'none' && st.runner !== 'none' && st.runner !== 'docker') return { sandboxed: true, runner: st.runner };
  if (readUserConfigFile(cfg.homeDir).external?.allowUnsandboxed === true && !st.required) return { sandboxed: false, runner: 'none' };
  throw new ExternalAgentRefusal('sandbox_unavailable', `external agent ${name} approves its own actions, so it only runs inside the OS sandbox, and ${requested === 'none' ? 'shell.sandbox is "none"' : `no sandbox runner is available here (${st.unavailable ?? st.runner})`}; it was not started. Allow unsandboxed external agents in ~/.tugline/config.json ("external": {"allowUnsandboxed": true}) only if you trust it.`);
}

/** Inside the sandbox the agent reaches the metering proxy through this port (a bridge to a unix socket in its state dir). */
export const EXTERNAL_MODEL_PORT = 3129;

function run(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, logFile?: string, signal?: AbortSignal, wrap?: CommandWrap, onOutput?: (chunk: string) => void, prefix: string[] = []): Promise<{ exitCode: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    // WS24 N47: an arena contestant's external agent runs under the same command wrappers (OS sandbox) as our tools
    const inner = prefix.length ? { file: prefix[0]!, args: [...prefix.slice(1), '/bin/bash', '-c', command] } : { file: '/bin/bash', args: ['-c', command] };
    const spec = wrap ? wrap({ ...inner, cwd, env }) : { ...inner, cwd, env };
    const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const log = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : undefined;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const t = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    const onData = (d: Buffer) => {
      log?.write(d);
      onOutput?.(d.toString());
      if (out.length < 2_000_000) out += d.toString();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      clearTimeout(t);
      log?.end();
      resolve({ exitCode: 127, timedOut, output: `failed to start: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      log?.end();
      resolve({ exitCode: code, timedOut, output: out });
    });
  });
}

export interface ExternalRunOptions {
  arm: ExternalArm;
  workspace: string;
  prompt: string;
  profile: { baseUrl: string; model: string; apiKey?: string; headers?: Record<string, string> };
  stateDir: string;
  timeoutS: number;
  logFile?: string;
  signal?: AbortSignal;
  /** WS24 N47: command wrappers (OS sandbox) for the agent process, and live output (arena streams) */
  wrap?: CommandWrap;
  /**
   * WS24 RC2: the harness config. When given, the external-agent gate applies (managed policy, OS sandbox) and the
   * version, setup and main commands all run in the same sandbox (`wrap` is then derived from it): the state dir is
   * writable, package downloads go through the egress allowlist proxy, and the model is reached through a bridge.
   */
  config?: HarnessConfig;
  /** label for refusals */
  name?: string;
  onOutput?: (chunk: string) => void;
}

export async function runExternal(o: ExternalRunOptions): Promise<ExternalRunResult> {
  const gate = o.config ? externalAgentGate(o.config, o.name ?? o.arm.preset ?? 'agent') : undefined;
  // live run (5 Nov): the real key reached Cline's argv and its saved settings (`cline auth -k`), on disk in the
  // results folder. Like team members (F11): the tool only ever gets a per-run dummy key; the metering proxy adds the
  // real credentials on the way out, so the key is never in its argv, env, state dir, output or workspace.
  const dummyKey = `oh-ext-${crypto.randomBytes(12).toString('hex')}`;
  const realHeaders: Record<string, string> = { ...(o.profile.headers ?? {}), ...(o.profile.apiKey ? { authorization: `Bearer ${o.profile.apiKey}` } : {}) };
  const proxy = await startMeteringProxy(o.profile.baseUrl, { headers: realHeaders, admit: () => undefined, settle: () => undefined });
  let bridge: net.Server | undefined;
  try {
    fs.mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
    let wrap = o.wrap;
    let prefix: string[] = [];
    let baseUrl = proxy.url;
    if (o.config && gate) {
      // the state dir is the one place outside the workspace the agent may write; the metering proxy is the only
      // extra address it may reach (a literal host:port entry), on top of the egress allowlist for downloads
      const sb = sandboxConfig(o.config);
      const meter = new URL(proxy.url);
      const derived = { ...o.config, sandbox: { ...((o.config as { sandbox?: object }).sandbox ?? {}), allowWrite: [...sb.allowWrite, o.stateDir], allowDomains: [...sb.allowDomains, `127.0.0.1:${meter.port}`] } } as HarnessConfig;
      wrap = commandWrapperFor(derived);
      if (gate.sandboxed && gate.runner === 'bwrap') {
        // bwrap has no host network: a bridge inside listens on EXTERNAL_MODEL_PORT and forwards to this socket
        const sock = path.join(o.stateDir, 'model.sock');
        bridge = net.createServer((c) => {
          const u = net.connect(Number(meter.port), '127.0.0.1');
          c.pipe(u);
          u.pipe(c);
          c.on('error', () => u.destroy());
          u.on('error', () => c.destroy());
        });
        await new Promise<void>((r) => bridge!.listen(sock, r));
        prefix = [process.execPath, '-e', BRIDGE_JS, sock, String(EXTERNAL_MODEL_PORT)];
        baseUrl = `http://127.0.0.1:${EXTERNAL_MODEL_PORT}${meter.pathname === '/' ? '' : meter.pathname}`;
      }
    }
    const promptFile = path.join(o.stateDir, 'prompt.txt');
    fs.writeFileSync(promptFile, o.prompt);
    const timeoutS = o.arm.timeout_s ?? o.timeoutS;
    const base: Record<string, string> = { pin: o.arm.pin ?? '', model: o.profile.model, base_url: baseUrl, api_key: dummyKey, workspace: o.workspace, prompt: o.prompt, prompt_file: promptFile, timeout_s: String(timeoutS), state: o.stateDir };
    base.base_url_toml = JSON.stringify(baseUrl);
    // The tool's model name may wrap the profile's (e.g. "openai/<model>" for litellm-based tools).
    const vars: Record<string, string> = { ...base, model: o.arm.model ? substitute(o.arm.model, base, false) : base.model };
    const env: NodeJS.ProcessEnv = { ...scrubbedEnv([]), ...Object.fromEntries(Object.entries(o.arm.env ?? {}).map(([k, v]) => [k, substitute(v, vars, false)])) };
    const secret = (s: string) => (vars.api_key.length >= 8 ? s.split(vars.api_key).join('***') : s);
    let version: string | undefined;
    // RC2: version and setup (`cline auth`, `npx -y cline@<pin>`, which downloads and runs package code) run in the
    // same sandbox as the main run
    if (o.arm.version) {
      const v = await run(substitute(o.arm.version, vars, true), o.workspace, env, 120_000, undefined, undefined, wrap);
      version = v.exitCode === 0 ? v.output.trim().split('\n')[0]?.slice(0, 200) : `unavailable (exit ${v.exitCode}): ${v.output.trim().slice(0, 200)}`;
    }
    const started = Date.now();
    if (o.arm.setup) {
      const s = await run(substitute(o.arm.setup, vars, true), o.workspace, env, 120_000, o.logFile, o.signal, wrap);
      if (s.exitCode !== 0) return { exitCode: s.exitCode, timedOut: s.timedOut, output: secret(`setup failed: ${s.output}`), durationMs: Date.now() - started, version, meter: proxy.meter, recordedCommand: secret(substitute(o.arm.setup, vars, true)) };
    }
    const command = substitute(o.arm.command!, vars, true);
    // inside the sandbox every request goes to the egress proxy; the model bridge is local, so it is exempt
    const inSandbox = prefix.length ? `export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost; ${command}` : command;
    const r = await run(inSandbox, o.workspace, env, timeoutS * 1000, o.logFile, o.signal, wrap, o.onOutput, prefix);
    return { ...r, output: secret(r.output), durationMs: Date.now() - started, version, meter: proxy.meter, recordedCommand: secret(command).replace(o.prompt.length > 40 ? shq(o.prompt) : '\u0000', '{{prompt}}') };
  } finally {
    bridge?.close();
    await proxy.close();
  }
}
