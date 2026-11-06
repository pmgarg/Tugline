/**
 * WS12 N8: render wiki markdown to HTML (no dependency) and `tug wiki serve`.
 *
 * The server binds 127.0.0.1 only, serves the generated pages, and shows cited
 * source files with line numbers (only files the inventory rules allow: no
 * secrets, nothing ignored, nothing outside the workspace). Mermaid blocks are
 * shown as source unless `--mermaid <script-url>` is given: there is no
 * network access by default.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { readablePath } from './inventory.js';
import type { NavNode } from './wiki.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface RenderOptions {
  /** map a markdown link target to an href (default: unchanged) */
  link?: (href: string) => string;
}

function inline(s: string, o: RenderOptions): string {
  const codes: string[] = [];
  let t = s.replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${codes.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    const h = o.link ? o.link(href.replace(/&amp;/g, '&')) : href;
    const safe = /^(https?:|#|\/|\.{0,2}\/|[\w.-]+(\.md|\.html)?(#.*)?$)/.test(h) && !/^javascript:/i.test(h) ? h : '#';
    return `<a href="${esc(safe)}">${label}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

/** Markdown subset used by the wiki: headings, paragraphs, lists, fences, quotes, tables, links. */
export function renderMarkdown(md: string, o: RenderOptions = {}): string {
  const out: string[] = [];
  const lines = md.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '), o)}</p>`);
    para = [];
  };
  while (i < lines.length) {
    const l = lines[i];
    const fence = /^\s*```(\w*)/.exec(l);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(fence[1] === 'mermaid' ? `<pre class="mermaid">${esc(body.join('\n'))}</pre>` : `<pre><code class="lang-${esc(fence[1] || 'text')}">${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      flush();
      const id = h[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      out.push(`<h${h[1].length} id="${id}">${inline(h[2], o)}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*[-*]\s+/, ''), o)}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*>/.test(l)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inline(q.join(' '), o)}</blockquote>`);
      continue;
    }
    if (/^\s*\|/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      flush();
      const row = (r: string, tag: string) => `<tr>${r.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => `<${tag}>${inline(c.trim(), o)}</${tag}>`).join('')}</tr>`;
      const rows = [row(l, 'th')];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(row(lines[i++], 'td'));
      out.push(`<table>${rows.join('')}</table>`);
      continue;
    }
    if (!l.trim()) flush();
    else para.push(l.trim());
    i++;
  }
  flush();
  return out.join('\n');
}

const CSS = `body{font:15px/1.55 system-ui,sans-serif;margin:0;display:flex;color:#1f2328;background:#fff}nav{width:260px;padding:16px;border-right:1px solid #ddd;height:100vh;overflow:auto;position:sticky;top:0;box-sizing:border-box;font-size:14px}nav ul{list-style:none;padding-left:12px;margin:4px 0}main{padding:24px 40px;max-width:980px;flex:1}pre{background:#f6f8fa;padding:10px;overflow:auto;border-radius:6px}code{background:#f6f8fa;padding:1px 4px;border-radius:4px}blockquote{color:#57606a;border-left:3px solid #d0d7de;margin:0;padding-left:12px}table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:4px 8px}a{color:#0969da}.src td{border:none;padding:0 8px;font:12px/1.5 ui-monospace,monospace;white-space:pre}.src tr:target{background:#fff8c5}.ln{color:#8c959f;text-align:right;user-select:none}@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}pre,code{background:#161b22}nav{border-color:#30363d}a{color:#4493f8}}`;

function navHtml(nav: NavNode[], href: (p: string) => string): string {
  const rec = (ns: NavNode[]): string => `<ul>${ns.map((n) => `<li><a href="${esc(href(n.path))}">${esc(n.title)}</a>${n.children?.length ? rec(n.children) : ''}</li>`).join('')}</ul>`;
  return rec(nav);
}

export function htmlPage(title: string, body: string, nav: NavNode[], o: { mermaidScript?: string; href?: (p: string) => string; extraHead?: string } = {}): string {
  const mer = o.mermaidScript ? `<script src="${esc(o.mermaidScript)}"></script><script>mermaid.initialize({startOnLoad:true});</script>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style>${o.extraHead ?? ''}</head><body><nav><b>Wiki</b>${navHtml(nav, o.href ?? ((p) => `/${p}`))}</nav><main>${body}</main>${mer}</body></html>`;
}

/** Numbered source view of a cited file. */
export function sourceHtml(rel: string, text: string): string {
  const rows = text.split('\n').map((l, i) => `<tr id="L${i + 1}"><td class="ln">${i + 1}</td><td>${esc(l)}</td></tr>`).join('');
  return `<h1><code>${esc(rel)}</code></h1><table class="src">${rows}</table>`;
}

export function readNav(dir: string): NavNode[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'nav.json'), 'utf8'));
  } catch {
    return [{ title: 'Overview', path: 'index.md' }];
  }
}

/**
 * Link rewriting for a page at `pageRel` (inside the wiki dir): links to wiki
 * pages stay relative; links that leave the wiki and land inside the workspace
 * become `<sourcePrefix><rel>#Lx`.
 */
export function wikiLinker(ws: string, dir: string, pageRel: string, sourcePrefix: string): (href: string) => string {
  return (href) => {
    if (/^(https?:|#|mailto:)/.test(href)) return href;
    const [p, hash] = href.split('#');
    const abs = path.resolve(path.dirname(path.join(dir, pageRel)), p);
    const inWiki = abs === dir || abs.startsWith(dir + path.sep);
    if (inWiki) return href;
    const rel = path.relative(ws, abs).split(path.sep).join('/');
    if (rel.startsWith('..')) return '#';
    return `${sourcePrefix}${rel}${hash ? `#${hash.replace(/-L\d+$/, '')}` : ''}`;
  };
}

export interface WikiServer {
  url: string;
  close(): Promise<void>;
}

/** `tug wiki serve`: a tiny static server on 127.0.0.1. */
export async function serveWiki(ws: string, dir: string, o: { port?: number; mermaidScript?: string } = {}): Promise<WikiServer> {
  const srv = http.createServer((req, res) => {
    const send = (code: number, body: string, type = 'text/html; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': o.mermaidScript ? "default-src 'self'; script-src 'self' 'unsafe-inline' " + new URL(o.mermaidScript).origin + "; style-src 'unsafe-inline'" : "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(body);
    };
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return send(400, 'bad request', 'text/plain');
    }
    const nav = readNav(dir);
    const p = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (p.startsWith('__source/')) {
      const rel = p.slice('__source/'.length);
      if (!readablePath(ws, rel)) return send(404, 'not available', 'text/plain');
      const abs = path.resolve(ws, rel);
      if (!abs.startsWith(ws + path.sep) || !fs.existsSync(abs)) return send(404, 'not found', 'text/plain');
      return send(200, htmlPage(rel, sourceHtml(rel, fs.readFileSync(abs, 'utf8')), nav, o));
    }
    if (p === 'nav.json') return send(200, JSON.stringify(nav), 'application/json');
    const page = p === '' ? 'index.md' : p;
    const abs = path.resolve(dir, page);
    if (!abs.startsWith(dir + path.sep) || !page.endsWith('.md') || !fs.existsSync(abs)) return send(404, htmlPage('Not found', '<h1>Not found</h1>', nav, o));
    const md = fs.readFileSync(abs, 'utf8');
    const title = /^#\s+(.*)$/m.exec(md)?.[1] ?? page;
    const pageDirUrl = '/' + path.posix.dirname(page).replace(/^\.$/, '');
    const linker = wikiLinker(ws, dir, page, '/__source/');
    const body = renderMarkdown(md, { link: (h) => {
      const r = linker(h);
      if (r.startsWith('/') || /^(https?:|#)/.test(r)) return r;
      return path.posix.join(pageDirUrl, r);
    } });
    return send(200, htmlPage(title, body, nav, o));
  });
  await new Promise<void>((r) => srv.listen(o.port ?? 0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => srv.close(() => r())) };
}
