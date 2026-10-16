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

test('GitHub publish actions ask for approval in acceptEdits mode and use the GitHub client', async () => {
  const root = tmpWorkspace({ 'a.txt': 'x' });
  const f = scriptedFetch([
    openAiTurn({ tools: [['github_push', { message: 'rilis', repo: 'u/app' }]] }),
    openAiTurn({ text: 'Selesai.' }),
  ]);
  const client = new TokenomixClient({ apiKey: 'k', fetchImpl: f });
  const pushed = [];
  const github = { push: async (r, a) => { pushed.push(a); return { ok: true, repo: 'u/app', commit_sha: 'a'.repeat(40), commit_url: 'https://github.com/u/app/commit/aaa' }; } };
  const agent = new Agent({ model: 'm', mode: 'acceptEdits', getRoot: () => root, getClient: () => client, getGitHub: () => github, getEnvInfo: async () => ({ toolchain: 'Terpasang: PHP 8.3', github: 'Token GitHub aktif sebagai @u.' }) });
  const perms = [];
  agent.on('event', (e) => {
    if (e.type === 'permission') { perms.push(e); setTimeout(() => agent.respondPermission(e.requestId, { allow: true }), 5); }
  });
  await agent.run('push');
  assert.strictEqual(perms.length, 1);
  assert.strictEqual(perms[0].category, 'publish');
  assert.match(perms[0].command, /Commit "rilis" lalu push ke u\/app/);
  assert.strictEqual(pushed[0].message, 'rilis');
  const sys = f.calls[0].body.messages[0].content;
  assert.match(sys, /Terpasang: PHP 8\.3/);
  assert.match(sys, /github_wait_workflow/);
  assert.ok(f.calls[0].body.tools.some((t) => t.function.name === 'github_push'));
});
