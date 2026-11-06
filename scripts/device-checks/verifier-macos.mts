/**
 * [DEVICE] macOS check for the N35 verifier's command sandbox (review F21). Expected: every line PASS.
 *   node --import tsx scripts/device-checks/verifier-macos.mts
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifierSeatbeltProfile } from '../../src/core/context/goalVerifier.js';

if (process.platform !== 'darwin') {
  console.log('SKIP: not macOS');
  process.exit(0);
}
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-dev-ver-')));
fs.writeFileSync(path.join(ws, 'calc.py'), 'print(1+1)\n');
const srv = net.createServer((c) => c.end('x')).listen(0, '127.0.0.1');
await new Promise((r) => setTimeout(r, 200));
const port = (srv.address() as net.AddressInfo).port;
const run = (cmd: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', verifierSeatbeltProfile(ws), '/bin/sh', '-c', cmd], { cwd: ws, encoding: 'utf8' });
const check = (name: string, ok: boolean) => console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
check('reads the workspace', /1\+1/.test(run('cat calc.py').stdout));
check('runs python on the workspace', /^2/.test(run('python3 calc.py').stdout));
check('cannot write the workspace', run('echo x > calc.py').status !== 0 && fs.readFileSync(path.join(ws, 'calc.py'), 'utf8') === 'print(1+1)\n');
check('cannot read ~/.ssh', run('ls ~/.ssh').status !== 0);
check('no network (local port)', run(`curl -s --max-time 3 http://127.0.0.1:${port}/`).status !== 0);
check('no network (internet)', run('curl -s --max-time 5 https://example.com').status !== 0);
srv.close();
fs.rmSync(ws, { recursive: true, force: true });
