/**
 * Set-of-marks (SPEC E4; research CU §1.8, S9): number the actionable elements
 * on a screenshot so a vision model answers with a ref instead of coordinates.
 *
 * S9 rules, all enforced here:
 *  - marks are drawn AFTER capture on the PNG (never as a DOM overlay, which
 *    changes the page and breaks clicks);
 *  - boxes come in CSS pixels and are scaled by the device pixel ratio;
 *  - nested clickables are deduplicated, keeping the outermost actionable one
 *    (an SVG inside a button is one mark, not two).
 * Labels are the snapshot refs, so a model's "e31" maps straight to getByRef.
 */
import type { UiNode } from '../types.js';
import { isInteractive } from '../snapshot/tree.js';
import { decodePng, encodePng, type Image } from './png.js';

export type Box = NonNullable<UiNode['box']>;
export interface Mark {
  ref: string;
  box: Box;
  role?: string;
  name?: string;
}

function contains(outer: Box, inner: Box, slack = 2): boolean {
  return inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;
}

function visible(b: Box, vp?: { width: number; height: number }): boolean {
  if (b.width < 2 || b.height < 2) return false;
  if (!vp) return true;
  return b.x + b.width > 0 && b.y + b.height > 0 && b.x < vp.width && b.y < vp.height;
}

/**
 * Actionable nodes with boxes, outermost first. A node nested inside an
 * actionable ancestor whose box contains it is dropped (keep the outermost).
 */
export function markCandidates(root: UiNode, viewport?: { width: number; height: number }): Mark[] {
  const out: Mark[] = [];
  const rec = (n: UiNode, coveredBy: Box | undefined) => {
    let cover = coveredBy;
    if (n.ref && n.box && isInteractive(n) && visible(n.box, viewport)) {
      if (!coveredBy || !contains(coveredBy, n.box)) {
        out.push({ ref: n.ref, box: n.box, role: n.role, name: n.name });
        cover = n.box;
      }
    }
    for (const c of n.children ?? []) rec(c, cover);
  };
  rec(root, undefined);
  return out;
}

/** CSS pixels → device pixels. */
export function scaleBox(b: Box, dpr: number): Box {
  return { x: Math.round(b.x * dpr), y: Math.round(b.y * dpr), width: Math.round(b.width * dpr), height: Math.round(b.height * dpr) };
}

// 3x5 bitmap glyphs for ref labels (digits and the ref prefixes e/f/d/r).
const GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'], '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'], '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'], '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'], e: ['111', '100', '111', '100', '111'], f: ['111', '100', '111', '100', '100'],
  d: ['110', '101', '101', '101', '110'], r: ['110', '101', '110', '101', '101'],
};

const COLORS: [number, number, number][] = [[230, 25, 75], [60, 180, 75], [0, 130, 200], [245, 130, 48], [145, 30, 180], [0, 128, 128]];

function setPx(img: Image, x: number, y: number, c: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const o = (y * img.width + x) * 4;
  img.data[o] = c[0];
  img.data[o + 1] = c[1];
  img.data[o + 2] = c[2];
  img.data[o + 3] = 255;
}

function rect(img: Image, b: Box, c: [number, number, number], t: number): void {
  for (let k = 0; k < t; k++) {
    for (let x = b.x; x < b.x + b.width; x++) {
      setPx(img, x, b.y + k, c);
      setPx(img, x, b.y + b.height - 1 - k, c);
    }
    for (let y = b.y; y < b.y + b.height; y++) {
      setPx(img, b.x + k, y, c);
      setPx(img, b.x + b.width - 1 - k, y, c);
    }
  }
}

function label(img: Image, text: string, x: number, y: number, c: [number, number, number], scale: number): void {
  const w = text.length * 4 * scale + scale;
  const h = 7 * scale;
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) setPx(img, x + xx, y + yy, c);
  let cx = x + scale;
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (g) for (let r = 0; r < 5; r++) for (let col = 0; col < 3; col++) if (g[r][col] === '1') for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) setPx(img, cx + col * scale + sx, y + scale + r * scale + sy, [255, 255, 255]);
    cx += 4 * scale;
  }
}

/** Draw marks onto a PNG captured at `dpr` device pixels per CSS pixel. */
export function drawMarks(png: Buffer, marks: Mark[], dpr = 1): Buffer {
  const img = decodePng(png);
  const s = Math.max(1, Math.round(2 * dpr));
  marks.forEach((m, i) => {
    const b = scaleBox(m.box, dpr);
    const c = COLORS[i % COLORS.length];
    rect(img, b, c, Math.max(1, Math.round(dpr)));
    label(img, m.ref, b.x, Math.max(0, b.y - 7 * s), c, s);
  });
  return encodePng(img);
}
