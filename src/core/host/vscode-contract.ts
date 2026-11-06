/**
 * The VS Code side of the harness (SPEC B, WS2): the `ide` config section and
 * its defaults. The extension maps VS Code settings onto it; config files can
 * set it too (`~/.tugline/config.json` → `"ide": {...}`).
 *
 * Kept in core (and free of any `vscode` import) so server mode and tests can
 * read the same defaults.
 */
import type { HarnessConfig } from '../config.js';

export type FimEndpoint = 'llama-infill' | 'completions';
export type FimTemplate = 'qwen' | 'codestral' | 'deepseek' | 'suffix';

export interface AutocompleteConfig {
  /** B14: off by default; the provider is not even registered when false. */
  enabled: boolean;
  /** Profile with a FIM-capable endpoint (default: the main profile). */
  profile?: string;
  /** llama.cpp `/infill`, or OpenAI-style `/completions` with a raw FIM prompt. */
  endpoint: FimEndpoint;
  /** Prompt template for `/completions` ('suffix' sends the OpenAI `suffix` field instead of FIM tokens). */
  template: FimTemplate;
  debounceMs: number;
  maxTokens: number;
}

/** v1.1 N15: next-edit suggestions from a Zeta-format model. */
export interface NesConfig {
  /** off by default: nothing is sent and no listener does work */
  enabled: boolean;
  /** profile with an OpenAI-style /v1/completions endpoint serving a Zeta-format model (default: the main profile) */
  profile?: string;
  /** a request not answered within this budget is cancelled */
  latencyMs: number;
  maxTokens: number;
  debounceMs: number;
}

/** v1.1 N25: push-to-talk voice input. */
export interface VoiceConfig {
  /** off by default */
  enabled: boolean;
  /** profile whose base URL serves `/audio/transcriptions` (whisper.cpp server, faster-whisper, vLLM) */
  transcriber?: string;
  /** or a full transcription URL, e.g. http://127.0.0.1:8178/v1/audio/transcriptions */
  url?: string;
  model: string;
  language?: string;
  /** audio capture program; auto = sox, ffmpeg, then arecord, whichever is installed */
  recorder: 'auto' | 'sox' | 'ffmpeg' | 'arecord';
  /** a recording stops by itself after this long */
  maxSeconds: number;
}

export interface IdeConfig {
  /** B1: save an agent-edited document after the edit unless the user had unsaved changes in it. */
  autoSave: boolean;
  /** B10: run bash in a visible "Tugline" terminal (shell integration), else a hidden child process. */
  visibleTerminal: boolean;
  /** B3: profile for inline edits (default: the chat's profile). */
  inlineEditProfile?: string;
  /** B8: profile used while in plan mode (maps to routing.planner). */
  planProfile?: string;
  /** B5: a vision-capable profile used to describe pasted images for text-only models. */
  visionProfile?: string;
  /** B5: OCR pasted images with tesseract for text-only models. */
  ocr: boolean;
  /** B13: OS-level notifications for long runs and permission requests. */
  notifications: boolean;
  /** B13: a run longer than this notifies when it ends. */
  notifyAfterMs: number;
  autocomplete: AutocompleteConfig;
  nes: NesConfig;
  voice: VoiceConfig;
}

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** SPEC B (WS2). Defaults: DEFAULT_IDE. */
    ide?: Partial<Omit<IdeConfig, 'autocomplete' | 'nes' | 'voice'>> & { autocomplete?: Partial<AutocompleteConfig>; nes?: Partial<NesConfig>; voice?: Partial<VoiceConfig> };
  }
}

export const DEFAULT_AUTOCOMPLETE: AutocompleteConfig = { enabled: false, endpoint: 'completions', template: 'qwen', debounceMs: 250, maxTokens: 128 };

export const DEFAULT_NES: NesConfig = { enabled: false, latencyMs: 400, maxTokens: 512, debounceMs: 150 };
export const DEFAULT_VOICE: VoiceConfig = { enabled: false, model: 'whisper-1', recorder: 'auto', maxSeconds: 60 };

export const DEFAULT_IDE: IdeConfig = {
  autoSave: true,
  visibleTerminal: false,
  ocr: false,
  notifications: true,
  notifyAfterMs: 30_000,
  autocomplete: DEFAULT_AUTOCOMPLETE,
  nes: DEFAULT_NES,
  voice: DEFAULT_VOICE,
};

export function ideConfig(cfg: Pick<HarnessConfig, 'ide'>): IdeConfig {
  const i = cfg.ide ?? {};
  return { ...DEFAULT_IDE, ...i, autocomplete: { ...DEFAULT_AUTOCOMPLETE, ...(i.autocomplete ?? {}) }, nes: { ...DEFAULT_NES, ...(i.nes ?? {}) }, voice: { ...DEFAULT_VOICE, ...(i.voice ?? {}) } };
}
