// Integrated terminal panel (xterm.js) with multiple terminals.

import { api, state, command } from './state.js';
import { h, $, icon, errorToast } from './ui.js';

const terms = new Map(); // id -> { term, fit, el, title }
let activeId = null;
let counter = 0;

function theme() {
  const light = state.settings && state.settings.theme === 'light';
  return light
    ? { background: '#f7f7fb', foreground: '#1c1a28', cursor: '#7c3aed', selectionBackground: '#ddd0fb' }
    : { background: '#0d0d12', foreground: '#e8e6f0', cursor: '#a78bfa', selectionBackground: '#3b2a6b', black: '#1a1a23', brightBlack: '#6e6a85' };
}

export async function newTerminal() {
  if (!state.workspace) return;
  const id = `t${++counter}`;
  const el = h('div', { class: 'term-view' });
  $('#term-host').append(el);
  const term = new window.Terminal({
    fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
    fontSize: Math.max(11, (Number(state.settings && state.settings.fontSize) || 14) - 1),
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    theme: theme(),
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  const entry = { term, fit, el, title: `Terminal ${counter}` };
  terms.set(id, entry);
  term.onData((d) => api.term.write(id, d));
  term.attachCustomKeyEventHandler((e) => {
    // Ctrl+C copies when text is selected, Ctrl+V pastes
    if (e.type === 'keydown' && e.ctrlKey && e.key === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    if (e.type === 'keydown' && e.ctrlKey && e.key === 'v') {
      navigator.clipboard.readText().then((t) => api.term.write(id, t));
      return false;
    }
    return true;
  });
  activate(id);
  try {
    const info = await api.term.create(id, { cols: term.cols, rows: term.rows });
    entry.title = info.shell.replace(/\.exe$/i, '');
    renderTabs();
    setTimeout(() => fitActive(), 50);
  } catch (e) {
    errorToast(e);
  }
  return id;
}

function activate(id) {
  activeId = id;
  for (const [tid, t] of terms) t.el.hidden = tid !== id;
  renderTabs();
  setTimeout(() => { fitActive(); const t = terms.get(id); if (t) t.term.focus(); }, 0);
}

export function fitActive() {
  const t = terms.get(activeId);
  if (!t || t.el.hidden || !t.el.offsetParent) return;
  try {
    t.fit.fit();
    api.term.resize(activeId, t.term.cols, t.term.rows);
  } catch { /* hidden */ }
}

function renderTabs() {
  const bar = $('#term-tabs');
  bar.innerHTML = '';
  for (const [id, t] of terms) {
    const tab = h('div', { class: `panel-tab${id === activeId ? ' active' : ''}` }, h('span', { html: icon('terminal') }), t.title);
    tab.addEventListener('click', () => activate(id));
    bar.append(tab);
  }
}

export function killTerminal(id = activeId) {
  const t = terms.get(id);
  if (!t) return;
  api.term.kill(id);
  t.term.dispose();
  t.el.remove();
  terms.delete(id);
  const next = [...terms.keys()].pop();
  if (next) activate(next); else { activeId = null; renderTabs(); }
}

export function killAll() {
  for (const id of [...terms.keys()]) killTerminal(id);
}

export function focusTerminal() {
  if (!terms.size) return newTerminal();
  const t = terms.get(activeId);
  if (t) t.term.focus();
  return activeId;
}

/** Run a command in a visible terminal (from palette or agent suggestions). */
export async function runInTerminal(cmd) {
  const id = activeId || (await newTerminal());
  api.term.write(id, `${cmd}\r`);
}

export function applyTerminalTheme() {
  for (const t of terms.values()) t.term.options.theme = theme();
}

export function initTerminal() {
  api.term.onData(({ id, data }) => { const t = terms.get(id); if (t) t.term.write(data); });
  api.term.onExit(({ id, code }) => {
    const t = terms.get(id);
    if (t) t.term.write(`\r\n\x1b[90m[proses selesai dengan kode ${code}]\x1b[0m\r\n`);
  });
  new ResizeObserver(() => fitActive()).observe($('#term-host'));
  command('newTerminal', 'Terminal baru', () => newTerminal(), 'Ctrl+Shift+`');
  command('killTerminal', 'Tutup terminal aktif', () => killTerminal());
}
