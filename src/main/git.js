'use strict';

/** Source control through the git command line (if installed). */

const { execFile } = require('child_process');

function git(root, args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), missing: !!(err && err.code === 'ENOENT') });
    });
  });
}

async function status(root) {
  if (!root) return { repo: false };
  const r = await git(root, ['status', '--porcelain=v1', '-b', '-uall']);
  if (r.missing) return { repo: false, gitMissing: true };
  if (!r.ok) return { repo: false };
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  let branch = '';
  let ahead = 0;
  let behind = 0;
  const files = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const m = line.slice(3);
      branch = m.split('...')[0].replace(/^No commits yet on /, '');
      ahead = Number((m.match(/ahead (\d+)/) || [])[1] || 0);
      behind = Number((m.match(/behind (\d+)/) || [])[1] || 0);
      continue;
    }
    const x = line[0];
    const y = line[1];
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ')[1];
    file = file.replace(/^"|"$/g, '');
    files.push({ path: file, index: x, worktree: y, staged: x !== ' ' && x !== '?', untracked: x === '?' });
  }
  return { repo: true, branch, ahead, behind, files };
}

async function fileAtHead(root, rel) {
  const r = await git(root, ['show', `HEAD:${rel}`]);
  return r.ok ? r.stdout : '';
}

async function commit(root, message, { all = true } = {}) {
  if (!message || !message.trim()) return { ok: false, error: 'Pesan commit kosong.' };
  if (all) {
    const a = await git(root, ['add', '-A']);
    if (!a.ok) return { ok: false, error: a.stderr || a.stdout };
  }
  const c = await git(root, ['commit', '-m', message]);
  return c.ok ? { ok: true, output: c.stdout } : { ok: false, error: c.stderr || c.stdout };
}

async function run(root, args) {
  const allowed = new Set(['pull', 'push', 'fetch', 'init', 'stash', 'checkout', 'restore']);
  if (!allowed.has(args[0])) return { ok: false, error: `Perintah git tidak diizinkan dari panel: ${args[0]}` };
  const r = await git(root, args, { timeout: 180000 });
  return r.ok ? { ok: true, output: (r.stdout + r.stderr).trim() } : { ok: false, error: (r.stderr || r.stdout).trim() };
}

module.exports = { status, fileAtHead, commit, run };
