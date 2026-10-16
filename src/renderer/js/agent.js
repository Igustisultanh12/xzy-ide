// Agent panel (chat with tools), permission prompts, todos, and the Agent Manager list.

import { api, state, emit, on, command } from './state.js';
import { h, $, icon, esc, toast, errorToast, renderMarkdown, miniDiff, basename, confirmDialog, promptDialog, contextMenu } from './ui.js';
import { showDiff, openFile, currentContext, setModelProvider } from './editor.js';

const MODE_LABEL = { ask: 'Tanya dulu', acceptEdits: 'Terima edit', auto: 'Otomatis', plan: 'Rencana' };
const SUGGESTIONS = [
  'Jelaskan struktur proyek ini dan cara menjalankannya',
  'Temukan dan perbaiki bug di berkas yang sedang terbuka',
  'Tambahkan unit test untuk fungsi utama lalu jalankan',
  'Buat XZY.md berisi panduan proyek untuk agen (/init)',
];

let agents = [];               // summaries
let currentId = null;
let current = null;            // full state of current agent
const pendingPerms = new Map(); // agentId -> Map(requestId -> request)
const itemEls = new Map();      // transcript item id -> element
let attachments = [];           // [{ path }]
let fileIndex = null;
let mention = null;             // { start, items, index }
let renderQueue = new Set();
let statusEl = null;

/* ---------------- list / selection ---------------- */

export async function loadAgents(selectId) {
  if (!state.workspace) return;
  agents = await api.agent.list();
  const id = selectId && agents.some((a) => a.id === selectId) ? selectId : (agents.some((a) => a.id === currentId) ? currentId : agents[0] && agents[0].id);
  renderAgentSelect();
  renderManager();
  if (id) await selectAgent(id);
}

export async function selectAgent(id) {
  currentId = id;
  try {
    current = await api.agent.get(id);
  } catch (e) {
    errorToast(e);
    return;
  }
  renderAgentSelect();
  renderManager();
  renderTranscript();
  renderTodos();
  syncControls();
}

async function newAgent() {
  if (!state.workspace) { toast('Buka folder dulu.'); return; }
  const a = await api.agent.create({ model: current ? current.model : undefined, mode: current ? current.mode : undefined });
  await loadAgents(a.id);
  $('#prompt').focus();
}

function renderAgentSelect() {
  const sel = $('#agent-select');
  sel.innerHTML = '';
  for (const a of agents) {
    const dot = a.status === 'running' ? '● ' : a.status === 'waiting' ? '◐ ' : '';
    sel.append(h('option', { value: a.id, text: `${dot}${a.title}`, selected: a.id === currentId }));
  }
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return new Date(ts).toLocaleDateString('id-ID');
}

function renderManager() {
  const list = $('#agents-list');
  list.innerHTML = '';
  list.append(h('button', { class: 'btn btn-primary btn-sm', html: `${icon('plus')} Agen baru`, onclick: newAgent }));
  for (const a of agents) {
    const done = a.todos.filter((t) => t.status === 'completed').length;
    const card = h('div', { class: `agent-card${a.id === currentId ? ' active' : ''}` },
      h('div', { class: 'row' }, h('span', { class: `dot ${a.status}` }), h('span', { class: 'title', text: a.title })),
      h('div', { class: 'meta' },
        h('span', { text: MODE_LABEL[a.mode] || a.mode }),
        h('span', { text: a.model || 'tanpa model' }),
        h('span', { text: timeAgo(a.updatedAt) }),
        pendingPerms.get(a.id) && pendingPerms.get(a.id).size ? h('span', { style: 'color:var(--warn)', text: 'butuh persetujuan' }) : ''),
      a.todos.length ? h('div', { class: 'progress', title: `${done}/${a.todos.length} tugas` }, h('i', { style: `width:${Math.round((done / a.todos.length) * 100)}%` })) : '');
    card.addEventListener('click', () => { selectAgent(a.id); emit('showAgentPanel'); });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Ganti nama', run: async () => { const t = await promptDialog('Nama agen', { value: a.title }); if (t) { await api.agent.rename(a.id, t); loadAgents(); } } },
        { label: 'Hapus agen', run: () => deleteAgent(a.id) },
      ]);
    });
    list.append(card);
  }
}

async function deleteAgent(id) {
  if (!(await confirmDialog('Hapus sesi agen ini beserta riwayat percakapannya?', { okText: 'Hapus', danger: true }))) return;
  await api.agent.remove(id);
  pendingPerms.delete(id);
  if (id === currentId) currentId = null;
  loadAgents();
}

function syncControls() {
  if (!current) return;
  $('#mode-select').value = current.mode;
  const ms = $('#model-select');
  if (current.model && ![...ms.options].some((o) => o.value === current.model)) ms.append(h('option', { value: current.model, text: current.model }));
  ms.value = current.model || '';
  const busy = current.status === 'running' || current.status === 'waiting';
  $('#send-btn').hidden = busy;
  $('#stop-btn').hidden = !busy;
  const u = current.usage || { prompt: 0, completion: 0 };
  $('#usage').textContent = u.prompt || u.completion ? `${fmt(u.prompt + u.completion)} token` : '';
  $('#sb-model').textContent = current.model ? `${current.model} · ${MODE_LABEL[current.mode]}` : 'Pilih model';
}

function fmt(n) { return new Intl.NumberFormat('id-ID').format(n || 0); }

export function renderModels() {
  const ms = $('#model-select');
  const val = current ? current.model : ms.value;
  ms.innerHTML = '';
  if (!state.models.length) ms.append(h('option', { value: '', text: state.settings && state.settings.hasApiKey ? 'Memuat model...' : 'Isi API key dulu' }));
  for (const m of state.models) ms.append(h('option', { value: m.id, text: m.multiplier ? `${m.id} ×${m.multiplier}` : m.id }));
  if (val && ![...ms.options].some((o) => o.value === val)) ms.append(h('option', { value: val, text: val }));
  ms.value = val || (state.settings && state.settings.defaultModel) || (state.models[0] && state.models[0].id) || '';
  if (current && !current.model && ms.value) api.agent.setModel(current.id, ms.value).then(() => { current.model = ms.value; syncControls(); });
}

/* ---------------- transcript ---------------- */

function renderTodos() {
  const box = $('#todos');
  const todos = (current && current.todos) || [];
  box.hidden = !todos.length;
  box.innerHTML = '';
  if (!todos.length) return;
  const done = todos.filter((t) => t.status === 'completed').length;
  box.append(h('div', { class: 'todo-head' }, h('span', { text: 'DAFTAR TUGAS' }), h('span', { text: `${done}/${todos.length}` })));
  for (const t of todos) box.append(h('div', { class: `todo ${t.status}` }, h('span', { class: 'box', html: t.status === 'completed' ? icon('check') : '' }), h('span', { text: t.content })));
}

function renderTranscript() {
  const tr = $('#transcript');
  tr.innerHTML = '';
  itemEls.clear();
  statusEl = null;
  if (!current) return;
  if (!current.transcript.length) {
    tr.append(emptyState());
  } else {
    for (const item of current.transcript) tr.append(renderItem(item));
  }
  const perms = pendingPerms.get(current.id);
  if (perms) for (const req of perms.values()) tr.append(renderPermission(req));
  updateStatusLine(current.status, '');
  if (current.status === 'idle') maybePlanActions();
  scrollDown(true);
}

function emptyState() {
  const box = h('div', { class: 'agent-empty' },
    h('div', { class: 'welcome-logo', style: 'width:44px;height:44px;font-size:20px', text: 'X' }),
    h('div', { style: 'font-weight:600;color:var(--text)', text: 'Apa yang ingin dikerjakan?' }),
    h('div', { class: 'small', text: 'Agen bisa membaca proyek, menulis kode, menjalankan perintah, dan memverifikasi hasilnya.' }));
  const sug = h('div', { class: 'suggest' });
  for (const s of SUGGESTIONS) sug.append(h('button', { text: s, onclick: () => { $('#prompt').value = s.endsWith('(/init)') ? '/init' : s; $('#prompt').focus(); } }));
  box.append(sug);
  return box;
}

function renderItem(item) {
  let el;
  if (item.kind === 'user') {
    el = h('div', { class: 'msg-user' }, item.text);
    if (item.attachments && item.attachments.length) {
      el.append(h('div', { class: 'att' }, item.attachments.map((p) => h('span', { class: 'chip', text: `@${p}` }))));
    }
  } else if (item.kind === 'assistant') {
    el = h('div', { class: 'msg-assistant', html: renderMarkdown(item.text) });
    decorateCode(el);
  } else if (item.kind === 'tool') {
    el = renderTool(item);
  } else if (item.kind === 'error') {
    el = h('div', { class: 'error-box', text: item.text });
  } else {
    el = h('div', { class: 'notice', text: item.text });
  }
  itemEls.set(item.id, el);
  return el;
}

function decorateCode(el) {
  for (const pre of el.querySelectorAll('pre')) {
    const btn = h('button', { class: 'copy-code', text: 'Salin' });
    btn.onclick = () => { navigator.clipboard.writeText(pre.innerText.replace(/Salin$/, '')); btn.textContent = 'Tersalin'; setTimeout(() => { btn.textContent = 'Salin'; }, 1200); };
    pre.append(btn);
  }
  for (const a of el.querySelectorAll('a[href]')) {
    a.addEventListener('click', (e) => { e.preventDefault(); const href = a.getAttribute('href'); if (/^https?:/i.test(href)) api.openExternal(href); });
  }
}

function renderTool(item) {
  const statusIcon = item.status === 'done' ? icon('check') : item.status === 'error' || item.status === 'denied' ? icon('x') : '';
  let meta = '';
  if (item.diff) meta = `<span class="diffstat"><span class="a">+${item.diff.added}</span> <span class="r">-${item.diff.removed}</span></span>`;
  else if (item.exitCode !== undefined && item.exitCode !== null) meta = `exit ${item.exitCode}`;
  else if (item.preview) meta = esc(item.preview);
  else if (item.error) meta = esc(item.error.slice(0, 60));
  const head = h('div', { class: 'tool-head' }, h('span', { class: 'st', html: statusIcon }), h('span', { class: 'label', text: item.label }), h('span', { class: 'meta', html: meta }));
  const body = h('div', { class: 'tool-body' });
  const el = h('div', { class: `tool ${item.status}` }, head, body);
  const fillBody = () => {
    body.innerHTML = '';
    if (item.args && item.args.command) body.append(h('pre', { text: `$ ${item.args.command}` }));
    if (item.output) body.append(h('pre', { class: 'out', text: item.output }));
    if (item.error && item.status !== 'done') body.append(h('pre', { style: 'color:var(--err)', text: item.error }));
    if (item.diff && item.diff.path) body.append(h('button', { class: 'btn btn-sm', text: `Buka ${item.diff.path}`, onclick: () => openFile(item.diff.path) }));
    if (!body.childNodes.length) body.append(h('pre', { text: JSON.stringify(item.args || {}, null, 2) }));
  };
  head.addEventListener('click', () => { el.classList.toggle('open'); if (el.classList.contains('open')) fillBody(); });
  el._item = item;
  el._fill = fillBody;
  if (item.name === 'run_command' && item.status === 'running') { el.classList.add('open'); fillBody(); }
  return el;
}

function scrollDown(force = false) {
  const tr = $('#transcript');
  const near = tr.scrollHeight - tr.scrollTop - tr.clientHeight < 160;
  if (force || near) requestAnimationFrame(() => { tr.scrollTop = tr.scrollHeight; });
}

function updateStatusLine(status, detail) {
  const tr = $('#transcript');
  if (status === 'running' || status === 'waiting') {
    if (!statusEl) {
      statusEl = h('div', { class: 'status-line' }, h('span', { class: 'spinner' }), h('span', { class: 'shimmer' }));
    }
    statusEl.lastChild.textContent = detail || (status === 'waiting' ? 'Menunggu persetujuan' : 'Berpikir');
    tr.append(statusEl);
  } else if (statusEl) {
    statusEl.remove();
    statusEl = null;
  }
}

function flushRenders() {
  for (const id of renderQueue) {
    const el = itemEls.get(id);
    const item = current && current.transcript.find((t) => t.id === id);
    if (el && item) {
      el.innerHTML = renderMarkdown(item.text);
      el.classList.add('streaming');
      decorateCode(el);
    }
  }
  renderQueue = new Set();
  scrollDown();
}

let flushScheduled = false;
function queueRender(id) {
  renderQueue.add(id);
  if (!flushScheduled) {
    flushScheduled = true;
    requestAnimationFrame(() => { flushScheduled = false; flushRenders(); });
  }
}

/* ---------------- permissions ---------------- */

function renderPermission(req) {
  const card = h('div', { class: 'permission', dataset: { req: req.requestId } });
  const decide = async (decision) => {
    card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await api.agent.permission(req.agentId, req.requestId, decision);
    } catch (e) { errorToast(e); }
  };
  const feedback = h('input', { class: 'input input-sm', placeholder: 'Masukan untuk agen jika ditolak (opsional)', spellcheck: 'false' });
  if (req.category === 'edit') {
    const action = req.after === null ? 'menghapus' : req.before === null ? 'membuat' : 'mengubah';
    card.append(h('div', { class: 'q', html: `Izinkan agen ${action} <code>${esc(req.path)}</code>? <span class="diffstat"><span class="a">+${req.stats.added}</span> <span class="r">-${req.stats.removed}</span></span>` }));
    const diffBox = h('div', { class: 'mini-diff' });
    for (const l of miniDiff(req.before || '', req.after || '', 2, 300)) {
      diffBox.append(h('div', { class: l.t === 'same' ? '' : l.t, text: `${l.t === 'add' ? '+' : l.t === 'del' ? '-' : l.t === 'hunk' ? '' : ' '} ${l.s}` }));
    }
    card.append(diffBox);
    card.append(h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary btn-sm', text: 'Izinkan', onclick: () => decide({ allow: true }) }),
      h('button', { class: 'btn btn-sm', text: 'Izinkan semua edit (sesi ini)', onclick: () => decide({ allow: true, always: true }) }),
      h('button', {
        class: 'btn btn-sm', text: 'Lihat diff', onclick: () => showDiff({
          title: `${req.path} (perubahan dari agen)`, original: req.before || '', modified: req.after || '', path: req.path,
          actions: [{ text: 'Tolak', run: () => decide({ allow: false, feedback: feedback.value }) }, { text: 'Izinkan', cls: 'btn-primary', run: () => decide({ allow: true }) }],
        }),
      }),
      h('button', { class: 'btn btn-danger btn-sm', text: 'Tolak', onclick: () => decide({ allow: false, feedback: feedback.value }) })));
  } else {
    card.append(h('div', { class: 'q', text: 'Izinkan agen menjalankan perintah ini?' }));
    card.append(h('pre', { text: `${req.cwd && req.cwd !== '.' ? `[${req.cwd}] ` : ''}${req.command}` }));
    card.append(h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary btn-sm', text: 'Jalankan', onclick: () => decide({ allow: true }) }),
      h('button', { class: 'btn btn-sm', text: 'Selalu izinkan perintah (sesi ini)', onclick: () => decide({ allow: true, always: true }) }),
      h('button', { class: 'btn btn-danger btn-sm', text: 'Tolak', onclick: () => decide({ allow: false, feedback: feedback.value }) })));
  }
  card.append(feedback);
  return card;
}

function maybePlanActions() {
  if (!current || current.mode !== 'plan' || current.status !== 'idle') return;
  const last = [...current.transcript].reverse().find((t) => t.kind === 'assistant' || t.kind === 'user');
  if (!last || last.kind !== 'assistant' || !last.text.trim()) return;
  const bar = h('div', { class: 'permission' },
    h('div', { class: 'q', text: 'Rencana siap. Jalankan sekarang?' }),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary btn-sm', text: 'Setujui dan jalankan (terima edit)', onclick: () => approvePlan('acceptEdits', bar) }),
      h('button', { class: 'btn btn-sm', text: 'Jalankan (tanya tiap aksi)', onclick: () => approvePlan('ask', bar) }),
      h('button', { class: 'btn btn-sm', text: 'Revisi rencana', onclick: () => { bar.remove(); $('#prompt').focus(); } })));
  $('#transcript').append(bar);
  scrollDown(true);
}

async function approvePlan(mode, bar) {
  bar.remove();
  await api.agent.setMode(current.id, mode);
  current.mode = mode;
  syncControls();
  send('Rencana disetujui. Kerjakan sesuai rencana itu sekarang, perbarui daftar tugas saat bekerja, lalu verifikasi hasilnya.');
}

/* ---------------- events ---------------- */

function onAgentEvent(e) {
  const summary = agents.find((a) => a.id === e.agentId);
  if (e.type === 'permission') {
    if (!pendingPerms.has(e.agentId)) pendingPerms.set(e.agentId, new Map());
    pendingPerms.get(e.agentId).set(e.requestId, e);
    if (e.agentId !== currentId) toast(`Agen "${summary ? summary.title : ''}" butuh persetujuan.`, 'info', 5000);
    notify('Agen butuh persetujuan', e.label);
  }
  if (e.type === 'permission_resolved') {
    const m = pendingPerms.get(e.agentId);
    if (m) m.delete(e.requestId);
  }
  if (summary) {
    if (e.type === 'status') summary.status = e.status;
    if (e.type === 'title') summary.title = e.title;
    if (e.type === 'todos') summary.todos = e.todos;
    if (e.type === 'mode') summary.mode = e.mode;
    if (e.type === 'model') summary.model = e.model;
    if (e.type === 'turn_end' && e.summary) Object.assign(summary, e.summary);
    if (['status', 'title', 'todos', 'turn_end', 'permission', 'permission_resolved', 'mode', 'model'].includes(e.type)) {
      renderManager();
      if (e.type !== 'status' || e.status !== 'running') renderAgentSelect();
    }
  }
  if (e.type === 'turn_end') {
    if (e.agentId !== currentId || !document.hasFocus()) notify('Agen selesai', summary ? summary.title : '');
    emit('agent:turnEnd', e.agentId);
  }
  if (e.type === 'preview') emit('preview:open', e.url);
  if (e.type === 'file_changed') emit('agent:fileChanged', e);

  if (e.agentId !== currentId || !current) return;
  const tr = $('#transcript');
  switch (e.type) {
    case 'transcript': {
      const empty = tr.querySelector('.agent-empty');
      if (empty) empty.remove();
      current.transcript.push(e.item);
      const el = renderItem(e.item);
      if (statusEl && statusEl.parentNode === tr) tr.insertBefore(el, statusEl); else tr.append(el);
      scrollDown(e.item.kind === 'user');
      break;
    }
    case 'transcript_remove': {
      current.transcript = current.transcript.filter((t) => t.id !== e.itemId);
      const el = itemEls.get(e.itemId);
      if (el) el.remove();
      itemEls.delete(e.itemId);
      break;
    }
    case 'text': {
      const item = current.transcript.find((t) => t.id === e.itemId);
      if (item) { item.text += e.delta; queueRender(e.itemId); }
      break;
    }
    case 'text_reset': {
      const item = current.transcript.find((t) => t.id === e.itemId);
      if (item) { item.text = ''; queueRender(e.itemId); }
      break;
    }
    case 'tool_output': {
      const el = itemEls.get(e.itemId);
      if (el && el._item) {
        el._item.output = ((el._item.output || '') + e.chunk).slice(-20000);
        const out = el.querySelector('pre.out');
        if (out) { out.textContent = el._item.output; out.scrollTop = out.scrollHeight; } else if (el.classList.contains('open')) el._fill();
        scrollDown();
      }
      break;
    }
    case 'tool_end': {
      const el = itemEls.get(e.itemId);
      if (el && el._item) {
        Object.assign(el._item, e);
        const fresh = renderTool(el._item);
        if (el.classList.contains('open') || e.status === 'error') { fresh.classList.add('open'); fresh._fill(); }
        el.replaceWith(fresh);
        itemEls.set(e.itemId, fresh);
      }
      break;
    }
    case 'permission': {
      const card = renderPermission(e);
      if (statusEl && statusEl.parentNode === tr) tr.insertBefore(card, statusEl); else tr.append(card);
      scrollDown(true);
      break;
    }
    case 'permission_resolved': {
      const card = tr.querySelector(`[data-req="${e.requestId}"]`);
      if (card) card.remove();
      break;
    }
    case 'status':
      current.status = e.status;
      updateStatusLine(e.status, e.detail);
      syncControls();
      $('#sb-agent').innerHTML = e.status === 'idle' ? '' : `<span class="spinner"></span> ${esc(e.detail || 'Agen bekerja')}`;
      break;
    case 'progress':
      if (statusEl && e.toolChars) statusEl.lastChild.textContent = `Menulis ${e.toolName ? `(${e.toolName}) ` : ''}${(e.toolChars / 1024).toFixed(1)} KB`;
      break;
    case 'todos':
      current.todos = e.todos;
      renderTodos();
      break;
    case 'usage':
      current.usage = e.usage;
      syncControls();
      break;
    case 'notice':
      toast(e.text, 'info', 4000);
      break;
    case 'mode': current.mode = e.mode; syncControls(); break;
    case 'model': current.model = e.model; syncControls(); break;
    case 'title': current.title = e.title; break;
    case 'cleared':
      current.transcript = [];
      current.todos = [];
      renderTranscript();
      renderTodos();
      break;
    case 'turn_end':
      for (const el of tr.querySelectorAll('.streaming')) el.classList.remove('streaming');
      if (e.summary) Object.assign(current, { status: e.summary.status, todos: e.summary.todos, usage: e.summary.usage, canUndo: e.summary.canUndo });
      updateStatusLine('idle');
      syncControls();
      maybePlanActions();
      break;
    default:
  }
}

function notify(title, body) {
  if (document.hasFocus()) return;
  try { new Notification(title, { body: body || '', silent: false }); } catch { /* not allowed */ }
}

/* ---------------- composer ---------------- */

async function ensureFileIndex() {
  if (!fileIndex && state.workspace) {
    try { fileIndex = await api.fs.allFiles(); } catch { fileIndex = []; }
  }
  return fileIndex || [];
}
export function invalidateFileIndex() { fileIndex = null; }

function renderChips() {
  const box = $('#attach-chips');
  box.innerHTML = '';
  for (const a of attachments) {
    const x = h('button', { title: 'Hapus', html: icon('x') });
    x.onclick = () => { attachments = attachments.filter((b) => b !== a); renderChips(); };
    box.append(h('span', { class: 'chip' }, `@${a.path}`, x));
  }
}

export function attachFile(path) {
  if (!attachments.some((a) => a.path === path)) attachments.push({ path });
  renderChips();
  emit('showAgentPanel');
  $('#prompt').focus();
}

export function insertPrompt(text) {
  const ta = $('#prompt');
  ta.value = (ta.value ? ta.value + '\n' : '') + text;
  emit('showAgentPanel');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  autoGrow();
}

function autoGrow() {
  const ta = $('#prompt');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(240, Math.max(64, ta.scrollHeight))}px`;
}

async function updateMention() {
  const ta = $('#prompt');
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const m = before.match(/(^|\s)@([^\s@]*)$/);
  const menu = $('#mention-menu');
  if (!m) { mention = null; menu.hidden = true; return; }
  const q = m[2].toLowerCase();
  const files = await ensureFileIndex();
  const items = files.filter((f) => f.toLowerCase().includes(q)).sort((a, b) => {
    const an = basename(a).toLowerCase().startsWith(q) ? 0 : 1;
    const bn = basename(b).toLowerCase().startsWith(q) ? 0 : 1;
    return an - bn || a.length - b.length;
  }).slice(0, 12);
  if (!items.length) { mention = null; menu.hidden = true; return; }
  mention = { start: pos - m[2].length - 1, items, index: 0 };
  renderMention();
}

function renderMention() {
  const menu = $('#mention-menu');
  menu.innerHTML = '';
  menu.hidden = false;
  mention.items.forEach((f, i) => {
    const el = h('div', { class: `mention-item${i === mention.index ? ' active' : ''}` }, h('span', { text: basename(f) }), h('span', { class: 'p', text: f }));
    el.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(i); });
    menu.append(el);
  });
}

function pickMention(i) {
  const ta = $('#prompt');
  const f = mention.items[i];
  const end = ta.selectionStart;
  ta.value = `${ta.value.slice(0, mention.start)}@${f} ${ta.value.slice(end)}`;
  const caret = mention.start + f.length + 2;
  ta.setSelectionRange(caret, caret);
  attachFile(f);
  mention = null;
  $('#mention-menu').hidden = true;
}

const SLASH = {
  '/clear': 'Bersihkan percakapan agen ini',
  '/undo': 'Batalkan perubahan berkas terakhir dari agen',
  '/plan': 'Ganti ke mode Rencana',
  '/ask': 'Ganti ke mode Tanya dulu',
  '/accept': 'Ganti ke mode Terima edit',
  '/auto': 'Ganti ke mode Otomatis',
  '/init': 'Buat XZY.md (panduan proyek untuk agen)',
  '/new': 'Buat sesi agen baru',
  '/help': 'Tampilkan daftar perintah',
};

async function handleSlash(text) {
  const [cmd] = text.trim().split(/\s+/);
  switch (cmd) {
    case '/clear': await api.agent.clear(current.id); return true;
    case '/undo': runUndo(); return true;
    case '/plan': case '/ask': case '/auto': case '/accept': {
      const mode = { '/plan': 'plan', '/ask': 'ask', '/auto': 'auto', '/accept': 'acceptEdits' }[cmd];
      await api.agent.setMode(current.id, mode);
      current.mode = mode;
      syncControls();
      toast(`Mode: ${MODE_LABEL[mode]}`, 'ok', 1500);
      return true;
    }
    case '/new': newAgent(); return true;
    case '/help':
      toast(Object.entries(SLASH).map(([k, v]) => `${k}  ${v}`).join('\n'), 'info', 9000);
      return true;
    case '/init':
      send('Pelajari proyek ini (struktur folder, bahasa/framework, cara install, build, test, dan konvensi kode), lalu buat berkas XZY.md di root berisi panduan ringkas untuk agen AI yang akan bekerja di proyek ini. Jika XZY.md sudah ada, perbarui.', true);
      return true;
    default:
      return false;
  }
}

async function send(textOverride, skipSlash = false) {
  if (!current) return;
  const ta = $('#prompt');
  const text = (textOverride ?? ta.value).trim();
  if (!text && !attachments.length) return;
  if (!skipSlash && text.startsWith('/') && SLASH[text.split(/\s+/)[0]]) {
    ta.value = '';
    autoGrow();
    await handleSlash(text);
    return;
  }
  if (!state.settings.hasApiKey) { toast('Isi API key TokenomixAI di Pengaturan dulu.', 'error'); emit('openSettings'); return; }
  if (!current.model) { toast('Pilih model dulu di bawah kolom chat.', 'error'); return; }

  const files = [];
  for (const a of attachments) {
    try {
      const r = await api.fs.read(a.path);
      if (r.content !== undefined) files.push({ path: a.path, content: r.content.length > 120000 ? `${r.content.slice(0, 120000)}\n...[dipotong]` : r.content });
    } catch { /* skip */ }
  }
  // Context: the file open in the editor, so "this file" works
  const ctx = currentContext();
  const hint = ctx && !files.some((f) => f.path === ctx.path) ? `[Konteks IDE: berkas yang sedang dibuka di editor adalah ${ctx.path}${ctx.selection ? `, baris ${ctx.startLine}-${ctx.endLine} sedang dipilih` : ''}]` : '';

  if (textOverride === undefined) { ta.value = ''; autoGrow(); }
  attachments = [];
  renderChips();
  try {
    await api.agent.send(current.id, text, files, hint);
    current.status = 'running';
    syncControls();
  } catch (e) {
    errorToast(e);
  }
}

async function runUndo() {
  if (!current) return;
  if (!(await confirmDialog('Kembalikan berkas yang diubah agen pada giliran terakhir?', { okText: 'Kembalikan' }))) return;
  try {
    const r = await api.agent.undo(current.id);
    toast(r.reverted.length ? `${r.reverted.length} berkas dikembalikan` : 'Tidak ada perubahan untuk dibatalkan.', r.reverted.length ? 'ok' : 'info');
  } catch (e) { errorToast(e); }
}

export function initAgentPanel() {
  api.agent.onEvent(onAgentEvent);
  setModelProvider(() => (current && current.model) || (state.settings && state.settings.defaultModel) || '');

  const ta = $('#prompt');
  ta.addEventListener('keydown', (e) => {
    if (mention) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mention.index = (mention.index + 1) % mention.items.length; renderMention(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mention.index = (mention.index - 1 + mention.items.length) % mention.items.length; renderMention(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mention.index); return; }
      if (e.key === 'Escape') { mention = null; $('#mention-menu').hidden = true; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  ta.addEventListener('input', () => { autoGrow(); updateMention(); });
  ta.addEventListener('blur', () => setTimeout(() => { mention = null; $('#mention-menu').hidden = true; }, 150));
  ta.addEventListener('focus', () => ensureFileIndex());

  const composer = $('#composer');
  composer.addEventListener('dragover', (e) => { e.preventDefault(); composer.style.outline = '2px dashed var(--accent)'; });
  composer.addEventListener('dragleave', () => { composer.style.outline = ''; });
  composer.addEventListener('drop', (e) => {
    e.preventDefault();
    composer.style.outline = '';
    const p = e.dataTransfer.getData('text/xzy-path');
    if (p) { attachFile(p); return; }
    for (const f of e.dataTransfer.files) {
      const abs = api.fs.pathForFile(f);
      const root = state.workspace ? state.workspace.root : '';
      if (abs && root && abs.toLowerCase().startsWith(root.toLowerCase())) attachFile(abs.slice(root.length + 1).replace(/\\/g, '/'));
      else toast('Hanya berkas di dalam folder workspace yang bisa dilampirkan.', 'error');
    }
  });

  $('#send-btn').addEventListener('click', () => send());
  $('#stop-btn').addEventListener('click', () => current && api.agent.stop(current.id));
  $('#agent-select').addEventListener('change', (e) => selectAgent(e.target.value));
  $('#mode-select').addEventListener('change', async (e) => {
    if (!current) return;
    await api.agent.setMode(current.id, e.target.value);
    current.mode = e.target.value;
    syncControls();
  });
  $('#model-select').addEventListener('change', async (e) => {
    if (!current) return;
    await api.agent.setModel(current.id, e.target.value);
    current.model = e.target.value;
    syncControls();
  });

  on('agent:insert', (text) => insertPrompt(text));
  on('agent:attach', (p) => attachFile(p));

  command('newAgent', 'Agen: sesi baru', () => newAgent(), 'Ctrl+Shift+N');
  command('agentUndo', 'Agen: batalkan perubahan terakhir', () => runUndo());
  command('agentClear', 'Agen: bersihkan percakapan', async () => {
    if (current && (await confirmDialog('Bersihkan percakapan agen ini?', { okText: 'Bersihkan' }))) api.agent.clear(current.id);
  });
  command('agentStop', 'Agen: berhenti', () => current && api.agent.stop(current.id), 'Esc');
  command('focusAgent', 'Agen: fokus ke chat', () => { emit('showAgentPanel'); ta.focus(); }, 'Ctrl+L');
  command('modeAsk', 'Agen: mode Tanya dulu', () => handleSlash('/ask'));
  command('modeAccept', 'Agen: mode Terima edit', () => handleSlash('/accept'));
  command('modeAuto', 'Agen: mode Otomatis', () => handleSlash('/auto'));
  command('modePlan', 'Agen: mode Rencana', () => handleSlash('/plan'));
  command('agentInit', 'Agen: buat XZY.md (/init)', () => handleSlash('/init'));
}

export function resetAgentPanel() {
  agents = [];
  current = null;
  currentId = null;
  pendingPerms.clear();
  fileIndex = null;
  $('#transcript').innerHTML = '';
  $('#todos').hidden = true;
  $('#agents-list').innerHTML = '';
  $('#agent-select').innerHTML = '';
}
