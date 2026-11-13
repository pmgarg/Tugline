/**
 * Model details from GET /models: each server family names the context window, output limit, tools and images
 * differently. The connection form fills its context-window and output choices from these.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelInfoOf, parseModelInfos, tokenLabel } from '../src/core/llm/modelInfo.js';
import { LLMClient } from '../src/core/llm/client.js';

test('model info: vLLM reports max_model_len', () => {
  assert.deepEqual(modelInfoOf({ id: 'Qwen/Qwen3-Coder-30B', object: 'model', max_model_len: 131072 }), { id: 'Qwen/Qwen3-Coder-30B', contextWindow: 131072 });
});

test('model info: OpenRouter reports context, output limit, tools and images', () => {
  const m = modelInfoOf({
    id: 'qwen/qwen3-coder',
    context_length: 262144,
    top_provider: { context_length: 262144, max_completion_tokens: 65536 },
    supported_parameters: ['temperature', 'tools', 'tool_choice'],
    architecture: { input_modalities: ['text', 'image'] },
  });
  assert.deepEqual(m, { id: 'qwen/qwen3-coder', contextWindow: 262144, maxOutput: 65536, tools: true, vision: true });
  assert.equal(modelInfoOf({ id: 'x', supported_parameters: ['temperature'] })!.tools, false);
});

test('model info: Groq, Mistral, LM Studio and llama.cpp field names', () => {
  assert.deepEqual(modelInfoOf({ id: 'llama-3.3-70b', context_window: 131072, max_completion_tokens: 32768 }), { id: 'llama-3.3-70b', contextWindow: 131072, maxOutput: 32768 });
  assert.deepEqual(modelInfoOf({ id: 'codestral', max_context_length: 256000, capabilities: { function_calling: true, vision: false } }), { id: 'codestral', contextWindow: 256000, tools: true, vision: false });
  assert.deepEqual(modelInfoOf({ id: 'qwen2-vl', type: 'vlm', max_context_length: 32768 }), { id: 'qwen2-vl', contextWindow: 32768, vision: true });
  assert.deepEqual(modelInfoOf({ id: 'model.gguf', meta: { n_ctx_train: 40960 } }), { id: 'model.gguf', contextWindow: 40960 });
});

test('model info: a plain OpenAI list has ids only; bad values are ignored', () => {
  assert.deepEqual(modelInfoOf({ id: 'gpt-x', object: 'model', owned_by: 'openai' }), { id: 'gpt-x' });
  assert.deepEqual(modelInfoOf({ id: 'm', context_length: -1, max_model_len: 'lots' }), { id: 'm' });
  assert.equal(modelInfoOf({ object: 'model' }), undefined);
});

test('model info: a list is sorted, one entry per id; Ollama /api/tags names work', () => {
  const l = parseModelInfos({ data: [{ id: 'b' }, { id: 'a', max_model_len: 4096 }, { id: 'a' }] });
  assert.deepEqual(l, [{ id: 'a', contextWindow: 4096 }, { id: 'b' }]);
  assert.deepEqual(parseModelInfos({ models: [{ name: 'qwen3:8b' }] }), [{ id: 'qwen3:8b' }]);
  assert.deepEqual(parseModelInfos({}), []);
});

test('model info: token sizes read as people say them', () => {
  assert.equal(tokenLabel(8192), '8K');
  assert.equal(tokenLabel(131072), '128K');
  assert.equal(tokenLabel(200000), '200K');
  assert.equal(tokenLabel(1048576), '1M');
  assert.equal(tokenLabel(512), '512');
});

test('model info: the client reads the details from the server, and listModels still gives the ids', async () => {
  const http = await import('node:http');
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'coder', max_model_len: 65536 }, { id: 'chat' }] }));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  try {
    const port = (s.address() as any).port;
    const c = new LLMClient({ name: 't', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', model: 'coder', contextWindow: 8192, maxOutputTokens: 256, toolMode: 'auto', vision: false });
    assert.deepEqual(await c.listModelInfo(), [{ id: 'chat' }, { id: 'coder', contextWindow: 65536 }]);
    assert.deepEqual(await c.listModels(), ['chat', 'coder']);
  } finally {
    await new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())));
  }
});
