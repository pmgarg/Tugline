// Tiny static server for the browser test site (tests and the evals/browser suite).
// Plain .mjs so both tsx tests and the compiled CLI can import it.
//
//   import { startSiteServer } from './serve.mjs';
//   const site = await startSiteServer();          // random port on 127.0.0.1
//   site.url  -> http://127.0.0.1:PORT/
//   await site.close();
//
// Extra routes for precondition tests:
//   /__status/<code>        responds with that HTTP status
//   /__redirect?to=<url>    302 to <url> (SSRF re-check after redirects)
//
// CLI: node evals/browser/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SITE_DIR = path.join(here, 'site');

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.csv': 'text/csv', '.txt': 'text/plain', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

export async function startSiteServer(opts = {}) {
  const root = path.resolve(opts.root ?? SITE_DIR);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const status = u.pathname.match(/^\/__status\/(\d{3})$/);
    if (status) {
      res.writeHead(Number(status[1]), { 'Content-Type': 'text/html' });
      res.end(`<html><head><title>${status[1]}</title></head><body><h1>HTTP ${status[1]}</h1><p>Too many requests from your network.</p></body></html>`);
      return;
    }
    if (u.pathname === '/__redirect') {
      res.writeHead(302, { Location: u.searchParams.get('to') ?? '/' });
      res.end();
      return;
    }
    let rel = decodeURIComponent(u.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Not found</title></head><body><h1>404</h1></body></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(opts.port ?? 0, '127.0.0.1', () => r()));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const site = await startSiteServer({ port: Number(process.argv[2] ?? 0) });
  console.log(`serving ${SITE_DIR} at ${site.url}`);
}
