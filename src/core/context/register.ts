/**
 * WS4 side-effect registrations (one import line in tools/providers.ts):
 * tool providers (jobs, memory, notebooks, repo map, worktrees) and the
 * /context, /goal, /jobs and /memory slash commands.
 */
import '../jobs/tools.js';
import '../memory/tools.js';
import '../tools/notebook.js';
import './repomap.js';
import './worktree.js';
import './commands.js';
