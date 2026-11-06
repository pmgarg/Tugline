/**
 * Vim mode for the REPL prompt (v1.2 N49; Qwen Code /vim). Insert mode is plain readline; Esc enters normal
 * mode, where motions and edits act on the line: h l 0 ^ $ w b e, x X D C S, dd cc dw cw, i a I A, p (paste the
 * last deletion), u (undo). Enter submits in either mode. The reducer is pure (tested); `attachVim` hooks it into
 * a readline interface.
 */
import type readline from 'node:readline';

export interface VimState {
  mode: 'insert' | 'normal';
  line: string;
  cursor: number;
  /** pending operator (d, c) */
  op?: string;
  register: string;
  undo: { line: string; cursor: number }[];
}

export function vimInit(): VimState {
  return { mode: 'insert', line: '', cursor: 0, register: '', undo: [] };
}

const isWord = (ch: string) => /\w/.test(ch);
function nextWord(l: string, i: number): number {
  const n = l.length;
  if (i >= n) return n;
  const w = isWord(l[i]);
  while (i < n && l[i] !== ' ' && isWord(l[i]) === w) i++;
  while (i < n && l[i] === ' ') i++;
  return i;
}
function prevWord(l: string, i: number): number {
  if (i <= 0) return 0;
  i--;
  while (i > 0 && l[i] === ' ') i--;
  const w = isWord(l[i]);
  while (i > 0 && l[i - 1] !== ' ' && isWord(l[i - 1]) === w) i--;
  return i;
}
function wordEnd(l: string, i: number): number {
  const n = l.length;
  if (i >= n - 1) return Math.max(0, n - 1);
  i++;
  while (i < n && l[i] === ' ') i++;
  const w = isWord(l[i]);
  while (i < n - 1 && l[i + 1] !== ' ' && isWord(l[i + 1]) === w) i++;
  return i;
}

/** Apply one key in normal mode (or Esc in insert mode). Returns the new state; `handled: false` means "let readline have it". */
export function vimKey(s: VimState, key: { sequence?: string; name?: string; ctrl?: boolean }): { state: VimState; handled: boolean } {
  if (key.name === 'return' || key.name === 'enter' || key.ctrl) return { state: { ...s, mode: 'insert', op: undefined }, handled: false };
  if (s.mode === 'insert') {
    if (key.name === 'escape') return { state: { ...s, mode: 'normal', cursor: Math.max(0, Math.min(s.cursor - 1, s.line.length - 1)) }, handled: true };
    return { state: s, handled: false };
  }
  const ch = key.sequence ?? '';
  const l = s.line;
  const c = s.cursor;
  const clamp = (x: number) => Math.max(0, Math.min(x, Math.max(0, l.length - 1)));
  const save = (st: VimState): VimState => ({ ...st, undo: [...s.undo.slice(-50), { line: s.line, cursor: s.cursor }] });
  const del = (from: number, to: number, enterInsert = false): VimState => {
    const [a, b] = from <= to ? [from, to] : [to, from];
    const line = l.slice(0, a) + l.slice(b);
    return save({ ...s, line, cursor: enterInsert ? a : Math.max(0, Math.min(a, line.length - 1)), register: l.slice(a, b), mode: enterInsert ? 'insert' : 'normal', op: undefined });
  };
  if (s.op) {
    const op = s.op;
    const ins = op === 'c';
    if (ch === op) return { state: del(0, l.length, ins), handled: true };
    if (ch === 'w') return { state: del(c, ins ? Math.max(c + 1, wordEnd(l, c) + 1) : nextWord(l, c), ins), handled: true };
    if (ch === 'b') return { state: del(prevWord(l, c), c, ins), handled: true };
    if (ch === '$') return { state: del(c, l.length, ins), handled: true };
    if (ch === '0') return { state: del(0, c, ins), handled: true };
    return { state: { ...s, op: undefined }, handled: true };
  }
  switch (ch) {
    case 'h':
      return { state: { ...s, cursor: clamp(c - 1) }, handled: true };
    case 'l':
      return { state: { ...s, cursor: clamp(c + 1) }, handled: true };
    case '0':
      return { state: { ...s, cursor: 0 }, handled: true };
    case '^':
      return { state: { ...s, cursor: Math.max(0, l.search(/\S/)) }, handled: true };
    case '$':
      return { state: { ...s, cursor: clamp(l.length - 1) }, handled: true };
    case 'w':
      return { state: { ...s, cursor: clamp(nextWord(l, c)) }, handled: true };
    case 'b':
      return { state: { ...s, cursor: prevWord(l, c) }, handled: true };
    case 'e':
      return { state: { ...s, cursor: wordEnd(l, c) }, handled: true };
    case 'x':
      return { state: l.length ? del(c, c + 1) : s, handled: true };
    case 'X':
      return { state: c > 0 ? del(c - 1, c) : s, handled: true };
    case 'D':
      return { state: del(c, l.length), handled: true };
    case 'C':
      return { state: del(c, l.length, true), handled: true };
    case 'S':
      return { state: del(0, l.length, true), handled: true };
    case 'd':
    case 'c':
      return { state: { ...s, op: ch }, handled: true };
    case 'i':
      return { state: { ...s, mode: 'insert' }, handled: true };
    case 'a':
      return { state: { ...s, mode: 'insert', cursor: Math.min(l.length, c + 1) }, handled: true };
    case 'I':
      return { state: { ...s, mode: 'insert', cursor: Math.max(0, l.search(/\S/)) }, handled: true };
    case 'A':
      return { state: { ...s, mode: 'insert', cursor: l.length }, handled: true };
    case 'p': {
      if (!s.register) return { state: s, handled: true };
      const at = Math.min(l.length, c + 1);
      return { state: save({ ...s, line: l.slice(0, at) + s.register + l.slice(at), cursor: at + s.register.length - 1 }), handled: true };
    }
    case 'u': {
      const prev = s.undo[s.undo.length - 1];
      return { state: prev ? { ...s, line: prev.line, cursor: prev.cursor, undo: s.undo.slice(0, -1) } : s, handled: true };
    }
    default:
      // anything else in normal mode is swallowed, never typed into the line
      return { state: s, handled: true };
  }
}

/** Hook vim mode into a readline interface (terminal mode). Returns a detach function. */
export function attachVim(rl: readline.Interface, onMode?: (m: VimState['mode']) => void): () => void {
  const r = rl as any;
  const orig = r._ttyWrite?.bind(r);
  if (!orig) return () => undefined;
  let st = vimInit();
  r._ttyWrite = (seq: string, key: any) => {
    // a fast Esc followed by a key arrives as one "meta" key (\x1b + char): it is Esc, then that key
    const sq: string | undefined = seq ?? key?.sequence;
    if (key?.meta && typeof sq === 'string' && sq.length === 2 && sq[0] === '\x1b' && st.mode === 'insert') {
      r._ttyWrite('\x1b', { name: 'escape', sequence: '\x1b' });
      r._ttyWrite(sq[1], { name: sq[1], sequence: sq[1] });
      return;
    }
    st = { ...st, line: r.line, cursor: r.cursor };
    const before = st.mode;
    const out = vimKey(st, key ?? { sequence: sq });
    st = out.state;
    if (!out.handled) {
      orig(seq, key);
      if (key?.name === 'return' || key?.name === 'enter') st = { ...vimInit() };
      return;
    }
    r.line = st.line;
    r.cursor = st.cursor;
    r._refreshLine?.();
    if (st.mode !== before) onMode?.(st.mode);
  };
  return () => {
    r._ttyWrite = orig;
  };
}
