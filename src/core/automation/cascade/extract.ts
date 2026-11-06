/**
 * L1 extract (SPEC E3; S9 "httpx + trafilatura, no browser, no LLM in the
 * fetch"): a guarded HTTP fetch plus readability-lite (`htmlToMarkdown`, which
 * already prefers <article>/<main> and drops navigation), then a usefulness
 * check: at least 200 characters and a goal keyword present.
 *
 * The fetch reuses web.ts's SSRF guard on every hop, so L1 can reach exactly
 * what web_fetch can (localhost only through `web.allowHosts`).
 */
import { assertPublicUrl, fetchText, htmlToMarkdown, UA } from '../../tools/web.js';

export interface L1Page {
  url: string;
  status: number;
  title: string;
  html: string;
  markdown: string;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'which', 'when', 'where', 'find', 'page', 'site', 'into', 'about', 'there', 'their', 'have', 'does', 'show', 'tell', 'give', 'list', 'value', 'please', 'using', 'open', 'read', 'return', 'answer', 'http', 'https', 'html', 'www']);

/** Goal words worth matching (≥4 letters, not stop words, no URL fragments). */
export function goalKeywords(goal: string): string[] {
  const noUrls = goal.replace(/https?:\/\/\S+/g, ' ');
  return [...new Set(noUrls.toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) ?? [])].filter((w) => !STOP.has(w));
}

export function isUseful(text: string, goal: string): { useful: boolean; reason: string } {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length < 200) return { useful: false, reason: `only ${t.length} characters of text` };
  const kws = goalKeywords(goal);
  const lower = t.toLowerCase();
  const hit = kws.filter((k) => lower.includes(k) || (k.endsWith('s') && lower.includes(k.slice(0, -1))));
  if (kws.length && !hit.length) return { useful: false, reason: `none of the goal keywords (${kws.slice(0, 6).join(', ')}) appear` };
  return { useful: true, reason: `${t.length} chars, keywords: ${hit.slice(0, 6).join(', ') || '(none needed)'}` };
}

/** Fetch with the SSRF guard re-checked on every redirect hop. */
export async function guardedFetch(url: string, allowHosts: string[], signal: AbortSignal): Promise<L1Page> {
  let current = new URL(url);
  if (!/^https?:$/.test(current.protocol)) throw new Error('only http(s) URLs');
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(current, allowHosts);
    const r = await fetchText(current.toString(), { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' }, redirect: 'manual' }, signal, 20_000);
    if (r.status >= 300 && r.status < 400 && r.location) {
      current = new URL(r.location, current);
      continue;
    }
    const isHtml = r.type.includes('html') || /^\s*<(!doctype|html)/i.test(r.text);
    const md = isHtml ? htmlToMarkdown(r.text, current.toString()) : { title: '', markdown: r.text };
    return { url: current.toString(), status: r.status, title: md.title, html: isHtml ? r.text : '', markdown: md.markdown };
  }
  throw new Error('too many redirects');
}
