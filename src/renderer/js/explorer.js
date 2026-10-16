// File explorer tree with lazy loading, context menu, create/rename/delete.

import { api, state, emit, on, command } from './state.js';
import { h, $, icon, fileIcon, contextMenu, confirmDialog, errorToast, toast, basename, dirname, debounce } from './ui.js';
import { openFile, discardAndCloseUnder, renameOpen } from './editor.js';

const children = new Map();   // dir rel path -> entries
const expanded = new Set(['.']);
let selected = null;
let editing = null;           // { kind: 'new'|'rename', dir, isDir, path }
let rows = [];                // flattened visible rows for keyboard nav

export async function loadDir(dir) {
  try {
    children.set(dir, await api.fs.list(dir));
  } catch {
    children.delete(dir);
    expanded.delete(dir);
  }
}

export async function refreshTree() {
  if (!state.workspace) return;
  const dirs = [...expanded];
  await Promise.all(dirs.map((d) => loadDir(d)));
  render();
}

export const refreshSoon = debounce(refreshTree, 250);

export async function resetTree() {
  children.clear();
  expanded.clear();
  expanded.add('.');
  selected = null;
  await refreshTree();
}

function gitMark(path) {
  const gs = state.gitStatus;
  if (!gs || !gs.repo) return '';
  const f = gs.files.find((x) => x.path === path);
  if (f) return f.untracked ? 'U' : (f.worktree !== ' ' ? f.worktree : f.index);
  if (gs.files.some((x) => x.path.startsWith(path + '/'))) return '•';
  return '';
}

function render() {
  const tree = $('#tree');
  const scroll = tree.scrollTop;
  tree.innerHTML = '';
  rows = [];
  const walk = (dir, depth) => {
    const list = children.get(dir) || [];
    if (editing && editing.kind === 'new' && editing.dir === dir) tree.append(editRow(depth, editing.isDir));
    for (const e of list) {
      if (editing && editing.kind === 'rename' && editing.path === e.path) {
        tree.append(editRow(depth, e.dir, e.name));
        continue;
      }
      const open = e.dir && expanded.has(e.path);
      const mark = gitMark(e.path);
      const row = h('div', {
        class: `tree-row${selected === e.path ? ' selected' : ''}${e.ignored ? ' ignored' : ''}`,
        style: `padding-left:${8 + depth * 12}px`,
        title: e.path,
        dataset: { path: e.path, dir: e.dir ? '1' : '' },
        draggable: 'true',
      },
      e.dir ? h('span', { html: icon('chevron', `chev${open ? ' open' : ''}`) }) : h('span', { style: 'width:14px;flex:none' }),
      h('span', { html: e.dir ? icon('folder') : fileIcon(e.name) }),
      h('span', { class: 'name', text: e.name }),
      mark ? h('span', { class: `git-mark git-${mark === '?' ? 'U' : mark}`, text: mark }) : '');
      row.addEventListener('click', () => onClick(e));
      row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); selected = e.path; render(); menuFor(e, ev); });
      row.addEventListener('dragstart', (ev) => ev.dataTransfer.setData('text/xzy-path', e.path));
      tree.append(row);
      rows.push(e);
      if (open) walk(e.path, depth + 1);
    }
  };
  walk('.', 0);
  tree.scrollTop = scroll;
}

function editRow(depth, isDir, value = '') {
  const input = h('input', { class: 'tree-input', value, spellcheck: 'false' });
  const row = h('div', { class: 'tree-row', style: `padding-left:${8 + depth * 12 + 14}px` }, h('span', { html: isDir ? icon('folder') : icon('files') }), input);
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const ed = editing;
    editing = null;
    const name = input.value.trim();
    if (commit && name && /[<>:"|?*]/.test(name)) { toast('Nama mengandung karakter yang tidak diizinkan Windows.', 'error'); render(); return; }
    if (commit && name) {
      try {
        if (ed.kind === 'new') {
          const rel = ed.dir === '.' ? name : `${ed.dir}/${name}`;
          const created = await api.fs.create(rel, ed.isDir);
          await loadDir(ed.dir);
          selected = created;
          if (!ed.isDir) openFile(created);
        } else if (name !== basename(ed.path)) {
          const parent = dirname(ed.path);
          const to = parent === '.' ? name : `${parent}/${name}`;
          const newPath = await api.fs.rename(ed.path, to);
          renameOpen(ed.path, newPath);
          await loadDir(parent);
          selected = newPath;
        }
      } catch (e) { errorToast(e); }
    }
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  setTimeout(() => {
    input.focus();
    const dot = value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 && !isDir ? dot : value.length);
  }, 0);
  return row;
}

async function onClick(e) {
  selected = e.path;
  if (e.dir) {
    if (expanded.has(e.path)) expanded.delete(e.path);
    else {
      expanded.add(e.path);
      if (!children.has(e.path)) await loadDir(e.path);
    }
    render();
  } else {
    render();
    openFile(e.path);
  }
}

function targetDir() {
  if (!selected) return '.';
  const isDir = (children.get(dirname(selected)) || []).find((x) => x.path === selected)?.dir;
  return isDir ? selected : dirname(selected);
}

export async function startNew(isDir, dir = targetDir()) {
  if (!state.workspace) return;
  if (dir !== '.') {
    expanded.add(dir);
    if (!children.has(dir)) await loadDir(dir);
  }
  editing = { kind: 'new', dir, isDir };
  render();
}

function startRename(e) {
  editing = { kind: 'rename', path: e.path, isDir: e.dir };
  render();
}

async function remove(e) {
  const ok = await confirmDialog(`Hapus ${e.dir ? 'folder' : 'berkas'} "${e.name}"?`, { okText: 'Hapus', danger: true, detail: 'Item dipindahkan ke Recycle Bin.' });
  if (!ok) return;
  try {
    await api.fs.remove(e.path);
    discardAndCloseUnder(e.path);
    await loadDir(dirname(e.path));
    render();
  } catch (err) { errorToast(err); }
}

function menuFor(e, ev) {
  const dir = e.dir ? e.path : dirname(e.path);
  contextMenu(ev.clientX, ev.clientY, [
    ...(e.dir ? [] : [{ label: 'Buka', run: () => openFile(e.path) }]),
    { label: 'Berkas baru', run: () => startNew(false, dir) },
    { label: 'Folder baru', run: () => startNew(true, dir) },
    '-',
    { label: 'Tambahkan ke chat agen', run: () => emit('agent:attach', e.path) },
    { label: 'Salin path relatif', run: () => navigator.clipboard.writeText(e.path) },
    { label: 'Tampilkan di File Explorer', run: () => api.fs.reveal(e.path) },
    '-',
    { label: 'Ganti nama', key: 'F2', run: () => startRename(e) },
    { label: 'Hapus', key: 'Del', run: () => remove(e) },
  ]);
}

function onKey(ev) {
  if (editing) return;
  const idx = rows.findIndex((r) => r.path === selected);
  const cur = rows[idx];
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const next = rows[Math.min(rows.length - 1, Math.max(0, idx + (ev.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { selected = next.path; render(); $(`.tree-row.selected`)?.scrollIntoView({ block: 'nearest' }); }
  } else if (ev.key === 'Enter' && cur) {
    onClick(cur);
  } else if (ev.key === 'ArrowRight' && cur && cur.dir && !expanded.has(cur.path)) {
    onClick(cur);
  } else if (ev.key === 'ArrowLeft' && cur) {
    if (cur.dir && expanded.has(cur.path)) { expanded.delete(cur.path); render(); }
    else { selected = dirname(cur.path); render(); }
  } else if (ev.key === 'F2' && cur) {
    startRename(cur);
  } else if (ev.key === 'Delete' && cur) {
    remove(cur);
  }
}

export function revealInTree(path) {
  const parts = path.split('/');
  let acc = '';
  const loads = [];
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    expanded.add(acc);
    if (!children.has(acc)) loads.push(loadDir(acc));
  }
  Promise.all(loads).then(() => { selected = path; render(); });
}

export function initExplorer() {
  const tree = $('#tree');
  tree.addEventListener('keydown', onKey);
  tree.addEventListener('contextmenu', (ev) => {
    if (ev.target !== tree) return;
    ev.preventDefault();
    contextMenu(ev.clientX, ev.clientY, [
      { label: 'Berkas baru', run: () => startNew(false, '.') },
      { label: 'Folder baru', run: () => startNew(true, '.') },
      { label: 'Muat ulang', run: () => refreshTree() },
    ]);
  });
  on('git', () => render());
  on('activeFile', (p) => { if (p) { selected = p; render(); } });

  command('newFile', 'Berkas baru', () => startNew(false), 'Ctrl+N');
  command('newFolder', 'Folder baru', () => startNew(true));
  command('refreshTree', 'Muat ulang explorer', () => refreshTree());
  command('collapseTree', 'Ciutkan semua folder', () => { expanded.clear(); expanded.add('.'); render(); });
}
