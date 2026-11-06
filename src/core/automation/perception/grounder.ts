/**
 * Grounder backend (SPEC E5, research CU §3, §5.4 L3c): a separate grounding
 * VLM (UI-TARS / Holo / Qwen-VL behind any OpenAI-compatible endpoint) turns
 * "the green Submit button" into (x, y) for a text-only main model.
 *
 * Two passes: ground on the full screenshot, then crop a window around the
 * first answer and ground again ("zoom-in re-grounding"), mapping the second
 * answer back. Small grounders are much more accurate on the zoomed crop.
 *
 * Output formats accepted: `click(start_box='(x,y)')` (UI-TARS),
 * `(x, y)`, `[x, y]`, `{"x":..,"y":..}`, or a box `[x1,y1,x2,y2]` (centre).
 * `coordinates: 'norm1000'` maps 0..1000 model coordinates to pixels.
 */
import { crop, decodePng, encodePng } from './png.js';

export interface GrounderConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  zoom?: boolean;
  timeoutMs?: number;
  coordinates?: 'pixel' | 'norm1000';
}

export interface GroundResult {
  x: number;
  y: number;
  /** Raw model answers, for the trajectory. */
  raw: string[];
  zoomed: boolean;
}

export class GrounderError extends Error {}

export function parsePoint(text: string): { x: number; y: number } | undefined {
  const t = text.replace(/<\|box_start\|>|<\|box_end\|>/g, '');
  const json = t.match(/\{[^{}]*"x"\s*:\s*(-?\d+(?:\.\d+)?)[^{}]*"y"\s*:\s*(-?\d+(?:\.\d+)?)[^{}]*\}/);
  if (json) return { x: Number(json[1]), y: Number(json[2]) };
  const box = t.match(/[[(]\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*[\])]/);
  if (box) return { x: (Number(box[1]) + Number(box[3])) / 2, y: (Number(box[2]) + Number(box[4])) / 2 };
  const pt = t.match(/[[(]\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*[\])]/);
  if (pt) return { x: Number(pt[1]), y: Number(pt[2]) };
  return undefined;
}

async function ask(cfg: GrounderConfig, png: Buffer, instruction: string, size: { width: number; height: number }): Promise<{ x: number; y: number; raw: string }> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: cfg.model,
    temperature: 0,
    max_tokens: 64,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
          { type: 'text', text: `The screenshot is ${size.width}x${size.height} pixels. Output only the click point for: ${instruction}\nAnswer as click(start_box='(x,y)').` },
        ],
      },
    ],
  };
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000) });
  } catch (e) {
    throw new GrounderError(`grounder unreachable at ${cfg.baseUrl}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new GrounderError(`grounder returned HTTP ${res.status}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = String(j.choices?.[0]?.message?.content ?? '');
  const p = parsePoint(raw);
  if (!p) throw new GrounderError(`grounder answer has no coordinates: ${raw.slice(0, 120)}`);
  const norm = cfg.coordinates === 'norm1000';
  return { x: norm ? (p.x / 1000) * size.width : p.x, y: norm ? (p.y / 1000) * size.height : p.y, raw };
}

/** Ground an instruction to (x, y) in the screenshot's pixel space. */
export async function ground(cfg: GrounderConfig, png: Buffer, instruction: string): Promise<GroundResult> {
  const img = decodePng(png);
  const first = await ask(cfg, png, instruction, img);
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(v)));
  if (cfg.zoom === false) return { x: clamp(first.x, img.width), y: clamp(first.y, img.height), raw: [first.raw], zoomed: false };
  // Zoom-in: a window half the screenshot's size, centred on the first answer.
  const w = Math.max(64, Math.round(img.width / 2));
  const h = Math.max(64, Math.round(img.height / 2));
  const x0 = Math.max(0, Math.min(img.width - w, Math.round(first.x - w / 2)));
  const y0 = Math.max(0, Math.min(img.height - h, Math.round(first.y - h / 2)));
  const part = crop(img, x0, y0, w, h);
  try {
    const second = await ask(cfg, encodePng(part), instruction, part);
    return { x: clamp(x0 + second.x, img.width), y: clamp(y0 + second.y, img.height), raw: [first.raw, second.raw], zoomed: true };
  } catch {
    return { x: clamp(first.x, img.width), y: clamp(first.y, img.height), raw: [first.raw], zoomed: false };
  }
}
