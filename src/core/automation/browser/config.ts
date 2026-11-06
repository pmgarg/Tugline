/**
 * Browser and perception config sections (SPEC S0.4: `browser` is owned by
 * WS5; `perception` is shared with WS6 desktop and also lives here, next to
 * the perception code). Declaration merging keeps config.ts untouched; defaults
 * are applied here (`browserConfig(cfg)`), never in loadConfig.
 */
import type { HarnessConfig } from '../../config.js';

export interface BrowserConfig {
  /** Register the browser_* tools. Off by default: 18 schemas cost context, and the browser reaches the network. */
  enabled: boolean;
  /** Default profile: isolated | persistent:<name> | attached */
  profile: string;
  headless: boolean;
  /** Explicit Chromium/Chrome binary. Otherwise Playwright's own, then any installed Playwright Chromium, then system Chrome. */
  executablePath?: string;
  /** 'auto' uses Playwright's ariaSnapshot({mode:'ai'}) + getByRef when present, else the DOM walk (data-oh-ref). */
  snapshotEngine: 'auto' | 'aria' | 'dom';
  /** Token budget for one rendered snapshot (E2). */
  snapshotTokens: number;
  /** Repeated siblings shown before collapsing into "… N more rows". */
  maxRepeatedSiblings: number;
  /** Characters of static text kept per text node. */
  maxTextChars: number;
  /** Actions per model turn (S9 fence rule). */
  maxActionsPerTurn: number;
  /** Rate limit: browser actions per minute. 0 = unlimited. */
  actionsPerMinute: number;
  /** Loop breaker: identical consecutive actions allowed. */
  maxIdenticalActions: number;
  /** Turns for the browser_task sub-loop (L2b). */
  taskMaxTurns: number;
  /** Record trajectories under <workspace>/.tugline/runs/<session>/ (E7). */
  record: boolean;
  /** Directory for recipes (L2a, exported from recordings). Default <homeDir>/recipes */
  recipesDir?: string;
  /** Workspace-relative directory for downloads. */
  downloadsDir: string;
  /** Allow submits on pages with card fields (otherwise needs_human). */
  allowPayments: boolean;
  /** Clicks on destructive-looking targets (delete/remove/…) need an explicit `expect`. */
  requireExpectForDestructive: boolean;
  /** CDP endpoint for profile=attached, e.g. http://127.0.0.1:9222 (E6). */
  cdpUrl?: string;
  /** Domains navigation may reach in attached mode. Empty = attach refused. Supports *.example.com */
  attachedAllowDomains: string[];
  /** Attached mode: subresources must also be on attachedAllowDomains (default: any public host; private/metadata always refused). */
  attachedStrictSubresources: boolean;
  /** profile "extension" (N29): drive tabs the user shares through the Tugline browser extension (needs tug serve). */
  extensionEnabled: boolean;
  /** Coordinate actions (browser_point) without an OCR region. Vision models only. */
  allowPoint: boolean;
  /** Close the browser after this long without a browser call (ms). */
  idleCloseMs: number;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
}

export interface PerceptionConfig {
  /** Pixels-to-text layer for text-only models (E5). Unset = off. */
  backend?: 'ocr' | 'grounder';
  ocr?: {
    /** 'tesseract' = system binary. */
    engine?: 'tesseract';
    command?: string;
    lang?: string;
    /** Optional OmniParser-style HTTP endpoint returning icon regions. */
    omniparserUrl?: string;
  };
  grounder?: {
    /** OpenAI-compatible endpoint of a grounding VLM (UI-TARS / Holo / Qwen-VL). */
    baseUrl: string;
    model: string;
    apiKey?: string;
    /** Second, zoomed-in grounding pass. */
    zoom?: boolean;
    timeoutMs?: number;
  };
}

declare module '../../config.js' {
  interface HarnessConfigExtensions {
    browser?: Partial<BrowserConfig>;
    perception?: PerceptionConfig;
  }
}

export const DEFAULT_BROWSER: BrowserConfig = {
  enabled: false,
  profile: 'isolated',
  headless: true,
  snapshotEngine: 'auto',
  snapshotTokens: 5000,
  maxRepeatedSiblings: 20,
  maxTextChars: 160,
  maxActionsPerTurn: 2,
  actionsPerMinute: 60,
  maxIdenticalActions: 3,
  taskMaxTurns: 15,
  record: true,
  downloadsDir: 'downloads',
  allowPayments: false,
  requireExpectForDestructive: true,
  attachedAllowDomains: [],
  attachedStrictSubresources: false,
  extensionEnabled: false,
  allowPoint: false,
  idleCloseMs: 10 * 60_000,
  actionTimeoutMs: 8000,
  navigationTimeoutMs: 30_000,
};

export function browserConfig(cfg: Pick<HarnessConfig, 'browser'>): BrowserConfig {
  return { ...DEFAULT_BROWSER, ...(cfg.browser ?? {}) };
}

export function perceptionConfig(cfg: Pick<HarnessConfig, 'perception'>): PerceptionConfig {
  return cfg.perception ?? {};
}
