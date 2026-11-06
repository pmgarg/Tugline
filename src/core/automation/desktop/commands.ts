/**
 * User-facing desktop commands (never the model's):
 *
 *   /desktop                 status: backend, health, windows, path stats, kill switch
 *   /desktop stop            kill switch: STOP file + stop all automation now (F7)
 *   /desktop resume          remove the STOP file and allow automation again
 *
 *   tug desktop-sandbox up [--build] | down | status     the sandboxed desktop (F10)
 *   tug desktop-replay <runDir> [--check]                strict replay of a desktop recording (F8)
 *   tug emergency-stop [--clear]                         write (or clear) ~/.tugline/STOP from any terminal
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerCliCommand, registerSlashCommand } from '../../commands.js';
import type { HarnessConfig } from '../../config.js';
import { isKilled } from '../policy/index.js';
import { readTrajectory } from '../recorder/trajectory.js';
import { SecretVault } from '../../secrets/vault.js';
import { desktopConfig, type DesktopConfig } from './config.js';
import { clearStop, emergencyStop, stopFileExists, stopFilePath } from './killswitch.js';
import { closeAllDesktopSessions, createBackend, peekDesktopSession } from './session.js';
import { ScanActVerifyDriver } from './driver.js';
import { replayDesktop } from './replay.js';

function run(file: string, args: string[], timeoutMs = 30 * 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 20_000_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

/** The package root (works from src/ under tsx and from dist/ after build). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

export function sandboxDockerfile(): string {
  return path.join(packageRoot(), 'docker', 'desktop-sandbox', 'Dockerfile');
}

/** docker build arguments for the sandbox image (proxy and CA pass-through when configured). */
export function sandboxBuildArgs(cfg: DesktopConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const args = ['build', '-t', cfg.sandbox.image, '-f', sandboxDockerfile()];
  const proxy = env.HTTPS_PROXY ?? env.https_proxy;
  if (proxy) args.push('--network', 'host', '--build-arg', `https_proxy=${proxy}`, '--build-arg', `HTTPS_PROXY=${proxy}`);
  if (env.TUG_SANDBOX_CA && fs.existsSync(env.TUG_SANDBOX_CA)) args.push('--secret', `id=oh_ca,src=${env.TUG_SANDBOX_CA}`);
  args.push(packageRoot());
  return args;
}

export function sandboxRunArgs(cfg: DesktopConfig): string[] {
  // noVNC only on 127.0.0.1 (S11: no exposed control surfaces); no host mounts; no privileges.
  return ['run', '-d', '--rm', '--name', cfg.sandbox.container, '-p', `127.0.0.1:${cfg.sandbox.vncPort}:6080`, '--shm-size', '256m', '--security-opt', 'no-new-privileges', cfg.sandbox.image];
}

export async function sandboxUp(config: HarnessConfig, o: { build?: boolean; log?: (s: string) => void } = {}): Promise<{ ok: boolean; message: string }> {
  const cfg = desktopConfig(config);
  if (!fs.existsSync(sandboxDockerfile())) return { ok: false, message: `no Dockerfile at ${sandboxDockerfile()}` };
  const have = await run('docker', ['image', 'inspect', cfg.sandbox.image], 30_000);
  if (o.build || have.code !== 0) {
    o.log?.(`building ${cfg.sandbox.image} (a few minutes the first time)…`);
    const b = await run('docker', sandboxBuildArgs(cfg));
    if (b.code !== 0) return { ok: false, message: `docker build failed:\n${b.out.slice(-3000)}` };
  }
  await run('docker', ['rm', '-f', cfg.sandbox.container], 30_000);
  const r = await run('docker', sandboxRunArgs(cfg), 60_000);
  if (r.code !== 0) return { ok: false, message: `docker run failed: ${r.out.slice(-2000)}` };
  return { ok: true, message: `desktop sandbox "${cfg.sandbox.container}" is up. Watch it at http://127.0.0.1:${cfg.sandbox.vncPort}/vnc.html · point the agent at it with desktop.backend = "sandbox"` };
}

export async function sandboxDown(config: HarnessConfig): Promise<{ ok: boolean; message: string }> {
  const cfg = desktopConfig(config);
  const r = await run('docker', ['rm', '-f', cfg.sandbox.container], 60_000);
  return { ok: r.code === 0, message: r.code === 0 ? `removed ${cfg.sandbox.container}` : r.out.slice(-1000) };
}

registerCliCommand({
  name: 'desktop-sandbox',
  description: 'start, stop or inspect the sandboxed Linux desktop (Docker: Xvfb + fluxbox + noVNC + AT-SPI)',
  usage: 'up [--build] | down | status',
  needsModel: false,
  async run(argv, ctx) {
    const sub = argv[0] ?? 'status';
    if (sub === 'up') {
      const r = await sandboxUp(ctx.config, { build: argv.includes('--build'), log: (s) => ctx.write(`${s}\n`) });
      ctx.write(`${r.message}\n`);
      return r.ok ? 0 : 1;
    }
    if (sub === 'down') {
      const r = await sandboxDown(ctx.config);
      ctx.write(`${r.message}\n`);
      return r.ok ? 0 : 1;
    }
    const cfg = desktopConfig(ctx.config);
    const r = await run('docker', ['inspect', '-f', '{{.State.Status}}', cfg.sandbox.container], 30_000);
    ctx.write(r.code === 0 ? `${cfg.sandbox.container}: ${r.out.trim()} · http://127.0.0.1:${cfg.sandbox.vncPort}/vnc.html\n` : `${cfg.sandbox.container}: not running (tug desktop-sandbox up)\n`);
    return 0;
  },
});

registerCliCommand({
  name: 'desktop-replay',
  description: 'strictly replay a recorded desktop run (no model); --check exits 0/1 for CI',
  usage: '<runDir> [--check]',
  needsModel: false,
  async run(argv, ctx) {
    const dir = argv.find((a) => !a.startsWith('--'));
    if (!dir) {
      ctx.write('usage: tug desktop-replay <runDir> [--check]\n');
      return 2;
    }
    const { steps } = readTrajectory(path.resolve(ctx.workspace, dir));
    if (!steps.length) {
      ctx.write(`no trajectory in ${dir}\n`);
      return 1;
    }
    const backend = createBackend(desktopConfig(ctx.config));
    await backend.start();
    const d = new ScanActVerifyDriver(backend, { settleMs: desktopConfig(ctx.config).settleMs });
    const vault = new SecretVault(ctx.config.homeDir);
    try {
      const r = await replayDesktop(d, steps, { resolveSecret: (ref) => vault.resolve(ref), log: (s) => ctx.write(`${s}\n`) });
      ctx.write(`${r.ok ? 'PASS' : 'FAIL'}: ${r.steps} desktop steps replayed${r.failure ? ` · ${r.failure}` : ''}\n`);
      return r.ok ? 0 : 1;
    } finally {
      await d.close();
    }
  },
});

registerCliCommand({
  name: 'emergency-stop',
  description: 'stop all Tugline automation now, in every process (writes ~/.tugline/STOP); --clear removes it',
  usage: '[--clear]',
  needsModel: false,
  run(argv, ctx) {
    const cfg = desktopConfig(ctx.config);
    if (argv.includes('--clear')) {
      clearStop(ctx.config.homeDir, cfg.stopFile);
      ctx.write('STOP cleared: automation may run again\n');
      return 0;
    }
    const f = emergencyStop(ctx.config.homeDir, 'tug emergency-stop', cfg.stopFile);
    ctx.write(`STOP written to ${f}: running agents stop within a second. Clear it with: tug emergency-stop --clear\n`);
    return 0;
  },
});

registerSlashCommand({
  name: 'desktop',
  description: 'desktop automation status and kill switch (stop/resume)',
  usage: '[stop|resume]',
  async run(args, ctx) {
    const sub = args.trim().split(/\s+/)[0];
    const cfg = desktopConfig(ctx.config);
    if (sub === 'stop') {
      const f = emergencyStop(ctx.config.homeDir, 'stopped by the user (/desktop stop)', cfg.stopFile);
      await closeAllDesktopSessions();
      ctx.write(`automation stopped (STOP file ${f}); /desktop resume to allow it again\n`);
      return;
    }
    if (sub === 'resume') {
      clearStop(ctx.config.homeDir, cfg.stopFile);
      ctx.write('automation allowed again\n');
      return;
    }
    const sid: string | undefined = ctx.agent?.sessionId;
    const s = sid ? peekDesktopSession(sid) : undefined;
    const stop = stopFileExists(stopFilePath(ctx.config.homeDir, cfg.stopFile));
    const lines = [`desktop ${cfg.enabled ? 'enabled' : 'disabled (desktop.enabled)'} · backend ${s?.backend?.name ?? cfg.backend}${isKilled() || stop ? ' · kill switch is ON' : ''}`];
    if (cfg.autoApproveApps.length) lines.push(`auto-approved apps: ${cfg.autoApproveApps.join(', ')}`);
    if (s?.driver) {
      const h = await s.driver.health().catch((e) => ({ ok: false, message: (e as Error).message }) as { ok: boolean; message?: string });
      lines.push(`health: ${h.ok ? 'ok' : 'NOT OK'}${h.message ? ` · ${h.message}` : ''}`);
      lines.push(`path stats: ${s.stats().text}`);
    }
    ctx.write(`${lines.join('\n')}\n`);
  },
});
