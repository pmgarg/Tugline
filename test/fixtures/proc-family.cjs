// A process family like Chrome's on macOS (R7 killProcessTree tests): this
// process (run detached, so it leads a process group), a child in its group,
// and a helper that left the group and was reparented (double fork + setsid,
// as Chrome's crashpad handler does). Prints [childPid, helperPid] and waits.
//   node proc-family.cjs <marker>
const { spawn, execFileSync } = require('node:child_process');

const marker = process.argv[2];
const keep = 'setInterval(() => {}, 1000)';
const child = spawn(process.execPath, ['-e', keep, '--', `${marker}-child`], { stdio: 'ignore' });
// The intermediate starts the helper detached (setsid) and exits, so the helper is no longer our descendant.
const forker = "const c = require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], '--', process.argv[2]], { stdio: 'ignore', detached: true }); c.unref(); console.log(c.pid);";
const helper = Number(execFileSync(process.execPath, ['-e', forker, keep, `${marker}-escaped`]).toString().trim());
console.log(JSON.stringify([child.pid, helper]));
setInterval(() => {}, 1000);
