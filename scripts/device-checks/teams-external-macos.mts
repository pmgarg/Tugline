/**
 * [DEVICE] macOS check for N34 external members (review F4): the deny-by-default Seatbelt profile.
 * Run on the Mac:  node --import tsx scripts/device-checks/teams-external-macos.mts
 * Expected: every line PASS.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { externalSeatbeltProfile } from '../../src/core/agent/team/external.js';

if (process.platform !== 'darwin') {
  console.log('SKIP: not macOS');
  process.exit(0);
}
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-dev-ext-')));
const wt = path.join(base, 'wt');
const state = path.join(base, 'state');
const other = path.join(base, 'other-member-wt');
for (const d of [wt, state, other]) fs.mkdirSync(d);
fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /x\n');
const proxy = net.createServer((c) => c.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok')).listen(0, '127.0.0.1');
const blocked = net.createServer((c) => c.end('no')).listen(0, '127.0.0.1');
await new Promise((r) => setTimeout(r, 200));
const pp = (proxy.address() as net.AddressInfo).port;
const bp = (blocked.address() as net.AddressInfo).port;
const profile = externalSeatbeltProfile({ worktree: wt, state, proxyPort: pp, readOnly: [path.dirname(path.dirname(process.execPath))] });
const run = (cmd: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/bash', '-c', cmd], { cwd: wt, encoding: 'utf8' });
const check = (name: string, ok: boolean, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
check('write in the worktree', run('echo x > ok.txt').status === 0 && fs.existsSync(path.join(wt, 'ok.txt')));
check('write in its state dir', run(`echo x > ${state}/s.txt`).status === 0);
check('no write to another member worktree in TMPDIR', run(`echo x > ${other}/pwn.txt`).status !== 0 && !fs.existsSync(path.join(other, 'pwn.txt')));
check('no write to the worktree .git file', run('echo x > .git').status !== 0);
check('no read of ~/.ssh', run('ls ~/.ssh').status !== 0);
check('no read of ~/.tugline', run('cat ~/.tugline/config.json').status !== 0);
check('no read of TMPDIR outside its dirs', run(`ls ${path.dirname(base)}`).status !== 0);
check('proxy port reachable', /ok/.test(run(`curl -s http://127.0.0.1:${pp}/`).stdout));
check('other local port blocked', !/no/.test(run(`curl -s --max-time 3 http://127.0.0.1:${bp}/`).stdout));
check('external network blocked', run('curl -s --max-time 5 https://example.com').status !== 0);
proxy.close();
blocked.close();
fs.rmSync(base, { recursive: true, force: true });
