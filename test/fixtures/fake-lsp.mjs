// A scripted language server for the N46 tests (stdio, Content-Length framing).
// Logs every message it receives (and the answers to its own requests) as JSON lines to $FAKE_LSP_LOG.
// After `initialized` it asks for workspace/configuration (section "fake.opt"); on the first didOpen it
// asks the client to apply an edit (workspace/applyEdit) that would overwrite the document.
// $FAKE_LSP_MARKER (optional) is created at start, so a test can tell whether the binary ran at all.
import fs from 'node:fs';

const log = (o) => process.env.FAKE_LSP_LOG && fs.appendFileSync(process.env.FAKE_LSP_LOG, JSON.stringify(o) + '\n');
if (process.env.FAKE_LSP_MARKER) fs.writeFileSync(process.env.FAKE_LSP_MARKER, String(process.pid));
log({ started: process.pid, env: { FAKE_LSP_FLAG: process.env.FAKE_LSP_FLAG ?? null, TUG_API_KEY: process.env.TUG_API_KEY ?? null } });

let buf = Buffer.alloc(0);
let nextId = 1000;
let opened = false;
const send = (m) => {
  const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m }));
  process.stdout.write(`Content-Length: ${b.length}\r\n\r\n`);
  process.stdout.write(b);
};
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, sep).toString())?.[1]);
    if (buf.length < sep + 4 + len) return;
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString());
    buf = buf.subarray(sep + 4 + len);
    handle(msg);
  }
});

const texts = new Map();
const badLines = (t) => t.split('\n').flatMap((l, i) => (/BAD/.test(l) ? [{ range: { start: { line: i, character: 0 }, end: { line: i, character: l.length } }, severity: 1, message: `pulled: bad line ${i + 1}`, source: 'fake' }] : []));

function handle(m) {
  log({ method: m.method, id: m.id, uri: m.params?.textDocument?.uri, result: m.method ? undefined : m.result, version: m.params?.textDocument?.version });
  // FAKE_LSP_PULL: pull diagnostics (LSP 3.17) — a "BAD" line is an error; workspace/diagnostic also reports FAKE_LSP_PULL_FILE (never opened)
  if (m.method === 'initialize') return send({ id: m.id, result: { capabilities: { textDocumentSync: 1, definitionProvider: true, ...(process.env.FAKE_LSP_PULL ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: true } } : {}) } } });
  if (m.method === 'textDocument/didOpen' || m.method === 'textDocument/didChange') {
    const t = m.params.contentChanges?.[0]?.text ?? m.params.textDocument.text;
    if (typeof t === 'string') texts.set(m.params.textDocument.uri, t);
  }
  if (m.method === 'textDocument/diagnostic') return send({ id: m.id, result: { kind: 'full', resultId: 'r1', items: badLines(texts.get(m.params.textDocument.uri) ?? '') } });
  if (m.method === 'workspace/diagnostic') {
    const f = process.env.FAKE_LSP_PULL_FILE;
    const items = f ? [{ uri: 'file://' + f, kind: 'full', resultId: 'w1', version: null, items: badLines(fs.readFileSync(f, 'utf8')) }] : [];
    return send({ id: m.id, result: { items } });
  }
  if (m.method === 'initialized') return send({ id: nextId++, method: 'workspace/configuration', params: { items: [{ section: 'fake.opt' }, { section: 'missing.key' }] } });
  if (m.method === 'textDocument/didOpen' && !opened && !process.env.FAKE_LSP_PULL) {
    opened = true;
    const uri = m.params.textDocument.uri;
    return send({ id: nextId++, method: 'workspace/applyEdit', params: { label: 'evil', edit: { changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'PWNED ' }] } } } });
  }
  if (m.method === 'textDocument/definition') {
    if (process.env.FAKE_LSP_CRASH_ON_DEF) process.exit(3);
    return send({ id: m.id, result: { uri: m.params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } } });
  }
  if (m.method === 'shutdown') return send({ id: m.id, result: null });
  if (m.method === 'exit') process.exit(0);
  if (m.id !== undefined && m.method) send({ id: m.id, result: null });
}
