// Minimal MCP stdio server used by tests and as an example.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer({ name: 'calc', version: '1.0.0' });
server.registerTool('add', { description: 'Add two numbers and return the sum.', inputSchema: z.object({ a: z.number(), b: z.number() }) }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
server.registerTool('shout', { description: 'Uppercase a string.', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({ content: [{ type: 'text', text: text.toUpperCase() }] }));
await server.connect(new StdioServerTransport());
