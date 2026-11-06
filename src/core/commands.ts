/**
 * Slash-command registry (SPEC S0.6). Any workstream can add /commands that work
 * in the CLI (and, via the same registry, in VS Code and server mode) without
 * editing src/cli/main.ts.
 */
import type { HarnessConfig } from './config.js';

export interface SlashContext {
  /** The Agent instance (typed loosely to avoid an import cycle). */
  agent: any;
  config: HarnessConfig;
  workspace: string;
  /** Print to the user (CLI stdout / chat notice). */
  write: (text: string) => void;
  /** Ask the user a question (may be undefined in headless surfaces). */
  ask?: (question: string, options?: string[]) => Promise<string>;
  surface: 'cli' | 'vscode' | 'server';
}

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  /** Return { prompt } to send a prompt to the agent after the command runs. */
  run(args: string, ctx: SlashContext): Promise<{ prompt?: string } | void> | { prompt?: string } | void;
}

const commands = new Map<string, SlashCommand>();

export function registerSlashCommand(c: SlashCommand): void {
  commands.set(c.name, c);
}

export function getSlashCommand(name: string): SlashCommand | undefined {
  return commands.get(name);
}

export function slashCommands(): SlashCommand[] {
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** `tug <name> …` subcommands (SPEC S0.6). argv excludes the subcommand itself. */
export interface CliCommand {
  name: string;
  description: string;
  usage?: string;
  /** Full help for `tug <name> --help` (default: the usage line). Docs checks read it (WS12). */
  help?: () => string;
  /** Does it need a model endpoint/agent? (false → runs before config/model checks) */
  needsModel?: boolean;
  run(argv: string[], ctx: { config: HarnessConfig; workspace: string; write: (t: string) => void }): Promise<number | void> | number | void;
}
const cli = new Map<string, CliCommand>();
export function registerCliCommand(c: CliCommand): void {
  cli.set(c.name, c);
}
export function getCliCommand(name: string): CliCommand | undefined {
  return cli.get(name);
}
export function cliCommands(): CliCommand[] {
  return [...cli.values()].sort((a, b) => a.name.localeCompare(b.name));
}
