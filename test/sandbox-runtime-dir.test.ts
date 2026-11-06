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
