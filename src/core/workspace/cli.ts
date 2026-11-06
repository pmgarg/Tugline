/**
 * `tug lease` (v1.1 R9): who is writing in which workspace.
 *
 *   tug lease status [--json] [--all]   this workspace's lease (--all: every lease under the home)
 *   tug lease break [--workspace dir]   remove a lease by hand (e.g. a holder on another host that is gone)
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerCliCommand } from '../commands.js';
import { parseFlags } from '../schedule/cli.js';
import { describeHolder, leaseConfig, leaseFile, listWorkspaceLeases, workspaceLeaseStatus } from './lease.js';

registerCliCommand({
  name: 'lease',
  description: 'workspace ownership: which session, schedule or job is writing in a workspace',
  usage: 'status [--all] [--json] | break [--workspace dir]',
  needsModel: false,
  async run(argv, ctx) {
    const f = parseFlags(argv, ['json', 'all']);
    const home = ctx.config.homeDir;
    const lc = leaseConfig(ctx.config);
    const ws = path.resolve(ctx.workspace, typeof f.workspace === 'string' ? f.workspace : '.');
    switch (f._[0] ?? 'status') {
      case 'status': {
        const rows = f.all ? listWorkspaceLeases(home, lc.staleMs) : [workspaceLeaseStatus(home, ws, lc.staleMs)];
        if (f.json) {
          ctx.write(JSON.stringify(rows, null, 2));
          return 0;
        }
        if (!rows.length || rows.every((r) => !r.held)) ctx.write(f.all ? 'no workspace leases' : `${ws}: free`);
        for (const r of rows) if (r.held && r.lease) ctx.write(`${r.workspace}: ${describeHolder(r.lease)}${r.stale ? ' — STALE (the next writer takes it over)' : ''}, heartbeat ${r.lease.heartbeatAt}`);
        return 0;
      }
      case 'break': {
        const file = leaseFile(home, ws);
        if (!fs.existsSync(file)) {
          ctx.write(`${ws}: no lease`);
          return 1;
        }
        fs.rmSync(file, { force: true });
        ctx.write(`${ws}: lease removed`);
        return 0;
      }
      default:
        ctx.write('usage: tug lease status [--all] [--json] | tug lease break [--workspace dir]');
        return 2;
    }
  },
});
