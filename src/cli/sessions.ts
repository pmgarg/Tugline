/**
 * Saved sessions shared by the CLI and VS Code (B6 history; v1.2 N49 `tug sessions …`, moved here from
 * vscode/src/sessions.ts so `tug` and the extension share one implementation). The sessions of a workspace are
 * the agent journals in <homeDir>/sessions/<projectKey>/. Journals are hash-chained, so they are never edited:
 * rename stores a title in `titles.json`; delete moves the journal to `trash/` (recoverable); resume loads the
 * messages into a new session; export renders them (Markdown, HTML with everything escaped, or JSON).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Journal, projectKey } from '../core/agent/journal.js';
import type { ChatMessage } from '../core/types.js';
import { contentToText } from '../core/util/text.js';

export interface SessionInfo {
  id: string;
  file: string;
  mtime: number;
  title: string;
  firstPrompt: string;
}

export function sessionsDir(homeDir: string, workspace: string): string {
  return path.join(homeDir, 'sessions', projectKey(workspace));
}

function titlesFile(homeDir: string, workspace: string): string {
  return path.join(sessionsDir(homeDir, workspace), 'titles.json');
}

function readTitles(homeDir: string, workspace: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(titlesFile(homeDir, workspace), 'utf8'));
  } catch {
    return {};
  }
}

export function titleFromPrompt(p: string): string {
  const t = p.replace(/<(attached_context|ide_context|hook_context|repo_map)\b[\s\S]*?<\/\1>/g, '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || '(empty)';
}

/** The first prompt of a journal (run_start events are journaled as {type:'event', event:{…}}). */
export function firstPrompt(file: string): string {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"run_start"')) continue;
      const r = JSON.parse(line);
      const p = r.event?.type === 'run_start' ? r.event.prompt : r.type === 'run_start' ? r.prompt : undefined;
      if (typeof p === 'string') return p;
    }
  } catch {
    /* unreadable journal */
  }
  return '';
}

export function listSessions(homeDir: string, workspace: string): SessionInfo[] {
  const titles = readTitles(homeDir, workspace);
  return Journal.listSessions(homeDir, workspace)
    .filter((s) => !s.id.includes('-sub-'))
    .map((s) => {
      const fp = s.firstPrompt || firstPrompt(s.file);
      return { ...s, firstPrompt: fp, title: titles[s.id] ?? titleFromPrompt(fp) };
    })
    .filter((s) => s.firstPrompt || titles[s.id]);
}

export function findSession(homeDir: string, workspace: string, idOrPrefix: string): SessionInfo | undefined {
  const all = listSessions(homeDir, workspace);
  return all.find((s) => s.id === idOrPrefix) ?? all.find((s) => s.id.startsWith(idOrPrefix));
}

export function renameSession(homeDir: string, workspace: string, id: string, title: string): void {
  const t = readTitles(homeDir, workspace);
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (clean) t[id] = clean;
  else delete t[id];
  fs.mkdirSync(sessionsDir(homeDir, workspace), { recursive: true });
  fs.writeFileSync(titlesFile(homeDir, workspace), JSON.stringify(t, null, 2));
}

/** Move a session's journal to trash/ (never deleted outright). Returns the new path. */
export function deleteSession(homeDir: string, workspace: string, id: string): string {
  if (!/^[\w.-]+$/.test(id)) throw new Error(`bad session id ${id}`);
  const dir = sessionsDir(homeDir, workspace);
  const from = path.join(dir, `${id}.jsonl`);
  if (!fs.existsSync(from)) throw new Error(`no session ${id}`);
  const trash = path.join(dir, 'trash');
  fs.mkdirSync(trash, { recursive: true });
  const to = path.join(trash, `${id}.jsonl`);
  fs.renameSync(from, to);
  return to;
}

/** Messages of a session (system prompt excluded), compactions applied. */
export function loadSessionMessages(file: string): ChatMessage[] {
  return Journal.loadMessages(file);
}

export interface SearchHit {
  session: SessionInfo;
  /** 'prompt' | 'answer' */
  where: 'prompt' | 'answer';
  snippet: string;
}

/** Substring search (case-insensitive) over a session's prompts and answers. */
export function searchSessions(homeDir: string, workspace: string, query: string, limit = 50): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const s of listSessions(homeDir, workspace)) {
    let found: SearchHit | undefined;
    if (s.title.toLowerCase().includes(q)) found = { session: s, where: 'prompt', snippet: s.title };
    if (!found) {
      for (const line of fs.readFileSync(s.file, 'utf8').split('\n')) {
        if (!line || !line.toLowerCase().includes(q)) continue;
        let r: any;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        let text = '';
        let where: SearchHit['where'] = 'prompt';
        if (r.type === 'message' && r.message?.role === 'user') text = contentToText(r.message.content);
        else if (r.type === 'message' && r.message?.role === 'assistant') {
          text = contentToText(r.message.content);
          where = 'answer';
        } else if (r.type === 'event' && r.event?.type === 'run_end') {
          text = String(r.event.finalText ?? '');
          where = 'answer';
        } else continue;
        const i = text.toLowerCase().indexOf(q);
        if (i < 0) continue;
        found = { session: s, where, snippet: text.slice(Math.max(0, i - 40), i + q.length + 60).replace(/\s+/g, ' ') };
        break;
      }
    }
    if (found) hits.push(found);
    if (hits.length >= limit) break;
  }
  return hits;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Render messages for export (Qwen /export, Cline export task). Journals are already secret-redacted. */
export function exportMessages(msgs: ChatMessage[], format: 'md' | 'json' | 'html', title = 'Tugline session'): string {
  const visible = msgs.filter((m) => m.role !== 'system' && !m._meta?.synthetic);
  if (format === 'json') return JSON.stringify({ title, messages: visible.map((m) => ({ role: m.role, content: contentToText(m.content), ...(m.tool_calls ? { tool_calls: m.tool_calls.map((t) => ({ name: t.function.name, arguments: t.function.arguments })) } : {}) })) }, null, 2);
  const blocks = visible.map((m) => {
    const text = contentToText(m.content);
    const calls = (m.tool_calls ?? []).map((t) => `${t.function.name} ${t.function.arguments}`);
    const who = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : `Tool result`;
    return { who, text, calls };
  });
  if (format === 'md') return [`# ${title}`, '', ...blocks.flatMap((b) => [`## ${b.who}`, '', b.who === 'Tool result' ? '```\n' + b.text.slice(0, 4000) + '\n```' : b.text, ...b.calls.map((c) => `\n> tool call: \`${c.slice(0, 300)}\``), ''])].join('\n');
  // HTML: every byte of content escaped; a CSP that forbids scripts; no remote resources
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${esc(title)}</title><style>body{font:14px/1.5 system-ui;max-width:52em;margin:2em auto}pre{white-space:pre-wrap;background:#f4f4f4;padding:.5em}</style></head><body><h1>${esc(title)}</h1>${blocks.map((b) => `<h2>${esc(b.who)}</h2><pre>${esc(b.text)}</pre>${b.calls.map((c) => `<p><code>${esc(c.slice(0, 300))}</code></p>`).join('')}`).join('')}</body></html>`;
}

// ---- v1.2 N45 (Cline task history parity): favourites and the size of the history

function favoritesFile(homeDir: string, workspace: string): string {
  return path.join(sessionsDir(homeDir, workspace), 'favorites.json');
}

export function favoriteIds(homeDir: string, workspace: string): string[] {
  try {
    const j = JSON.parse(fs.readFileSync(favoritesFile(homeDir, workspace), 'utf8'));
    return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Star or unstar a session; returns whether it is a favourite now. */
export function toggleFavorite(homeDir: string, workspace: string, id: string): boolean {
  const cur = new Set(favoriteIds(homeDir, workspace));
  const now = !cur.has(id);
  if (now) cur.add(id);
  else cur.delete(id);
  fs.mkdirSync(sessionsDir(homeDir, workspace), { recursive: true });
  fs.writeFileSync(favoritesFile(homeDir, workspace), JSON.stringify([...cur]), { mode: 0o600 });
  return now;
}

/** Bytes used by this workspace's saved sessions (trash excluded). */
export function sessionsSize(homeDir: string, workspace: string): number {
  let n = 0;
  const dir = sessionsDir(homeDir, workspace);
  try {
    for (const f of fs.readdirSync(dir)) {
      const st = fs.statSync(path.join(dir, f));
      if (st.isFile()) n += st.size;
    }
  } catch {
    /* none */
  }
  return n;
}

/** Move every session of the workspace to trash/ (favourites are kept unless `includeFavorites`). */
export function deleteAllSessions(homeDir: string, workspace: string, includeFavorites = false): number {
  const fav = new Set(includeFavorites ? [] : favoriteIds(homeDir, workspace));
  let n = 0;
  for (const s of listSessions(homeDir, workspace)) {
    if (fav.has(s.id)) continue;
    deleteSession(homeDir, workspace, s.id);
    n++;
  }
  return n;
}
