/** `tug acp` / `tug --acp` (SPEC G1): an ACP agent on stdio. Logs go to stderr; stdout is the protocol. */
import { fileURLToPath } from 'node:url';
import { registerCliCommand } from '../core/commands.js';
import { bundledDirs } from '../core/agent/agent.js';

registerCliCommand({
  name: 'acp',
  description: 'speak the Agent Client Protocol on stdio (Zed, JetBrains, Neovim)',
  async run() {
    let dirs: { bundledSkillsDir?: string; bundledAgentsDir?: string } = {};
    try {
      const d = bundledDirs(fileURLToPath(import.meta.url));
      dirs = { bundledSkillsDir: d.skills, bundledAgentsDir: d.agents };
    } catch {
      /* bundled */
    }
    // Anything that would print to stdout must go to stderr instead.
    console.log = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n');
    const { runAcp } = await import('./agent.js'); // the ACP SDK is loaded only in ACP mode
    await runAcp({ agentOptions: dirs });
    return 0;
  },
});
