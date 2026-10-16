// Monaco editor: tabs, models, saving, diff views and inline AI edit.

import { api, state, emit, on, command } from './state.js';
import { h, $, icon, esc, toast, errorToast, modal, choiceDialog, languageFor, basename, fileIcon } from './ui.js';

let monaco = null;
let editor = null;
const tabs = [];           // { path, model, viewState, savedVersion, binary }
let active = null;

export function getMonaco() { return monaco; }
export function getEditor() { return editor; }
export function activePath() { return active ? active.path : null; }
export function openPaths() { return tabs.map((t) => t.path); }

export function initMonaco() {
  return new Promise((resolve, reject) => {
    window.MonacoEnvironment = { getWorkerUrl: () => new URL('../monaco-worker.js', import.meta.url).href };
    const req = window.require;
    req.config({ paths: { vs: new URL('../../../node_modules/monaco-editor/min/vs', import.meta.url).href } });
    req(['vs/editor/editor.main'], () => {
      monaco = window.monaco;
      defineThemes();
      createEditor();
      resolve(monaco);
    }, reject);
  });
}

function defineThemes() {
  monaco.editor.defineTheme('xzy-dark', {
    base: 'vs-dark', inherit: true, rules: [
      { token: 'comment', foreground: '6e6a85', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c792ea' },
      { token: 'string', foreground: 'a5e075' },
      { token: 'number', foreground: 'f78c6c' },
      { token: 'type', foreground: '82aaff' },
    ],
    colors: {
      'editor.background': '#0d0d12', 'editor.lineHighlightBackground': '#16161f', 'editorLineNumber.foreground': '#4a475c',
      'editorLineNumber.activeForeground': '#b7b4c7', 'editor.selectionBackground': '#3b2a6b', 'editorCursor.foreground': '#a78bfa',
      'editorIndentGuide.background1': '#22222d', 'editorWidget.background': '#13131a', 'editorWidget.border': '#2a2a36',
      'minimap.background': '#0d0d12', 'scrollbarSlider.background': '#36364580',
    },
  });
  monaco.editor.defineTheme('xzy-light', {
    base: 'vs', inherit: true, rules: [],
    colors: { 'editor.background': '#ffffff', 'editor.lineHighlightBackground': '#f4f3fa', 'editorCursor.foreground': '#7c3aed', 'editor.selectionBackground': '#ddd0fb' },
  });
}

export function applyEditorSettings(s) {
  if (!monaco) return;
  monaco.editor.setTheme(s.theme === 'light' ? 'xzy-light' : 'xzy-dark');
  if (editor) editor.updateOptions({ fontSize: Number(s.fontSize) || 14, wordWrap: s.wordWrap === 'on' ? 'on' : 'off' });
}

function createEditor() {
  const s = state.settings || {};
  editor = monaco.editor.create($('#editor'), {
    model: null,
    theme: s.theme === 'light' ? 'xzy-light' : 'xzy-dark',
    automaticLayout: true,
    fontSize: Number(s.fontSize) || 14,
    fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
    fontLigatures: true,
    minimap: { enabled: true, renderCharacters: false, maxColumn: 100 },
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    renderWhitespace: 'selection',
    wordWrap: s.wordWrap === 'on' ? 'on' : 'off',
    scrollBeyondLastLine: false,
    tabSize: 2,
    stickyScroll: { enabled: true },
    padding: { top: 6 },
  });

  editor.onDidChangeCursorPosition((e) => {
    $('#sb-cursor').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  });
  editor.onDidChangeModelContent(() => {
    if (!active) return;
    updateDirty(active);
    if (state.settings && state.settings.autoSave) autoSave();
  });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActive());
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => inlineEdit());
  editor.addAction({
    id: 'xzy.addSelectionToChat',
    label: 'Kirim pilihan ke chat agen',
    contextMenuGroupId: '9_xzy',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL],
    run: () => sendSelectionToAgent(),
  });
  editor.addAction({ id: 'xzy.inlineEdit', label: 'Edit dengan AI (Ctrl+K)', contextMenuGroupId: '9_xzy', run: () => inlineEdit() });
  editor.addAction({
    id: 'xzy.explain',
    label: 'Minta agen menjelaskan kode ini',
    contextMenuGroupId: '9_xzy',
    run: () => sendSelectionToAgent('Jelaskan kode ini:'),
  });
  renderTabs();
}

let autoSaveTimer = null;
function autoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => saveAll(true), 1200);
}

function updateDirty(tab) {
  const dirty = tab.model && tab.model.getAlternativeVersionId() !== tab.savedVersion;
  if (dirty !== tab.dirty) {
    tab.dirty = dirty;
    renderTabs();
  }
}

export function isDirty(path) {
  const t = tabs.find((x) => x.path === path);
  return !!(t && t.dirty);
}

function uriFor(path) {
  return monaco.Uri.from({ scheme: 'file', path: '/' + path.replace(/^\/+/, '') });
}

export async function openFile(path, { line, column, focus = true } = {}) {
  if (!monaco) return;
  let tab = tabs.find((t) => t.path === path);
  if (!tab) {
    let data;
    try {
      data = await api.fs.read(path);
    } catch (e) {
      errorToast(e);
      return;
    }
    if (data.binary || data.tooLarge) {
      toast(data.binary ? `${basename(path)} adalah berkas biner dan tidak bisa dibuka di editor.` : `${basename(path)} terlalu besar untuk dibuka.`, 'error');
      return;
    }
    const uri = uriFor(path);
    let model = monaco.editor.getModel(uri);
    if (model) model.setValue(data.content);
    else model = monaco.editor.createModel(data.content, languageFor(path), uri);
    tab = { path, model, viewState: null, savedVersion: model.getAlternativeVersionId(), dirty: false, mtime: data.mtime };
    tabs.push(tab);
  }
  activate(tab);
  if (line) {
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: column || 1 });
  }
  if (focus) editor.focus();
}

function activate(tab) {
  if (active && active !== tab) active.viewState = editor.saveViewState();
  active = tab;
  editor.setModel(tab.model);
  if (tab.viewState) editor.restoreViewState(tab.viewState);
  $('#editor-empty').hidden = true;
  $('#sb-lang').textContent = tab.model.getLanguageId();
  $('#sb-eol').textContent = tab.model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
  renderTabs();
  renderBreadcrumb();
  emit('activeFile', tab.path);
}

function renderBreadcrumb() {
  const el = $('#breadcrumb');
  el.innerHTML = '';
  if (!active) return;
  const parts = active.path.split('/');
  parts.forEach((p, i) => {
    if (i) el.append(h('span', { class: 'muted', html: icon('chevron', 'svg') }));
    el.append(h('span', { text: p }));
  });
}

function renderTabs() {
  const bar = $('#tabs');
  bar.innerHTML = '';
  for (const t of tabs) {
    const close = h('span', { class: 'close', title: 'Tutup', html: `<span class="x">${icon('x')}</span>` });
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.path); });
    const tab = h('div', { class: `tab${t === active ? ' active' : ''}${t.dirty ? ' dirty' : ''}`, title: t.path },
      h('span', { html: fileIcon(t.path) }), h('span', { class: 'label', text: basename(t.path) }), close);
    tab.addEventListener('click', () => activate(t));
    tab.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.path); } });
    bar.append(tab);
  }
  if (active) {
    const el = bar.querySelector('.tab.active');
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

export async function closeTab(path, { force = false } = {}) {
  const i = tabs.findIndex((t) => t.path === path);
  if (i < 0) return true;
  const tab = tabs[i];
  if (tab.dirty && !force) {
    const choice = await choiceDialog(`Simpan perubahan pada ${basename(path)}?`, [
      { text: 'Batal', value: 'cancel' },
      { text: 'Jangan simpan', value: 'discard' },
      { text: 'Simpan', value: 'save', cls: 'btn-primary' },
    ], 'Perubahan akan hilang jika tidak disimpan.');
    if (choice === 'save') { if (!(await save(tab))) return false; }
    else if (choice !== 'discard') return false;
  }
  tabs.splice(i, 1);
  tab.model.dispose();
  if (active === tab) {
    active = null;
    const next = tabs[i] || tabs[i - 1];
    if (next) activate(next);
    else {
      editor.setModel(null);
      $('#editor-empty').hidden = false;
      $('#breadcrumb').innerHTML = '';
      $('#sb-lang').textContent = '';
      $('#sb-cursor').textContent = '';
      $('#sb-eol').textContent = '';
      emit('activeFile', null);
    }
  }
  renderTabs();
  return true;
}

export async function closeAll() {
  for (const t of [...tabs]) {
    if (!(await closeTab(t.path))) return false;
  }
  return true;
}

export function discardAndCloseUnder(prefix) {
  for (const t of [...tabs]) {
    if (t.path === prefix || t.path.startsWith(prefix + '/')) {
      t.dirty = false;
      closeTab(t.path, { force: true });
    }
  }
}

export function renameOpen(from, to) {
  for (const t of tabs) {
    if (t.path === from || t.path.startsWith(from + '/')) {
      const newPath = to + t.path.slice(from.length);
      const content = t.model.getValue();
      const wasActive = t === active;
      t.model.dispose();
      t.model = monaco.editor.createModel(content, languageFor(newPath), uriFor(newPath));
      t.savedVersion = t.dirty ? -1 : t.model.getAlternativeVersionId();
      t.path = newPath;
      if (wasActive) { active = null; activate(t); }
    }
  }
  renderTabs();
}

async function save(tab) {
  try {
    await api.fs.write(tab.path, tab.model.getValue());
    tab.savedVersion = tab.model.getAlternativeVersionId();
    tab.dirty = false;
    renderTabs();
    emit('saved', tab.path);
    return true;
  } catch (e) {
    errorToast(e);
    return false;
  }
}

export async function saveActive() {
  if (active) {
    if (await save(active)) toast(`${basename(active.path)} disimpan`, 'ok', 1500);
  }
}

export async function saveAll(silent = false) {
  for (const t of tabs) if (t.dirty) await save(t);
  if (!silent) toast('Semua berkas disimpan', 'ok', 1500);
}

/** Files changed on disk (by the agent, git, or another program). */
export async function onDiskChanged(absPaths) {
  if (!state.workspace) return;
  const root = state.workspace.root.replace(/\\/g, '/').toLowerCase();
  for (const abs of absPaths) {
    const norm = String(abs).replace(/\\/g, '/');
    if (!norm.toLowerCase().startsWith(root)) continue;
    const rel = norm.slice(root.length).replace(/^\/+/, '');
    const tab = tabs.find((t) => t.path.toLowerCase() === rel.toLowerCase());
    if (!tab) continue;
    let data;
    try { data = await api.fs.read(tab.path); } catch { continue; }
    if (data.binary || data.tooLarge || typeof data.content !== 'string') continue;
    if (data.content === tab.model.getValue()) { tab.savedVersion = tab.model.getAlternativeVersionId(); updateDirty(tab); continue; }
    if (tab.dirty) {
      toast(`${basename(tab.path)} berubah di disk, tapi ada perubahan yang belum disimpan di editor.`, 'error', 7000);
      continue;
    }
    const view = tab === active ? editor.saveViewState() : null;
    tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: data.content }], () => null);
    tab.savedVersion = tab.model.getAlternativeVersionId();
    tab.dirty = false;
    if (view) editor.restoreViewState(view);
  }
  renderTabs();
}

export function currentContext() {
  if (!active || !editor) return null;
  const sel = editor.getSelection();
  const text = sel && !sel.isEmpty() ? active.model.getValueInRange(sel) : '';
  return { path: active.path, language: active.model.getLanguageId(), selection: text, startLine: sel ? sel.startLineNumber : 1, endLine: sel ? sel.endLineNumber : 1 };
}

function sendSelectionToAgent(prefix = '') {
  const ctx = currentContext();
  if (!ctx) return;
  const ref = ctx.selection
    ? `${prefix ? prefix + '\n' : ''}Dari ${ctx.path} baris ${ctx.startLine}-${ctx.endLine}:\n\`\`\`${ctx.language}\n${ctx.selection}\n\`\`\`\n`
    : `${prefix ? prefix + ' ' : ''}@${ctx.path} `;
  emit('agent:insert', ref);
}

/* ---------------- diff views ---------------- */

export function showDiff({ title, original, modified, path, readOnly = true, actions = [] }) {
  const m = modal({ title, wide: true });
  const host = h('div', { class: 'diff-host' });
  m.body.append(host);
  const lang = languageFor(path || '');
  const o = monaco.editor.createModel(original ?? '', lang);
  const mod = monaco.editor.createModel(modified ?? '', lang);
  const diff = monaco.editor.createDiffEditor(host, {
    automaticLayout: true,
    readOnly,
    originalEditable: false,
    renderSideBySide: host.clientWidth > 700,
    theme: state.settings && state.settings.theme === 'light' ? 'xzy-light' : 'xzy-dark',
    fontSize: Number(state.settings && state.settings.fontSize) || 13,
    minimap: { enabled: false },
  });
  diff.setModel({ original: o, modified: mod });
  const cleanup = () => { diff.dispose(); o.dispose(); mod.dispose(); };
  const done = (fn) => () => { const value = mod.getValue(); m.close(); cleanup(); if (fn) fn(value); };
  if (!actions.length) actions = [{ text: 'Tutup' }];
  for (const a of actions) m.foot.append(h('button', { class: `btn ${a.cls || ''}`, text: a.text, onclick: done(a.run) }));
  const origClose = m.close;
  m.close = (v) => { origClose(v); cleanup(); };
  return m;
}

export async function openGitDiff(path) {
  try {
    const original = await api.git.headFile(path);
    let modified = '';
    try { const r = await api.fs.read(path); modified = r.content || ''; } catch { modified = ''; }
    showDiff({ title: `${path} (HEAD vs kerja)`, original, modified, path, actions: [{ text: 'Buka berkas', cls: 'btn-primary', run: () => openFile(path) }, { text: 'Tutup' }] });
  } catch (e) {
    errorToast(e);
  }
}

/* ---------------- inline AI edit (Ctrl+K) ---------------- */

let inlineBox = null;
export function inlineEdit() {
  if (!active || !editor) return;
  if (inlineBox) { inlineBox.remove(); inlineBox = null; }
  const model = active.model;
  const sel = editor.getSelection();
  const range = sel.isEmpty() ? new monaco.Range(sel.startLineNumber, 1, sel.startLineNumber, model.getLineMaxColumn(sel.startLineNumber)) : sel;
  const pos = editor.getScrolledVisiblePosition({ lineNumber: range.startLineNumber, column: 1 });
  const input = h('input', { class: 'input', placeholder: 'Ubah kode ini... (mis. "tambahkan validasi input")', spellcheck: 'false' });
  const go = h('button', { class: 'btn btn-primary btn-sm', text: 'Buat' });
  const cancel = h('button', { class: 'icon-btn', title: 'Batal (Esc)', html: icon('x') });
  inlineBox = h('div', { class: 'inline-edit' }, h('span', { html: icon('sparkles') }), input, go, cancel);
  inlineBox.style.top = `${Math.max(4, (pos ? pos.top : 0) - 44)}px`;
  $('#editor-host').append(inlineBox);
  input.focus();
  const close = () => { if (inlineBox) { inlineBox.remove(); inlineBox = null; } editor.focus(); };
  cancel.onclick = close;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') go.click();
  });
  go.onclick = async () => {
    const instruction = input.value.trim();
    if (!instruction) return;
    go.disabled = true;
    go.innerHTML = '<span class="spinner"></span>';
    const full = model.getValue();
    const startOffset = model.getOffsetAt(range.getStartPosition());
    const endOffset = model.getOffsetAt(range.getEndPosition());
    const original = full.slice(startOffset, endOffset);
    try {
      const out = await api.ai.inlineEdit({
        model: emitModelRequest(),
        path: active.path,
        language: model.getLanguageId(),
        before: full.slice(0, startOffset),
        selection: original,
        after: full.slice(endOffset),
        instruction,
      });
      close();
      showDiff({
        title: `Edit AI: ${instruction.slice(0, 60)}`,
        original,
        modified: out,
        path: active.path,
        readOnly: false,
        actions: [
          { text: 'Buang' },
          {
            text: 'Terapkan', cls: 'btn-primary', run: (value) => {
              editor.executeEdits('xzy-inline', [{ range, text: value, forceMoveMarkers: true }]);
              editor.pushUndoStop();
            },
          },
        ],
      });
    } catch (e) {
      go.disabled = false;
      go.textContent = 'Buat';
      errorToast(e);
    }
  };
}

let modelProvider = () => (state.settings && state.settings.defaultModel) || '';
export function setModelProvider(fn) { modelProvider = fn; }
function emitModelRequest() { return modelProvider(); }

command('save', 'Simpan berkas', () => saveActive(), 'Ctrl+S');
command('saveAll', 'Simpan semua berkas', () => saveAll(), 'Ctrl+K S');
command('closeTab', 'Tutup tab', () => active && closeTab(active.path), 'Ctrl+W');
command('inlineEdit', 'Edit kode dengan AI', () => inlineEdit(), 'Ctrl+K');
command('formatDocument', 'Format dokumen', () => editor && editor.getAction('editor.action.formatDocument')?.run());
command('toggleWordWrap', 'Bungkus baris (word wrap)', async () => {
  const next = state.settings.wordWrap === 'on' ? 'off' : 'on';
  state.settings = await api.settings.set({ wordWrap: next });
  applyEditorSettings(state.settings);
});
command('gotoLine', 'Pergi ke baris', () => { if (editor) { editor.focus(); editor.getAction('editor.action.gotoLine')?.run(); } }, 'Ctrl+G');

on('settings', (s) => applyEditorSettings(s));
on('saveActiveSilently', () => { if (active && active.dirty) save(active); });
export { esc };
