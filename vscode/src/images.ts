/**
 * Image paste and drag-drop (SPEC B5). Pure: validation and the user message
 * that is sent to the model. Unit-tested.
 *
 * Vision profiles get `image_url` parts. A text-only profile NEVER gets image
 * parts: the images are turned into text (OCR or a description by a vision
 * profile) when that is configured, otherwise they are refused with a notice.
 */
import { attachmentBlock } from '../../src/core/util/attachments.js';
import type { ContentPart } from '../../src/core/types.js';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface PastedImage {
  name: string;
  /** data:<mime>;base64,<…> */
  dataUrl: string;
}

export function parseDataUrl(dataUrl: string): { mime: string; base64: string; bytes: number } | undefined {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) return undefined;
  const base64 = m[2].replace(/\s/g, '');
  const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return { mime: m[1].toLowerCase(), base64, bytes: Math.floor((base64.length * 3) / 4) - pad };
}

/** Why an image cannot be attached, or undefined when it is fine. */
export function validateImage(img: PastedImage): string | undefined {
  const p = parseDataUrl(img.dataUrl);
  if (!p) return `${img.name}: not an image data URL`;
  if (!(IMAGE_TYPES as readonly string[]).includes(p.mime)) return `${img.name}: ${p.mime} is not supported (png, jpg or webp)`;
  if (p.bytes > MAX_IMAGE_BYTES) return `${img.name}: ${(p.bytes / 1024 / 1024).toFixed(1)} MB is over the 5 MB limit`;
  return undefined;
}

export interface ImageText {
  name: string;
  /** 'ocr' | 'description' */
  via: string;
  text: string;
}

export interface BuiltMessage {
  content: string | ContentPart[];
  notices: string[];
}

/**
 * The user message for a prompt with images.
 * - vision: text part first, then one image_url part per valid image;
 * - text-only: a string; image text (OCR/description) is attached as untrusted
 *   context, and images with no text are refused with a notice.
 */
export function buildUserMessage(text: string, images: PastedImage[], o: { vision: boolean; imageTexts?: ImageText[] }): BuiltMessage {
  const notices: string[] = [];
  const valid: PastedImage[] = [];
  for (const img of images) {
    const why = validateImage(img);
    if (why) notices.push(`Image not attached: ${why}`);
    else valid.push(img);
  }
  if (!valid.length) return { content: text, notices };
  if (o.vision) {
    return { content: [{ type: 'text', text }, ...valid.map((i) => ({ type: 'image_url' as const, image_url: { url: i.dataUrl } }))], notices };
  }
  const blocks: string[] = [];
  for (const img of valid) {
    const t = o.imageTexts?.find((x) => x.name === img.name);
    if (t && t.text.trim()) blocks.push(attachmentBlock('attached_context', { source: `image:${img.name}`, kind: t.via }, `<untrusted_image_text>\n${t.text.trim().slice(0, 8000)}\n</untrusted_image_text>`));
    else notices.push(`Image not sent (${img.name}): this model has no vision. Turn on OCR (tugline.ocr) or set tugline.visionProfile to describe images with a vision model.`);
  }
  return { content: blocks.length ? `${text}\n\n${blocks.join('\n\n')}` : text, notices };
}

/** Prompt used to have a vision profile describe an image for a text-only model. */
export function describePrompt(): string {
  return 'Describe this image for a coding assistant that cannot see it. Transcribe all visible text, code, error messages and UI labels exactly; describe layout and diagrams briefly. No preamble.';
}
