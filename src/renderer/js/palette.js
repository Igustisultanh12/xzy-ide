// Command palette (Ctrl+Shift+P) and quick open (Ctrl+P).

import { api, state, commands } from './state.js';
import { h, esc, fileIcon, basename } from './ui.js';
import { openFile } from './editor.js';

let openEl = null;

function fuzzy(query, text) {
  if (!query) return { score: 0, idx: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return { score: 1000 - direct - t.length * 0.1, idx: [...Array(q.length).keys()].map((k) => k + direct) };
  let ti = 0;
  const idx = [];
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti < 0) return null;
    idx.push(ti++);
  }
  const spread = idx[idx.length - 1] - idx[0];
  return { score: 500 - spread - t.length * 0.1, idx };
}

function mark(text, idx) {
  const set = new Set(idx);
  return [...text].map((c, i) => (set.has(i) ? `<b>${esc(c)}</b>` : esc(c))).join('');
}

function open({ placeholder, initial = '', source, onPick }) {
  close();
  const input = h('input', { placeholder, value: initial, spellcheck: 'false' });
  const items = h('div', { class: 'items' });
  const box = h('div', { class: 'palette' }, input, items);
  const back = h('div', { class: 'backdrop' }, box);
  openEl = back;
  document.getElementById('overlay-root').append(back);
  let list = [];
  let index = 0;
  const render = async () => {
    list = await source(input.value);
    index = 0;
    draw();
  };
  const draw = () => {
    items.innerHTML = '';
    list.slice(0, 80).forEach((it, i) => {
      const el = h('div', { class: `item${i === index ? ' active' : ''}`, html: it.html });
      el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      items.append(el);
    });
    const a = items.querySelector('.active');
    if (a) a.scrollIntoView({ block: 'nearest' });
  };
  const pick = (i) => {
    const it = list[i];
    close();
    if (it) onPick(it, input.value);
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(list.length - 1, index + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(0, index - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(index); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
  render();
}

export function close() {
  if (openEl) { openEl.remove(); openEl = null; }
}

export function commandPalette(initial = '') {
  open({
    placeholder: 'Ketik perintah...',
    initial,
    source: (q) => {
      const all = [...commands.values()];
      return all
        .map((c) => ({ c, m: fuzzy(q, c.label) }))
        .filter((x) => !q || x.m)
        .sort((a, b) => (b.m ? b.m.score : 0) - (a.m ? a.m.score : 0) || a.c.label.localeCompare(b.c.label))
        .map(({ c, m }) => ({ c, html: `<span>${m ? mark(c.label, m.idx) : esc(c.label)}</span>${c.key ? `<span class="p"><kbd>${esc(c.key)}</kbd></span>` : ''}` }));
    },
    onPick: (it) => it.c.run(),
  });
}

let fileCache = null;
let fileCacheAt = 0;
export function invalidateQuickOpen() { fileCache = null; }

export function quickOpen() {
  if (!state.workspace) return;
  open({
    placeholder: 'Cari berkas berdasarkan nama (ketik > untuk perintah, : untuk baris)',
    source: async (q) => {
      if (q.startsWith('>')) {
        close();
        commandPalette(q.slice(1));
        return [];
      }
      if (q.startsWith(':')) {
        const n = Number(q.slice(1));
        return n ? [{ line: n, html: `Pergi ke baris ${n}` }] : [];
      }
      if (!fileCache || Date.now() - fileCacheAt > 15000) {
        fileCache = await api.fs.allFiles();
        fileCacheAt = Date.now();
      }
      return fileCache
        .map((p) => ({ p, m: fuzzy(q, basename(p)) || (q.includes('/') ? fuzzy(q, p) : null) }))
        .filter((x) => !q || x.m)
        .sort((a, b) => (b.m ? b.m.score : 0) - (a.m ? a.m.score : 0))
        .slice(0, 80)
        .map(({ p, m }) => ({ p, html: `${fileIcon(p)}<span>${m && !q.includes('/') ? mark(basename(p), m.idx) : esc(basename(p))}</span><span class="p">${esc(p)}</span>` }));
    },
    onPick: async (it) => {
      if (it.line) {
        const { getEditor } = await import('./editor.js');
        const ed = getEditor();
        if (ed && ed.getModel()) { ed.revealLineInCenter(it.line); ed.setPosition({ lineNumber: it.line, column: 1 }); ed.focus(); }
        return;
      }
      openFile(it.p);
    },
  });
}
