#!/usr/bin/env node
/**
 * Smoke test of the exact artefacts we distribute (R7): the npm tarball and the .vsix.
 *
 *   node scripts/smoke-artefacts.mjs [--tgz tugline-x.y.z.tgz] [--vsix file.vsix] [--out dir]
 *
 * npm package: `npm pack` (unless --tgz is given; needs `npm run build` first),
 * install the tarball into an empty temp project, then run the installed `tug`
 * through its npm bin shim:
 *   tug --version   equals package.json's version
 *   tug --help      lists the subcommands
 *   tug doctor      against scripts/mock-openai.mjs: reachable, chat and native tool calls work
 *   tug -p "…"      one headless prompt answered by the mock
 * .vsix: list the zip's central directory (no `unzip` needed, so it also runs on
 * Windows) and check the files the extension needs are there and dev files are not.
 * Exits non-zero on any failure. Cross-platform: Linux, macOS, Windows.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startMockOpenAI } from './mock-openai.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

// ------------------------------------------------------------ zip reading (central directory)

/** Entries of a zip file: name, sizes, and where the local header is. */
export function listZip(file) {
  const buf = fs.readFileSync(file);
  // End of central directory record: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${file}: not a zip file (no end of central directory)`);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`${file}: bad central directory entry ${n}`);
    const method = buf.readUInt16LE(off + 10);
    const compressed = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    entries.push({ name: buf.toString('utf8', off + 46, off + 46 + nameLen), method, compressed, size, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The uncompressed bytes of one zip entry (stored or deflated). */
export function readZipEntry(file, entry) {
  const buf = fs.readFileSync(file);
  const l = entry.local;
  if (buf.readUInt32LE(l) !== 0x04034b50) throw new Error(`${file}: bad local header for ${entry.name}`);
  const start = l + 30 + buf.readUInt16LE(l + 26) + buf.readUInt16LE(l + 28);
  const data = buf.subarray(start, start + entry.compressed);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`${entry.name}: unsupported zip method ${entry.method}`);
}

/** Problems with a .vsix's structure (empty = fine). */
export function checkVsix(file, expectVersion) {
  const problems = [];
  const entries = listZip(file);
  const names = new Set(entries.map((e) => e.name));
  const has = (n) => names.has(n);
  const hasDir = (d) => entries.some((e) => e.name.startsWith(d));
  for (const n of ['[Content_Types].xml', 'extension.vsixmanifest', 'extension/package.json', 'extension/dist/extension.js', 'extension/media/icon.png', 'extension/media/main.js', 'extension/media/main.css']) if (!has(n)) problems.push(`missing ${n}`);
  if (!has('extension/LICENSE.txt') && !has('extension/LICENSE')) problems.push('missing extension/LICENSE(.txt)');
  for (const d of ['extension/resources/skills/', 'extension/resources/agents/']) if (!hasDir(d)) problems.push(`missing ${d}`);
  for (const d of ['extension/src/', 'extension/node_modules/', 'extension/scripts/']) if (hasDir(d)) problems.push(`dev files shipped: ${d}`);
  const maps = entries.filter((e) => e.name.endsWith('.map')).map((e) => e.name);
  if (maps.length) problems.push(`source maps shipped: ${maps.join(', ')}`);
  const pj = entries.find((e) => e.name === 'extension/package.json');
  if (pj) {
    const pkg = JSON.parse(readZipEntry(file, pj).toString('utf8'));
    const main = path.posix.normalize(path.posix.join('extension', pkg.main ?? ''));
    if (!has(main)) problems.push(`package.json main ${pkg.main} is not in the vsix`);
    if (expectVersion && pkg.version !== expectVersion) problems.push(`vsix version ${pkg.version} != ${expectVersion}`);
    const js = entries.find((e) => e.name === main);
    if (js && js.size < 10_000) problems.push(`${main} is only ${js.size} bytes`);
  }
  return problems;
}

// ------------------------------------------------------------ npm package

/**
 * Run a command and collect its output. Asynchronous on purpose: the mock
 * endpoint lives in this process, and spawnSync would block the event loop it
 * needs to answer `tug doctor`.
 */
function run(file, args, o = {}) {
  // npm and the bin shims are .cmd files on Windows, which need a shell to start
  // (Node refuses to spawn .cmd without one); the shell joins argv with spaces, so quote.
  const shell = isWin && /\.cmd$|^npm$/i.test(file);
  const q = (a) => (shell && /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  const { timeout = 300_000, ...rest } = o;
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(shell ? q(file) : file, args.map(q), { shell, stdio: ['ignore', 'pipe', 'pipe'], ...rest });
    const t = setTimeout(() => {
      out += `\n[timed out after ${timeout} ms]`;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => (out += `\n${e.message}`));
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

async function smokeNpm(tgz, failures, log) {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-smoke-'));
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'oh-smoke', private: true, version: '0.0.0' }));
    const inst = await run('npm', ['install', '--no-audit', '--no-fund', '--omit=optional', path.resolve(tgz)], { cwd: tmp });
    if (inst.code !== 0) {
      failures.push(`npm install ${path.basename(tgz)} failed:\n${inst.out.slice(-2000)}`);
      return;
    }
    const bin = path.join(tmp, 'node_modules', '.bin', isWin ? 'tug.cmd' : 'tug');
    if (!fs.existsSync(bin)) {
      failures.push(`the package installed no "tug" bin shim (${bin})`);
      return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-smoke-home-'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-smoke-ws-'));
    const mock = await startMockOpenAI();
    const env = { ...process.env, HOME: home, USERPROFILE: home, TUG_BASE_URL: mock.url, TUG_MODEL: 'mock-model', TUG_API_KEY: 'sk-smoke-1234567890abcdef', NO_COLOR: '1' };
    for (const k of Object.keys(env)) if (/^(https?|all)_proxy$/i.test(k)) delete env[k];
    const oh = (args) => run(bin, args, { cwd: ws, env, timeout: 120_000 });
    try {
      const v = await oh(['--version']);
      log(`tug --version → ${v.out.trim()}`);
      if (v.code !== 0 || v.out.trim() !== version) failures.push(`tug --version printed "${v.out.trim()}" (exit ${v.code}), expected ${version}`);
      const h = await oh(['--help']);
      if (h.code !== 0 || !/tug doctor/.test(h.out) || !/tug eval/.test(h.out)) failures.push(`tug --help (exit ${h.code}) does not list the subcommands:\n${h.out.slice(0, 1500)}`);
      else log('tug --help → lists doctor, eval, …');
      const d = await oh(['doctor']);
      const dout = strip(d.out);
      log(`tug doctor →\n${dout.split('\n').map((l) => `    ${l}`).join('\n')}`);
      for (const [re, what] of [
        [/reachable:\s+yes/, 'endpoint reachable'],
        [/chat works:\s+yes/, 'chat works'],
        [/native tool calls:\s+yes/, 'native tool calls'],
        [/skills\s+\S/, 'bundled skills listed'],
      ])
        if (!re.test(dout)) failures.push(`tug doctor: no "${what}" (exit ${d.code})`);
      if (d.code !== 0) failures.push(`tug doctor exited ${d.code}`);
      const p = await oh(['-p', 'Reply with exactly: SMOKE-OK', '--no-mcp']);
      if (p.code !== 0 || !/SMOKE-OK/.test(p.out)) failures.push(`tug -p (exit ${p.code}) did not answer:\n${p.out.slice(-1500)}`);
      else log('tug -p → SMOKE-OK');
    } finally {
      await mock.close();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const arg = (n) => {
    const i = process.argv.indexOf(n);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const failures = [];
  const log = (s) => console.log(`  ${s}`);
  const out = path.resolve(arg('--out') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'oh-pack-')));
  let tgz = arg('--tgz');
  if (!tgz) {
    if (!fs.existsSync(path.join(ROOT, 'dist', 'cli', 'main.js'))) throw new Error('dist/ is missing: run `npm run build` first (or pass --tgz)');
    fs.mkdirSync(out, { recursive: true });
    const p = await run('npm', ['pack', '--json', '--pack-destination', out], { cwd: ROOT });
    if (p.code !== 0) throw new Error(`npm pack failed:\n${p.out}`);
    const info = JSON.parse(p.out.slice(p.out.indexOf('[')));
    tgz = path.join(out, info[0].filename);
    const files = info[0].files.map((f) => f.path);
    for (const need of ['dist/cli/main.js', 'dist/core/index.js', 'package.json', 'README.md']) if (!files.includes(need)) failures.push(`npm package lacks ${need}`);
    if (!files.some((f) => f.startsWith('skills/'))) failures.push('npm package lacks the bundled skills/');
    if (files.some((f) => f.startsWith('src/') || f.startsWith('test/'))) failures.push('npm package ships src/ or test/');
  }
  console.log(`npm package: ${tgz}`);
  await smokeNpm(tgz, failures, log);
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode', 'package.json'), 'utf8')).version;
  const vsix = arg('--vsix') ?? fs.readdirSync(path.join(ROOT, 'vscode')).filter((f) => f.endsWith('.vsix')).map((f) => path.join(ROOT, 'vscode', f))[0];
  if (vsix) {
    console.log(`vsix: ${vsix}`);
    const problems = checkVsix(vsix, version);
    for (const p of problems) failures.push(`vsix: ${p}`);
    if (!problems.length) log(`${listZip(vsix).length} entries, required files present`);
  } else if (process.argv.includes('--require-vsix')) failures.push('no .vsix found (run `npm run vscode:package` or pass --vsix)');
  else console.log('vsix: none found, skipped (pass --vsix or --require-vsix)');
  if (failures.length) {
    console.error(`\nSMOKE FAILED (${failures.length}):\n${failures.map((f) => `- ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('\nsmoke OK');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.error(`smoke: ${e.message}`);
    process.exit(1);
  });
}
