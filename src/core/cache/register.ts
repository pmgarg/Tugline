/**
 * WS10 side-effect registrations (one import line in tools/providers.ts):
 * N10 prompt-cache extensions and the /cache command.
 */
import { registerAgentExtension } from '../agent/extensions.js';
import { registerSlashCommand } from '../commands.js';
import { cacheMeterExtension, idleCompactionExtension, prefixGuardExtension } from './extension.js';
import { cacheTallyFor, formatCacheLine } from './meter.js';
import { promptCacheSettings } from './settings.js';

registerAgentExtension(cacheMeterExtension);
registerAgentExtension(prefixGuardExtension);
registerAgentExtension(idleCompactionExtension);

registerSlashCommand({
  name: 'cache',
  description: 'prompt-cache hit rate, the last prefix break and its cause',
  run(_args, ctx) {
    const a = ctx.agent;
    const t = cacheTallyFor(a.sessionId);
    const s = promptCacheSettings(ctx.config);
    const p = a.llm?.profile ?? {};
    const server = p.server ?? a.llm?.detectedServer;
    const lines = [
      formatCacheLine(t),
      `server: ${server ?? 'unknown (run `tug doctor` to probe)'}${server === 'llamacpp' ? ` · cache_prompt ${p.llamacpp?.cachePrompt === false ? 'off' : 'on'} · slots ${p.llamacpp?.slots ?? 'unknown (no id_slot pinning)'}` : ''}`,
      `prefix breaks this session: ${t?.breaks ?? 0}${t?.lastBreak ? ` · last at turn ${t.lastBreak.turn}: ${t.lastBreak.causes.join(', ')} (${t.lastBreak.detail}; ~${t.lastBreak.invalidatedTokens} tokens re-read)` : ''}`,
      `guard ${s.guard ? 'on' : 'off'} · stable environment ${s.stableEnvironment ? 'on' : 'off'} · idle compaction ${s.idleCompaction ? `after ${Math.round(s.idleCompactMs / 1000)}s idle above ${Math.round(s.idleCompactAt * 100)}% of the budget` : 'off'}`,
    ];
    ctx.write(lines.join('\n'));
  },
});
