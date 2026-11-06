/**
 * WS7 side-effect registrations (one import line in tools/providers.ts):
 * `tug mcp …`, `tug plugin …`, /plugins, /output-style, /statusline, the
 * imported-rules extension, and a provider that registers the workspace's
 * markdown commands (.claude/commands etc.) when an agent is created.
 */
import '../mcp/cli.js';
import './cli.js';
import './index.js';
import './statusLine.js';
import '../skills/compat.js';
import '../skills/outputStyles.js';
import { registerToolProvider } from '../tools/registry.js';
import { registerWorkspaceCommands } from '../skills/compat.js';

registerToolProvider({
  id: 'ws7-commands',
  tools(_cfg, env) {
    if (env.depth === 0) registerWorkspaceCommands(env.workspace);
    return [];
  },
});
