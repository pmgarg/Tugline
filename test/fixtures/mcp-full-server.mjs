// MCP stdio server for the WS7 G3 tests: a tool, a resource, a prompt, and a
// tool that asks the user for input (elicitation). It serves both protocol eras:
// on 2026-07-28 it returns `input_required` (multi round-trip); on a 2025-era
// connection it falls back to the push-style elicitation request.
import { McpServer, inputRequired, acceptedContent } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer({ name: 'notes', version: '1.0.0' });

server.registerTool('echo', { description: 'Echo the text back.', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }));

server.registerResource('readme', 'notes://readme', { title: 'Project notes', description: 'The team notes file', mimeType: 'text/plain' }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'NOTES: the deploy password rotates on Fridays.' }],
}));

server.registerPrompt('greet', { title: 'Greeting', description: 'Write a greeting for someone', argsSchema: z.object({ name: z.string() }) }, ({ name }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `Write a one-line greeting for ${name}.` } }],
}));

const nameSchema = z.object({ name: z.string(), excited: z.boolean().optional() });
server.registerTool('whoami', { description: 'Ask the user for their name and greet them.', inputSchema: z.object({}) }, async (_args, ctx) => {
  const message = 'What is your name?';
  const requestedSchema = { type: 'object', properties: { name: { type: 'string', description: 'Your name' }, excited: { type: 'boolean', description: 'Add an exclamation mark?' } }, required: ['name'] };
  let content = acceptedContent(ctx?.mcpReq?.inputResponses, 'who', nameSchema);
  if (!content) {
    if (typeof ctx?.mcpReq?.elicitInput === 'function') {
      try {
        const r = await ctx.mcpReq.elicitInput({ mode: 'form', message, requestedSchema });
        if (r.action !== 'accept') return { content: [{ type: 'text', text: `user ${r.action}d` }] };
        content = r.content;
      } catch {
        return inputRequired({ inputRequests: { who: inputRequired.elicit({ message, requestedSchema: nameSchema }) } });
      }
    } else {
      return inputRequired({ inputRequests: { who: inputRequired.elicit({ message, requestedSchema: nameSchema }) } });
    }
  }
  return { content: [{ type: 'text', text: `Hello ${content.name}${content.excited ? '!' : '.'}` }] };
});

await server.connect(new StdioServerTransport());
