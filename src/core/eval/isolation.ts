/**
 * Docker isolation for eval and benchmark runs (v1.1 G5; FINAL_REVIEW Security #7).
 *
 * Per run, the task gets its own container:
 *  - image: the task's own (built from its Dockerfile, or the `client` service of
 *    its docker-compose.yaml), else a named base image (e.g. python:3.12-slim);
 *  - the eval workspace is bind-mounted at the task's workdir (/app for
 *    terminal-bench, /testbed for SWE-bench). Files the image put in that
 *    workdir are first copied into the workspace, so the mount hides nothing;
 *  - every command the agent runs goes through a command wrapper (SPEC S0.7)
 *    that turns it into `docker exec` in that container. The wrapper is scoped
 *    by config: only an agent whose config carries this run's `evalContainer`
 *    is affected, so parallel runs and other agents are untouched;
 *  - hidden tests are copied into the container (/oh-hidden) only after the
 *    agent has finished; the acceptance commands then run inside it.
 * File tools (read_file, edit_file) work on the host side of the same bind
 * mount, so both views stay identical.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HarnessConfig } from '../config.js';
import { registerCommandWrapper, type SpawnSpec } from '../tools/shell.js';

const pexec = promisify(execFile);

export type Isolation = 'host' | 'docker';
export const HIDDEN_IN_CONTAINER = '/oh-hidden';

/** How a task wants to be containerised (task.json `docker`). */
export interface TaskDocker {
  /** Use this image as is. */
  image?: string;
  /** Build from this directory (it has a Dockerfile, or a docker-compose.yaml with a `client` service). */
  build?: string;
  /** Where the workspace is mounted inside the container. */
  workdir: string;
  /** Commands run in the container before the agent starts (e.g. installing a test runner). */
  setup?: string[];
}

export interface EvalContainer {
  name: string;
  workdir: string;
  /** Host directory bind-mounted at `workdir`. */
  hostWork: string;
  /** Shell inside the container (bash when present, else sh). */
  shell: string;
}

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** Internal: set by the eval runner for a docker-isolated run; the command wrapper keys on it. */
    evalContainer?: EvalContainer;
  }
}

async function docker(args: string[], timeout = 600_000): Promise<string> {
  const { stdout } = await pexec('docker', args, { timeout, maxBuffer: 64 * 1024 * 1024 });
  return stdout.toString();
}

let available: Promise<boolean> | undefined;
/** Is a Docker daemon reachable? (cached per process; `refresh` re-checks) */
export function dockerAvailable(refresh = false): Promise<boolean> {
  if (!available || refresh)
    available = pexec('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 8000 })
      .then((r) => !!r.stdout.toString().trim())
      .catch(() => false);
  return available;
}

export async function resolveIsolation(want: 'auto' | Isolation | undefined): Promise<Isolation> {
  if (want === 'host') return 'host';
  const ok = await dockerAvailable();
  if (want === 'docker' && !ok) throw new Error('--isolation docker: no Docker daemon is reachable (start Docker, or use --isolation host)');
  return ok ? 'docker' : 'host';
}

/** The build context and Dockerfile of a task directory (compose: the `client` service, terminal-bench's convention). */
export function buildSpecFor(dir: string): { context: string; dockerfile: string } | undefined {
  for (const c of ['docker-compose.yaml', 'docker-compose.yml']) {
    const f = path.join(dir, c);
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    // Read only what we need: services.client.build (string context, or {context, dockerfile}).
    const client = text.split(/\n(?=\s{2}\w[\w-]*:\s*$)/m).find((b) => /^\s{2}client:\s*$/m.test(b));
    if (client) {
      const ctx = client.match(/^\s+context:\s*["']?([^"'\n]+)/m)?.[1]?.trim() ?? client.match(/^\s+build:\s*["']?([^"'\n{][^"'\n]*)/m)?.[1]?.trim();
      const df = client.match(/^\s+dockerfile:\s*["']?([^"'\n]+)/m)?.[1]?.trim();
      const context = path.resolve(dir, ctx && !ctx.startsWith('$') ? ctx : '.');
      return { context, dockerfile: path.resolve(context, df ?? 'Dockerfile') };
    }
  }
  if (fs.existsSync(path.join(dir, 'Dockerfile'))) return { context: dir, dockerfile: path.join(dir, 'Dockerfile') };
  return undefined;
}

function hashDir(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) h.update(path.relative(dir, p)).update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 12);
}

const built = new Map<string, Promise<string>>();
/** The image to run: a named one, or one built (once per content hash) from the task's Dockerfile. */
export function ensureImage(d: TaskDocker, log?: (s: string) => void): Promise<string> {
  if (!d.build) {
    if (!d.image) return Promise.reject(new Error('task docker spec has neither image nor build'));
    return Promise.resolve(d.image);
  }
  const spec = buildSpecFor(d.build);
  if (!spec) return d.image ? Promise.resolve(d.image) : Promise.reject(new Error(`no Dockerfile or docker-compose.yaml in ${d.build}`));
  const tag = `oh-bench/${path.basename(d.build).toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}:${hashDir(spec.context)}`;
  let p = built.get(tag);
  if (!p) {
    p = (async () => {
      const exists = await docker(['image', 'inspect', tag], 30_000).then(() => true).catch(() => false);
      if (!exists) {
        log?.(`  building ${tag}`);
        try {
          await docker(['build', '-q', '-t', tag, '-f', spec.dockerfile, spec.context], 1_800_000);
        } catch (e) {
          throw new Error(`docker build for ${path.basename(d.build!)} failed: ${String((e as any).stderr ?? (e as Error).message).trim().slice(-800)}`);
        }
      }
      return tag;
    })();
    built.set(tag, p);
    p.catch(() => built.delete(tag));
  }
  return p;
}

/** Copy whatever the image put in its workdir into the (empty-ish) host workspace, so the bind mount hides nothing. */
async function seedFromImage(image: string, workdir: string, hostWork: string): Promise<void> {
  const id = (await docker(['create', image], 120_000)).trim();
  try {
    const tmp = fs.mkdtempSync(path.join(path.dirname(hostWork), '.oh-seed-'));
    try {
      await docker(['cp', `${id}:${workdir}/.`, tmp], 300_000);
      // The task's own files (already in the workspace) win over the image's copies.
      fs.cpSync(tmp, hostWork, { recursive: true, force: false, errorOnExist: false });
    } catch {
      /* the image has no such directory: nothing to seed */
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    await docker(['rm', '-f', id], 60_000).catch(() => undefined);
  }
}

export interface StartOptions {
  image: string;
  hostWork: string;
  workdir: string;
  network?: 'bridge' | 'none';
  setup?: string[];
  log?: (s: string) => void;
}

export async function startContainer(o: StartOptions): Promise<EvalContainer> {
  await seedFromImage(o.image, o.workdir, o.hostWork);
  const name = `oh-eval-${crypto.randomBytes(5).toString('hex')}`;
  // Root inside, like the official harnesses: the bind-mounted workspace must be writable whatever the image's USER is.
  await docker([
    'run', '-d', '--rm', '--name', name, '--init', '--user', '0:0',
    '--memory=4g', '--pids-limit=1024',
    '-v', `${o.hostWork}:${o.workdir}`, '-w', o.workdir,
    '--label', 'tugline.eval=1',
    '--entrypoint', 'sh', o.image, '-c', 'while :; do sleep 3600; done',
  ], 120_000);
  const shell = (await docker(['exec', name, 'sh', '-c', 'command -v bash || command -v sh'], 30_000).catch(() => '/bin/sh')).trim().split('\n')[0] || '/bin/sh';
  const c: EvalContainer = { name, workdir: o.workdir, hostWork: o.hostWork, shell };
  try {
    for (const cmd of o.setup ?? []) {
      o.log?.(`  setup: ${cmd}`);
      await docker(['exec', '-w', o.workdir, name, shell, '-c', cmd], 1_800_000).catch((e) => {
        throw new Error(`setup command failed in ${o.image}: ${cmd}\n${String(e.stderr || e.stdout || e.message).trim().slice(-800)}`);
      });
    }
    // Setup may need the network (installing a test runner); the agent then runs without it.
    if (o.network === 'none') await docker(['network', 'disconnect', 'bridge', name], 30_000);
  } catch (e) {
    await docker(['rm', '-f', name], 60_000).catch(() => undefined);
    throw e;
  }
  return c;
}

/** Copy the hidden test material in, after the agent has finished. */
export async function copyHiddenIn(c: EvalContainer, hostDir: string): Promise<void> {
  await docker(['exec', c.name, 'mkdir', '-p', HIDDEN_IN_CONTAINER], 30_000);
  await docker(['cp', `${hostDir}/.`, `${c.name}:${HIDDEN_IN_CONTAINER}`], 300_000);
}

/** argv for running a scorer command inside the container. */
export function execArgv(c: EvalContainer, command: string): string[] {
  return ['docker', 'exec', '-i', '-w', c.workdir, c.name, c.shell, '-c', command];
}

/** Give files the container created as root in the bind mount back to the host user (a no-op when the host runs as root). */
export async function releaseWorkspace(c: EvalContainer): Promise<void> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined && uid !== 0) await docker(['exec', c.name, 'chown', '-R', `${uid}:${gid}`, c.workdir], 120_000).catch(() => undefined);
}

export async function stopContainer(c: EvalContainer): Promise<void> {
  await releaseWorkspace(c);
  await docker(['rm', '-f', c.name], 60_000).catch(() => undefined);
}

/** Map a host path inside the workspace to the container path. */
export function containerPath(c: EvalContainer, hostPath: string): string {
  const rel = path.relative(c.hostWork, hostPath);
  if (!rel) return c.workdir;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return c.workdir;
  return path.posix.join(c.workdir, rel.split(path.sep).join('/'));
}

const SHELLS = /(^|\/)(bash|zsh|sh)$/;

/** The S0.7 wrapper: an agent command becomes `docker exec` in this run's container. */
export function dockerExecWrap(c: EvalContainer): (spec: SpawnSpec) => SpawnSpec {
  return (spec) => {
    const file = SHELLS.test(spec.file) ? c.shell : spec.file;
    const env = ['-e', 'TUGLINE=1', '-e', 'CI=1', '-e', 'PAGER=cat', '-e', 'GIT_PAGER=cat', '-e', 'PYTHONUNBUFFERED=1'];
    return {
      file: 'docker',
      args: ['exec', '-i', ...env, '-w', containerPath(c, spec.cwd), c.name, file, ...spec.args],
      cwd: c.hostWork,
      env: spec.env, // for the docker client only (PATH, DOCKER_HOST); none of it is passed into the container
    };
  };
}

registerCommandWrapper('ws8-eval-docker', (cfg: HarnessConfig) => (cfg.evalContainer ? dockerExecWrap(cfg.evalContainer) : undefined));
