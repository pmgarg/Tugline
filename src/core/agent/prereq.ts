/**
 * Missing-prerequisite stop (live run 31 Oct 2026). On a task whose test needs a secret the environment does not
 * provide (`t03-digest-missing-secret`), 8 of 12 runs used the whole 25-minute budget: the models tried to
 * brute-force the HMAC key, set the variable themselves or edited the test, instead of saying what was missing.
 *
 * When a tool's output shows that a secret or deployment value is missing (an assertion on os.environ.get("X"), a
 * KeyError on a credential-like name, "X must be provided"), and X is not set for the agent:
 *  1. the model is told once, in that tool result, that X cannot be derived, and that it should report what is
 *     needed and stop instead of guessing, brute-forcing, setting, hard-coding or editing tests around it;
 *  2. the run stops as `blocked` when, after that, it keeps going without progress (agent.blockedAfterTurns
 *     turns, default 4) or tries to work around the value twice. The final message names exactly what is needed.
 * Progress is a file change that is not a workaround, or a passing command.
 */
import { registerAgentExtension, type AgentApi } from './extensions.js';

/** Names that are secrets or deployment-provided values (not ordinary config a project may default). */
const CREDENTIAL = /(SECRET|TOKEN|PASSW|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?ID|CREDENTIAL|AUTH|BEARER|SIGNING|CERT|DSN|CONN(ECTION)?_?STR|DATABASE_URL|WEBHOOK)/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
/** Words that look like names in log output but are never the missing value. */
const NOT_A_VALUE = new Set(['ERROR', 'WARNING', 'WARN', 'FAILED', 'FAIL', 'FATAL', 'INFO', 'DEBUG', 'NOTE', 'PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'TERM', 'LANG', 'TMPDIR', 'CI']);

/** Environment variable names the output says are missing. Exported for tests. */
export function missingFromOutput(output: string): string[] {
  const o = output.slice(-20_000);
  const found = new Set<string>();
  const add = (n: string | undefined, strong = false) => {
    if (n && ENV_NAME.test(n) && !NOT_A_VALUE.has(n) && (strong || CREDENTIAL.test(n))) found.add(n);
  };
  const failing = /(AssertionError|assert |Error|FAILED|failed|Traceback|Exception|not set|missing|required|must be)/;
  if (!failing.test(o)) return [];
  // Python: assert os.environ.get("X") / os.environ["X"] / os.getenv("X") inside a failure
  for (const m of o.matchAll(/os\.(?:environ\.get|getenv)\(\s*["']([A-Z][A-Z0-9_]+)["']|os\.environ\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g)) add(m[1] ?? m[2]);
  for (const m of o.matchAll(/KeyError:\s*["']([A-Z][A-Z0-9_]+)["']/g)) add(m[1], true);
  // Node: process.env.X in an error line
  for (const m of o.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g)) add(m[1] ?? m[2]);
  // Prose: "X must be provided / is not set / is required / is missing", "missing X", "environment variable X"
  for (const m of o.matchAll(/\b([A-Z][A-Z0-9_]{2,})[`'"]?\s+(?:must be (?:provided|set|configured)|is not set|not set|is required|is missing|not configured|not provided)([^\n]{0,40})/g)) add(m[1], /provided|deployment|configured/.test(m[0]));
  for (const m of o.matchAll(/\b(?:missing|unset|undefined|no)\s+(?:environment variable|env var|secret|credential|API key)?\s*[`'"]?([A-Z][A-Z0-9_]{2,})/gi)) add(m[1]);
  for (const m of o.matchAll(/environment variable\s+[`'"]?([A-Z][A-Z0-9_]{2,})/gi)) add(m[1]);
  return [...found];
}

/** Does this command or edit try to get around the missing value (set it, guess it, change the test)? */
export function workaround(names: string[], tool: string, args: any): boolean {
  const text = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  for (const n of names) {
    // setting it: N=…, export N=…, env N=…, os.environ["N"] = …, process.env.N = …, monkeypatch.setenv("N"
    if (new RegExp(`(?:^|[\\s;&|("'])(?:export\\s+|env\\s+)?${n}=`).test(text)) return true;
    if (new RegExp(`os\\.environ\\[\\s*\\\\?["']${n}\\\\?["']\\s*\\]\\s*=|setenv\\(\\s*\\\\?["']${n}|process\\.env\\.${n}\\s*=|os\\.environ\\.setdefault\\(\\s*\\\\?["']${n}`).test(text)) return true;
  }
  // guessing a key: loops over candidate keys with hmac / hashlib / itertools
  if (tool === 'bash' && /hmac|hashlib/.test(text) && /(itertools|for \w+ in|product\(|candidates|wordlist|brute)/.test(text)) return true;
  // editing the check instead of the code
  if (/^(edit_file|write_file|apply_patch|multi_edit)$/.test(tool) && /(^|[/\\"])(tests?\/|test_[\w-]+\.py|[\w-]+_test\.py|conftest\.py|[\w-]+\.(test|spec)\.[jt]sx?)/.test(text)) return true;
  return false;
}

interface State {
  names: string[];
  hintTurn: number;
  idle: number;
  workarounds: number;
  progressThisTurn: boolean;
  lastTurn: number;
  stopped: boolean;
}

const state = new WeakMap<object, State>();
const key = (a: AgentApi) => (a.agent as object) ?? a;

export function blockedMessage(names: string[]): string {
  const list = names.map((n) => `\`${n}\``).join(', ');
  return (
    `Stopped: this task needs ${list}, which this environment does not provide. ` +
    `It looks like a secret or a deployment value, so it cannot be worked out from the code, and setting a made-up value, ` +
    `hard-coding one or changing the tests would only hide the problem. ` +
    `To continue, provide ${names.length > 1 ? 'them' : 'it'} (for example \`export ${names[0]}=…\` in the environment the tests run in) and run again.`
  );
}

registerAgentExtension({
  id: 'prereq-stop',
  onRunStart(a) {
    state.set(key(a), { names: [], hintTurn: 0, idle: 0, workarounds: 0, progressThisTurn: false, lastTurn: 0, stopped: false });
  },
  afterTool(a, call) {
    if ((a.config.agent as any).prereqStop === false) return;
    const s = state.get(key(a));
    if (!s) return;
    if (s.names.length) {
      if (workaround(s.names, call.tool, call.args)) {
        s.workarounds++;
        return { text: `[harness] That works around the missing ${s.names.map((n) => `\`${n}\``).join(', ')} instead of solving the task. Report what is needed and stop.` };
      }
      const changed = Array.isArray((call.meta as any)?.changes) && (call.meta as any).changes.length > 0;
      if (call.ok && (changed || call.tool === 'bash')) s.progressThisTurn = s.progressThisTurn || changed || /(\b0 failed\b|\bpassed\b(?![^\n]*\bfailed\b)|\bOK\b)/.test(call.output.slice(-2000));
      return;
    }
    const names = missingFromOutput(call.output).filter((n) => !process.env[n]);
    if (!names.length) return;
    s.names = names;
    s.hintTurn = a.stats.turns;
    const list = names.map((n) => `\`${n}\``).join(', ');
    a.notice('warn', `missing prerequisite: ${list} is not set in this environment`);
    a.journal({ type: 'prerequisite_missing', names });
    return {
      text:
        `[harness] This needs ${list}, which is not set in this environment and looks like a secret or deployment value. ` +
        `It cannot be derived from the code: do not guess or brute-force it, do not set a value yourself, do not hard-code it, ` +
        `and do not change tests to get around it. If the task cannot be done without it, stop now and tell the user exactly what is needed.`,
    };
  },
  beforeTurn(a, turn) {
    const s = state.get(key(a));
    if (!s || !s.names.length || s.stopped || (a.config.agent as any).prereqStop === false) return;
    if (s.lastTurn > 0 && turn > s.lastTurn) {
      // close out the previous turn
      s.idle = s.progressThisTurn ? 0 : s.idle + 1;
      s.progressThisTurn = false;
    }
    s.lastTurn = turn;
    const limit = Number((a.config.agent as any).blockedAfterTurns ?? 4);
    if (s.workarounds >= 2 || (turn > s.hintTurn + 1 && s.idle >= limit)) {
      s.stopped = true;
      a.journal({ type: 'prerequisite_blocked', names: s.names, workarounds: s.workarounds, idleTurns: s.idle });
      return { stop: 'blocked', message: blockedMessage(s.names) };
    }
  },
});
