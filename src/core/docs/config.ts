/**
 * WS12 `docs` config section (declaration-merged into HarnessConfig; defaults here).
 */
import type { HarnessConfig } from '../config.js';

export interface DocsConfig {
  /** Profile for wiki/ask/sync/changelog work (default: routing.explore, else the main profile). */
  profile?: string;
  wiki: {
    /** Output directory, workspace-relative (default .tugline/wiki). */
    outDir: string;
    /** At most this many module pages (small directories are merged into their parent). */
    maxPages: number;
  };
  check: {
    /** Documentation files to check. */
    docs: string[];
    /** argv that prints the CLI's help (`<argv> --help`, `<argv> <sub> --help`); empty disables the flag check. */
    cli: string[];
    /** Name the docs use for the CLI. */
    cliName: string;
    links: boolean;
    codeRefs: boolean;
    cliFlags: boolean;
    snippets: boolean;
  };
  sync: {
    /** The doc-sync agent may write only these globs (enforced by the permission policy). */
    writeOnly: string[];
  };
  ask: {
    /** Offer the `ask_codebase` tool to agents (off by default: every tool costs schema tokens on small models). */
    tool: boolean;
  };
}

export const DEFAULT_DOCS: DocsConfig = {
  wiki: { outDir: '.tugline/wiki', maxPages: 30 },
  check: { docs: ['README.md', '*.md', 'docs/**/*.md'], cli: ['tug'], cliName: 'tug', links: true, codeRefs: true, cliFlags: true, snippets: true },
  sync: { writeOnly: ['docs/**', 'README.md', '*.md'] },
  ask: { tool: false },
};

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** WS12 documentation features. Defaults: DEFAULT_DOCS. */
    docs?: { profile?: string; wiki?: Partial<DocsConfig['wiki']>; check?: Partial<DocsConfig['check']>; sync?: Partial<DocsConfig['sync']>; ask?: Partial<DocsConfig['ask']> };
  }
}

export function docsConfig(cfg: Pick<HarnessConfig, 'docs'> | undefined): DocsConfig {
  const d = cfg?.docs ?? {};
  return {
    profile: d.profile,
    wiki: { ...DEFAULT_DOCS.wiki, ...(d.wiki ?? {}) },
    check: { ...DEFAULT_DOCS.check, ...(d.check ?? {}) },
    sync: { ...DEFAULT_DOCS.sync, ...(d.sync ?? {}) },
    ask: { ...DEFAULT_DOCS.ask, ...(d.ask ?? {}) },
  };
}
