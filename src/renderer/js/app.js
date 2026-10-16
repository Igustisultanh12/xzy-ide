// App bootstrap: layout, workspace lifecycle, keybindings, preview, welcome screen.

import { api, state, emit, on, command, runCommand } from './state.js';
import { h, $, $$, icon, toast, errorToast, basename } from './ui.js';
import { initMonaco, openFile, onDiskChanged, closeAll, applyEditorSettings, saveActive } from './editor.js';
import { initExplorer, resetTree, refreshSoon, revealInTree } from './explorer.js';
import { initSearch, refreshGit, refreshGitSoon } from './search.js';
import { initTerminal, newTerminal, killAll, fitActive, applyTerminalTheme, focusTerminal } from './terminal.js';
import { initAgentPanel, loadAgents, renderModels, resetAgentPanel, invalidateFileIndex } from './agent.js';
import { commandPalette, quickOpen, invalidateQuickOpen } from './palette.js';
import { openSettings, loadModels } from './settings.js';

const app = $('#app');
let currentView = null;

/* ---------------- layout ---------------- */

function setIcons() {
  const map = { explorer: 'files', search: 'search', git: 'git', agents: 'agents' };
  for (const b of $$('.act[data-view]')) b.innerHTML = icon(map[b.dataset.view]);
  $('.act[data-action="preview"]').innerHTML = icon('globe');
  $('.act[data-action="settings"]').innerHTML = icon('settings');
  const cmdIcons = {
    newFile: 'filePlus', newFolder: 'folderPlus', refreshTree: 'refresh', collapseTree: 'collapse', gitPull: 'download', gitPush: 'upload',
    gitRefresh: 'refresh', newAgent: 'plus', agentUndo: 'undo', agentClear: 'trash', newTerminal: 'plus', killTerminal: 'trash', togglePanel: 'x',
    previewBack: 'arrowLeft', previewReload: 'refresh', previewExternal: 'external', previewClose: 'x',
  };
  for (const b of $$('.icon-btn[data-cmd]')) if (cmdIcons[b.dataset.cmd]) b.innerHTML = icon(cmdIcons[b.dataset.cmd]);
}

function showView(view) {
  if (currentView === view && !app.classList.contains('sidebar-hidden')) {
    app.classList.add('sidebar-hidden');
    $$('.act[data-view]').forEach((b) => b.classList.remove('active'));
    return;
  }
  currentView = view;
  app.classList.remove('sidebar-hidden');
  for (const v of ['explorer', 'search', 'git', 'agents']) $(`#view-${v}`).hidden = v !== view;
  $$('.act[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'search') setTimeout(() => $('#search-input').focus(), 0);
  if (view === 'git') refreshGit();
  saveLayout();
}

function initResizers() {
  const restore = (() => { try { return JSON.parse(localStorage.getItem('xzy-layout') || '{}'); } catch { return {}; } })();
  if (restore.sidebar) document.documentElement.style.setProperty('--sidebar-w', `${restore.sidebar}px`);
  if (restore.agent) document.documentElement.style.setProperty('--agent-w', `${restore.agent}px`);
  if (restore.panel) document.documentElement.style.setProperty('--panel-h', `${restore.panel}px`);
  if (restore.panelHidden) app.classList.add('panel-hidden');
  if (restore.agentHidden) app.classList.add('agent-hidden');

  const drag = (el, onMove) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      el.classList.add('dragging');
      document.body.style.cursor = getComputedStyle(el).cursor;
      const move = (ev) => onMove(ev);
      const up = () => {
        el.classList.remove('dragging');
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        saveLayout();
        fitActive();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  };
  drag($('#resize-sidebar'), (e) => {
    const w = Math.min(Math.max(e.clientX - 48, 170), 600);
    document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
  });
  drag($('#resize-agent'), (e) => {
    const w = Math.min(Math.max(window.innerWidth - e.clientX, 300), Math.max(320, window.innerWidth - 500));
    document.documentElement.style.setProperty('--agent-w', `${w}px`);
  });
  drag($('#resize-panel'), (e) => {
    const rect = $('#main').getBoundingClientRect();
    const hgt = Math.min(Math.max(rect.bottom - e.clientY, 90), rect.height - 120);
    document.documentElement.style.setProperty('--panel-h', `${hgt}px`);
    fitActive();
  });
}

function saveLayout() {
  const css = getComputedStyle(document.documentElement);
  const num = (v) => parseInt(css.getPropertyValue(v), 10) || undefined;
  try {
    localStorage.setItem('xzy-layout', JSON.stringify({
      sidebar: num('--sidebar-w'), agent: num('--agent-w'), panel: num('--panel-h'),
      panelHidden: app.classList.contains('panel-hidden'), agentHidden: app.classList.contains('agent-hidden'),
    }));
  } catch { /* storage unavailable */ }
}

function applyTheme() {
  const t = state.settings && state.settings.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  applyEditorSettings(state.settings);
  applyTerminalTheme();
}

/* ---------------- workspace ---------------- */

async function enterWorkspace(ws) {
  if (!ws) return;
  state.workspace = ws;
  app.classList.remove('no-workspace');
  $('#ws-name').textContent = ws.name.toUpperCase();
  document.title = `${ws.name} - XZY IDE`;
  invalidateFileIndex();
  invalidateQuickOpen();
  await resetTree();
  refreshGit();
  await loadAgents();
  renderModels();
  if (!app.classList.contains('panel-hidden')) newTerminal();
}

async function openFolder() {
  try {
    const folder = await api.workspace.pick();
    if (!folder) return;
    if (state.workspace && !(await leaveWorkspace(true))) return;
    await enterWorkspace(await api.workspace.open(folder));
  } catch (e) { errorToast(e); }
}

async function openRecent(folder) {
  try {
    if (state.workspace && !(await leaveWorkspace(true))) return;
    await enterWorkspace(await api.workspace.open(folder));
  } catch (e) {
    errorToast(new Error(`Tidak bisa membuka ${folder}: ${e.message}`));
  }
}

async function leaveWorkspace(keepServer = false) {
  if (!(await closeAll())) return false;
  killAll();
  resetAgentPanel();
  if (!keepServer) await api.workspace.close();
  state.workspace = null;
  state.gitStatus = null;
  return true;
}

async function closeFolder() {
  if (!(await leaveWorkspace())) return;
  app.classList.add('no-workspace');
  document.title = 'XZY IDE';
  $('#sb-branch').innerHTML = '';
  renderWelcome();
}

function renderWelcome() {
  const list = $('#recent-list');
  list.innerHTML = '';
  const recents = (state.settings && state.settings.recentFolders) || [];
  if (!recents.length) list.append(h('div', { class: 'muted', text: 'Belum ada folder yang dibuka.' }));
  for (const f of recents) {
    const it = h('div', { class: 'recent-item', title: f }, h('span', { text: basename(f) }), h('span', { class: 'p', text: f }));
    it.addEventListener('click', () => openRecent(f));
    list.append(it);
  }
  $('#api-warning').hidden = !!(state.settings && state.settings.hasApiKey);
}

/* ---------------- preview ---------------- */

let webview = null;
function openPreview(url) {
  const pane = $('#preview-pane');
  pane.hidden = false;
  const target = url || $('#preview-url').value;
  $('#preview-url').value = target;
  if (!webview) {
    webview = document.createElement('webview');
    webview.setAttribute('partition', 'persist:preview');
    webview.addEventListener('did-navigate', (e) => { $('#preview-url').value = e.url; });
    webview.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) $('#preview-url').value = e.url; });
    webview.addEventListener('did-fail-load', (e) => {
      if (e.errorCode !== -3 && e.isMainFrame) toast(`Pratinjau gagal dimuat (${e.errorDescription}). Pastikan server sudah berjalan.`, 'error');
    });
    webview.setAttribute('src', normalizeUrl(target));
    $('#preview-host').append(webview);
  } else {
    webview.loadURL(normalizeUrl(target)).catch(() => {});
  }
}

function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  return `http://${s}`;
}

/* ---------------- commands & keys ---------------- */

function registerCommands() {
  command('openFolder', 'Buka folder', () => openFolder(), 'Ctrl+O');
  command('closeFolder', 'Tutup folder', () => closeFolder());
  command('palette', 'Palet perintah', () => commandPalette(), 'Ctrl+Shift+P');
  command('quickOpen', 'Buka berkas cepat', () => quickOpen(), 'Ctrl+P');
  command('togglePanel', 'Tampilkan/sembunyikan terminal', () => {
    app.classList.toggle('panel-hidden');
    saveLayout();
    if (!app.classList.contains('panel-hidden')) setTimeout(() => focusTerminal(), 30);
  }, 'Ctrl+`');
  command('toggleSidebar', 'Tampilkan/sembunyikan sidebar', () => { app.classList.toggle('sidebar-hidden'); saveLayout(); }, 'Ctrl+B');
  command('toggleAgent', 'Tampilkan/sembunyikan panel agen', () => { app.classList.toggle('agent-hidden'); saveLayout(); }, 'Ctrl+Alt+B');
  command('showExplorer', 'Tampilkan Explorer', () => showView('explorer'), 'Ctrl+Shift+E');
  command('showSearch', 'Cari di workspace', () => showView('search'), 'Ctrl+Shift+F');
  command('showGit', 'Tampilkan Source Control', () => showView('git'), 'Ctrl+Shift+G');
  command('showAgents', 'Tampilkan Agent Manager', () => showView('agents'), 'Ctrl+Shift+A');
  command('preview', 'Buka pratinjau browser', () => openPreview());
  command('previewClose', 'Tutup pratinjau', () => { $('#preview-pane').hidden = true; });
  command('previewReload', 'Muat ulang pratinjau', () => webview && webview.reload());
  command('previewBack', 'Pratinjau: kembali', () => webview && webview.canGoBack() && webview.goBack());
  command('previewExternal', 'Buka pratinjau di browser', () => api.openExternal(normalizeUrl($('#preview-url').value)));
  command('reveal', 'Tampilkan berkas aktif di Explorer', async () => { const { activePath } = await import('./editor.js'); const p = activePath(); if (p) { showView('explorer'); revealInTree(p); } });
}

function onKeyDown(e) {
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  const combos = [
    [ctrl && e.shiftKey && k === 'p', 'palette'],
    [ctrl && !e.shiftKey && !e.altKey && k === 'p', 'quickOpen'],
    [ctrl && (e.code === 'Backquote') && !e.shiftKey, 'togglePanel'],
    [ctrl && e.shiftKey && e.code === 'Backquote', 'newTerminal'],
    [ctrl && !e.shiftKey && !e.altKey && k === 'b', 'toggleSidebar'],
    [ctrl && e.altKey && k === 'b', 'toggleAgent'],
    [ctrl && !e.shiftKey && k === 'l', 'focusAgent'],
    [ctrl && e.shiftKey && k === 'e', 'showExplorer'],
    [ctrl && e.shiftKey && k === 'f', 'showSearch'],
    [ctrl && e.shiftKey && k === 'g', 'showGit'],
    [ctrl && e.shiftKey && k === 'a', 'showAgents'],
    [ctrl && e.shiftKey && k === 'n', 'newAgent'],
    [ctrl && k === ',', 'settings'],
    [ctrl && !e.shiftKey && k === 'o', 'openFolder'],
    [ctrl && !e.shiftKey && k === 'w' && state.workspace, 'closeTab'],
    [ctrl && !e.shiftKey && k === 'n' && state.workspace, 'newFile'],
  ];
  for (const [hit, id] of combos) {
    if (hit) {
      e.preventDefault();
      e.stopPropagation();
      runCommand(id);
      return;
    }
  }
  if (ctrl && k === 's' && !document.activeElement.closest('.monaco-editor')) { e.preventDefault(); saveActive(); }
}

/* ---------------- boot ---------------- */

async function boot() {
  setIcons();
  registerCommands();
  initResizers();

  document.addEventListener('click', (e) => {
    const cmdEl = e.target.closest('[data-cmd]');
    if (cmdEl && !cmdEl.disabled) { runCommand(cmdEl.dataset.cmd); return; }
    const view = e.target.closest('.act[data-view]');
    if (view) { showView(view.dataset.view); return; }
    const action = e.target.closest('.act[data-action]');
    if (action) runCommand(action.dataset.action);
  });
  document.addEventListener('keydown', onKeyDown, true);
  api.onMenu((cmd) => runCommand(cmd === 'terminal' ? 'togglePanel' : cmd));

  [state.info, state.settings] = await Promise.all([api.info(), api.settings.get()]);
  applyTheme();
  renderWelcome();

  try {
    await initMonaco();
  } catch (e) {
    errorToast(new Error(`Editor gagal dimuat: ${e.message || e}`));
  }
  applyEditorSettings(state.settings);
  initExplorer();
  initSearch();
  initTerminal();
  initAgentPanel();

  on('settings', (s) => { applyTheme(); renderWelcome(); renderModels(); void s; });
  on('models', () => renderModels());
  on('openSettings', () => openSettings());
  on('showAgentPanel', () => { app.classList.remove('agent-hidden'); saveLayout(); });
  on('preview:open', (url) => openPreview(url));
  on('saved', () => { refreshGitSoon(); });

  api.fs.onChanged(({ paths }) => {
    onDiskChanged(paths);
    refreshSoon();
    refreshGitSoon();
    invalidateFileIndex();
    invalidateQuickOpen();
  });

  loadModels().then(() => renderModels());
  const ws = await api.workspace.current();
  if (ws) await enterWorkspace(ws);
  showView('explorer');

  window.__xzyReady = true;
  emit('ready');
}

boot().catch((e) => {
  console.error(e);
  errorToast(e);
  window.__xzyBootError = String(e && e.stack ? e.stack : e);
});

// Exposed for keyboard-less flows in tests and the welcome buttons
window.xzyOpenFile = openFile;
