'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { GitHub, parseRepo, extractLog } = require('../../src/main/github');
const { tmpWorkspace } = require('./helpers');

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const run = (id, status, conclusion) => ({ id, name: 'Build', status, conclusion, event: 'push', head_branch: 'main', head_sha: SHA, html_url: `https://github.com/u/app/actions/runs/${id}`, run_started_at: '2026-10-16T00:00:00Z' });

function router(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers, body: init.body });
    for (const [re, handler] of routes) {
      if (re.test(`${init.method || 'GET'} ${url}`)) return typeof handler === 'function' ? handler(url, init) : handler.shift ? handler.shift() : handler;
    }
    return json({ message: 'Not Found' }, 404);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('parseRepo understands links and owner/repo', () => {
  assert.strictEqual(parseRepo('https://github.com/Igustisultanh12/xzy-ide.git'), 'Igustisultanh12/xzy-ide');
  assert.strictEqual(parseRepo('git@github.com:a/b.git'), 'a/b');
  assert.strictEqual(parseRepo('a/b'), 'a/b');
  assert.strictEqual(parseRepo('nope'), null);
});

test('waitRuns waits for the commit run and reports failure', async () => {
  const seq = [json({ workflow_runs: [] }), json({ workflow_runs: [run(7, 'queued', null)] })];
  const runSeq = [json(run(7, 'in_progress', null)), json(run(7, 'completed', 'failure'))];
  const gh = new GitHub({ token: 't', sleep: async () => {}, fetchImpl: router([[/GET .*\/actions\/runs\?/, seq], [/GET .*\/actions\/runs\/7$/, runSeq]]) });
  const statuses = [];
  const r = await gh.waitRuns(null, { repo: 'u/app', head_sha: SHA, pollSeconds: 0 }, { onStatus: (s) => statuses.push(s) });
  assert.strictEqual(r.conclusion, 'failure');
  assert.deepStrictEqual(r.failed_run_ids, [7]);
  assert.ok(statuses.some((s) => s.includes('menunggu workflow muncul')));
  assert.ok(statuses.some((s) => s.includes('in progress')));
});

test('waitRuns success reports artifacts and release; stop aborts', async () => {
  const gh = new GitHub({ token: 't', sleep: async () => {}, fetchImpl: router([
    [/GET .*\/actions\/runs\/9\/artifacts/, json({ artifacts: [{ name: 'app.apk', size_in_bytes: 10 }] })],
    [/GET .*\/actions\/runs\/9$/, json(run(9, 'completed', 'success'))],
    [/GET .*\/releases\?/, json([{ tag_name: 'v1.0.0', html_url: 'https://github.com/u/app/releases/tag/v1.0.0', published_at: '2026-10-16T00:05:00Z', assets: [{ name: 'app.apk', browser_download_url: 'https://x/app.apk' }] }])],
  ]) });
  const ok = await gh.waitRuns(null, { repo: 'u/app', run_id: 9 });
  assert.strictEqual(ok.conclusion, 'success');
  assert.strictEqual(ok.artifacts[0].name, 'app.apk');
  assert.strictEqual(ok.latest_release.made_by_this_run, true);

  const gh2 = new GitHub({ token: 't', sleep: async () => {}, fetchImpl: router([[/./, () => json(run(9, 'in_progress', null))]]) });
  const stopped = await gh2.waitRuns(null, { repo: 'u/app', run_id: 9 }, { shouldStop: () => true });
  assert.strictEqual(stopped.status, 'stopped');
});

test('failureDetails returns failed steps, annotations and error lines', async () => {
  const log = '2026-10-16T00:00:01Z start\n'.repeat(100) + '2026-10-16T00:00:02Z e: file:///app/Main.kt:12:5 Unresolved reference: Text\n2026-10-16T00:00:03Z ##[error]Process completed with exit code 1.\n';
  const gh = new GitHub({ token: 't', fetchImpl: router([
    [/GET .*\/runs\/7\/jobs/, json({ jobs: [{ id: 5, name: 'build', conclusion: 'failure', html_url: 'u', steps: [{ name: 'Gradle', conclusion: 'failure' }] }, { id: 6, name: 'lint', conclusion: 'success', steps: [] }] })],
    [/GET .*\/check-runs\/5\/annotations/, json([{ annotation_level: 'failure', path: 'app/Main.kt', start_line: 12, message: 'Unresolved reference' }])],
    [/GET .*\/jobs\/5\/logs/, new Response(log, { status: 200 })],
  ]) });
  const r = await gh.failureDetails(null, { repo: 'u/app', run_id: 7 });
  assert.strictEqual(r.failed_jobs.length, 1);
  assert.deepStrictEqual(r.failed_jobs[0].failed_steps, ['Gradle']);
  assert.match(r.failed_jobs[0].annotations[0], /Main\.kt:12 Unresolved/);
  assert.match(r.failed_jobs[0].log, /Unresolved reference: Text/);
  assert.doesNotMatch(r.failed_jobs[0].log, /2026-10-16T/);
});

test('createRelease creates the tag and uploads workspace files', async () => {
  const root = tmpWorkspace({ 'dist/app.apk': 'APKDATA' });
  const f = router([
    [/GET .*\/releases\/tags\//, () => json({ message: 'Not Found' }, 404)],
    [/POST https:\/\/api\.github\.com\/repos\/u\/app\/releases$/, () => json({ tag_name: 'v1.2.0', html_url: 'https://github.com/u/app/releases/tag/v1.2.0', upload_url: 'https://uploads.github.com/repos/u/app/releases/1/assets{?name,label}', assets: [] }, 201)],
    [/POST https:\/\/uploads\.github\.com/, () => json({ name: 'app.apk', browser_download_url: 'https://github.com/u/app/releases/download/v1.2.0/app.apk', size: 7 }, 201)],
  ]);
  const gh = new GitHub({ token: 't', fetchImpl: f });
  const r = await gh.createRelease(root, { repo: 'u/app', tag: 'v1.2.0', files: ['dist/app.apk'] });
  assert.strictEqual(r.tag, 'v1.2.0');
  assert.strictEqual(r.uploaded[0].name, 'app.apk');
  const up = f.calls.find((c) => c.url.startsWith('https://uploads.github.com'));
  assert.match(up.url, /\?name=app\.apk$/);
  assert.strictEqual(up.headers['Content-Type'], 'application/octet-stream');
  assert.strictEqual(Buffer.from(up.body).toString(), 'APKDATA');
  await assert.rejects(gh.createRelease(root, { repo: 'u/app', tag: 'v1', files: ['../../etc/passwd'] }), /luar workspace/);
});

test('push initializes git, commits and pushes to the remote; rejects non fast-forward', async () => {
  const remotes = fs.mkdtempSync(path.join(os.tmpdir(), 'xzy-remotes-'));
  fs.mkdirSync(path.join(remotes, 'u'));
  execFileSync('git', ['init', '--bare', '-b', 'main', path.join(remotes, 'u', 'app.git')]);
  const root = tmpWorkspace({ 'index.php': '<?php echo "hi";\n', '.github/workflows/build.yml': 'on: push\n' });
  const gitBase = process.platform === 'win32' ? `file:///${remotes.replace(/\\/g, '/')}` : `file://${remotes}`;
  // Isolate from the developer's global git identity
  const emptyCfg = path.join(remotes, 'empty.gitconfig');
  fs.writeFileSync(emptyCfg, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: emptyCfg, GIT_CONFIG_NOSYSTEM: '1' };
  const gh = new GitHub({ token: 'secret-token', gitBase, env, fetchImpl: router([[/GET .*\/user$/, json({ login: 'u', id: 42, name: 'U' })]]) });
  let out = '';
  const r = await gh.push(root, { repo: 'u/app', message: 'feat: awal', onOutput: (c) => { out += c; } });
  assert.strictEqual(r.repo, 'u/app');
  assert.strictEqual(r.branch, 'main');
  assert.match(r.commit_sha, /^[0-9a-f]{40}$/);
  assert.ok(r.has_workflows);
  assert.match(r.next_step, /github_wait_workflow/);
  assert.doesNotMatch(out, /secret-token/);
  const remoteHead = execFileSync('git', ['--git-dir', path.join(remotes, 'u', 'app.git'), 'rev-parse', 'main']).toString().trim();
  assert.strictEqual(remoteHead, r.commit_sha);
  assert.strictEqual(execFileSync('git', ['-C', root, 'config', 'user.email']).toString().trim(), '42+u@users.noreply.github.com');

  // Someone else pushes; our next push must be rejected with a clear message
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'xzy-other-'));
  execFileSync('git', ['clone', '-q', path.join(remotes, 'u', 'app.git'), other]);
  fs.writeFileSync(path.join(other, 'x.txt'), 'x');
  execFileSync('git', ['-C', other, '-c', 'user.name=o', '-c', 'user.email=o@o', 'add', '-A']);
  execFileSync('git', ['-C', other, '-c', 'user.name=o', '-c', 'user.email=o@o', 'commit', '-qm', 'other']);
  execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main']);
  fs.writeFileSync(path.join(root, 'index.php'), '<?php echo "v2";\n');
  await assert.rejects(gh.push(root, { repo: 'u/app', message: 'v2' }), /github_pull/);
  const pulled = await gh.pull(root, { repo: 'u/app', branch: 'main' });
  assert.ok(pulled.ok);
  const again = await gh.push(root, { repo: 'u/app', message: 'v2' });
  assert.ok(again.ok);
});

test('missing token gives a clear instruction', async () => {
  const gh = new GitHub({ token: '' });
  await assert.rejects(gh.listRuns(null, { repo: 'u/app' }), /Token GitHub belum diisi/);
});

test('extractLog trims to the budget', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i} error here`).join('\n');
  assert.ok(extractLog(big, 3000).length <= 3100);
});

test('workflow-scope refusal is explained with the token scopes, not as "remote is newer"', async () => {
  const remotes = fs.mkdtempSync(path.join(os.tmpdir(), 'xzy-remotes-wf-'));
  fs.mkdirSync(path.join(remotes, 'u'));
  const bare = path.join(remotes, 'u', 'app.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  // Simulate GitHub's refusal for workflow files
  const hook = path.join(bare, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "refusing to allow a Personal Access Token to create or update workflow `.github/workflows/android-build.yml` without `workflow` scope" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  const root = tmpWorkspace({ 'ai/.github/workflows/android-build.yml': 'on: push\n', 'ai/README.md': '# app\n' });
  const emptyCfg = path.join(remotes, 'empty.gitconfig');
  fs.writeFileSync(emptyCfg, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: emptyCfg, GIT_CONFIG_NOSYSTEM: '1' };
  const gitBase = process.platform === 'win32' ? `file:///${remotes.replace(/\\/g, '/')}` : `file://${remotes}`;
  const gh = new GitHub({ token: 'tok', gitBase, env, fetchImpl: router([[/GET .*\/user$/, () => json({ login: 'u', id: 1 }, 200, { 'x-oauth-scopes': 'repo, read:org' })]]) });

  // The repo lives in the "ai" subfolder of the workspace (tool param path: "ai")
  const tools = require('../../src/main/tools');
  await assert.rejects(
    tools.execute(root, 'github_push', { path: 'ai', repo: 'u/app', message: 'add workflow' }, { github: gh }),
    (e) => /izin workflow/.test(e.message) && /@u/.test(e.message) && /repo, read:org/.test(e.message) && !/belum ada di lokal/.test(e.message),
  );
  assert.ok(fs.existsSync(path.join(root, 'ai', '.git')), 'git repo created in the subfolder, not the workspace root');
  assert.ok(!fs.existsSync(path.join(root, '.git')));
});
