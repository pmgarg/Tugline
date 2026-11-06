/**
 * V0.1 driver: the VS Code extension host path (v1.2 N45). Each scenario launches a real VS Code (the E2E
 * harness's @vscode/test-electron and cached build, under Xvfb) on the scenario's workspace, with HOME set to the
 * scenario's fake home, so the extension builds its config the way it does for a user (loadConfig + explicit
 * settings + managed policy). The chat panel's approval prompts come to `ctx.human` over a token-protected
 * loopback control endpoint and are answered through the panel's own reply message.
 */
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { HumanPrompt, SurfaceDriver, SurfaceResult } from '../types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const VSC = path.join(ROOT, 'vscode');
let ownDisplay: string | undefined;
let xvfb: ChildProcess | undefined;

function cachedVersion(): string | undefined {
  const dir = path.join(VSC, '.vscode-test');
  const d = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => /^vscode-linux-x64-\d/.test(n)) : undefined;
  return d?.replace('vscode-linux-x64-', '');
}

export const driver: SurfaceDriver = {
  id: 'vscode-host',
  label: 'VS Code extension host (chat panel)',
  skip: () => (process.platform !== 'linux' ? 'the VS Code driver runs under Xvfb on Linux' : !cachedVersion() && !process.env.CI ? 'no cached VS Code build in vscode/.vscode-test (run the VS Code E2E once)' : false),
  async setup() {
    // the bundle includes the core (src/): rebuild when any source file is newer (a merge changes core files only)
    const newest = (dir: string): number => {
      let m = 0;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        m = Math.max(m, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
      }
      return m;
    };
    const dist = path.join(VSC, 'dist', 'extension.js');
    if (!fs.existsSync(dist) || fs.statSync(dist).mtimeMs < Math.max(newest(path.join(VSC, 'src')), newest(path.join(VSC, '..', 'src')))) {
      const b = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: VSC, stdio: 'pipe' });
      if (b.status !== 0) throw new Error(`extension build failed: ${b.stderr}`);
    }
    if (!process.env.DISPLAY) {
      // Xvfb picks a free display itself (-displayfd). A random :90-:98 collided when several test files ran this
      // driver in parallel (CI): one file's teardown killed the X server the other's VS Code was using.
      const x = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
      xvfb = x;
      const num = await new Promise<string>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('Xvfb did not report a display in 15 s')), 15_000);
        (x.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => {
          buf += d.toString();
          if (buf.includes('\n')) {
            clearTimeout(timer);
            resolve(buf.trim());
          }
        });
        x.once('exit', (c) => (clearTimeout(timer), reject(new Error(`Xvfb exited (${c})`))));
      });
      const disp = `:${num}`;
      process.env.DISPLAY = disp;
      ownDisplay = disp;
    }
  },
  async teardown() {
    xvfb?.kill();
    xvfb = undefined;
    // a second setup (another suite in the same process) must start its own display, not reuse the dead one
    if (ownDisplay && process.env.DISPLAY === ownDisplay) delete process.env.DISPLAY;
    ownDisplay = undefined;
  },
  async run(ctx) {
    const token = crypto.randomBytes(16).toString('hex');
    const prompts: HumanPrompt[] = [];
    let result: SurfaceResult | undefined;
    const srv = http.createServer((req, res) => {
      if (req.headers['x-conformance-token'] !== token || req.method !== 'POST') {
        res.writeHead(403);
        res.end();
        return;
      }
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', async () => {
        const body = JSON.parse(b || '{}');
        if (req.url === '/human') {
          prompts.push(body);
          const decision = await ctx.human(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ decision }));
        } else if (req.url === '/result') {
          result = { stopReason: body.stopReason, finalText: body.finalText, output: body.output ?? '', prompts };
          res.writeHead(200);
          res.end('{}');
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    ctx.defer(() => new Promise<void>((r) => srv.close(() => r())));
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-conf-vsc-'));
    ctx.defer(() => fs.rmSync(userData, { recursive: true, force: true }));
    fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false }));
    const req = createRequire(path.join(VSC, 'package.json'));
    const { runTests } = req('@vscode/test-electron');
    await runTests({
      version: cachedVersion() ?? 'stable',
      cachePath: path.join(VSC, '.vscode-test'),
      extensionDevelopmentPath: VSC,
      extensionTestsPath: path.join(VSC, 'test', 'conformanceSuite.cjs'),
      extensionTestsEnv: { ...ctx.env, TUG_CONF_URL: `http://127.0.0.1:${(srv.address() as any).port}/`, TUG_CONF_TOKEN: token, TUG_CONF_PROMPT: ctx.prompt },
      launchArgs: [ctx.workspace, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
    });
    if (!result) throw new Error('the extension host did not report a result');
    return result;
  },
};
