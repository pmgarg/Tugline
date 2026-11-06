// Dependency-free MCP stdio server (2025-era handshake) used by the plugin fixtures.
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const tools = [{ name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }];
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return; // notifications
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': return ok({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'plugin-calc', version: '1.0.0' } });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools });
    case 'tools/call': return ok({ content: [{ type: 'text', text: String((m.params?.arguments?.a ?? 0) + (m.params?.arguments?.b ?? 0)) }] });
    default: return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
});
