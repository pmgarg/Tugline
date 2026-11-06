/**
 * WorkspaceHost (SPEC S0.1): where file tools read and write.
 *
 * The CLI and eval harness use DiskHost. The VS Code extension provides a host
 * backed by open TextDocuments and WorkspaceEdit, so agent edits merge with the
 * user's unsaved changes and land on the undo stack (SPEC B1).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Diagnostic {
  path: string;
  line: number;
  col: number;
  severity: 'error' | 'warning';
  message: string;
  source?: string;
}

export interface HostText {
  text: string;
  /** Opaque version token: mtime for disk, document.version for editors. */
  version: string;
  /** True if the editor holds unsaved changes. */
  dirty: boolean;
  eol: '\n' | '\r\n';
  /** False when the bytes are not valid UTF-8 (then `text` is lossy and must not be written back). */
  utf8: boolean;
  /** Raw bytes when the host has them (disk). */
  bytes?: Uint8Array;
}

/**
 * A foreground shell command the bash tool is about to run (SPEC B10). `file`,
 * `args`, `cwd` and `env` are the spec AFTER every command wrapper (OS sandbox,
 * S0.7) was applied, so a host that runs it elsewhere (a visible terminal) keeps
 * the sandbox.
 */
export interface HostCommand {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The command line the model asked for (for display). */
  command: string;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface HostCommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export interface WorkspaceHost {
  readonly kind: 'disk' | 'vscode' | (string & {});
  readText(abs: string): Promise<HostText | undefined>;
  writeText(abs: string, text: string, opts?: { label?: string }): Promise<{ version: string }>;
  exists(abs: string): Promise<boolean>;
  delete(abs: string): Promise<void>;
  /**
   * Save dirty agent-touched documents before a shell command. Returns the paths saved, or (v1.1 R8)
   * a report: saved, skipped (the user had unsaved changes, so the shell sees the disk version) and
   * failed saves. The agent reports skipped/failed files to the model and records them as evidence.
   */
  flushForShell?(): Promise<string[] | FlushReport>;
  /**
   * v1.1 R8: save these documents (ones the user had unsaved changes in), after the user decided
   * to run a check against the editor version. Hosts without it can only run against the disk.
   */
  saveDocuments?(paths: string[]): Promise<FlushReport>;
  /** Current diagnostics, optionally waiting for a fresh publish after an edit. */
  diagnostics?(abs?: string, opts?: { waitMs?: number }): Promise<Diagnostic[]>;
  onExternalChange?(cb: (abs: string) => void): () => void;
  /**
   * Run a foreground command visibly (VS Code terminal, B10). Resolve undefined,
   * before starting anything, to let the shell tool spawn it itself (fallback);
   * once the command has started, always resolve with its result.
   */
  runCommand?(cmd: HostCommand): Promise<HostCommandResult | undefined>;
  /**
   * Code navigation from the editor's language features (N3). Resolve undefined
   * when the op is unsupported or no provider answers, so the core falls back to
   * its own LSP client / tree-sitter. See NavRequest / NavResult.
   */
  navigate?(req: NavRequest): Promise<NavResult | undefined>;
}

/**
 * N3 navigation contract (lines and columns are 1-based; `path` is absolute).
 * VS Code maps these to the stable commands:
 *   definition       → vscode.executeDefinitionProvider(uri, pos)
 *   references       → vscode.executeReferenceProvider(uri, pos)   (declaration included)
 *   documentSymbols  → vscode.executeDocumentSymbolProvider(uri)    (flattened, `container` = parent name)
 *   workspaceSymbols → vscode.executeWorkspaceSymbolProvider(query)
 *   hover            → vscode.executeHoverProvider(uri, pos)        (markdown joined as plain text)
 *   rename           → vscode.executeDocumentRenameProvider(uri, pos, newName) (edits only, never applied)
 */
export type NavOp = 'definition' | 'references' | 'documentSymbols' | 'workspaceSymbols' | 'hover' | 'rename'
  // v1.2 N46 (VS Code: executeImplementationProvider, executeTypeDefinitionProvider, prepare/provideIncoming/OutgoingCalls, executeCodeActionProvider)
  | 'implementation' | 'typeDefinition' | 'incomingCalls' | 'outgoingCalls' | 'codeActions';
export interface NavRequest {
  op: NavOp;
  path?: string;
  line?: number;
  col?: number;
  /** workspaceSymbols query */
  query?: string;
  /** rename */
  newName?: string;
  /** v1.2 N46: range end for codeActions (1-based, inclusive line) */
  endLine?: number;
  endCol?: number;
}
export interface NavLocation {
  path: string;
  line: number;
  col: number;
  endLine?: number;
  /** symbol name (symbols ops) */
  name?: string;
  /** LSP SymbolKind name: "class", "method", … */
  kind?: string;
  /** enclosing symbol */
  container?: string;
}
export interface NavEdit {
  path: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  newText: string;
}
export interface NavCall {
  name: string;
  kind?: string;
  path: string;
  line: number;
  col: number;
  /** where the call happens (incoming: in the caller; outgoing: in this function) */
  at?: { line: number; col: number }[];
}
export interface NavAction {
  title: string;
  kind?: string;
  /** the WorkspaceEdit, flattened; absent when the action only runs a server command (never executed) */
  edits?: NavEdit[];
  command?: string;
}
export interface NavResult {
  locations?: NavLocation[];
  hover?: string;
  edits?: NavEdit[];
  /** v1.2 N46: call hierarchy and code actions */
  calls?: NavCall[];
  actions?: NavAction[];
}

/** v1.1 R8: what flushForShell did with each dirty document. */
export interface FlushReport {
  saved: string[];
  skipped: string[];
  failed: { path: string; error: string }[];
}

export class DiskHost implements WorkspaceHost {
  readonly kind = 'disk' as const;
  async readText(abs: string): Promise<HostText | undefined> {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(abs);
    } catch {
      return undefined;
    }
    if (!st.isFile()) return undefined;
    const bytes = await fs.promises.readFile(abs);
    let utf8 = true;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      utf8 = false;
      text = bytes.toString('utf8');
    }
    return { text, version: String(st.mtimeMs), dirty: false, eol: text.includes('\r\n') ? '\r\n' : '\n', utf8, bytes };
  }
  async writeText(abs: string, text: string): Promise<{ version: string }> {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, text, 'utf8');
    return { version: String((await fs.promises.stat(abs)).mtimeMs) };
  }
  async exists(abs: string): Promise<boolean> {
    try {
      await fs.promises.access(abs);
      return true;
    } catch {
      return false;
    }
  }
  async delete(abs: string): Promise<void> {
    await fs.promises.rm(abs, { force: true });
  }
}

export const diskHost = new DiskHost();
