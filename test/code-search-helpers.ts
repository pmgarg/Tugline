/**
 * Deterministic mock of an OpenAI-compatible /embeddings endpoint for the N2
 * tests (not a test file itself). Each text becomes a 256-dim vector of hashed
 * features: code tokens (camelCase / snake_case split) and their character
 * trigrams, so "authenticate" and "auth" overlap a little — a crude, honest
 * stand-in for a real embedder, never tuned to the queries.
 */
import http from 'node:http';
import { codeTokens } from '../src/core/context/index/bm25.js';

export const MOCK_DIM = 256;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mockEmbed(text: string): number[] {
  const v = new Array(MOCK_DIM).fill(0);
  const add = (f: string, w: number) => {
    const h = hash(f);
    v[h % MOCK_DIM] += (h & 0x80000000 ? -1 : 1) * w;
  };
  for (const t of codeTokens(text)) {
    add(`w:${t}`, 1);
    const p = `^${t}$`;
    for (let i = 0; i + 3 <= p.length; i++) add(`g:${p.slice(i, i + 3)}`, 0.35);
  }
  return v;
}

export interface MockEmbedServer {
  url: string;
  requests: { model: string; inputs: number }[];
  /** make the next requests fail with this HTTP status (0 = healthy) */
  failWith: number;
  close(): Promise<void>;
}

export async function startMockEmbeddings(): Promise<MockEmbedServer> {
  const state = { requests: [] as { model: string; inputs: number }[], failWith: 0 };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/embeddings')) {
        res.writeHead(404).end();
        return;
      }
      if (state.failWith) {
        res.writeHead(state.failWith, { 'content-type': 'application/json' }).end('{"error":"down"}');
        return;
      }
      const j = JSON.parse(body);
      const inputs: string[] = Array.isArray(j.input) ? j.input : [j.input];
      state.requests.push({ model: j.model, inputs: inputs.length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', model: j.model, data: inputs.map((t, index) => ({ object: 'embedding', index, embedding: mockEmbed(t) })) }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port;
  const out: MockEmbedServer = {
    url: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return state.requests;
    },
    get failWith() {
      return state.failWith;
    },
    set failWith(v: number) {
      state.failWith = v;
    },
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
  return out;
}
