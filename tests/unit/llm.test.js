'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TokenomixClient, sanitizeMessages, toAnthropic, LlmError } = require('../../src/main/llm');
const { sseResponse, openAiTurn, scriptedFetch } = require('./helpers');

test('chat completions: streams text and assembles tool calls', async () => {
  const f = scriptedFetch([openAiTurn({ text: 'Halo ', tools: [['read_file', { path: 'a.txt' }]] })]);
  const c = new TokenomixClient({ apiKey: 'k', fetchImpl: f });
  let text = '';
  const r = await c.stream({ model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], tools: [] }, { onText: (t) => { text += t; } });
  assert.strictEqual(text, 'Halo ');
  assert.strictEqual(r.toolCalls[0].function.name, 'read_file');
  assert.deepStrictEqual(JSON.parse(r.toolCalls[0].function.arguments), { path: 'a.txt' });
  assert.strictEqual(r.finishReason, 'tool_calls');
  assert.strictEqual(f.calls[0].url, 'https://api.tokenomixai.com/v1/chat/completions');
  assert.strictEqual(f.calls[0].headers.Authorization, 'Bearer k');
  assert.strictEqual(f.calls[0].body.stream, true);
});

test('claude models use /v1/messages with native tool blocks', async () => {
  const ev = (type, d) => ({ type, ...d });
  const f = scriptedFetch([sseResponse([
    ev('message_start', { message: { usage: { input_tokens: 50, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Oke.' } }),
    ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'grep', input: {} } }),
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"pattern":' } }),
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"x"}' } }),
    ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }),
    ev('message_stop', {}),
  ])]);
  const c = new TokenomixClient({ apiKey: 'k', fetchImpl: f });
  const r = await c.stream({
    model: 'claude-opus-5-5',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'cari' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: '{"content":"isi"}' },
    ],
    tools: [{ type: 'function', function: { name: 'grep', description: 'd', parameters: { type: 'object', properties: {} } } }],
  });
  assert.strictEqual(f.calls[0].url, 'https://api.tokenomixai.com/v1/messages');
  const body = f.calls[0].body;
  assert.strictEqual(body.system, 'sys');
  assert.deepStrictEqual(body.messages[2].content[0], { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"content":"isi"}' });
  assert.strictEqual(body.tools[0].input_schema.type, 'object');
  assert.strictEqual(r.text, 'Oke.');
  assert.deepStrictEqual(r.toolCalls, [{ id: 'toolu_9', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } }]);
  assert.strictEqual(r.finishReason, 'tool_calls');
  assert.deepStrictEqual(r.usage, { prompt: 50, completion: 20 });
});

test('falls back to chat completions when /v1/messages is refused', async () => {
  const f = scriptedFetch([
    new Response(JSON.stringify({ error: { message: 'no route' } }), { status: 404 }),
    openAiTurn({ text: 'via openai' }),
  ]);
  const c = new TokenomixClient({ apiKey: 'k', fetchImpl: f });
  const r = await c.stream({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(r.text, 'via openai');
  assert.match(f.calls[1].url, /chat\/completions$/);
  assert.strictEqual(c.useMessagesApi('claude-x'), false);
});

test('errors carry status and retryable flag', async () => {
  const c1 = new TokenomixClient({ apiKey: 'k', fetchImpl: scriptedFetch([new Response('{"error":{"code":"upstream_unavailable","message":"busy"}}', { status: 502 })]) });
  await assert.rejects(c1.stream({ model: 'glm', messages: [{ role: 'user', content: 'x' }] }), (e) => e instanceof LlmError && e.retryable && e.status === 502);
  const c2 = new TokenomixClient({ apiKey: 'k', fetchImpl: scriptedFetch([new Response('{"error":{"code":"invalid_api_key","message":"bad"}}', { status: 401 })]) });
  await assert.rejects(c2.stream({ model: 'glm', messages: [{ role: 'user', content: 'x' }] }), /API key TokenomixAI ditolak/);
  const c3 = new TokenomixClient({ apiKey: '' });
  await assert.rejects(c3.listModels(), /belum diisi/);
});

test('cut-off stream is reported as retryable', async () => {
  const f = scriptedFetch([sseResponse([{ choices: [{ delta: { content: 'setengah' } }] }])]);
  const c = new TokenomixClient({ apiKey: 'k', fetchImpl: f });
  await assert.rejects(c.stream({ model: 'glm', messages: [{ role: 'user', content: 'x' }] }), /terputus/);
});

test('listModels maps the catalog', async () => {
  const f = scriptedFetch([new Response(JSON.stringify({ data: [{ id: 'kimi-k3', owned_by: 'moonshot' }, { id: 'claude-opus-5-5' }] }), { status: 200 })]);
  const c = new TokenomixClient({ apiKey: 'k', baseUrl: 'https://api.tokenomixai.com/', fetchImpl: f });
  const m = await c.listModels();
  assert.deepStrictEqual(m.map((x) => x.id), ['claude-opus-5-5', 'kimi-k3']);
  assert.strictEqual(f.calls[0].url, 'https://api.tokenomixai.com/v1/models');
});

test('sanitizer repairs shapes providers reject', () => {
  const out = sanitizeMessages([
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'bad.id', type: 'function', function: { name: 'write_file', arguments: '{"path":"x","conte' } },
      { id: 'c2', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'bad.id', content: 'ok' },
    { role: 'tool', tool_call_id: 'ghost', content: 'orphan' },
    { role: 'assistant', content: '  ' },
  ]);
  assert.deepStrictEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'tool']);
  assert.strictEqual(out[0].content, 'a\n\nb');
  assert.strictEqual(out[1].tool_calls[0].id, 'bad_id');
  assert.strictEqual(out[1].tool_calls[0].function.arguments, '{}');
  assert.strictEqual(out[2].tool_call_id, 'bad_id');
  assert.strictEqual(out[3].tool_call_id, 'c2');
});

test('toAnthropic merges results and follow-up text into one user turn', () => {
  const b = toAnthropic({
    model: 'claude', messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'cek', tool_calls: [{ id: 't1', type: 'function', function: { name: 'a', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'r' },
      { role: 'user', content: 'lanjut' },
    ],
  }, 1000);
  assert.deepStrictEqual(b.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepStrictEqual(b.messages[2].content.map((c) => c.type), ['tool_result', 'text']);
  assert.strictEqual(b.max_tokens, 1000);
});
