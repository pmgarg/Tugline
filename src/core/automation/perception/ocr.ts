/**
 * OCR regions (SPEC E5, research CU §5.4 L3b): "pixels to text" for text-only
 * models. The screenshot becomes a numbered list of text regions with boxes:
 *
 *   [r1] "Cancel" (20,40 150x70)
 *   [r2] "Submit" (240,40 150x70)
 *
 * The model picks an id; the harness clicks the centre and verifies. Region
 * text is OCR of page pixels: untrusted, wrapped like any page content.
 *
 * Backend: the system `tesseract` binary (Apache-2.0), run through the
 * harness command wrapper so an OS sandbox applies. An optional OmniParser
 * HTTP endpoint adds icon regions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CommandWrap } from '../../tools/shell.js';
import { crop, decodePng, encodePng, type Image } from './png.js';
import type { Box } from './marks.js';

export interface Region {
  id: string;
  text: string;
  /** CSS pixels in the screenshot */
  box: Box;
  confidence: number;
  kind: 'text' | 'icon';
}

export interface OcrOptions {
  command?: string;
  lang?: string;
  /** Upscale factor before OCR (small UI text reads much better at 2x). */
  upscale?: number;
  wrap?: CommandWrap;
  workDir?: string;
  timeoutMs?: number;
  omniparserUrl?: string;
}

function upscale(img: Image, f: number): Image {
  if (f <= 1) return img;
  const w = img.width * f;
  const h = img.height * f;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / f);
    for (let x = 0; x < w; x++) {
      const so = (sy * img.width + Math.floor(x / f)) * 4;
      out.set(img.data.subarray(so, so + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data: out };
}

/** Parse tesseract TSV output into line regions (words grouped by block/paragraph/line). */
export function parseTesseractTsv(tsv: string, scale = 1, minConf = 30): Region[] {
  const groups = new Map<string, { words: string[]; x0: number; y0: number; x1: number; y1: number; conf: number[] }>();
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const text = c[11].trim();
    const conf = Number(c[10]);
    if (!text || conf < minConf) continue;
    const [left, top, width, height] = [Number(c[6]), Number(c[7]), Number(c[8]), Number(c[9])];
    const k = `${c[1]}.${c[2]}.${c[3]}.${c[4]}`;
    const g = groups.get(k) ?? { words: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, conf: [] };
    // A large horizontal gap means separate controls on one text line (two buttons): split the region.
    if (g.words.length && left - g.x1 > Math.max(40, height * 2.5)) {
      groups.set(`${k}.${left}`, { words: [text], x0: left, y0: top, x1: left + width, y1: top + height, conf: [conf] });
      continue;
    }
    g.words.push(text);
    g.x0 = Math.min(g.x0, left);
    g.y0 = Math.min(g.y0, top);
    g.x1 = Math.max(g.x1, left + width);
    g.y1 = Math.max(g.y1, top + height);
    g.conf.push(conf);
    groups.set(k, g);
  }
  const regions: Region[] = [];
  for (const g of groups.values()) {
    regions.push({
      id: '',
      text: g.words.join(' '),
      box: { x: Math.round(g.x0 / scale), y: Math.round(g.y0 / scale), width: Math.round((g.x1 - g.x0) / scale), height: Math.round((g.y1 - g.y0) / scale) },
      confidence: Math.round(g.conf.reduce((a, b) => a + b, 0) / g.conf.length),
      kind: 'text',
    });
  }
  regions.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  regions.forEach((r, i) => (r.id = `r${i + 1}`));
  return regions;
}

function run(file: string, args: string[], o: OcrOptions): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let spec = { file, args, cwd: o.workDir ?? os.tmpdir(), env: { ...process.env, OMP_THREAD_LIMIT: '1' } as NodeJS.ProcessEnv };
  if (o.wrap) spec = { ...spec, ...o.wrap(spec) } as typeof spec;
  return new Promise((resolve) => {
    const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? 30_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, stdout, stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Greyscale, optionally inverted: tesseract reads dark-on-light; light-on-dark buttons need the inverse. */
function grey(img: Image, invert: boolean): Image {
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    const l = Math.round(0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]);
    const v = invert ? 255 - l : l;
    out[i] = out[i + 1] = out[i + 2] = v;
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

function overlap(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return (x * y) / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}

function contains(o: Box, i: Box, slack = 4): boolean {
  return i.x >= o.x - slack && i.y >= o.y - slack && i.x + i.width <= o.x + o.width + slack && i.y + i.height <= o.y + o.height + slack;
}

/**
 * Merge passes (blocks first): keep a region unless an earlier one covers the
 * same place. Exception: a "block" that sits inside a full-page text line was
 * a glyph cluster (bold text), not a control, so the text line replaces it.
 * Renumber in reading order.
 */
export function mergeRegions(passes: Region[][], blockPass = 0): Region[] {
  const out: { r: Region; block: boolean }[] = [];
  passes.forEach((pass, pi) => {
    for (const r of pass) {
      const i = out.findIndex((o) => overlap(o.r.box, r.box) > 0.5);
      if (i < 0) out.push({ r, block: pi === blockPass });
      else if (out[i].block && pi !== blockPass && contains(r.box, out[i].r.box) && !contains(out[i].r.box, r.box)) out[i] = { r, block: false };
    }
  });
  const regions = out.map((o) => o.r);
  regions.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  regions.forEach((r, i) => (r.id = `r${i + 1}`));
  return regions;
}

/**
 * Solid blocks: filled rectangles whose colour differs from the page
 * background (buttons, toolbar items, controls drawn on a canvas). Text on a
 * coloured block is often missed by a full-page pass (light-on-dark, low
 * contrast); OCR of the cropped block reads it, and the block's box is a
 * better click target than the glyphs.
 */
export function findBlocks(img: Image, opts: { minW?: number; minH?: number; maxFrac?: number; minFill?: number; max?: number } = {}): Box[] {
  const { width: W, height: H, data } = img;
  // Background = most common colour (coarsely quantised).
  const hist = new Map<number, number>();
  for (let i = 0; i < W * H; i += 7) {
    const o = i * 4;
    const k = ((data[o] >> 4) << 8) | ((data[o + 1] >> 4) << 4) | (data[o + 2] >> 4);
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  let bgKey = 0;
  let best = -1;
  for (const [k, v] of hist) if (v > best) [bgKey, best] = [k, v];
  const bg = [((bgKey >> 8) & 15) * 16 + 8, ((bgKey >> 4) & 15) * 16 + 8, (bgKey & 15) * 16 + 8];
  const fg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    fg[i] = Math.abs(data[o] - bg[0]) + Math.abs(data[o + 1] - bg[1]) + Math.abs(data[o + 2] - bg[2]) > 36 ? 1 : 0;
  }
  // Connected components (4-neighbour) with an explicit stack.
  const seen = new Uint8Array(W * H);
  const out: (Box & { fill: number })[] = [];
  const stack = new Int32Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (!fg[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0;
    while (sp) {
      const p = stack[--sp];
      const x = p % W;
      const y = (p - x) / W;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && fg[p - 1] && !seen[p - 1]) (seen[p - 1] = 1), (stack[sp++] = p - 1);
      if (x < W - 1 && fg[p + 1] && !seen[p + 1]) (seen[p + 1] = 1), (stack[sp++] = p + 1);
      if (y > 0 && fg[p - W] && !seen[p - W]) (seen[p - W] = 1), (stack[sp++] = p - W);
      if (y < H - 1 && fg[p + W] && !seen[p + W]) (seen[p + W] = 1), (stack[sp++] = p + W);
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const fill = n / (w * h);
    if (w >= (opts.minW ?? 24) && h >= (opts.minH ?? 14) && w * h <= (opts.maxFrac ?? 0.25) * W * H && fill >= (opts.minFill ?? 0.6)) out.push({ x: x0, y: y0, width: w, height: h, fill });
  }
  out.sort((a, b) => b.width * b.height - a.width * a.height);
  return out.slice(0, opts.max ?? 16).map(({ fill: _f, ...b }) => b);
}

/** OCR a PNG into numbered text regions (solid blocks, then normal and inverted full-page passes, merged). */
export async function ocrRegions(png: Buffer, o: OcrOptions = {}): Promise<Region[]> {
  const f = o.upscale ?? 2;
  const img = upscale(decodePng(png), f);
  if (o.workDir) fs.mkdirSync(o.workDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(o.workDir ?? os.tmpdir(), 'oh-ocr-'));
  try {
    const passes: Region[][] = [];
    const blocks: Region[] = [];
    const src = decodePng(png);
    for (const b of findBlocks(src)) {
      const file = path.join(dir, `block-${blocks.length}.png`);
      fs.writeFileSync(file, encodePng(grey(upscale(crop(src, b.x, b.y, b.width, b.height), 2), false)));
      const r = await run(o.command ?? 'tesseract', [file, 'stdout', '-l', o.lang ?? 'eng', '--psm', '7', 'tsv'], { ...o, workDir: dir });
      if (r.code !== 0) continue;
      const words = parseTesseractTsv(r.stdout, 2, 50);
      const text = words.map((w) => w.text).join(' ').trim();
      if (text && /[A-Za-z0-9]{2}/.test(text)) blocks.push({ id: '', text, box: b, confidence: Math.min(...words.map((w) => w.confidence)), kind: 'text' });
    }
    passes.push(blocks);
    for (const invert of [false, true]) {
      const file = path.join(dir, `shot-${invert ? 'inv' : 'std'}.png`);
      fs.writeFileSync(file, encodePng(grey(img, invert)));
      const r = await run(o.command ?? 'tesseract', [file, 'stdout', '-l', o.lang ?? 'eng', '--psm', '11', 'tsv'], { ...o, workDir: dir });
      if (r.code !== 0) throw new Error(`tesseract failed (${r.code}): ${r.stderr.slice(0, 300)}`);
      passes.push(parseTesseractTsv(r.stdout, f));
    }
    const regions = mergeRegions(passes);
    if (o.omniparserUrl) regions.push(...(await omniparserRegions(png, o.omniparserUrl, regions.length)));
    return regions;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Optional OmniParser-style endpoint: POST {image: base64} → {regions:[{bbox:[x0,y0,x1,y1], caption}]}. */
export async function omniparserRegions(png: Buffer, url: string, offset = 0): Promise<Region[]> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: png.toString('base64') }), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`OmniParser endpoint returned HTTP ${res.status}`);
  const j = (await res.json()) as { regions?: { bbox: number[]; caption?: string; text?: string }[] };
  return (j.regions ?? []).map((r, i) => ({ id: `r${offset + i + 1}`, text: r.caption ?? r.text ?? '(icon)', box: { x: r.bbox[0], y: r.bbox[1], width: r.bbox[2] - r.bbox[0], height: r.bbox[3] - r.bbox[1] }, confidence: 50, kind: 'icon' as const }));
}

export function renderRegions(regions: Region[]): string {
  if (!regions.length) return '(no text found in the screenshot)';
  return regions.map((r) => `[${r.id}] ${JSON.stringify(r.text)} (${r.box.x},${r.box.y} ${r.box.width}x${r.box.height})${r.kind === 'icon' ? ' icon' : ''}`).join('\n');
}

export function centre(b: Box): [number, number] {
  return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)];
}
