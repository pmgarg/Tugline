/**
 * Tugline SDK example: a custom tool, a skill defined in code, an approval
 * callback, and one prompt.
 *
 *   TUG_BASE_URL=http://localhost:11434/v1 TUG_MODEL=qwen3-coder:30b npx tsx examples/sdk/basic.mts "What is 6 times 7?"
 *
 * In an installed package, import from 'tugline/dist/sdk/index.js' instead.
 */
import { createAgent, defineSkill, defineTool, type PermissionRequest } from '../../src/sdk/index.js';

const multiply = defineTool<{ a: number; b: number }>({
  name: 'multiply',
  kind: 'meta', // pure computation: touches no files, commands or network
  readOnly: true,
  description: 'Multiply two numbers exactly. Use it for any multiplication.',
  parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  run: ({ a, b }) => String(a * b),
});

const style = defineSkill({
  name: 'math-answers',
  description: 'Use for arithmetic questions.',
  instructions: 'Use the multiply tool, then answer with just the number.',
});

const agent = await createAgent({
  baseUrl: process.env.TUG_BASE_URL,
  model: process.env.TUG_MODEL,
  apiKey: process.env.TUG_API_KEY ?? '',
  tools: [multiply],
  skills: [style],
  // Approvals: allow reads, deny everything else (a real app would ask its user).
  onPermission: (req: PermissionRequest) => (req.kind === 'read' ? { decision: 'allow' } : { decision: 'deny', feedback: 'not allowed in this example' }),
  onEvent: (e) => {
    if (e.type === 'tool_end') console.error(`[tool] ${e.name} → ${e.output}`);
  },
});

try {
  const result = await agent.run(process.argv[2] ?? 'What is 6 times 7?');
  console.log(result.finalText);
  console.error(`[${result.stopReason}] ${result.stats.toolCalls} tool call(s), ${result.stats.promptTokens + result.stats.completionTokens} tokens`);
} finally {
  await agent.dispose();
}
