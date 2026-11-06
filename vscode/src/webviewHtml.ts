/**
 * HTML shell for the extension's webviews (v1.2 N45 SAC1): a strict CSP (`default-src 'none'`), scripts only by
 * nonce, styles inline or from the extension, images from the extension or data: URLs, and no remote content.
 * No `vscode` import: unit-tested with node, and the E2E test parses the live panels' HTML.
 */
import crypto from 'node:crypto';

export function makeNonce(): string {
  return crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function webviewShell(o: { title: string; cspSource: string; nonce: string; style: string; body: string; script: string }): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${o.cspSource} data:; style-src ${o.cspSource} 'unsafe-inline'; script-src 'nonce-${o.nonce}'; connect-src 'none'; frame-src 'none'; form-action 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(o.title)}</title>
<style>${o.style}</style></head>
<body>${o.body}<script nonce="${o.nonce}">${o.script}</script></body></html>`;
}

/** Theme-aware form controls for the panels (UI tour: the arena and board showed browser-default buttons). */
export const THEMED_CONTROLS = `button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-button-border,var(--vscode-panel-border));border-radius:3px;padding:2px 8px;margin:2px 4px 2px 0;font:inherit;cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
button.primary:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.5;cursor:default}
select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,transparent);border-radius:3px;padding:2px;font:inherit;margin:0 4px}
input,textarea{padding:3px 5px;border-radius:3px;font:inherit}input[type=checkbox]{width:auto}
label{margin-right:4px}`;

export interface CspAudit {
  ok: boolean;
  problems: string[];
}

/** Check a webview's HTML: CSP present and strict, every script nonce-bound, no remote URLs, no inline handlers. */
export function auditWebviewHtml(html: string): CspAudit {
  const problems: string[] = [];
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i.exec(html)?.[1];
  if (!csp) problems.push('no Content-Security-Policy meta tag');
  else {
    if (!/default-src 'none'/.test(csp)) problems.push(`CSP lacks default-src 'none': ${csp}`);
    const script = /script-src ([^;]+)/.exec(csp)?.[1] ?? '';
    if (!/^'nonce-[A-Za-z0-9+/=]+'$/.test(script.trim())) problems.push(`script-src is not a single nonce: ${script}`);
    if (/unsafe-eval|\*|https?:/.test(script)) problems.push(`script-src too broad: ${script}`);
    const nonce = /'nonce-([^']+)'/.exec(script)?.[1];
    for (const m of html.matchAll(/<script\b([^>]*)>/gi)) if (!new RegExp(`nonce="${nonce}"`).test(m[1])) problems.push(`script without the nonce: <script${m[1]}>`);
  }
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']?(https?:|\/\/)/gi)) problems.push(`remote resource: ${m[0]}`);
  if (/@import\s+url\(\s*['"]?https?:/i.test(html)) problems.push('remote stylesheet import');
  if (/\son[a-z]+\s*=\s*["']/i.test(html.replace(/<script\b[\s\S]*?<\/script>/gi, ''))) problems.push('inline event handler attribute');
  return { ok: problems.length === 0, problems };
}
