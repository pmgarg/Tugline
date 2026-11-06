/**
 * The `remember` tool (SPEC D6). Project memory lives in an agent-control file
 * (.tugline/MEMORY.md), so the permission engine asks for every write, even
 * in auto mode. User memory (~/.tugline/MEMORY.md) is injected into every
 * future session in every project, a persistence vector, so it asks in every
 * mode too (`alwaysAsk`, enforced by the agent loop; it is outside the
 * workspace, so it cannot be described to the policy as a path).
 */
import path from 'node:path';
import { registerToolProvider } from '../tools/registry.js';
import { ToolError, type ToolDef } from '../tools/types.js';
import { addMemory, MEMORY_KINDS, memoryFile, type MemoryKind, type MemoryScope } from './memory.js';

type Args = { text: string; scope?: MemoryScope; kind?: MemoryKind; key?: string };

export const rememberTool: ToolDef<Args> = {
  name: 'remember',
  kind: 'edit',
  description:
    'Save a durable memory that future sessions will see in their instructions. Only for stable facts (build/test commands, layout), user preferences, decisions, ' +
    'procedures that worked, or pointers to docs — never raw tool output, temporary paths, guesses or secrets. ' +
    'Give a short `key`: a new memory with the same key supersedes the old one. scope "project" (default) is shared with this repository; "user" applies to all projects.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'One sentence' },
      scope: { type: 'string', enum: ['project', 'user'] },
      kind: { type: 'string', enum: [...MEMORY_KINDS] },
      key: { type: 'string', description: 'Short kebab-case subject, e.g. "test-command"' },
    },
    required: ['text'],
  },
  title: (a) => `Remember (${a.scope ?? 'project'}): ${String(a.text ?? '').slice(0, 80)}`,
  permissionInput: (a, ctx) =>
    (a.scope ?? 'project') === 'user'
      ? { alwaysAsk: 'writes your user memory (~/.tugline/MEMORY.md), which is loaded into every future session in every project' }
      : { paths: [{ path: memoryFile('project', ctx.workspace, ctx.config.homeDir), write: true }] },
  validate(a) {
    if (a.scope && a.scope !== 'project' && a.scope !== 'user') throw new ToolError('scope must be "project" or "user"');
    if (a.kind && !MEMORY_KINDS.includes(a.kind)) throw new ToolError(`kind must be one of ${MEMORY_KINDS.join(', ')}`);
  },
  async run(a, ctx) {
    const scope = a.scope ?? 'project';
    const file = memoryFile(scope, ctx.workspace, ctx.config.homeDir);
    let r: { line: string; superseded: string[] };
    try {
      r = addMemory(file, { kind: a.kind ?? 'fact', key: a.key ?? '', text: a.text });
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    const where = scope === 'user' ? '~/.tugline/MEMORY.md' : path.relative(ctx.workspace, file);
    return { output: `Saved to ${where}:\n${r.line}${r.superseded.length ? `\nSuperseded:\n${r.superseded.join('\n')}` : ''}\nIt will be in the instructions of the next session.`, meta: { memoryFile: file } };
  },
};

registerToolProvider({ id: 'ws4-memory', tools: () => [rememberTool] });
