'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const tools = require('../../src/main/tools');
const { tmpWorkspace } = require('./helpers');

test('read_file numbers lines and pages long files', async () => {
  const root = tmpWorkspace({ 'a.txt': 'satu\ndua\ntiga\n' });
  const r = await tools.execute(root, 'read_file', { path: 'a.txt' });
  assert.match(r.content, /1\tsatu/);
  assert.strictEqual(r.total_lines, 4);
  const p = await tools.execute(root, 'read_file', { path: 'a.txt', offset: 2, limit: 1 });
  assert.match(p.content, /^2\tdua$/);
  assert.ok(p.more);
});

test('paths outside the workspace are refused', async () => {
  const root = tmpWorkspace({ 'a.txt': 'x' });
  await assert.rejects(tools.execute(root, 'read_file', { path: '../../etc/passwd' }), /di luar workspace/);
  await assert.rejects(tools.planEdit(root, 'write_file', { path: '..\\..\\evil.txt', content: 'x' }), /di luar workspace/);
});

test('glob and grep skip node_modules and find matches', async () => {
  const root = tmpWorkspace({
    'src/app.js': 'const hello = 1;\n',
    'src/lib/util.ts': 'export function hello() {}\n',
    'node_modules/x/index.js': 'hello\n',
    'README.md': '# hello\n',
  });
  const g = await tools.execute(root, 'glob', { pattern: 'src/**/*.{js,ts}' });
  assert.deepStrictEqual(g.files.sort(), ['src/app.js', 'src/lib/util.ts']);
  const g2 = await tools.execute(root, 'glob', { pattern: '*.md' });
  assert.deepStrictEqual(g2.files, ['README.md']);
  const s = await tools.execute(root, 'grep', { pattern: 'hello', include: '*.ts' });
  assert.deepStrictEqual(s.matches, ['src/lib/util.ts:1: export function hello() {}']);
  const all = await tools.execute(root, 'grep', { pattern: 'HELLO', case_insensitive: true });
  assert.strictEqual(all.count, 3);
});

test('edit_file replaces unique text, keeps CRLF, explains failures', async () => {
  const root = tmpWorkspace({ 'a.php': 'line1\r\nfoo = 1;\r\nline3\r\n', 'b.txt': 'x x' });
  const plan = await tools.planEdit(root, 'edit_file', { path: 'a.php', old_string: 'foo = 1;\nline3', new_string: 'foo = 2;\nline3' });
  await tools.applyEdit(plan);
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.php'), 'utf8'), 'line1\r\nfoo = 2;\r\nline3\r\n');
  await assert.rejects(tools.planEdit(root, 'edit_file', { path: 'a.php', old_string: 'nope', new_string: 'y' }), /tidak ditemukan/);
  await assert.rejects(tools.planEdit(root, 'edit_file', { path: 'b.txt', old_string: 'x', new_string: 'y' }), /muncul 2 kali/);
  const all = await tools.planEdit(root, 'edit_file', { path: 'b.txt', old_string: 'x', new_string: 'y', replace_all: true });
  assert.strictEqual(all.after, 'y y');
});

test('write_file creates folders; delete_file removes', async () => {
  const root = tmpWorkspace({});
  const plan = await tools.planEdit(root, 'write_file', { path: 'deep/dir/new.txt', content: 'halo' });
  assert.strictEqual(plan.before, null);
  await tools.applyEdit(plan);
  assert.strictEqual(fs.readFileSync(path.join(root, 'deep/dir/new.txt'), 'utf8'), 'halo');
  await tools.applyEdit(await tools.planEdit(root, 'delete_file', { path: 'deep/dir/new.txt' }));
  assert.ok(!fs.existsSync(path.join(root, 'deep/dir/new.txt')));
});

test('run_command returns exit code and output', async () => {
  const root = tmpWorkspace({});
  const cmd = process.platform === 'win32' ? 'Write-Output halo; exit 3' : 'echo halo; exit 3';
  let streamed = '';
  const r = await tools.execute(root, 'run_command', { command: cmd }, { onOutput: (c) => { streamed += c; } });
  assert.strictEqual(r.exit_code, 3);
  assert.match(r.output, /halo/);
  assert.match(streamed, /halo/);
});

test('run_command honours the timeout', async () => {
  const root = tmpWorkspace({});
  const cmd = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
  const t = Date.now();
  const r = await tools.execute(root, 'run_command', { command: cmd, timeout_seconds: 5 });
  assert.ok(r.timed_out);
  assert.ok(Date.now() - t < 20000);
});

test('plan mode only offers read tools', () => {
  const names = tools.definitions({ planMode: true }).map((d) => d.function.name);
  assert.ok(names.includes('read_file'));
  assert.ok(!names.includes('write_file'));
  assert.ok(!names.includes('run_command'));
});
