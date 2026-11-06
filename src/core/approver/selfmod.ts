/**
 * N43: the self-modification and persistence files (the agent's own config, hooks, CI, package lifecycle scripts,
 * build files that run code, rc files). In `auto` mode a write to one is on the deterministic floor; in `acceptEdits`
 * it asks (review finding 8). No imports from the permission engine, so policy.ts can use it without a cycle.
 */
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

function physicalPath(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  for (let head = abs; ; ) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Files whose change runs code later or changes the agent itself. Written in auto mode they always go to the human
 * (SAC4); they are never fast-pathed (and `fastPathEdit` excludes them on its own as well). Idea from Qwen Code's
 * PERSISTENCE / SELF_MODIFICATION path patterns (autoMode.ts, c726d2c), extended to our control files.
 */
export const SELF_MODIFICATION = [
  /(?:^|\/)\.git(?:\/|$)/i, // hooks, config, worktree .git files
  /(?:^|\/)\.husky\//i,
  /(?:^|\/)\.tugline(?:\/|$)/i,
  /(?:^|\/)\.(?:claude|agents|cursor|vscode|qwen)(?:\/|$)/i,
  /(?:^|\/)(?:AGENTS|CLAUDE|QWEN|GEMINI)\.md$/i,
  /(?:^|\/)\.mcp\.json$/i,
  /(?:^|\/)\.github\//i, // workflows, actions, CODEOWNERS
  /(?:^|\/)\.gitlab-ci\.yml$/i,
  /(?:^|\/)\.circleci\//i,
  /(?:^|\/)(?:azure-pipelines|bitbucket-pipelines|\.travis|appveyor|Jenkinsfile)(?:\.ya?ml)?$/i,
  /(?:^|\/)\.gitmodules$/i,
  /(?:^|\/)\.(?:gitattributes|gitconfig)$/i,
  /(?:^|\/)\.envrc$/i,
  /(?:^|\/)\.pre-commit-config\.yaml$/i,
  /(?:^|\/)package\.json$/i, // npm lifecycle scripts run on the next install
  /(?:^|\/)\.(?:npmrc|yarnrc(?:\.yml)?|pnpmfile\.cjs)$/i,
  /(?:^|\/)(?:setup\.py|setup\.cfg|conftest\.py|sitecustomize\.py|usercustomize\.py)$/i, // run on install / on every pytest run / on every python start
  /(?:^|\/)(?:makefile|gnumakefile|justfile|\.justfile|taskfile\.ya?ml)$/i,
  /(?:^|\/)\.(?:bashrc|bash_profile|bash_login|profile|zshrc|zshenv|zprofile|zlogin|inputrc)$/i, // rc files, wherever they are
  /(?:^|\/)\.config\/(?:fish|autostart|systemd)\//i,
  /(?:^|\/)\.ssh\//i,
];

/**
 * Why writing this path is self-modification or persistence, or null. The path may be a glob (an unexpanded shell
 * argument such as `Makefil?`, a rule pattern such as `.git*\/**`): then it counts when the pattern can name one of
 * the self-modification files (S7 rule scopes), or with `anySegment` when any one of its segments can (an unexpanded
 * shell glob, review finding 2).
 */
export function selfModificationPath(abs: string, workspace: string, anySegment = false): string | null {
  const ws = physicalPath(workspace);
  const cands = [path.resolve(workspace, abs), physicalPath(path.resolve(workspace, abs))];
  for (const c of cands) {
    const rel = path.relative(ws, c).split(path.sep).join('/');
    const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : c.split(path.sep).join('/');
    const re = SELF_MODIFICATION.find((r) => r.test(shown));
    if (re) return shown;
    if (/[*?[]/.test(shown) && globCanName(shown, anySegment)) return shown;
  }
  return null;
}

function globCanName(pattern: string, anySegment: boolean): boolean {
  const opts = { dot: true, nocase: true };
  const whole = picomatch(pattern, opts);
  if (NAMES.some((n) => whole(n) || whole(`${n}/x`))) return true;
  return anySegment && pattern.split('/').some((seg) => /[*?[]/.test(seg) && NAMES.some((n) => picomatch.isMatch(n, seg, opts)));
}


/** File names the floor protects, for globs that match nothing yet (`> Makefil?`, `> .githu?/workflows/x`). */
/** The file and directory names the patterns above protect (for matching globs against them). */
const NAMES = ['.git', '.husky', '.tugline', '.claude', '.agents', '.cursor', '.vscode', '.qwen', 'AGENTS.md', 'CLAUDE.md', 'QWEN.md', 'GEMINI.md', '.mcp.json', '.github', '.gitlab-ci.yml', '.circleci', '.gitmodules', '.gitattributes', '.gitconfig', '.envrc', '.pre-commit-config.yaml', 'package.json', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', 'setup.py', 'setup.cfg', 'conftest.py', 'sitecustomize.py', 'usercustomize.py', 'Makefile', 'GNUmakefile', 'justfile', '.justfile', 'Taskfile.yml', 'Taskfile.yaml', '.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.inputrc', '.ssh', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', '.travis.yml', 'appveyor.yml', 'Jenkinsfile'];
