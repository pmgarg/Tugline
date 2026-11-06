/**
 * CI found it (GitHub ubuntu-24.04, XDG_RUNTIME_DIR=/run/user/1001): with $XDG_RUNTIME_DIR under /run, bwrap could
 * not create its mount point inside the already-hidden, read-only /run, so every sandboxed command failed. On a
 * Linux desktop $XDG_RUNTIME_DIR is /run/user/<uid>.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hardenedBwrapBase, runnerAvailable } from '../src/core/sandbox/index.js';

test('bwrap: $XDG_RUNTIME_DIR inside /run is covered by the hidden /run (commands still run, its sockets stay hidden)', { skip: process.platform !== 'linux' && 'Linux only' }, (t) => {
  if (!runnerAvailable('bwrap')) return t.skip('bwrap is not available');
  const sub = fs.readdirSync('/run', { withFileTypes: true }).find((d) => d.isDirectory() && !d.isSymbolicLink());
  if (!sub) return t.skip('no directory under /run');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-xdg-'));
  const prev = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = path.join('/run', sub.name);
  try {
    const base = hardenedBwrapBase({ workspace: ws });
    assert.ok(!base.join(' ').includes(`--tmpfs ${process.env.XDG_RUNTIME_DIR} `), 'no second mount inside the hidden /run');
    const r = spawnSync('bwrap', [...base, '--bind', ws, ws, '--', '/bin/sh', '-c', `ls -A ${process.env.XDG_RUNTIME_DIR} 2>&1; echo ran`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ran/);
    const inside = r.stdout.replace(/ran\s*$/, '');
    const host = fs.readdirSync(process.env.XDG_RUNTIME_DIR!);
    assert.ok(!host.some((n) => inside.split(/\s+/).includes(n)), `none of the host's runtime entries is visible: ${inside}`);
  } finally {
    if (prev === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prev;
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('bwrap: a resolver file under /run (systemd-resolved) is bound before /run is made read-only, so host-network commands run', { skip: process.platform !== 'linux' && 'Linux only' }, (t) => {
  if (!runnerAvailable('bwrap')) return t.skip('bwrap is not available');
  // any regular file two levels under /run stands in for /run/systemd/resolve/stub-resolv.conf
  let file: string | undefined;
  for (const d of fs.readdirSync('/run', { withFileTypes: true })) {
    if (!d.isDirectory() || d.isSymbolicLink()) continue;
    try {
      const f = fs.readdirSync(path.join('/run', d.name), { withFileTypes: true }).find((x) => x.isFile());
      if (f) { file = path.join('/run', d.name, f.name); break; }
    } catch {
      /* unreadable */
    }
  }
  if (!file) return t.skip('no file under /run');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-resolv-'));
  try {
    const base = hardenedBwrapBase({ workspace: ws, keepResolver: true, resolverFiles: [file] });
    const bind = base.findIndex((x, i) => x === '--ro-bind' && base[i + 1] === file);
    const remount = base.findIndex((x, i) => x === '--remount-ro' && base[i + 1] === '/run');
    assert.ok(bind > 0 && remount > bind, `bound before /run is made read-only: ${base.join(' ')}`);
    const r = spawnSync('bwrap', [...base, '--', '/bin/sh', '-c', `test -f ${file} && echo seen; touch /run/x 2>/dev/null && echo writable || echo ro`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /seen/);
    assert.match(r.stdout, /ro/, '/run stays read-only');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
