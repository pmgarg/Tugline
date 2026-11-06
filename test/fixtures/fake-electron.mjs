#!/usr/bin/env node
// A stand-in for an Electron app relaunched with a debugging port (F5 cleanup, R7).
// Serves /json/version on --remote-debugging-port and starts two helpers that
// carry the --user-data-dir, like Chrome's:
//   - a renderer in the app's process group (killed with the group),
//   - a crash handler that leaves the group and is reparented (double fork + setsid),
//     as Chrome's crashpad handler does on macOS.
import http from 'node:http';
import { spawn } from 'node:child_process';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const port = Number(arg('remote-debugging-port'));
const profile = arg('user-data-dir') ?? '';
const keep = 'setInterval(() => {}, 1000)';
spawn(process.execPath, ['-e', keep, '--', '--type=renderer', `--user-data-dir=${profile}`], { stdio: 'ignore' });
// Double fork: the intermediate starts the handler detached (setsid) and exits, so it is reparented at once.
const forker = "require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], '--', '--type=crashpad-handler', process.argv[2]], { stdio: 'ignore', detached: true }).unref();";
spawn(process.execPath, ['-e', forker, keep, `--database=${profile}/Crashpad`], { stdio: 'ignore' });
http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'FakeElectron/1.0', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }));
  })
  .listen(port, '127.0.0.1');
