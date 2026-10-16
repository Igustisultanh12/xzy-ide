// Workspace search panel and source control panel.

import { api, state, emit, command } from './state.js';
import { h, $, icon, esc, fileIcon, debounce, errorToast, toast, basename } from './ui.js';
import { openFile, openGitDiff } from './editor.js';

/* ---------------- search ---------------- */

let lastQuery = '';

async function runSearch() {
  const q = $('#search-input').value;
  const out = $('#search-results');
  lastQuery = q;
  if (!q || !state.workspace) { out.innerHTML = ''; return; }
  out.innerHTML = '<div class="sr-file muted"><span class="spinner"></span> Mencari...</div>';
  try {
    const r = await api.fs.search(q, {
      matchCase: $('#search-case').checked,
      wholeWord: $('#search-word').checked,
      regex: $('#search-regex').checked,
      include: $('#search-include').value.trim(),
    });
    if (q !== lastQuery) return;
    renderResults(r, q);
  } catch (e) {
    out.innerHTML = '';
    out.append(h('div', { class: 'sr-file', text: e.message }));
  }
}

function renderResults(r, q) {
  const out = $('#search-results');
  out.innerHTML = '';
  if (!r.matches.length) { out.append(h('div', { class: 'sr-file muted', text: 'Tidak ada hasil.' })); return; }
  out.append(h('div', { class: 'sr-file muted', text: `${r.count}${r.truncated ? '+' : ''} hasil di ${r.files_searched} berkas dicari` }));
  const groups = new Map();
  for (const m of r.matches) {
    const i1 = m.indexOf(':');
    const i2 = m.indexOf(':', i1 + 1);
    const file = m.slice(0, i1);
    const line = Number(m.slice(i1 + 1, i2));
    const text = m.slice(i2 + 2);
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file).push({ line, text });
  }
  let re = null;
  try {
    const src = $('#search-regex').checked ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(src, $('#search-case').checked ? 'g' : 'gi');
  } catch { re = null; }
  for (const [file, items] of groups) {
    out.append(h('div', { class: 'sr-file', title: file }, h('span', { html: fileIcon(file) }), h('span', { text: basename(file) }), h('span', { class: 'muted small', text: file })));
    for (const it of items) {
      const html = highlight(it.text, re);
      const row = h('div', { class: 'sr-line', html: `<span class="muted">${it.line}</span>  ${html}` });
      row.addEventListener('click', () => openFile(file, { line: it.line }));
      out.append(row);
    }
  }
}

function highlight(text, re) {
  if (!re) return esc(text);
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) && m[0] !== '') {
    out += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

export function initSearch() {
  const run = debounce(runSearch, 300);
  for (const id of ['#search-input', '#search-include']) $(id).addEventListener('input', run);
  for (const id of ['#search-case', '#search-word', '#search-regex']) $(id).addEventListener('change', runSearch);
  $('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
}

/* ---------------- source control ---------------- */

export async function refreshGit() {
  if (!state.workspace) return;
  try {
    state.gitStatus = await api.git.status();
  } catch {
    state.gitStatus = { repo: false };
  }
  renderGit();
  emit('git', state.gitStatus);
  const gs = state.gitStatus;
  $('#sb-branch').innerHTML = gs.repo ? `${icon('branch')} ${esc(gs.branch || 'main')}${gs.ahead ? ` ${gs.ahead}↑` : ''}${gs.behind ? ` ${gs.behind}↓` : ''}` : '';
  const badge = document.querySelector('.act[data-view="git"] .badge');
  if (badge) badge.remove();
  if (gs.repo && gs.files.length) {
    document.querySelector('.act[data-view="git"]').append(h('span', { class: 'badge', text: gs.files.length > 99 ? '99+' : gs.files.length }));
  }
}

export const refreshGitSoon = debounce(refreshGit, 700);

function renderGit() {
  const body = $('#git-body');
  body.innerHTML = '';
  const gs = state.gitStatus;
  if (!gs || !gs.repo) {
    body.append(h('p', { class: 'muted', text: gs && gs.gitMissing ? 'Git belum terpasang. Pasang Git for Windows dari git-scm.com agar fitur ini aktif.' : 'Folder ini belum menjadi repositori git.' }));
    if (gs && !gs.gitMissing) {
      body.append(h('button', { class: 'btn btn-sm', text: 'Inisialisasi repositori', onclick: async () => { const r = await api.git.run(['init']); if (!r.ok) errorToast(new Error(r.error)); refreshGit(); } }));
    }
    return;
  }
  const msg = h('textarea', { class: 'textarea', rows: '3', placeholder: `Pesan commit (Ctrl+Enter untuk commit ke ${gs.branch})`, spellcheck: 'false' });
  const commitBtn = h('button', { class: 'btn btn-primary btn-sm', text: `Commit semua (${gs.files.length})` });
  const aiBtn = h('button', { class: 'btn btn-sm', title: 'Minta agen menulis pesan commit', html: `${icon('sparkles')} Tulis pesan` });
  const doCommit = async () => {
    if (!gs.files.length) { toast('Tidak ada perubahan untuk di-commit.'); return; }
    commitBtn.disabled = true;
    const r = await api.git.commit(msg.value, true);
    commitBtn.disabled = false;
    if (r.ok) { toast('Commit berhasil', 'ok'); msg.value = ''; } else errorToast(new Error(r.error));
    refreshGit();
  };
  commitBtn.onclick = doCommit;
  aiBtn.onclick = () => emit('agent:insert', 'Lihat perubahan git saat ini (jalankan `git diff` dan `git status`), lalu tuliskan satu pesan commit yang ringkas dan jelas dalam bahasa Indonesia. Jangan commit.');
  msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) doCommit(); });
  body.append(h('div', { class: 'git-commit' }, msg, h('div', { style: 'display:flex;gap:6px' }, commitBtn, aiBtn)));

  const staged = gs.files.filter((f) => f.staged);
  const changes = gs.files.filter((f) => !f.staged);
  const section = (title, list) => {
    if (!list.length) return;
    body.append(h('div', { class: 'git-section', text: `${title} (${list.length})` }));
    for (const f of list) {
      const st = f.untracked ? 'U' : (f.staged ? f.index : f.worktree);
      const row = h('div', { class: 'git-file', title: f.path }, h('span', { html: fileIcon(f.path) }), h('span', { text: basename(f.path) }), h('span', { class: 'muted small', text: f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '' }), h('span', { class: `st git-${st === '?' ? 'U' : st}`, text: st }));
      row.addEventListener('click', () => (st === 'D' || st === 'U' || st === 'A' ? (st === 'D' ? openGitDiff(f.path) : openFile(f.path)) : openGitDiff(f.path)));
      body.append(row);
    }
  };
  section('STAGED', staged);
  section('PERUBAHAN', changes);
  if (!gs.files.length) body.append(h('p', { class: 'muted', text: 'Tidak ada perubahan.' }));
  renderActions(body);
}

/* ---------------- GitHub Actions ---------------- */

let actionsTimer = null;
async function renderActions(body) {
  const box = h('div', { class: 'gh-actions' });
  body.append(h('div', { class: 'git-section', text: 'GITHUB ACTIONS' }), box);
  const actions = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:4px' },
    h('button', { class: 'btn btn-sm', html: `${icon('upload')} Push oleh agen`, onclick: () => emit('agent:insert', 'Commit semua perubahan dengan pesan yang jelas lalu push ke GitHub (github_push). Jika repo punya workflow, pantau GitHub Actions sampai selesai dan perbaiki jika gagal.') }),
    h('button', { class: 'btn btn-sm', html: `${icon('sparkles')} Sampai rilis`, onclick: () => emit('agent:insert', '/ship') }));
  if (!state.settings || !state.settings.hasGithubToken) {
    box.append(h('p', { class: 'muted small', text: 'Isi token GitHub di Pengaturan agar agen bisa push, memantau Actions, dan membuat release.' }));
    box.append(actions);
    return;
  }
  box.append(h('div', { class: 'muted small', text: 'Memuat...' }));
  let r;
  try { r = await api.github.runs(); } catch (e) { box.innerHTML = ''; box.append(h('p', { class: 'muted small', text: e.message }), actions); return; }
  box.innerHTML = '';
  if (!r.repo) {
    box.append(h('p', { class: 'muted small', text: 'Workspace belum terhubung ke repo GitHub (remote origin). Minta agen membuat repo dan push.' }), actions);
    return;
  }
  box.append(h('div', { class: 'muted small', style: 'margin-bottom:4px', text: r.repo }));
  if (!r.runs.length) box.append(h('p', { class: 'muted small', text: 'Belum ada workflow run.' }));
  let active = false;
  for (const run of r.runs) {
    const st = run.status === 'completed' ? run.conclusion : run.status;
    if (run.status !== 'completed') active = true;
    const row = h('div', { class: 'gh-run', title: `${run.workflow} · ${st}` },
      h('span', { class: `gh-dot ${st}` }), h('span', { class: 't', text: `${run.workflow} · ${run.head_sha.slice(0, 7)}` }), h('span', { class: 'muted', text: st }));
    row.addEventListener('click', () => api.openExternal(run.url));
    box.append(row);
  }
  box.append(actions);
  clearTimeout(actionsTimer);
  if (active) actionsTimer = setTimeout(() => { if (!document.getElementById('view-git').hidden) refreshGit(); }, 20000);
}

async function gitRun(args, label) {
  toast(`${label}...`, 'info', 1500);
  const r = await api.git.run(args);
  if (r.ok) toast(`${label} selesai`, 'ok'); else errorToast(new Error(r.error || `${label} gagal`));
  refreshGit();
}

command('gitRefresh', 'Git: muat ulang status', () => refreshGit());
command('gitPull', 'Git: pull', () => gitRun(['pull'], 'Pull'));
command('gitPush', 'Git: push', () => gitRun(['push'], 'Push'));
command('gitFetch', 'Git: fetch', () => gitRun(['fetch'], 'Fetch'));
