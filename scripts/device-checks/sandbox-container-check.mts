/**
 * N36 AC5 [DEVICE] Part B helper (run by sandbox-container-macos.sh; also works on Linux):
 * a mock model on all interfaces, `node dist/cli/main.js --container <engine> -p …`, then the checks.
 * Prints PASS/FAIL lines. Argument: docker | podman.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const engine = process.argv[2] ?? 'docker';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const base = fs.mkdtempSync(path.join(os.homedir(), '.oh-n36-ct-'));
const ws = path.join(base, 'ws');
const home = path.join(base, 'home');
fs.mkdirSync(ws);
fs.mkdirSync(path.join(home, '.tugline'), { recursive: true });
fs.writeFileSync(path.join(home, 'HOST-CANARY.txt'), 'host-home-canary');
const hostCfg = path.join(home, '.tugline', 'config.json');
fs.writeFileSync(hostCfg, JSON.stringify({ permissionMode: 'yolo', agent: { requireVerification: false }, checkpoints: { enabled: false }, sandbox: { allowDomainsPreset: [], runner: 'auto' } }));
// review finding 8: another service on the Mac's localhost (Docker Desktop: host.docker.internal reaches it), not allowlisted
const other = http.createServer((_q, r) => r.end('OTHER-HOST-SERVICE'));
await new Promise<void>((r) => other.listen(0, '0.0.0.0', () => r()));
const oport = (other.address() as any).port;
const gw = engine === 'docker' ? 'host.docker.internal' : 'host.containers.internal';
// paths assembled at run time (the in-container permission engine would ask, and nobody answers -p)
fs.writeFileSync(path.join(ws, '.envname'), 'environ\n');
fs.writeFileSync(path.join(ws, '.t'), `${hostCfg}\n`);
const steps = [
  `echo made-in-container > made.txt; cat ${home}/HOST-CANARY.txt; echo home-rc=$?`,
  `(exec 3<>/dev/tcp/1.1.1.1/80) 2>&1; echo direct-rc=$?`,
  `node -e "require('http').get('http://example.org/',r=>console.log('blocked-status:'+r.statusCode)).on('error',e=>console.log('blocked-err:'+e.message))"`,
  // finding 8: the model host's other ports are not reachable through the proxy
  `node -e "require('http').get('http://${gw}:${oport}/',r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log('other:'+r.statusCode+':'+b))}).on('error',e=>console.log('other-err:'+e.message))"`,
  // finding 7: no process environment in the container holds the key
  `for i in $(ls /proc | grep -E '^[0-9]+$'); do tr '\\0' '\\n' < /proc/$i/$(cat .envname) 2>/dev/null; done | grep -c "sk-device-ch[e]ck"; echo key-scan-done`,
  // re-check RC-1: crafted model-relay paths are refused (encoded dot segments, another origin), the model path works
  `node -e "const h=require('http');const g=(n,p)=>new Promise(r=>h.get({host:'127.0.0.1',port:3129,path:p},x=>{x.resume();console.log(n+':'+x.statusCode);r()}).on('error',e=>{console.log(n+'-err:'+e.message);r()}));(async()=>{await g('relay-dots','/m0/v1/%2e%2e/admin');await g('relay-origin','/m0//${gw}:${oport}/x');await g('relay-ok','/m0/v1/models')})()"`,
  // finding 2: plant links where the host used to write the next session's config
  `t=$(cat .t); ln -sfn "$t" "$HOME/.tugline/config.json" 2>&1; ln -sfn "$t" "$HOME/.tugline/trusted-workspaces.json" 2>&1; echo planted`,
];
const reqs: any[] = [];
let firstTools: string[] = [];
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.method === 'GET') return void res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    const body = JSON.parse(b);
    reqs.push(body);
    const step = body.messages.filter((m: any) => m.role === 'tool').length;
    const msg = step < steps.length ? { role: 'assistant', content: '', tool_calls: [{ id: `c${step}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: steps[step] }) } }] } : { role: 'assistant', content: 'container task done' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
});
await new Promise<void>((r) => srv.listen(0, '0.0.0.0', () => r()));
const port = (srv.address() as any).port;
const child = spawn(process.execPath, [path.join(root, 'dist/cli/main.js'), '--container', engine, '-p', 'make the file'], { cwd: ws, env: { ...process.env, HOME: home, TUG_BASE_URL: `http://127.0.0.1:${port}/v1`, TUG_MODEL: 'mock-model', TUG_API_KEY: 'sk-device-check-0123456789', TUG_CONTEXT_WINDOW: '32768' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const code = await new Promise<number | null>((r) => child.on('close', r));
firstTools = reqs.slice(1).map((r) => String(r.messages.at(-1).content));
// finding 2: a second session of the same project; the host config must be unchanged afterwards
const before = fs.readFileSync(hostCfg, 'utf8');
reqs.length = 0;
steps.length = 0;
const child2 = spawn(process.execPath, [path.join(root, 'dist/cli/main.js'), '--container', engine, '-p', 'second session'], { cwd: ws, env: { ...process.env, HOME: home, TUG_BASE_URL: `http://127.0.0.1:${port}/v1`, TUG_MODEL: 'mock-model', TUG_API_KEY: 'sk-device-check-0123456789', TUG_CONTEXT_WINDOW: '32768' }, stdio: ['ignore', 'pipe', 'pipe'] });
child2.stdout.on('data', (d) => (out += d));
child2.stderr.on('data', (d) => (out += d));
const code2 = await new Promise<number | null>((r) => child2.on('close', r));
srv.close();
other.close();
const tools = firstTools;
const check = (name: string, ok: boolean) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
check(`tug --container ${engine} completes the mock task (exit ${code})`, code === 0 && fs.existsSync(path.join(ws, 'made.txt')));
check('the host home is not visible inside the container', /home-rc=1/.test(tools[0] ?? '') && !(tools[0] ?? '').includes('host-home-canary'));
check('a direct connection fails (no route out but the proxy)', /direct-rc=1/.test(tools[1] ?? ''));
check('a non-allowlisted host is refused by the proxy (403)', /blocked-status:403/.test(tools[2] ?? ''));
check(`another service on the Mac's localhost (${gw}:${oport}) is NOT reachable (review finding 8)`, !/OTHER-HOST-SERVICE/.test(tools[3] ?? '') && /other:403|other-err/.test(tools[3] ?? ''));
check('the API key is in no process environment of the agent container (review finding 7)', /^0$/m.test(tools[4] ?? ''));
check('the model relay refuses crafted paths (encoded "..", another origin) and serves the model path (re-check RC-1)', /relay-dots:403/.test(tools[5] ?? '') && /relay-origin:403/.test(tools[5] ?? '') && /relay-ok:200/.test(tools[5] ?? ''));
check(`a second session leaves the host user config unchanged after links were planted (review finding 2; exit ${code2})`, code2 === 0 && fs.readFileSync(hostCfg, 'utf8') === before && !fs.lstatSync(hostCfg).isSymbolicLink());
const left = execFileSync(engine, ['ps', '-a', '--filter', 'label=tugline.session', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim();
check('no session container left behind', left === '');
if (code !== 0) console.log(out.slice(-3000));
fs.rmSync(base, { recursive: true, force: true });
