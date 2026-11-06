/**
 * Wrapping of untrusted content (web pages, accessibility text, OCR, MCP output).
 * The model is told that text inside <untrusted_*> tags is data, never instructions
 * (EAG S12). A page that contains a literal "</untrusted_web_content>" could close the
 * wrapper early and have the rest read as trusted text, so any such tag inside the body
 * is neutralised before wrapping.
 */
const TAG = /<(\/?)(untrusted_[a-z_]*)/gi;

/** Neutralise wrapper tags inside untrusted text (`<` becomes `‹`). */
export function neutralizeUntrusted(body: string): string {
  return body.replace(TAG, (_m, slash: string, name: string) => `‹${slash}${name}`);
}

function attr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n]+/g, ' ');
}

/** `<untrusted_${kind} k="v">\n…\n</untrusted_${kind}>` with the body and attributes made safe. */
export function wrapUntrusted(kind: 'web_content' | 'tool_output' | (string & {}), attrs: Record<string, string | undefined>, body: string): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${attr(v!)}"`)
    .join('');
  return `<untrusted_${kind}${a}>\n${neutralizeUntrusted(body)}\n</untrusted_${kind}>`;
}

// ---- G2 taint signal: tool results that carry untrusted content say so with `meta.untrusted: true`.

/** Minimal shapes (kept structural so this util does not depend on the tool types). */
interface OutputLike {
  output: string;
  images?: unknown[];
  meta?: Record<string, unknown>;
}

/** The same output, flagged as carrying untrusted content (taints the session, G2). */
export function untrustedOutput<T extends OutputLike>(out: T): T {
  return { ...out, meta: { ...(out.meta ?? {}), untrusted: true } };
}

/** An untrusted envelope that opens a line of the text (what wrapUntrusted produces). */
export const UNTRUSTED_LINE = /(?:^|\n)<untrusted_[a-z_]+[\s>]/;

/**
 * Wrap a tool so its results are flagged untrusted whenever they carry an
 * untrusted envelope or images (a screenshot of a page is page content too).
 * For tool families that wrap at many return sites (browser_*, desktop_*).
 */
export function withUntrustedMeta<T extends { run: (...a: any[]) => Promise<OutputLike> }>(tool: T): T {
  return {
    ...tool,
    run: async (...a: any[]) => {
      const out = await tool.run(...a);
      return out && (UNTRUSTED_LINE.test(out.output ?? '') || (out.images?.length ?? 0) > 0) ? untrustedOutput(out) : out;
    },
  };
}
