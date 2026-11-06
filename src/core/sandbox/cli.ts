/**
 * N36: `tug sandbox` (status | verify | run -- <cmd> | trust-project) and `/sandbox`.
 *
 *   tug sandbox status [--json]   what is in force for this workspace and why: requested and effective runner, the
 *                                fallback chain (bwrap → landlock → policy), Landlock ABI and what it covers,
 *                                network, credential stores hidden, process lifetime, project settings ignored.
 *   tug sandbox verify            probes the boundary with real commands through the same wrapper the agent uses:
 *                                a workspace write works; a write outside, a credential-store read and a direct
 *                                connection fail. Exit 1 if any probe is not as expected (Qwen: `qwen sandbox --verify`).
 *   tug sandbox run -- <cmd…>     runs one command confined exactly as the agent's commands are.
 *   tug sandbox trust-project [dir] [--revoke]
 *                                user scope: let this workspace's .tugline/config loosen sandbox and network
 *                                settings (SAC1). Off by default; the only way besides editing ~/.tugline/config.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerCliCommand, registerSlashCommand } from '../commands.js';
import type { HarnessConfig } from '../config.js';
import { commandWrapperFor, containerSandboxFor, execCommand, scrubbedEnv } from '../tools/shell.js';
import { closeSandboxProxies, sandboxConfig, sandboxStatus } from './index.js';
import { containerSessionPlan } from './container.js';
import { denyReadPaths, LANDLOCK_LIMITS } from './settings.js';

export function statusReport(cfg: HarnessConfig, workspace: string): { text: string; json: Record<string, unknown> } {
  const st = sandboxStatus(cfg);
  const sb = sandboxConfig(cfg);
  const lines: string[] = [];
  lines.push(st.summary);
  lines.push(`requested runner: ${st.requested}${(cfg.sandbox as { runner?: string } | undefined)?.runner ? ' (sandbox.runner)' : (cfg.sandbox as { mode?: string } | undefined)?.mode ? ' (sandbox.mode)' : ' (shell.sandbox)'}`);
  lines.push(`effective runner: ${st.runner}${st.unavailable ? ` (requested one unavailable: ${st.unavailable})` : ''}`);
  for (const c of st.chain) lines.push(`  fallback chain: ${c}`);
  if (st.landlock) lines.push(`landlock: ${st.landlock.summary}`);
  lines.push(`network: ${st.network}${st.network === 'proxy' ? ` (${st.allowDomains.length} hosts through the allowlist proxy: ${st.allowDomains.slice(0, 8).join(', ')}${st.allowDomains.length > 8 ? ', …' : ''})` : st.network === 'none' ? ' (no network for commands)' : ' (unrestricted: sandbox.network is "host")'}`);
  lines.push(`workspace: ${st.filesystem === 'read-only' ? 'read-only' : 'writable'}; protected paths and agent-control files read-only (${st.runner === 'landlock' ? 'static check + restore guard; Landlock cannot express read-only beneath a writable directory' : st.runner === 'none' ? 'static check + restore guard' : 'kernel-enforced'})`);
  lines.push(`credential stores hidden from commands: ${st.denyRead.length ? st.denyRead.map((p) => p.replace(os.homedir(), '~')).join(', ') : st.runner === 'docker' || st.runner === 'podman' ? '(the host home is not mounted)' : st.runner === 'none' ? 'NONE (no sandbox)' : '(none of sandbox.denyRead exists on this machine)'}`);
  lines.push(`host daemon sockets (Docker, containerd, Podman …): ${st.runner === 'none' ? 'NOT hidden (no sandbox; the permission engine asks before a command names one)' : sb.unixSockets === 'allow' ? 'REACHABLE (sandbox.unixSockets: "allow")' : st.runner === 'landlock' ? 'unreachable (unix-socket creation refused by seccomp)' : st.runner === 'docker' || st.runner === 'podman' ? 'not mounted' : 'unreachable (runtime socket directories hidden)'}`);
  if (st.runner === 'landlock') {
    // re-check RC-3: what Landlock cannot give commands, said where the user looks
    lines.push(`landlock limits: ${LANDLOCK_LIMITS}`);
    const ws = path.resolve(workspace);
    if (st.denyRead.some((d) => d.startsWith(ws + path.sep))) lines.push(`landlock limits: the workspace contains credential stores (the home directory?): commands cannot create new entries directly in it, only in its subdirectories`);
  }
  lines.push(`required (sandbox.require): ${st.required ? 'yes' : 'no'}${st.refusing ? ' — commands are REFUSED until a sandbox is available' : ''}`);
  lines.push(`process lifetime: ${st.processLifetime === 'sandbox' ? 'commands die with the session (sandbox PID namespace / reaper)' : st.processLifetime === 'bwrap' ? 'commands die with the session (bwrap PID namespace)' : 'commands may outlive the session'}`);
  const plan = containerSessionPlan(cfg, workspace);
  lines.push(`session: ${sb.session === 'container' ? `container (${plan.ok ? `${plan.engine}, image ${plan.image}` : plan.reason})` : 'host (use `tug --container` to run the whole session in a container)'}`);
  const clamped = cfg.trust?.clamped ?? [];
  if (clamped.length) lines.push(`project config ignored (it cannot loosen these; \`tug sandbox trust-project\` allows it):\n${clamped.map((c) => `  - ${c}`).join('\n')}`);
  return { text: lines.join('\n'), json: { ...st, session: sb.session ?? 'host', container: plan, clamped } };
}

interface Probe {
  name: string;
  command: string;
  expect: 'ok' | 'fail';
}

export async function verifyProbes(cfg: HarnessConfig, workspace: string): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const st = sandboxStatus(cfg);
  // outside the workspace and outside any temp dir (bwrap gives commands a private /tmp)
  const outside = fs.mkdtempSync(path.join(path.dirname(path.resolve(workspace)), '.oh-sandbox-verify-'));
  const probes: Probe[] = [
    { name: 'a workspace write succeeds', command: `printf ok > .oh-sandbox-verify && rm -f .oh-sandbox-verify`, expect: st.filesystem === 'read-only' ? 'fail' : 'ok' },
    { name: 'a write outside the workspace is denied', command: `printf x > '${outside}/probe'`, expect: 'fail' },
  ];
  // a credential store with something in it: its content must not be visible (bwrap shows an empty dir or file)
  const nonEmpty = (p: string) => {
    try {
      return fs.statSync(p).isDirectory() ? fs.readdirSync(p).length > 0 : fs.statSync(p).size > 0;
    } catch {
      return false;
    }
  };
  const cred = denyReadPaths({ homeDir: cfg.homeDir, sandbox: sandboxConfig(cfg) }).find((p) => p !== path.resolve(cfg.homeDir) && nonEmpty(p));
  if (cred) {
    const q = cred.replace(/'/g, `'\\''`);
    probes.push({ name: `a credential store read is denied (${cred.replace(os.homedir(), '~')})`, command: fs.statSync(cred).isDirectory() ? `[ -n "$(ls -A '${q}' 2>/dev/null)" ]` : `[ -n "$(head -c1 '${q}' 2>/dev/null)" ]`, expect: 'fail' });
  }
  if (st.network !== 'host') probes.push({ name: 'a direct connection (bypassing the proxy) is denied', command: `exec 3<>/dev/tcp/1.1.1.1/80`, expect: 'fail' });
  const out: { name: string; ok: boolean; detail: string }[] = [];
  try {
    for (const p of probes) {
      const r = await execCommand({ shellCommand: p.command, cwd: workspace, timeoutMs: 20_000, env: scrubbedEnv(cfg.shell.scrubEnv), wrap: commandWrapperFor(cfg), sandbox: containerSandboxFor(cfg, workspace) });
      const ok = p.expect === 'ok' ? r.exitCode === 0 : r.exitCode !== 0;
      out.push({ name: p.name, ok, detail: `exit ${r.exitCode}${r.output.trim() ? `: ${r.output.trim().split('\n').pop()!.slice(0, 160)}` : ''}` });
    }
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    closeSandboxProxies();
  }
  return out;
}

/** Add or remove a workspace in the user config's sandbox.trustProjectConfig. */
export function setProjectTrust(homeDir: string, workspace: string, on: boolean): string {
  const file = path.join(homeDir, 'config.json');
  // review finding 2: never write through a link (a container or a command may have planted one)
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symbolic link; refusing to write through it`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  let cfg: any = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    cfg = {};
  }
  const ws = path.resolve(workspace);
  const list: string[] = Array.isArray(cfg.sandbox?.trustProjectConfig) ? cfg.sandbox.trustProjectConfig : [];
  const next = on ? [...new Set([...list, ws])] : list.filter((p) => path.resolve(p) !== ws);
  cfg.sandbox = { ...(cfg.sandbox ?? {}), trustProjectConfig: next };
  fs.mkdirSync(homeDir, { recursive: true });
  // a new file renamed over the old one: replaces a link, never follows it
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Review finding 17: granting asks the person at the terminal (an interactive TTY), never a script or a model: the
 * permission engine also treats the command as dangerous (always asks). Tests replace the question.
 */
let confirmTrust: (question: string) => Promise<boolean> = async (question) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
};
export function setTrustConfirm(f: typeof confirmTrust): () => void {
  const old = confirmTrust;
  confirmTrust = f;
  return () => (confirmTrust = old);
}

export async function sandboxCommand(argv: string[], ctx: { config: HarnessConfig; workspace: string; write: (t: string) => void }): Promise<number> {
  const sub = argv[0] ?? 'status';
  if (sub === 'status') {
    const r = statusReport(ctx.config, ctx.workspace);
    ctx.write(argv.includes('--json') ? JSON.stringify(r.json, null, 2) : r.text);
    return 0;
  }
  if (sub === 'verify') {
    ctx.write(sandboxStatus(ctx.config).summary);
    const res = await verifyProbes(ctx.config, ctx.workspace);
    for (const r of res) ctx.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.detail})`);
    const bad = res.filter((r) => !r.ok).length;
    ctx.write(bad ? `${bad} probe(s) failed: the sandbox does not hold here.` : 'sandbox verified.');
    return bad ? 1 : 0;
  }
  if (sub === 'run') {
    const i = argv.indexOf('--');
    const cmd = (i >= 0 ? argv.slice(i + 1) : argv.slice(1)).join(' ');
    if (!cmd.trim()) {
      ctx.write('usage: tug sandbox run -- <command>');
      return 2;
    }
    try {
      const r = await execCommand({ shellCommand: cmd, cwd: ctx.workspace, timeoutMs: ctx.config.shell.timeoutMs, env: scrubbedEnv(ctx.config.shell.scrubEnv), wrap: commandWrapperFor(ctx.config), sandbox: containerSandboxFor(ctx.config, ctx.workspace) });
      if (r.output) ctx.write(r.output.replace(/\n$/, ''));
      return r.exitCode ?? 1;
    } finally {
      closeSandboxProxies();
    }
  }
  if (sub === 'trust-project') {
    const revoke = argv.includes('--revoke');
    const dir = argv.slice(1).find((a) => !a.startsWith('--')) ?? ctx.workspace;
    if (!revoke && !(await confirmTrust(`Let ${path.resolve(dir)}'s .tugline/config loosen sandbox, network and approval settings?`))) {
      ctx.write(`not changed: granting needs a yes at an interactive terminal (\`tug sandbox trust-project\` run by a script or an agent is refused). Revoking needs no confirmation.`);
      return 1;
    }
    const file = setProjectTrust(ctx.config.homeDir, dir, !revoke);
    ctx.write(revoke ? `${path.resolve(dir)}: its project config can no longer loosen sandbox, network or approval settings (${file}).` : `${path.resolve(dir)}: its .tugline/config may now loosen sandbox, network and approval settings (recorded in ${file}). Undo with \`tug sandbox trust-project --revoke\`.`);
    return 0;
  }
  ctx.write('usage: tug sandbox status [--json] | verify | run -- <cmd> | trust-project [dir] [--revoke]');
  return 2;
}

registerCliCommand({
  name: 'sandbox',
  description: 'sandbox: status (what is in force and why), verify (probe the boundary), run one command confined, trust-project',
  usage: 'status [--json] | verify | run -- <cmd> | trust-project [dir] [--revoke]',
  needsModel: false,
  run: (argv, ctx) => sandboxCommand(argv, ctx),
});

registerSlashCommand({
  name: 'sandbox',
  description: 'show what the sandbox enforces for this session and why',
  run(_args, ctx) {
    ctx.write(statusReport(ctx.config, ctx.workspace).text);
  },
});
