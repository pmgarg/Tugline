/**
 * CLI colour themes (v1.2 N49; Qwen Code /theme). `--theme`, `/theme`, or `"cli": {"theme": …}` in the user
 * config. NO_COLOR (no-color.org), `--screen-reader` and a non-TTY stdout all mean plain text.
 */
export const THEMES = ['dark', 'light', 'high-contrast', 'none'] as const;
export type ThemeName = (typeof THEMES)[number];

export interface Palette {
  dim: (s: string) => string;
  bold: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  magenta: (s: string) => string;
}

declare module '../core/config.js' {
  interface HarnessConfigExtensions {
    cli?: { theme?: ThemeName; vim?: boolean; /** review F13: trust the OS certificate store (default true) */ systemCa?: boolean };
  }
}

const wrap = (open: string, close = '\x1b[0m') => (s: string) => `${open}${s}${close}`;
const id = (s: string) => s;

const CODES: Record<Exclude<ThemeName, 'none'>, Record<keyof Palette, string>> = {
  // the v1.0 colours
  dark: { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m' },
  // dark foregrounds that stay readable on a white background (no dim, no yellow-on-white)
  light: { dim: '\x1b[90m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[35m', cyan: '\x1b[34m', magenta: '\x1b[35m' },
  // bright and bold, nothing dimmed
  'high-contrast': { dim: '\x1b[97m', bold: '\x1b[1;97m', red: '\x1b[1;91m', green: '\x1b[1;92m', yellow: '\x1b[1;93m', cyan: '\x1b[1;96m', magenta: '\x1b[1;95m' },
};

export function isTheme(s: unknown): s is ThemeName {
  return typeof s === 'string' && (THEMES as readonly string[]).includes(s);
}

/** The theme in force: plain when colour is off for any reason. */
export function resolveTheme(o: { flag?: string; config?: string; tty: boolean; env?: NodeJS.ProcessEnv; screenReader?: boolean }): ThemeName {
  const env = o.env ?? process.env;
  if (!o.tty || (env.NO_COLOR !== undefined && env.NO_COLOR !== '') || o.screenReader) return 'none';
  if (isTheme(o.flag)) return o.flag;
  if (isTheme(o.config)) return o.config;
  return 'dark';
}

export function palette(t: ThemeName): Palette {
  if (t === 'none') return { dim: id, bold: id, red: id, green: id, yellow: id, cyan: id, magenta: id };
  const c = CODES[t];
  return { dim: wrap(c.dim), bold: wrap(c.bold), red: wrap(c.red), green: wrap(c.green), yellow: wrap(c.yellow), cyan: wrap(c.cyan), magenta: wrap(c.magenta) };
}
