'use strict';

/**
 * GitHub for the agent: push the workspace with the user's token, watch GitHub Actions
 * until they finish, read why a run failed, re-run jobs, and publish releases.
 * Uses the REST API with a personal access token (stored encrypted in settings) and the
 * git command line for pushing.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

class GitHubError extends Error {}

const API = 'https://api.github.com';

function parseRepo(input) {
  const s = String(input || '').trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i)
    || s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i)
    || s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function git(root, args, { env, timeout = 300000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, timeout, windowsHide: true, env, maxBuffer: 30 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim(), missing: !!(err && err.code === 'ENOENT') });
    });
  });
}

function mask(text, token) {
  let t = String(text || '');
  if (token) t = t.split(token).join('***');
  return t.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
}

class GitHub {
  constructor({ token, fetchImpl, sleep, gitBase, env } = {}) {
    this.token = token || '';
    this.fetch = fetchImpl || globalThis.fetch;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.gitBase = (gitBase || process.env.XZY_GITHUB_GIT_BASE || 'https://github.com').replace(/\/+$/, '');
    this.env = env || process.env;
    this.user = null;
  }

  requireToken() {
    if (!this.token) throw new GitHubError('Token GitHub belum diisi. Buka Pengaturan > GitHub, lalu tempel Personal Access Token (classic: scope "repo" dan "workflow"; fine-grained: Contents, Actions, Workflows = Read and write, Administration = Read and write untuk membuat repo).');
  }

  async api(method, p, body, { raw = false, accept } = {}) {
    this.requireToken();
    const url = p.startsWith('http') ? p : `${API}${p}`;
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'XZY-IDE',
        ...(body ? { 'Content-Type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' } : {}),
      },
      body: body ? (body instanceof Uint8Array ? body : JSON.stringify(body)) : undefined,
      redirect: 'follow',
    });
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const msg = (json && json.message) || text.slice(0, 300) || res.statusText;
      const err = new GitHubError(this.explain(res.status, msg, p, res.headers.get('x-accepted-github-permissions')));
      err.status = res.status;
      throw err;
    }
    return json;
  }

  explain(status, msg, p, accepted) {
    let s = `GitHub HTTP ${status}: ${msg}`;
    if ([401].includes(status)) s += '. Token GitHub tidak valid atau kedaluwarsa; perbarui di Pengaturan.';
    if ([403, 404].includes(status)) {
      s += `. Kemungkinan token tidak punya izin untuk ${p.split('?')[0]}`;
      if (accepted) s += ` (izin yang diminta GitHub: ${accepted})`;
      s += '. Classic token butuh scope "repo" + "workflow"; fine-grained token butuh akses ke repo ini dengan Contents, Actions, Workflows = Read and write.';
    }
    return s;
  }

  /** Login and scopes of the configured token (scopes null = fine-grained token). */
  async tokenInfo() {
    const res = await this.api('GET', '/user', null, { raw: true });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new GitHubError(`Token GitHub tidak valid (HTTP ${res.status}).`);
    const scopes = res.headers.get('x-oauth-scopes');
    return { login: json.login, scopes, fineGrained: scopes === null, hasWorkflow: scopes === null ? null : scopes.split(',').map((s) => s.trim()).includes('workflow') };
  }

  async me() {
    if (!this.user) this.user = await this.api('GET', '/user');
    return this.user;
  }

  /** owner/repo of the workspace's origin remote, if any. */
  async originRepo(root) {
    const r = await git(root, ['remote', 'get-url', 'origin'], { env: this.env });
    return r.ok ? parseRepo(r.out) : null;
  }

  async resolveRepo(root, repo) {
    const full = parseRepo(repo) || (root ? await this.originRepo(root) : null);
    if (!full) throw new GitHubError('Repo GitHub tidak diketahui. Sebutkan repo (mis. "pemilik/nama-repo" atau link GitHub-nya), atau buat dulu dengan github_create_repo.');
    return full;
  }

  async repoInfo(root, repo) {
    const full = await this.resolveRepo(root, repo);
    const r = await this.api('GET', `/repos/${full}`);
    return {
      repo: r.full_name,
      url: r.html_url,
      private: r.private,
      default_branch: r.default_branch,
      can_push: r.permissions ? !!r.permissions.push : null,
      has_workflows_dir: root ? fs.existsSync(path.join(root, '.github', 'workflows')) : null,
    };
  }

  async createRepo({ name, private: isPrivate = true, description }) {
    if (!/^[\w.-]{1,100}$/.test(String(name || ''))) throw new GitHubError(`Nama repo tidak valid: ${name}`);
    const me = await this.me();
    try {
      const existing = await this.api('GET', `/repos/${me.login}/${name}`);
      return { repo: existing.full_name, url: existing.html_url, default_branch: existing.default_branch, already_existed: true };
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const r = await this.api('POST', '/user/repos', { name, private: !!isPrivate, description: description || undefined, auto_init: false });
    return { repo: r.full_name, url: r.html_url, default_branch: r.default_branch || 'main', created: true };
  }

  /**
   * Commit everything in the workspace and push it to GitHub with the token.
   * Initializes git and the origin remote when needed. Never force-pushes.
   */
  async push(root, { repo, branch, message, onOutput = () => {} } = {}) {
    this.requireToken();
    const env = this.env;
    const check = await git(root, ['--version'], { env });
    if (check.missing) throw new GitHubError('Git belum terpasang di komputer ini. Pasang dengan: winget install --id Git.Git -e (lalu coba lagi).');

    if (!fs.existsSync(path.join(root, '.git'))) {
      const init = await git(root, ['init', '-b', branch || 'main'], { env });
      if (!init.ok) throw new GitHubError(`git init gagal: ${init.err}`);
      onOutput('git init\n');
    }
    const full = await this.resolveRepo(root, repo);
    const remoteUrl = `https://github.com/${full}.git`;
    const origin = await git(root, ['remote', 'get-url', 'origin'], { env });
    if (!origin.ok) await git(root, ['remote', 'add', 'origin', remoteUrl], { env });
    else if (parseRepo(origin.out) !== full && repo) await git(root, ['remote', 'set-url', 'origin', remoteUrl], { env });

    // Identity for the commit (only if the user has none configured)
    const name = await git(root, ['config', 'user.name'], { env });
    const email = await git(root, ['config', 'user.email'], { env });
    if (!name.out || !email.out) {
      const me = await this.me();
      if (!name.out) await git(root, ['config', 'user.name', me.name || me.login], { env });
      if (!email.out) await git(root, ['config', 'user.email', `${me.id}+${me.login}@users.noreply.github.com`], { env });
    }

    let current = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { env })).out;
    if (!current || current === 'HEAD') current = branch || 'main';
    const target = branch || current;

    await git(root, ['add', '-A'], { env });
    const status = await git(root, ['status', '--porcelain'], { env });
    let committed = false;
    if (status.out) {
      const c = await git(root, ['commit', '-m', message || 'Update dari XZY IDE'], { env });
      if (!c.ok) throw new GitHubError(`git commit gagal: ${c.err || c.out}`);
      committed = true;
      onOutput(`${c.out}\n`);
    }
    const head = await git(root, ['rev-parse', 'HEAD'], { env });
    if (!head.ok) throw new GitHubError('Belum ada commit untuk di-push (workspace kosong?).');

    const authUrl = this.gitBase.startsWith('https://')
      ? `${this.gitBase.replace('https://', `https://x-access-token:${this.token}@`)}/${full}.git`
      : `${this.gitBase}/${full}.git`;
    const pushArgs = ['-c', 'credential.helper=', '-c', 'core.askPass=', 'push', authUrl, `HEAD:refs/heads/${target}`];
    const p = await git(root, pushArgs, { env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
    onOutput(mask(`${p.out}\n${p.err}\n`, this.token));
    if (!p.ok) {
      const errText = mask(p.err || p.out, this.token);
      // Check the workflow refusal first: it also contains "[remote rejected]"
      if (/workflow/i.test(errText) && /scope|permission|refusing/i.test(errText)) {
        const t = await this.tokenInfo().catch(() => null);
        const who = t ? `Token GitHub di Pengaturan XZY IDE (@${t.login}) ${t.fineGrained ? 'adalah fine-grained token tanpa izin Workflows = Read and write' : `hanya punya scope: ${t.scopes || '(kosong)'}`}.` : '';
        throw new GitHubError(`GitHub menolak push karena commit ini mengubah berkas .github/workflows dan token belum punya izin workflow. ${who} Perbaiki: classic token -> centang scope "workflow" (dan "repo") di https://github.com/settings/tokens; fine-grained -> Workflows = Read and write. Lalu tempel token itu di Pengaturan XZY IDE > Token GitHub, klik Tes token, Simpan, dan minta agen push lagi. Jangan memakai git push di terminal (itu memakai kredensial Windows, bukan token XZY IDE). Detail: ${errText}`);
      }
      if (/non-fast-forward|fetch first|\[rejected\]/i.test(errText)) {
        throw new GitHubError(`Push ditolak karena branch ${target} di GitHub punya commit yang belum ada di lokal. Jalankan github_pull (rebase) dulu, selesaikan konflik jika ada, lalu push lagi. Detail: ${errText}`);
      }
      throw new GitHubError(`git push gagal: ${errText}`);
    }
    // Keep the remote-tracking ref in sync for the git panel
    await git(root, ['update-ref', `refs/remotes/origin/${target}`, head.out], { env });
    await git(root, ['branch', `--set-upstream-to=origin/${target}`], { env });
    return {
      ok: true,
      repo: full,
      branch: target,
      commit_sha: head.out,
      committed,
      commit_url: `https://github.com/${full}/commit/${head.out}`,
      actions_url: `https://github.com/${full}/actions`,
      has_workflows: fs.existsSync(path.join(root, '.github', 'workflows')),
      next_step: fs.existsSync(path.join(root, '.github', 'workflows'))
        ? 'Panggil github_wait_workflow dengan head_sha = commit_sha ini untuk memantau GitHub Actions.'
        : undefined,
    };
  }

  async pull(root, { repo, branch, onOutput = () => {} } = {}) {
    this.requireToken();
    const full = await this.resolveRepo(root, repo);
    let current = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { env: this.env })).out || 'main';
    const target = branch || current;
    const authUrl = this.gitBase.startsWith('https://')
      ? `${this.gitBase.replace('https://', `https://x-access-token:${this.token}@`)}/${full}.git`
      : `${this.gitBase}/${full}.git`;
    const p = await git(root, ['-c', 'credential.helper=', 'pull', '--rebase', '--autostash', authUrl, target], { env: { ...this.env, GIT_TERMINAL_PROMPT: '0' } });
    onOutput(mask(`${p.out}\n${p.err}\n`, this.token));
    if (!p.ok) throw new GitHubError(`git pull --rebase gagal (mungkin ada konflik; selesaikan berkas yang konflik lalu jalankan "git rebase --continue"): ${mask(p.err || p.out, this.token)}`);
    current = (await git(root, ['rev-parse', 'HEAD'], { env: this.env })).out;
    return { ok: true, repo: full, branch: target, head: current, output: mask(p.out, this.token).slice(-3000) };
  }

  /* ---------------- GitHub Actions ---------------- */

  summarizeRun(r) {
    return {
      id: r.id, workflow: r.name, status: r.status, conclusion: r.conclusion, event: r.event, branch: r.head_branch,
      head_sha: String(r.head_sha || '').toLowerCase(), url: r.html_url, started_at: r.run_started_at || r.created_at,
    };
  }

  async listRuns(root, { repo, branch, head_sha: headSha, limit = 10 } = {}) {
    const full = await this.resolveRepo(root, repo);
    const qs = new URLSearchParams({ per_page: String(headSha ? 30 : limit) });
    if (branch && !headSha) qs.set('branch', branch);
    if (headSha && headSha.length === 40) qs.set('head_sha', headSha);
    const r = await this.api('GET', `/repos/${full}/actions/runs?${qs}`);
    let runs = (r.workflow_runs || []).map((x) => this.summarizeRun(x));
    if (headSha) runs = runs.filter((x) => x.head_sha.startsWith(String(headSha).toLowerCase()));
    return { repo: full, runs: runs.slice(0, limit) };
  }

  /**
   * Wait until all workflow runs of a commit (or one run) complete.
   * onStatus(text) gets progress; shouldStop() aborts.
   */
  async waitRuns(root, { repo, head_sha: headSha, run_id: runId, branch, maxSeconds = 1200, pollSeconds = 10, appearSeconds = 120 } = {}, { onStatus = () => {}, shouldStop = () => false } = {}) {
    const full = await this.resolveRepo(root, repo);
    const started = Date.now();
    let ids = runId ? [Number(runId)] : [];
    let runs = [];
    for (;;) {
      if (shouldStop()) return { status: 'stopped', message: 'Menunggu workflow dihentikan.' };
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (ids.length) {
        runs = [];
        for (const id of ids) runs.push(this.summarizeRun(await this.api('GET', `/repos/${full}/actions/runs/${id}`)));
      } else {
        let found = (await this.listRuns(root, { repo: full, branch: headSha ? undefined : branch, head_sha: headSha, limit: 30 })).runs;
        if (!headSha && found.length) found = found.filter((x) => x.head_sha === found[0].head_sha);
        if (found.length) { ids = found.map((x) => x.id); runs = found; }
        else if (elapsed >= appearSeconds) {
          return {
            status: 'not_found', repo: full,
            message: `Tidak ada workflow run untuk ${headSha ? `commit ${String(headSha).slice(0, 7)}` : `branch ${branch || 'default'}`}. Pastikan ada .github/workflows/*.yml dengan trigger push untuk branch ini dan Actions aktif di repo.`,
          };
        } else onStatus(`menunggu workflow muncul (${elapsed} dtk)`);
      }
      if (runs.length && runs.every((x) => x.status === 'completed')) return this.finalResult(full, runs);
      if (runs.length) onStatus(`${runs.map((x) => `${x.workflow}: ${String(x.status).replace('_', ' ')}`).join(', ')} · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`);
      if (elapsed >= maxSeconds) {
        return { status: 'still_running', repo: full, runs, message: `Workflow masih berjalan setelah ${Math.round(maxSeconds / 60)} menit. Panggil github_wait_workflow lagi dengan run_id ${ids[0]} untuk terus menunggu.` };
      }
      for (let i = 0; i < pollSeconds * 2; i++) {
        if (shouldStop()) break;
        await this.sleep(500);
      }
    }
  }

  async finalResult(full, runs) {
    const failed = runs.filter((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion));
    const result = { status: 'completed', conclusion: failed.length ? 'failure' : 'success', repo: full, runs };
    if (failed.length) {
      result.failed_run_ids = failed.map((r) => r.id);
      result.next_step = 'Panggil github_workflow_logs untuk run yang gagal, perbaiki kodenya, push lagi (github_push), lalu tunggu lagi.';
      return result;
    }
    const artifacts = [];
    for (const r of runs) {
      try {
        const a = await this.api('GET', `/repos/${full}/actions/runs/${r.id}/artifacts?per_page=20`);
        for (const x of a.artifacts || []) artifacts.push({ name: x.name, size_bytes: x.size_in_bytes, run_url: r.url });
      } catch { /* optional */ }
    }
    result.artifacts = artifacts;
    try {
      const rel = await this.api('GET', `/repos/${full}/releases?per_page=1`);
      if (rel && rel[0]) {
        const startedAt = Date.parse(runs[0].started_at || 0) || 0;
        result.latest_release = {
          tag: rel[0].tag_name, url: rel[0].html_url, published_at: rel[0].published_at,
          assets: (rel[0].assets || []).map((a) => ({ name: a.name, url: a.browser_download_url })),
          made_by_this_run: startedAt > 0 && (Date.parse(rel[0].published_at || 0) || 0) >= startedAt,
        };
      }
    } catch { /* optional */ }
    return result;
  }

  async failureDetails(root, { repo, run_id: runId } = {}) {
    const full = await this.resolveRepo(root, repo);
    const jobs = await this.api('GET', `/repos/${full}/actions/runs/${runId}/jobs?per_page=50&filter=latest`);
    const out = [];
    let budget = 24000;
    for (const job of jobs.jobs || []) {
      if (!['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required'].includes(job.conclusion)) continue;
      const failedSteps = (job.steps || []).filter((s) => ['failure', 'timed_out', 'cancelled'].includes(s.conclusion)).map((s) => s.name);
      let annotations = [];
      try {
        const ann = await this.api('GET', `/repos/${full}/check-runs/${job.id}/annotations?per_page=30`);
        annotations = (ann || []).map((a) => `${a.annotation_level} ${a.path || ''}${a.start_line ? `:${a.start_line}` : ''} ${a.message}`.trim());
      } catch { /* optional */ }
      let log = '';
      if (budget > 0) {
        try {
          const res = await this.api('GET', `/repos/${full}/actions/jobs/${job.id}/logs`, null, { raw: true });
          log = res.ok ? extractLog(await res.text(), Math.min(10000, budget)) : `(log tidak bisa dibaca: HTTP ${res.status})`;
          budget -= log.length;
        } catch (e) {
          log = `(log tidak bisa dibaca: ${e.message})`;
        }
      }
      out.push({ job: job.name, conclusion: job.conclusion, failed_steps: failedSteps, annotations: annotations.slice(0, 30), log, url: job.html_url });
    }
    return { repo: full, run_id: runId, failed_jobs: out, note: out.length ? undefined : 'Tidak ada job yang gagal di run ini.' };
  }

  async rerun(root, { repo, run_id: runId, failed_only: failedOnly = true } = {}) {
    const full = await this.resolveRepo(root, repo);
    await this.api('POST', `/repos/${full}/actions/runs/${runId}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`);
    return { ok: true, repo: full, run_id: runId, url: `https://github.com/${full}/actions/runs/${runId}` };
  }

  async dispatch(root, { repo, workflow, ref, inputs } = {}) {
    const full = await this.resolveRepo(root, repo);
    const info = await this.api('GET', `/repos/${full}`);
    await this.api('POST', `/repos/${full}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref: ref || info.default_branch, inputs: inputs || {} });
    return { ok: true, repo: full, workflow, ref: ref || info.default_branch, note: 'Workflow dipicu. Gunakan github_wait_workflow dengan branch untuk memantau.' };
  }

  /* ---------------- releases ---------------- */

  async listReleases(root, { repo } = {}) {
    const full = await this.resolveRepo(root, repo);
    const r = await this.api('GET', `/repos/${full}/releases?per_page=5`);
    return { repo: full, releases: (r || []).map((x) => ({ tag: x.tag_name, name: x.name, url: x.html_url, draft: x.draft, prerelease: x.prerelease, published_at: x.published_at, assets: (x.assets || []).map((a) => a.name) })) };
  }

  async createRelease(root, { repo, tag, name, body, target, prerelease = false, draft = false, files = [], generate_notes: generateNotes = true } = {}) {
    if (!tag) throw new GitHubError('Argumen tag wajib, mis. "v1.0.0".');
    const full = await this.resolveRepo(root, repo);
    let rel;
    try {
      rel = await this.api('GET', `/repos/${full}/releases/tags/${encodeURIComponent(tag)}`);
    } catch (e) {
      if (e.status !== 404) throw e;
      rel = await this.api('POST', `/repos/${full}/releases`, {
        tag_name: tag, name: name || tag, body: body || undefined, target_commitish: target || undefined,
        prerelease: !!prerelease, draft: !!draft, generate_release_notes: !body && generateNotes,
      });
    }
    const uploaded = [];
    for (const rel0 of files || []) {
      const abs = path.resolve(root, rel0);
      if (path.relative(root, abs).startsWith('..')) throw new GitHubError(`Berkas di luar workspace: ${rel0}`);
      const data = fs.readFileSync(abs);
      const fname = path.basename(abs);
      const old = (rel.assets || []).find((a) => a.name === fname);
      if (old) await this.api('DELETE', `/repos/${full}/releases/assets/${old.id}`);
      const uploadUrl = String(rel.upload_url).replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(fname)}`;
      const res = await this.api('POST', uploadUrl, new Uint8Array(data), { raw: true, accept: 'application/vnd.github+json' });
      if (!res.ok) throw new GitHubError(`Upload ${fname} gagal: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const a = await res.json();
      uploaded.push({ name: a.name, url: a.browser_download_url, size: a.size });
    }
    return { ok: true, repo: full, tag: rel.tag_name, url: rel.html_url, uploaded };
  }
}

/** Keep the useful part of a job log: error lines with context, plus the tail. */
function extractLog(raw, maxChars) {
  const lines = String(raw).split(/\r?\n/).map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ''));
  const keep = new Set();
  lines.forEach((l, i) => {
    if (/##\[error\]|\berror\b|FAILED|FAILURE|Exception|e: file:|What went wrong|exit code [1-9]|fatal:/i.test(l)) {
      for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 6); j++) keep.add(j);
    }
  });
  let errors = '';
  let last = -2;
  for (const j of [...keep].sort((a, b) => a - b)) {
    errors += (j !== last + 1 ? '...\n' : '') + lines[j] + '\n';
    last = j;
  }
  let out = (errors ? `== Baris error ==\n${errors}\n` : '') + `== Akhir log ==\n${lines.slice(-60).join('\n')}`;
  if (out.length > maxChars) {
    const half = Math.floor(maxChars / 2);
    out = `${out.slice(0, half)}\n...[dipotong]...\n${out.slice(-half)}`;
  }
  return out;
}

module.exports = { GitHub, GitHubError, parseRepo, extractLog, mask };
