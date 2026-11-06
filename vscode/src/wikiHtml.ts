/** WS12: wiki page HTML for the VS Code webview (pure: no vscode import, unit-tested with node). */
import fs from 'node:fs';
import path from 'node:path';
import { htmlPage, readNav, renderMarkdown, wikiLinker } from '../../src/core/docs/render.js';

/** Pure: the HTML for one wiki page in the webview (links become #wiki:/#src: targets handled by the panel script). */
export function wikiWebviewHtml(ws: string, dir: string, page: string, nonce: string, cspSource: string): string {
  const abs = path.resolve(dir, page);
  const md = abs.startsWith(dir + path.sep) && fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '# Not found\n';
  const linker = wikiLinker(ws, dir, page, '#src:');
  const body = renderMarkdown(md, {
    link: (h) => {
      const r = linker(h);
      if (r.startsWith('#src:') || /^(https?:|#)/.test(r)) return r;
      const [p, hash] = r.split('#');
      return `#wiki:${path.posix.normalize(path.posix.join(path.posix.dirname(page), p))}${hash ? `#${hash}` : ''}`;
    },
  });
  const script = `<script nonce="${nonce}">const vs=acquireVsCodeApi();document.addEventListener('click',(e)=>{const a=e.target.closest('a');if(!a)return;const h=a.getAttribute('href')||'';if(h.startsWith('#wiki:')||h.startsWith('#src:')){e.preventDefault();vs.postMessage({type:h.startsWith('#wiki:')?'wiki':'src',target:h.replace(/^#(wiki|src):/,'')});}});</script>`;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
  return htmlPage(/^#\s+(.*)$/m.exec(md)?.[1] ?? page, body, readNav(dir), { href: (p) => `#wiki:${p}`, extraHead: csp }).replace('</body>', `${script}</body>`);
}

