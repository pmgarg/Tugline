/**
 * Published per-model prices for hosted endpoints that list them (OpenRouter), used when a profile sets no `pricing`.
 * Without prices every cost is $0 and dollar spend limits (C7, managed caps) silently never trigger (live run, 5 Nov).
 *
 * The list is public (no key is sent), fetched at most once a day and cached in ~/.tugline/cache/. A profile's own
 * `pricing` always wins; nothing here can lower a configured price.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ModelProfile } from '../types.js';

type Price = { inputPerM: number; outputPerM: number };
const known = new Map<string, Price>();
const DAY = 24 * 60 * 60 * 1000;

function hostOf(baseUrl: string | undefined): string {
  try {
    return new URL(baseUrl ?? '').host.toLowerCase();
  } catch {
    return '';
  }
}

/** The published price for this profile's endpoint and model, if one was loaded. */
export function publishedPricing(p: Pick<ModelProfile, 'baseUrl' | 'model'>): Price | undefined {
  return known.get(`${hostOf(p.baseUrl)}|${p.model}`);
}

/** Parse OpenRouter's /models list (prices are USD per token, as strings) into per-million prices. Exported for tests. */
export function parseOpenRouterModels(json: unknown): Map<string, Price> {
  const out = new Map<string, Price>();
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return out;
  for (const m of data) {
    const id = (m as any)?.id;
    const pr = (m as any)?.pricing;
    const i = Number(pr?.prompt);
    const o = Number(pr?.completion);
    if (typeof id === 'string' && Number.isFinite(i) && Number.isFinite(o) && i >= 0 && o >= 0) out.set(id, { inputPerM: i * 1e6, outputPerM: o * 1e6 });
  }
  return out;
}

/**
 * Load published prices for the profile's endpoint when it has none configured (OpenRouter only). Never throws, never
 * waits longer than `timeoutMs`; on failure costs stay unknown, as before.
 */
export async function ensurePublishedPricing(p: Pick<ModelProfile, 'baseUrl' | 'model' | 'pricing'>, homeDir: string, timeoutMs = 4000): Promise<void> {
  const host = hostOf(p.baseUrl);
  if (p.pricing || host !== 'openrouter.ai' || known.has(`${host}|${p.model}`)) return;
  const file = path.join(homeDir, 'cache', 'pricing-openrouter.json');
  let json: unknown;
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < DAY) json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* no cache yet */
  }
  if (!json) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!res.ok) return;
      json = await res.json();
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(json), { mode: 0o600 });
    } catch {
      return;
    }
  }
  for (const [id, price] of parseOpenRouterModels(json)) known.set(`${host}|${id}`, price);
}

/** Tests only. */
export function _setPublishedPricing(baseUrl: string, model: string, price: Price | undefined): void {
  const k = `${hostOf(baseUrl)}|${model}`;
  if (price) known.set(k, price);
  else known.delete(k);
}
