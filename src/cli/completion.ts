/**
 * `tug completion bash|zsh|fish` (v1.2 N49): shell completion for subcommands, flags and flag values. The
 * scripts are static text generated from the registered commands; they never run `tug` while completing.
 */
import { cliCommands } from '../core/commands.js';
import { THEMES } from './theme.js';

export const BUILTIN_SUBCOMMANDS = ['setup', 'doctor', 'models', 'sessions', 'eval', 'rescore', 'completion', 'config', 'version'];

/** Flags of the main command, with the values a completer can offer. */
export const FLAGS: Record<string, string[] | null> = {
  '--print': null,
  '--output-format': ['text', 'json', 'stream-json'],
  '--input-format': ['text', 'stream-json'],
  '--input-file': null,
  '--json': null,
  '--model': null,
  '--profile': null,
  '--base-url': null,
  '--api-key': null,
  '--mode': ['ask', 'acceptEdits', 'plan', 'auto'],
  '--plan': null,
  '--yolo': null,
  '--no-sandbox': null,
  '--cwd': null,
  '--home': null,
  '--ctx': null,
  '--max-turns': null,
  '--max-output': null,
  '--max-wall-time': null,
  '--timeout': null,
  '--max-tool-calls': null,
  '--allowed-tools': null,
  '--exclude-tools': null,
  '--allowed-mcp-server-names': null,
  '--include-directories': null,
  '--system-prompt': null,
  '--append-system-prompt': null,
  '--output-style': null,
  '--effort': ['off', 'low', 'medium', 'high'],
  '--theme': [...THEMES],
  '--screen-reader': null,
  '--vim': null,
  '--session-id': null,
  '--fork-session': null,
  '--resume': null,
  '--continue': null,
  '--text-tools': null,
  '--native-tools': null,
  '--compact-prompt': null,
  '--allowlist': null,
  '--validate': null,
  '--verbose': null,
  '--acp': null,
  '--no-mcp': null,
  '--trust': null,
  '--help': null,
  '--version': null,
};

function subcommands(): string[] {
  return [...new Set([...BUILTIN_SUBCOMMANDS, ...cliCommands().map((c) => c.name)])].sort();
}

export function completionScript(shell: string): string {
  const subs = subcommands();
  const flags = Object.keys(FLAGS);
  const valued = Object.entries(FLAGS).filter(([, v]) => v);
  if (shell === 'bash') {
    return `# tug (Tugline) bash completion. Install: tug completion bash > ~/.local/share/bash-completion/completions/tug
_tug() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
${valued.map(([f, v]) => `    ${f}) COMPREPLY=( $(compgen -W "${v!.join(' ')}" -- "$cur") ); return 0;;`).join('\n')}
  esac
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "${flags.join(' ')}" -- "$cur") )
  elif [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${subs.join(' ')}" -- "$cur") )
  else
    COMPREPLY=( $(compgen -f -- "$cur") )
  fi
}
complete -F _tug tug
complete -F _tug tugline
`;
  }
  if (shell === 'zsh') {
    return `#compdef tug tugline
# tug (Tugline) zsh completion. Install: tug completion zsh > "\${fpath[1]}/_tug"
_tug() {
  local -a subs flags
  subs=(${subs.map((s) => `'${s}'`).join(' ')})
  flags=(${flags.map((f) => `'${f}'`).join(' ')})
  case "$words[CURRENT-1]" in
${valued.map(([f, v]) => `    ${f}) compadd -- ${v!.join(' ')}; return;;`).join('\n')}
  esac
  if [[ "$words[CURRENT]" == -* ]]; then
    compadd -- $flags
  elif (( CURRENT == 2 )); then
    compadd -- $subs
  else
    _files
  fi
}
compdef _tug tug tugline 2>/dev/null || true
`;
  }
  if (shell === 'fish') {
    return [
      '# tug (Tugline) fish completion. Install: tug completion fish > ~/.config/fish/completions/tug.fish',
      `complete -c tug -f -n '__fish_use_subcommand' -a '${subs.join(' ')}'`,
      ...Object.entries(FLAGS).map(([f, v]) => `complete -c tug -l ${f.slice(2)}${v ? ` -x -a '${v.join(' ')}'` : ''}`),
      '',
    ].join('\n');
  }
  throw new Error(`unknown shell "${shell}" (bash, zsh or fish)`);
}
