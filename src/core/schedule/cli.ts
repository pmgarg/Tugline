/**
 * `tug schedule …` and `tug daemon` (SPEC H1), registered through the CLI
 * command registry (no edits to src/cli/main.ts).
 */
import { PERMISSION_MODES, YOLO_WARNING } from '../approver/modes.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerCliCommand } from '../commands.js';
import type { PermissionMode } from '../types.js';
import { SecretVault } from '../secrets/vault.js';
import { CronError, describeNext, parseCron, type CronTz } from './cron.js';
import { Daemon } from './daemon.js';
import { liveness } from './heartbeat.js';
import { Intake, type Admission } from './intake.js';
import { cancelWait, listWaiting, loadParked } from './parked.js';
import { morningReport } from './report.js';
import { runScheduled } from './run.js';
import { launchdPlist, servicePaths, systemdUnit } from './service.js';
import { addSchedule, getSchedule, loadSchedules, newScheduleId, recordActivity, removeSchedule, saveSchedules } from './store.js';
import { scheduleConfig, type Schedule, type Trigger } from './types.js';
import { LOOPBACK_NOTICE, webhookSecretName } from './webhook.js';

/** Minimal flag parser: --k v, --k=v, --flag; everything else is positional. */
export function parseFlags(argv: string[], booleans: string[] = []): { _: string[]; [k: string]: string | boolean | string[] } {
  const out: { _: string[]; [k: string]: string | boolean | string[] } = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) out[k] = a.slice(eq + 1);
      else if (booleans.includes(k) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) out[k] = true;
      else out[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

const MODES: PermissionMode[] = [...PERMISSION_MODES];

function describeTrigger(t: Trigger): string {
  switch (t.type) {
    case 'cron':
      return `cron "${t.cron}"${t.tz === 'local' ? ' (local time)' : ' (UTC)'}`;
    case 'watch':
      return `watch ${t.glob}`;
    case 'webhook':
      return 'webhook';
    case 'github':
      return `github ${t.events.join(',')}`;
  }
}

const USAGE = `tug schedule add (--cron "<expr>" [--tz local] | --watch "<glob>" | --webhook | --github "<event>[,<event>]") --prompt "<instruction>"
                [--workspace dir] [--profile name] [--mode ask|acceptEdits|plan|auto|yolo] [--name n]
                [--max-runs N] [--budget USD] [--run-budget USD] [--ignore-actor a,b]
                [--daily-tokens N] [--run-tokens N] [--daily-gpu-seconds S] [--run-gpu-seconds S] [--gpu-share 0..1]
                [--isolation wait|worktree]
tug schedule list [--json]          tug schedule remove <id>          tug schedule run-now <id> [--force]
tug schedule enable|disable <id>    tug schedule secret <id>          tug schedule report [--since 24h|7d|ISO]
tug schedule waits [<id>] [--json]  tug schedule cancel <handle>      tug schedule status
tug schedule install-service [--print] [--port N]

disable pauses a schedule: its parked waits stay dormant (events that arrive are kept) and resume when it is enabled.
remove and cancel invalidate parked waits. Budgets are reserved per run (reserve, then reconcile with what was spent).

Webhook and GitHub schedules are served by \`tug daemon\` on http://127.0.0.1:<schedule.port, default 7880>/hooks/<id>
(or on the server port with \`tug serve --with-daemon\`). ${LOOPBACK_NOTICE}`;

function parseSince(s: string | undefined, now = new Date()): Date | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d+)([hd])$/);
  if (m) return new Date(now.getTime() - Number(m[1]) * (m[2] === 'h' ? 3600_000 : 86_400_000));
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`--since expects 24h, 7d or an ISO date, got "${s}"`);
  return d;
}

registerCliCommand({
  name: 'schedule',
  description: 'scheduled tasks and event triggers (cron, file watch, webhook, GitHub)',
  usage: 'add|list|remove|run-now|enable|disable|waits|cancel|secret|report|status|install-service …',
  help: () => USAGE,
  needsModel: false,
  async run(argv, ctx) {
    const f = parseFlags(argv, ['json', 'webhook', 'force', 'print']);
    const sub = f._[0];
    const home = ctx.config.homeDir;
    const sc = scheduleConfig(ctx.config);
    const now = new Date();
    switch (sub) {
      case 'add': {
        const prompt = typeof f.prompt === 'string' ? f.prompt : f._.slice(1).join(' ');
        if (!prompt) {
          ctx.write(`a schedule needs --prompt "<instruction>"\n\n${USAGE}`);
          return 2;
        }
        let trigger: Trigger;
        if (typeof f.cron === 'string') {
          try {
            parseCron(f.cron);
          } catch (e) {
            ctx.write(`invalid --cron: ${(e as CronError).message}`);
            return 2;
          }
          trigger = { type: 'cron', cron: f.cron, tz: f.tz === 'local' ? 'local' : 'UTC' };
        } else if (typeof f.watch === 'string') trigger = { type: 'watch', glob: f.watch, debounceMs: f.debounce ? Number(f.debounce) : undefined };
        else if (typeof f.github === 'string') trigger = { type: 'github', events: f.github.split(',').map((x) => x.trim()).filter(Boolean) };
        else if (f.webhook) trigger = { type: 'webhook' };
        else {
          ctx.write(`choose a trigger: --cron, --watch, --webhook or --github\n\n${USAGE}`);
          return 2;
        }
        if (f.isolation !== undefined && f.isolation !== 'wait' && f.isolation !== 'worktree') {
          ctx.write('--isolation must be wait or worktree');
          return 2;
        }
        const mode = typeof f.mode === 'string' ? (f.mode as PermissionMode) : undefined;
        if (mode && !MODES.includes(mode)) {
          ctx.write(`--mode must be one of ${MODES.join(', ')}`);
          return 2;
        }
        const s: Schedule = {
          id: newScheduleId(),
          name: typeof f.name === 'string' ? f.name : undefined,
          trigger,
          prompt,
          workspace: path.resolve(ctx.workspace, typeof f.workspace === 'string' ? f.workspace : '.'),
          profile: typeof f.profile === 'string' ? f.profile : undefined,
          mode,
          maxRunsPerDay: f['max-runs'] ? Number(f['max-runs']) : undefined,
          dailyBudgetUsd: f.budget ? Number(f.budget) : undefined,
          runBudgetUsd: f['run-budget'] ? Number(f['run-budget']) : undefined,
          dailyTokens: f['daily-tokens'] ? Number(f['daily-tokens']) : undefined,
          runTokens: f['run-tokens'] ? Number(f['run-tokens']) : undefined,
          dailyGpuSeconds: f['daily-gpu-seconds'] ? Number(f['daily-gpu-seconds']) : undefined,
          runGpuSeconds: f['run-gpu-seconds'] ? Number(f['run-gpu-seconds']) : undefined,
          gpuShare: f['gpu-share'] ? Number(f['gpu-share']) : undefined,
          isolation: f.isolation === 'worktree' ? 'worktree' : f.isolation === 'wait' ? 'wait' : undefined,
          ignoreActors: typeof f['ignore-actor'] === 'string' ? f['ignore-actor'].split(',').map((x) => x.trim()) : undefined,
          enabled: true,
          createdAt: now.toISOString(),
        };
        addSchedule(home, s);
        ctx.write(`added ${s.id}${s.name ? ` (${s.name})` : ''}: ${describeTrigger(trigger)} in ${s.workspace}, mode ${s.mode ?? 'ask (headless: approvals are denied and recorded)'}`);
        if (trigger.type === 'cron') ctx.write(`next runs: ${describeNext(parseCron(trigger.cron), now, (trigger.tz ?? 'UTC') as CronTz, 3).join(', ')}`);
        if (mode === 'yolo') ctx.write(`warning: ${YOLO_WARNING}`);
        if (mode === 'auto') ctx.write('note: auto mode lets the safety classifier approve commands; anything it blocks or cannot check is denied and recorded (nobody is there to ask).');
        if (trigger.type === 'webhook' || trigger.type === 'github') {
          const secret = crypto.randomBytes(32).toString('hex');
          new SecretVault(home).set(webhookSecretName(s.id), secret);
          ctx.write(`webhook: POST http://${sc.host}:${sc.port}/hooks/${s.id}  (tug daemon, or the same path on tug serve)`);
          ctx.write(`secret (shown once; stored in the secrets vault as ${webhookSecretName(s.id)}): ${secret}`);
          ctx.write(trigger.type === 'github' ? 'GitHub: Settings → Webhooks → content type application/json, this secret, and the events you chose.' : 'Sign each body with HMAC-SHA256 and send X-OH-Signature: sha256=<hex> (or X-Hub-Signature-256).');
        }
        if (trigger.type === 'webhook' || trigger.type === 'github') ctx.write(LOOPBACK_NOTICE);
        ctx.write('Runs happen while `tug daemon` is running (or install it as a service: tug schedule install-service).');
        return 0;
      }
      case 'list': {
        const list = loadSchedules(home);
        if (f.json) {
          ctx.write(JSON.stringify(list, null, 2));
          return 0;
        }
        if (!list.length) {
          ctx.write('no schedules (tug schedule add …)');
          return 0;
        }
        for (const s of list) {
          const next = s.trigger.type === 'cron' ? (() => {
            try {
              return ` next ${describeNext(parseCron(s.trigger.cron), now, s.trigger.tz ?? 'UTC')[0] ?? 'never'}`;
            } catch {
              return ' (invalid cron)';
            }
          })() : '';
          ctx.write(`${s.id}${s.name ? ` ${s.name}` : ''}  ${s.enabled ? 'on ' : 'off'}  ${describeTrigger(s.trigger)}${next}  mode=${s.mode ?? 'ask'}  ${s.workspace}\n    ${s.prompt.slice(0, 100)}`);
        }
        return 0;
      }
      case 'remove': {
        const id = f._[1];
        const target = loadSchedules(home).find((x) => x.id === id || x.name === id);
        if (!id || !removeSchedule(home, id)) {
          ctx.write(`no schedule ${id ?? ''}`);
          return 1;
        }
        // v1.1 R3: removing a schedule invalidates its parked waits (they never resume).
        const cancelled = target ? listWaiting(home).filter((w) => w.scheduleId === target.id && cancelWait(home, w.handle, 'schedule removed')) : [];
        for (const w of cancelled) recordActivity(home, { kind: 'cancelled', scheduleId: w.scheduleId, runId: w.runId, handle: w.handle, reason: 'schedule_removed' });
        ctx.write(`removed ${id}${cancelled.length ? `; cancelled ${cancelled.length} parked wait(s)` : ''}`);
        return 0;
      }
      case 'waits': {
        const ws = listWaiting(home).filter((w) => !f._[1] || w.scheduleId === f._[1] || w.handle === f._[1]);
        const byId = new Map(loadSchedules(home).map((x) => [x.id, x]));
        if (f.json) {
          ctx.write(JSON.stringify(ws, null, 2));
          return 0;
        }
        if (!ws.length) ctx.write('no parked waits');
        for (const w of ws) {
          const sch = byId.get(w.scheduleId);
          const state = !sch ? 'orphaned' : !sch.enabled ? 'dormant (schedule disabled)' : w.pending ? `pending delivery (${w.pending.reason})` : 'waiting';
          ctx.write(`${w.handle}  ${w.scheduleId}  ${w.waitFor.event ? `event ${w.waitFor.event.type}` : `time ${w.waitFor.time}`}  ${state}\n    ${w.reason}`);
        }
        return 0;
      }
      case 'cancel': {
        const h = f._[1];
        const w = h ? loadParked(home, h) : undefined;
        if (!w || !cancelWait(home, w.handle, typeof f.reason === 'string' ? f.reason : 'cancelled by the user')) {
          ctx.write(`no parked wait ${h ?? ''} that is still waiting`);
          return 1;
        }
        recordActivity(home, { kind: 'cancelled', scheduleId: w.scheduleId, runId: w.runId, handle: w.handle, reason: 'user' });
        ctx.write(`cancelled ${w.handle}; run ${w.runId} will not resume`);
        return 0;
      }
      case 'enable':
      case 'disable': {
        const list = loadSchedules(home);
        const s = list.find((x) => x.id === f._[1] || x.name === f._[1]);
        if (!s) {
          ctx.write(`no schedule ${f._[1] ?? ''}`);
          return 1;
        }
        s.enabled = sub === 'enable';
        saveSchedules(home, list);
        // v1.1 R3: pause keeps parked waits dormant; enable reactivates them (the daemon delivers what arrived meanwhile).
        const dormant = listWaiting(home).filter((w) => w.scheduleId === s.id);
        ctx.write(`${s.id} ${s.enabled ? 'enabled' : 'disabled'}${dormant.length ? (s.enabled ? `; ${dormant.length} parked wait(s) active again (${dormant.filter((w) => w.pending).length} with an event to deliver on the next daemon tick)` : `; ${dormant.length} parked wait(s) dormant until enabled`) : ''}`);
        return 0;
      }
      case 'secret': {
        const s = getSchedule(home, f._[1] ?? '');
        if (!s || (s.trigger.type !== 'webhook' && s.trigger.type !== 'github')) {
          ctx.write('usage: tug schedule secret <webhook schedule id>  (rotates the HMAC secret)');
          return 1;
        }
        const secret = crypto.randomBytes(32).toString('hex');
        new SecretVault(home).set(webhookSecretName(s.id), secret);
        ctx.write(`new secret for ${s.id} (shown once): ${secret}`);
        return 0;
      }
      case 'run-now': {
        const s = loadSchedules(home).find((x) => x.id === f._[1] || x.name === f._[1]);
        if (!s) {
          ctx.write(`no schedule ${f._[1] ?? ''}`);
          return 1;
        }
        // A human pressed the button: the window governor still counts it unless --force.
        const intake = new Intake({ config: ctx.config });
        let adm: Admission | undefined;
        if (!f.force) {
          const gate = intake.admit(s, { for: 'run-now' });
          if ('reason' in gate) {
            recordActivity(home, { kind: 'refused', scheduleId: s.id, reason: gate.reason, detail: `run-now: ${gate.detail}` });
            ctx.write(`refused by the window governor: ${gate.detail} (use --force to run anyway)`);
            return 1;
          }
          adm = gate;
        }
        let rec: Awaited<ReturnType<typeof runScheduled>> | undefined;
        try {
          rec = await runScheduled({
            config: ctx.config,
            schedule: s,
            event: { id: `run-now-${now.getTime()}`, source: 'manual', type: 'manual', scheduleId: s.id, receivedAt: now.toISOString() },
            costCeilingUsd: adm?.ceiling,
            tokenCeiling: adm?.tokens,
            gpuSecondsCeiling: adm?.gpuSeconds,
            gpuShare: s.gpuShare ?? sc.gpuShare,
            onEvent: (e) => {
              if (e.type === 'tool_start') ctx.write(`  · ${e.title}`);
            },
          });
        } finally {
          if (adm) intake.reconcile(s, adm, rec);
        }
        recordActivity(home, { kind: 'acted', key: `manual/${rec.runId}`, scheduleId: s.id, runId: rec.runId, costUsd: rec.costUsd, stopReason: rec.stopReason, detail: `run-now: ${rec.status}` });
        ctx.write(`${rec.status} (${rec.stopReason}); ${rec.refusals.length} action(s) denied for lack of approval${rec.handle ? `; parked as ${rec.handle}` : ''}\n${rec.finalText ?? ''}`);
        return rec.status === 'error' ? 1 : 0;
      }
      case 'report': {
        ctx.write(morningReport(home, { since: parseSince(typeof f.since === 'string' ? f.since : undefined), staleMs: sc.staleMs }));
        return 0;
      }
      case 'status': {
        const l = liveness(home, sc.staleMs);
        ctx.write(`daemon: ${l.status}${l.ageMs !== undefined ? ` (last beat ${Math.round(l.ageMs / 1000)}s ago, pid ${l.heartbeat?.pid}${l.heartbeat?.url ? `, ${l.heartbeat.url}` : ''})` : ''}`);
        return l.ok ? 0 : 1;
      }
      case 'install-service': {
        const cli = path.resolve(fileURLToPath(import.meta.url), '../../../cli/main.js');
        const args = f.port ? ['--port', String(f.port)] : [];
        const spec = { node: process.execPath, cli, args, homeDir: home, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } };
        const p = servicePaths();
        const text = p.kind === 'launchd' ? launchdPlist(spec) : systemdUnit(spec);
        if (f.print) {
          ctx.write(text);
          return 0;
        }
        fs.mkdirSync(path.dirname(p.file), { recursive: true });
        fs.writeFileSync(p.file, text);
        ctx.write(`wrote ${p.file}\nload it with:   ${p.load}\nremove it with: ${p.unload}`);
        if (!fs.existsSync(cli)) ctx.write(`note: ${cli} does not exist yet; run \`npm run build\` first.`);
        return 0;
      }
      default:
        ctx.write(USAGE);
        return sub ? 2 : 0;
    }
  },
});

registerCliCommand({
  name: 'daemon',
  description: 'run the scheduler: cron, file watches, webhooks (127.0.0.1), parked waits, heartbeat',
  usage: '[--port N] [--no-listen]   (webhooks bind 127.0.0.1 only: put a TLS reverse proxy or tunnel in front for GitHub)',
  needsModel: false,
  async run(argv, ctx) {
    const f = parseFlags(argv, ['no-listen']);
    const d = new Daemon({ config: ctx.config, log: (s) => ctx.write(`${new Date().toISOString().slice(11, 19)} ${s}`) });
    let url: string | undefined;
    try {
      ({ url } = await d.start({ listen: !f['no-listen'], port: f.port ? Number(f.port) : undefined }));
    } catch (e) {
      await d.stop();
      ctx.write(`tug daemon: ${(e as Error).message}`);
      return 1;
    }
    const n = loadSchedules(ctx.config.homeDir).filter((s) => s.enabled).length;
    ctx.write(`tug daemon: ${n} schedule(s)${url ? `, webhooks on ${url}/hooks/<id>` : ''}, liveness ${url ? `${url}/hooks/_liveness` : 'heartbeat file only'}. Ctrl-C to stop.`);
    if (url) ctx.write(LOOPBACK_NOTICE);
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    ctx.write('stopping (waiting for running jobs)…');
    await d.stop();
    return 0;
  },
});
