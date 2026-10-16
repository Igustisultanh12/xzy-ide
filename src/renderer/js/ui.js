// Small DOM helpers, icons, toasts, modals and context menus.

const P = {
  files: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  git: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="8" r="3"/><path d="M6 9v6"/><path d="M18 11a6 6 0 0 1-6 6H9"/>',
  agents: '<rect x="3" y="8" width="18" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M9 14h.01M15 14h.01"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  filePlus: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6M12 12v6"/>',
  folderPlus: '<path d="M12 10v6M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  collapse: '<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  branch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  sparkles: '<path d="M9.94 14.06 7 21l-2.94-6.94L-2 11l7.06-2.94L7 1l2.94 7.06L17 11z" transform="translate(4 1) scale(.8)"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
};

export function icon(name, cls = '') {
  return `<svg class="svg ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.files}</svg>`;
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toast(message, type = 'info', ms = 4000) {
  const el = h('div', { class: `toast ${type}`, role: 'status' }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; setTimeout(() => el.remove(), 220); }, ms);
}

export function errorToast(e) { toast(e && e.message ? e.message : String(e), 'error', 6000); }

/** Generic modal; returns { el, close, body, foot }. */
export function modal({ title, wide = false, onClose } = {}) {
  const root = document.getElementById('overlay-root');
  const body = h('div', { class: 'modal-body' });
  const foot = h('div', { class: 'modal-foot' });
  const closeBtn = h('button', { class: 'icon-btn', title: 'Tutup', html: icon('x') });
  const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h2', { text: title || '' }), closeBtn), body, foot);
  const back = h('div', { class: 'backdrop center' }, box);
  let closed = false;
  const close = (v) => {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose(v);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  closeBtn.onclick = () => close();
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  root.append(back);
  return { el: box, body, foot, close };
}

export function confirmDialog(message, { okText = 'Ya', danger = false, detail = '' } = {}) {
  return new Promise((resolve) => {
    const m = modal({ title: 'Konfirmasi', onClose: (v) => resolve(!!v) });
    m.body.append(h('div', { text: message }), detail ? h('div', { class: 'muted', text: detail }) : '');
    const ok = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, text: okText, onclick: () => m.close(true) });
    m.foot.append(h('button', { class: 'btn', text: 'Batal', onclick: () => m.close(false) }), ok);
    setTimeout(() => ok.focus(), 10);
  });
}

/** Choice dialog: resolves with the chosen button's value (or null when dismissed). */
export function choiceDialog(message, buttons, detail = '') {
  return new Promise((resolve) => {
    let result = null;
    const m = modal({ title: 'XZY IDE', onClose: () => resolve(result) });
    m.body.append(h('div', { text: message }), detail ? h('div', { class: 'muted', text: detail }) : '');
    buttons.forEach((b, i) => {
      const el = h('button', { class: `btn ${b.cls || ''}`, text: b.text, onclick: () => { result = b.value; m.close(); } });
      m.foot.append(el);
      if (i === buttons.length - 1) setTimeout(() => el.focus(), 10);
    });
  });
}

export function promptDialog(title, { value = '', placeholder = '', okText = 'OK' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const m = modal({ title, onClose: () => resolve(result) });
    const input = h('input', { class: 'input', value, placeholder, spellcheck: 'false' });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { result = input.value; m.close(); } });
    m.body.append(input);
    m.foot.append(h('button', { class: 'btn', text: 'Batal', onclick: () => m.close() }),
      h('button', { class: 'btn btn-primary', text: okText, onclick: () => { result = input.value; m.close(); } }));
    setTimeout(() => { input.focus(); input.select(); }, 10);
  });
}

let openMenu = null;
export function contextMenu(x, y, items) {
  if (openMenu) openMenu.remove();
  const menu = h('div', { class: 'ctx-menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') { menu.append(h('div', { class: 'sep' })); continue; }
    menu.append(h('div', { class: 'item', role: 'menuitem', onclick: () => { close(); it.run(); } }, h('span', { text: it.label }), it.key ? h('span', { class: 'k', text: it.key }) : ''));
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 6)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 6)}px`;
  openMenu = menu;
  const close = () => { menu.remove(); if (openMenu === menu) openMenu = null; document.removeEventListener('mousedown', outside, true); };
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  return close;
}

const EXT_COLORS = {
  js: ['#f7df1e', 'JS'], mjs: ['#f7df1e', 'JS'], cjs: ['#f7df1e', 'JS'], jsx: ['#61dafb', 'JX'], ts: ['#3178c6', 'TS'], tsx: ['#3178c6', 'TX'],
  vue: ['#42b883', 'V'], php: ['#8892bf', 'P'], py: ['#3776ab', 'PY'], java: ['#e76f00', 'J'], kt: ['#a97bff', 'K'], go: ['#00add8', 'GO'],
  rs: ['#dea584', 'RS'], c: ['#a8b9cc', 'C'], cpp: ['#00599c', 'C+'], cs: ['#9b4f96', 'C#'], rb: ['#cc342d', 'RB'], swift: ['#f05138', 'SW'],
  html: ['#e34c26', '<>'], css: ['#2965f1', '#'], scss: ['#cf649a', 'S'], json: ['#cbcb41', '{}'], md: ['#9aa4b2', 'M'], yml: ['#cb171e', 'Y'], yaml: ['#cb171e', 'Y'],
  xml: ['#e37933', 'X'], sql: ['#e38c00', 'DB'], sh: ['#89e051', '$'], ps1: ['#5391fe', 'PS'], bat: ['#c1f12e', 'B'], env: ['#ecd53f', 'E'], txt: ['#9aa4b2', 'T'],
  png: ['#a074c4', 'IM'], jpg: ['#a074c4', 'IM'], svg: ['#ffb13b', 'SV'], gradle: ['#02303a', 'G'], lock: ['#9aa4b2', 'L'], dart: ['#0175c2', 'D'],
};
export function fileIcon(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  const [color, label] = EXT_COLORS[ext] || ['#6e6a85', ''];
  return `<span class="file-icon" style="background:${color}">${esc(label)}</span>`;
}

const LANGS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', html: 'html', htm: 'html',
  vue: 'html', css: 'css', scss: 'scss', less: 'less', php: 'php', py: 'python', java: 'java', kt: 'kotlin', kts: 'kotlin', go: 'go', rs: 'rust',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', swift: 'swift', md: 'markdown', yml: 'yaml', yaml: 'yaml', xml: 'xml',
  sql: 'sql', sh: 'shell', bash: 'shell', ps1: 'powershell', bat: 'bat', cmd: 'bat', dockerfile: 'dockerfile', ini: 'ini', env: 'ini', dart: 'dart',
  gradle: 'java', graphql: 'graphql', lua: 'lua', r: 'r', scala: 'scala', toml: 'ini', svg: 'xml', blade: 'php',
};
export function languageFor(name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.blade.php')) return 'php';
  if (lower === 'dockerfile' || lower.endsWith('/dockerfile')) return 'dockerfile';
  return LANGS[lower.split('.').pop()] || 'plaintext';
}

export function basename(p) { return String(p).split(/[\\/]/).pop(); }
export function dirname(p) { const s = String(p).split('/'); s.pop(); return s.join('/') || '.'; }

/** Line-based diff (LCS) for the compact preview in permission cards. */
export function miniDiff(before, after, context = 2, maxLines = 400) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  if (a.length * b.length > 4e6) {
    return [{ t: 'hunk', s: `Berkas besar: ${a.length} -> ${b.length} baris (buka diff lengkap)` }];
  }
  const n = a.length; const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0; let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ t: 'same', s: a[i] }); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { ops.push({ t: 'add', s: b[j] }); j++; }
    else { ops.push({ t: 'del', s: a[i] }); i++; }
  }
  const keep = new Set();
  ops.forEach((o, k) => { if (o.t !== 'same') for (let d = -context; d <= context; d++) keep.add(k + d); });
  const out = [];
  let last = -2;
  ops.forEach((o, k) => {
    if (!keep.has(k)) return;
    if (k !== last + 1) out.push({ t: 'hunk', s: '...' });
    out.push(o);
    last = k;
  });
  return out.slice(0, maxLines);
}

export function renderMarkdown(text) {
  try {
    const html = window.marked.parse(String(text || ''), { gfm: true, breaks: true });
    return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  } catch {
    return esc(text).replace(/\n/g, '<br>');
  }
}
