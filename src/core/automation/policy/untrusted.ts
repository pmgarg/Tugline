/**
 * Untrusted-content envelope for page, accessibility and OCR text (SPEC R3).
 * Delegates to the shared helper in src/core/util/untrusted.ts so every surface
 * neutralises wrapper tags the same way.
 */
import { neutralizeUntrusted as neutralize, wrapUntrusted as wrap } from '../../util/untrusted.js';

export const neutralizeUntrusted = neutralize;

/** `<untrusted_web_content source="…">…</untrusted_web_content>` for browser surfaces. */
export function wrapUntrusted(source: string, body: string): string {
  return wrap('web_content', { source }, body);
}
