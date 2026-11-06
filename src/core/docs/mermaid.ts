/**
 * WS12: a small Mermaid validator (no dependency; the real parser is a browser
 * bundle). It accepts the diagram types the wiki uses — flowchart/graph,
 * sequenceDiagram, classDiagram, stateDiagram — and checks each statement
 * against that type's grammar closely enough to catch what small models get
 * wrong: unknown diagram types, unbalanced brackets or quotes, arrows that
 * aren't Mermaid, prose inside the block. Invalid blocks are removed from the
 * page with a note (N8 AC2).
 */

export interface MermaidCheck {
  ok: boolean;
  type?: string;
  error?: string;
  line?: number;
}

const ID = String.raw`[A-Za-z_][\w.-]*`;
const NODE_SHAPE = String.raw`(?:\[\[[^\]]*\]\]|\[\([^)]*\)\]|\(\([^)]*\)\)|\[\/[^\]]*\/\]|\[\\[^\]]*\\\]|\[[^\]]*\]|\([^)]*\)|\{\{[^}]*\}\}|\{[^}]*\}|>[^\]]*\])`;
const NODE = String.raw`${ID}(?:${NODE_SHAPE})?(?::::${ID})?`;
const ARROW = String.raw`(?:<?-{2,}>?|<?={2,}>?|<?-\.+->?|--[ox]|<?-->|~~~|-\.-|---)`;
const LABEL = String.raw`(?:\|[^|]*\|)?`;
const EDGE_LINE = new RegExp(String.raw`^${NODE}(?:\s*&\s*${NODE})*(?:\s*${ARROW}\s*${LABEL}\s*${NODE}(?:\s*&\s*${NODE})*)+\s*;?$`);
const EDGE_TEXT = new RegExp(String.raw`^${NODE}\s*--\s*[^-|>]+?\s*-->\s*${NODE}\s*;?$`);
const NODE_LINE = new RegExp(String.raw`^${NODE}\s*;?$`);
const FLOW_KW = /^(subgraph\b.*|end|direction\s+(TB|TD|BT|RL|LR)|classDef\s+\S+.*|class\s+\S+\s+\S+|style\s+\S+.*|linkStyle\s+.*|click\s+.*|%%.*)$/;

const PARTICIPANT = /^(participant|actor)\s+[^\s].*$/;
const MSG = /^[\w.$ -]+?\s*(-{1,2}>>|-{1,2}>|-{1,2}x|-{1,2}\))[+-]?\s*[\w.$ -]+?\s*:\s*.*$/;
const SEQ_KW = /^(autonumber|activate\s+\S+|deactivate\s+\S+|note\s+(left of|right of|over)\s+[^:]+:.*|loop\b.*|alt\b.*|else\b.*|opt\b.*|par\b.*|and\b.*|critical\b.*|break\b.*|rect\b.*|box\b.*|end|%%.*|title\s+.*)$/i;

const CLASS_KW = /^(class\s+[\w~<>,]+(\s*\{|\s*\[.*\])?|\}|[+\-#~]?[\w$<>~,\[\]]+(\s*[\w$<>~,\[\](): *]*)?|[\w~<>]+\s*:\s*.+|[\w~<>"]+\s*(?:"[^"]*"\s*)?(<\|--|--\|>|\*--|--\*|o--|--o|-->|<--|--|\.\.>|<\.\.|\.\.\|>|<\|\.\.|\.\.)\s*(?:"[^"]*"\s*)?[\w~<>"]+(\s*:\s*.*)?|note\s+.*|direction\s+\w+|%%.*)$/;
const STATE_KW = /^(\[\*\]|[\w.]+)\s*-->\s*(\[\*\]|[\w.]+)(\s*:\s*.*)?$|^(state\s+.*|[\w.]+\s*:\s*.*|\}|note\s+.*|end note|direction\s+\w+|%%.*|\[\*\]|[\w.]+)$/;

function balanced(s: string): string | undefined {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  let quote = false;
  for (const ch of s) {
    if (ch === '"') quote = !quote;
    if (quote) continue;
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== ch) return `unbalanced "${ch}"`;
    }
  }
  if (quote) return 'unterminated quote';
  if (stack.length) return `missing "${stack[stack.length - 1]}"`;
  return undefined;
}

export function validateMermaid(src: string): MermaidCheck {
  const lines = src.split('\n').map((l) => l.trim());
  let i = 0;
  while (i < lines.length && (!lines[i] || lines[i].startsWith('%%'))) i++;
  const head = lines[i] ?? '';
  const type = /^(flowchart|graph)\b/.test(head) ? 'flowchart' : /^sequenceDiagram\b/.test(head) ? 'sequence' : /^classDiagram\b/.test(head) ? 'class' : /^stateDiagram(-v2)?\b/.test(head) ? 'state' : undefined;
  if (!type) return { ok: false, error: `unknown or missing diagram type "${head.slice(0, 40)}"`, line: i + 1 };
  if (type === 'flowchart' && !/^(flowchart|graph)(\s+(TB|TD|BT|RL|LR))?\s*;?$/.test(head)) return { ok: false, type, error: `bad header "${head}"`, line: i + 1 };
  let body = 0;
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k];
    if (!l) continue;
    body++;
    const b = type === 'flowchart' ? balanced(l) : undefined;
    if (b) return { ok: false, type, error: `${b} in "${l.slice(0, 60)}"`, line: k + 1 };
    let ok = false;
    if (type === 'flowchart') ok = FLOW_KW.test(l) || EDGE_LINE.test(l) || EDGE_TEXT.test(l) || NODE_LINE.test(l);
    else if (type === 'sequence') ok = PARTICIPANT.test(l) || MSG.test(l) || SEQ_KW.test(l);
    else if (type === 'class') ok = CLASS_KW.test(l);
    else ok = STATE_KW.test(l);
    if (!ok) return { ok: false, type, error: `not valid ${type} syntax: "${l.slice(0, 60)}"`, line: k + 1 };
  }
  if (!body) return { ok: false, type, error: 'empty diagram' };
  return { ok: true, type };
}

/**
 * Validate every ```mermaid block of a page; invalid ones are replaced by a
 * note so the page still renders.
 */
export function stripInvalidMermaid(md: string): { text: string; removed: { error: string }[]; kept: number } {
  const removed: { error: string }[] = [];
  let kept = 0;
  const text = md.replace(/```mermaid[ \t]*\n([\s\S]*?)```/g, (_m, body: string) => {
    const r = validateMermaid(body);
    if (r.ok) {
      kept++;
      return '```mermaid\n' + body.replace(/\s+$/, '') + '\n```';
    }
    removed.push({ error: r.error ?? 'invalid' });
    const why = (r.error ?? 'invalid').replace(/:?\s*(in\s*)?".*"$/, '').replace(/[`\n]/g, ' ').trim();
    return `> Note: a generated diagram was removed because it is not valid Mermaid (${why}${r.line ? ` at line ${r.line}` : ''}).`;
  });
  return { text, removed, kept };
}

/** A Mermaid-safe node id and label. */
export function mermaidId(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'n';
}
export function mermaidLabel(s: string): string {
  return s.replace(/["[\](){}|<>]/g, ' ').trim();
}
