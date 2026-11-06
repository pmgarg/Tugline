/**
 * N43 re-check findings D and J: blocks of attached context (`@file` mentions, IDE context, hook context, the repo
 * map, piped stdin, ACP file resources) are built here, never by string concatenation elsewhere.
 *
 *  - Every block carries a random id in its opening tag (`<attached_context source="@a.ts" kind="file" id="…">`).
 *    Only blocks with an id are treated as attachments by the classifier transcript, so text the user typed that
 *    happens to look like a tag (`<file path="x">…</file>`) stays the user's words (J).
 *  - Inside a block, any text that looks like one of these tags (`</attached_context>`, `<file …>` …) is escaped
 *    (`&lt;`), so a file cannot end its own block early and smuggle the rest of its text out as the user's
 *    request (D). The first closing tag after a harness-built opening tag is therefore always the real one.
 */
import { randomBytes } from 'node:crypto';

export const ATTACHMENT_TAGS = ['attached_context', 'ide_context', 'hook_context', 'repo_map', 'stdin', 'file'] as const;
export type AttachmentTag = (typeof ATTACHMENT_TAGS)[number];

const TAG_LIKE = new RegExp(`<(/?)(${ATTACHMENT_TAGS.join('|')})\\b`, 'gi');

/** Escape tag-like text inside an attachment body. */
export function escapeAttachmentTags(body: string): string {
  return body.replace(TAG_LIKE, '&lt;$1$2');
}

/** One attachment block: `<tag attrs… id="…">\nbody\n</tag>` with the body escaped. */
export function attachmentBlock(tag: AttachmentTag, attrs: Record<string, string | undefined>, body: string): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "'")}"`)
    .join('');
  return `<${tag}${a} id="${randomBytes(8).toString('hex')}">\n${escapeAttachmentTags(body)}\n</${tag}>`;
}

/** A harness-built block (with its id); the body cannot contain the closing tag, see the module comment. */
export const ATTACHMENT_BLOCK = new RegExp(`<(${ATTACHMENT_TAGS.join('|')})\\b([^>]*\\sid="[0-9a-f]{16}")>[\\s\\S]*?</\\1>`, 'g');
