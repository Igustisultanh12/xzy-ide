'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Agent } = require('../../src/main/agent');
const { TokenomixClient } = require('../../src/main/llm');
const { tmpWorkspace, openAiTurn, scriptedFetch } = require('./helpers');

function makeAgent(root, turns, mode = 'auto') {
  const f = scriptedFetch(turns);
  const client = new TokenomixClient({ apiKey: 'k', fetchImpl: f });
  const agent = new Agent({ model: 'glm-5.1', mode, getRoot: () => root, getClient: () => client, getSettings: () => ({}) });
  const events = [];
  agent.on('event', (e) => events.push(e));
  return { agent, f, events };
}

test('agent reads, edits a file, runs a command and answers', async () => {
  const root = tmpWorkspace({ 'app.js': 'console.log("lama");\n' });
  const cmd = process.platform === 'win32' ? 'Get-Content app.js' : 'cat app.js';
  const { agent, f, events } = makeAgent(root, [
    openAiTurn({ text: 'Saya baca dulu.', tools: [['read_file', { path: 'app.js' }], ['todo_write', { todos: [{ content: 'Ubah pesan', status: 'in_progress' }] }]] }),
    openAiTurn({ tools: [['edit_file', { path: 'app.js', old_string: 'lama', new_string: 'baru' }]] }),
    openAiTurn({ tools: [['run_command', { command: cmd }]] }),
    openAiTurn({ text: 'Selesai: app.js diubah.' }),
  ]);

  await agent.run('ganti pesan jadi baru');

  assert.strictEqual(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'console.log("baru");\n');
  assert.strictEqual(f.calls.length, 4);
  // Results of each tool reach the next request
  const msgs2 = f.calls[1].body.messages;
  const readResult = msgs2.find((m) => m.role === 'tool' && m.content.includes('console.log'));
  assert.ok(readResult, 'read_file result must be sent to the model');
  const msgs4 = f.calls[3].body.messages;
  assert.ok(msgs4.some((m) => m.role === 'tool' && m.content.includes('baru') && m.content.includes('exit_code')));
  assert.deepStrictEqual(agent.todos, [{ content: 'Ubah pesan', status: 'in_progress' }]);
  assert.strictEqual(agent.title, 'ganti pesan jadi baru');
  assert.ok(events.some((e) => e.type === 'file_changed'));
  assert.strictEqual(agent.status, 'idle');
  assert.ok(agent.transcript.some((t) => t.kind === 'assistant' && t.text.includes('Selesai')));

  const undo = await agent.undoLast();
  assert.strictEqual(undo.reverted.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'console.log("lama");\n');
});

test('ask mode waits for approval with a diff; denial is reported to the model', async () => {
  const root = tmpWorkspace({ 'a.txt': 'satu\n' });
  const { agent, f, events } = makeAgent(root, [
    openAiTurn({ tools: [['write_file', { path: 'a.txt', content: 'dua\n' }]] }),
    openAiTurn({ tools: [['write_file', { path: 'b.txt', content: 'baru\n' }]] }),
    openAiTurn({ text: 'Oke.' }),
  ], 'ask');

  agent.on('event', (e) => {
    if (e.type !== 'permission') return;
    assert.strictEqual(e.category, 'edit');
    if (e.path === 'a.txt') {
      assert.strictEqual(e.before, 'satu\n');
      assert.strictEqual(e.after, 'dua\n');
      setTimeout(() => agent.respondPermission(e.requestId, { allow: false, feedback: 'jangan ubah a.txt' }), 10);
    } else {
      setTimeout(() => agent.respondPermission(e.requestId, { allow: true }), 10);
    }
  });

  await agent.run('ubah');
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'satu\n');
  assert.strictEqual(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'baru\n');
  const denied = f.calls[1].body.messages.find((m) => m.role === 'tool');
  assert.match(denied.content, /menolak.*jangan ubah a\.txt/);
  assert.strictEqual(events.filter((e) => e.type === 'permission').length, 2);
});

test('plan mode never writes', async () => {
  const root = tmpWorkspace({ 'a.txt': 'x' });
  const { agent, f } = makeAgent(root, [
    openAiTurn({ tools: [['write_file', { path: 'a.txt', content: 'y' }]] }),
    openAiTurn({ text: 'Rencana: ...' }),
  ], 'plan');
  await agent.run('rencanakan');
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'x');
  assert.ok(!f.calls[0].body.tools.some((t) => t.function.name === 'write_file'));
  assert.match(f.calls[1].body.messages.find((m) => m.role === 'tool').content, /Mode Rencana/);
});

test('retryable gateway errors are retried, stop aborts', async () => {
  const root = tmpWorkspace({});
  const { agent, f } = makeAgent(root, [
    new Response('{"error":{"code":"upstream_unavailable","message":"busy"}}', { status: 502 }),
    openAiTurn({ text: 'Berhasil setelah retry.' }),
  ]);
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 5), ...a);
  try {
    await agent.run('halo');
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.strictEqual(f.calls.length, 2);
  assert.ok(agent.transcript.some((t) => t.text === 'Berhasil setelah retry.'));
});

test('serialize/restore keeps the conversation and closes dangling calls', () => {
  const a = new Agent({ model: 'm', getRoot: () => null, getClient: () => null });
  a.messages = [{ role: 'user', content: 'x' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] }];
  const b = new Agent({ getRoot: () => null, getClient: () => null }).restore(JSON.parse(JSON.stringify(a.serialize())));
  assert.strictEqual(b.messages.length, 3);
  assert.strictEqual(b.messages[2].tool_call_id, 'c1');
});
