'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, safeStorage, Menu, nativeTheme } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const { Settings } = require('./settings');
const { TokenomixClient } = require('./llm');
const { Agent } = require('./agent');
const tools = require('./tools');
const git = require('./git');
const { TerminalManager } = require('./terminal');

const APP_ROOT = path.join(__dirname, '..', '..');
const isE2E = process.env.XZY_E2E === '1';

if (process.env.XZY_USER_DATA) app.setPath('userData', process.env.XZY_USER_DATA);
app.setAppUserModelId('id.xzyku.ide');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

let win = null;
let settings = null;
let workspaceRoot = '';
let watcher = null;
const agents = new Map();
let terminals = null;
let saveTimer = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function client() {
  return new TokenomixClient({
    apiKey: settings.get('apiKey'),
    baseUrl: settings.get('baseUrl'),
    maxTokens: Number(settings.get('maxTokens')) || 16384,
  });
}

/* ---------------- sessions per workspace ---------------- */

function sessionsFile(root) {
  const hash = crypto.createHash('sha1').update(String(root).toLowerCase()).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'sessions', `${hash}.json`);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSessions, 800);
}

function saveSessions() {
  if (!workspaceRoot) return;
  try {
    const file = sessionsFile(workspaceRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = [...agents.values()].map((a) => a.serialize());
    fs.writeFileSync(file, JSON.stringify({ root: workspaceRoot, agents: data }));
  } catch (e) {
    console.error('save sessions failed', e);
  }
}

function attachAgent(agent) {
  agent.on('event', (e) => {
    send('agent:event', e);
    if (['turn_end', 'title', 'mode', 'model', 'cleared', 'todos'].includes(e.type)) scheduleSave();
    if (e.type === 'file_changed') send('fs:changed', { paths: [e.path], byAgent: true });
  });
  agents.set(agent.id, agent);
  return agent;
}

function newAgent(opts = {}) {
  return attachAgent(new Agent({
    model: opts.model || settings.get('defaultModel'),
    mode: opts.mode || settings.get('defaultMode'),
    title: opts.title,
    getRoot: () => workspaceRoot,
    getClient: client,
    getSettings: () => settings.all(),
  }));
}

function loadSessions(root) {
  for (const a of agents.values()) a.stop();
  agents.clear();
  try {
    const data = JSON.parse(fs.readFileSync(sessionsFile(root), 'utf8'));
    for (const s of data.agents || []) {
      const a = new Agent({ id: s.id, getRoot: () => workspaceRoot, getClient: client, getSettings: () => settings.all() });
      attachAgent(a.restore(s));
    }
  } catch { /* none yet */ }
  if (agents.size === 0) newAgent();
}

/* ---------------- workspace ---------------- */

async function openWorkspace(folder) {
  const abs = path.resolve(folder);
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) throw new Error('Bukan folder.');
  if (workspaceRoot) saveSessions();
  workspaceRoot = abs;
  settings.addRecent(abs);
  loadSessions(abs);
  startWatcher(abs);
  if (win) win.setTitle(`${path.basename(abs)} - XZY IDE`);
  return { root: abs, name: path.basename(abs) };
}

function startWatcher(root) {
  if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
  watcher = null;
  const pending = new Set();
  let timer = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (_ev, file) => {
      if (!file) return;
      const top = String(file).split(/[\\/]/)[0];
      if (tools.IGNORED_DIRS.has(top) && top !== '.git') return;
      if (String(file).startsWith('.git')) return;
      pending.add(path.join(root, String(file)));
      clearTimeout(timer);
      timer = setTimeout(() => {
        send('fs:changed', { paths: [...pending] });
        pending.clear();
      }, 300);
    });
    watcher.on('error', () => {});
  } catch { /* recursive watch unsupported (Linux older Node): UI refreshes manually */ }
}

function inside(rel) {
  return tools.resolveInside(workspaceRoot, rel);
}

/* ---------------- IPC ---------------- */

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    terminalMode: terminals.mode,
    e2e: isE2E,
    userData: app.getPath('userData'),
  }));

  handle('settings:get', () => settings.public());
  handle('settings:set', (patch) => {
    const r = settings.set(patch);
    nativeTheme.themeSource = r.theme === 'light' ? 'light' : 'dark';
    return r;
  });
  handle('settings:test', async (patch = {}) => {
    const c = new TokenomixClient({
      apiKey: patch.apiKey && !patch.apiKey.includes('...') ? patch.apiKey : settings.get('apiKey'),
      baseUrl: patch.baseUrl || settings.get('baseUrl'),
    });
    const models = await c.listModels();
    return { count: models.length, sample: models.slice(0, 5).map((m) => m.id) };
  });
  handle('models:list', () => client().listModels());

  handle('workspace:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Buka folder' });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });
  handle('workspace:open', (folder) => openWorkspace(folder));
  handle('workspace:current', () => (workspaceRoot ? { root: workspaceRoot, name: path.basename(workspaceRoot) } : null));
  handle('workspace:close', () => {
    saveSessions();
    for (const a of agents.values()) a.stop();
    agents.clear();
    workspaceRoot = '';
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
    if (win) win.setTitle('XZY IDE');
    return true;
  });

  handle('fs:list', async (rel = '.') => {
    const abs = inside(rel);
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => e.name !== '.git')
      .map((e) => ({ name: e.name, path: tools.relPath(workspaceRoot, path.join(abs, e.name)), dir: e.isDirectory(), ignored: e.isDirectory() && tools.IGNORED_DIRS.has(e.name) }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1));
  });
  handle('fs:read', async (rel) => {
    const abs = inside(rel);
    const st = await fsp.stat(abs);
    if (st.size > 15 * 1024 * 1024) return { tooLarge: true, size: st.size };
    const buf = await fsp.readFile(abs);
    const sample = buf.subarray(0, 8000);
    if (sample.includes(0)) return { binary: true, size: st.size };
    return { content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs };
  });
  handle('fs:write', async (rel, content) => {
    const abs = inside(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
    return true;
  });
  handle('fs:create', async (rel, isDir) => {
    const abs = inside(rel);
    if (fs.existsSync(abs)) throw new Error('Sudah ada berkas/folder dengan nama itu.');
    if (isDir) await fsp.mkdir(abs, { recursive: true });
    else {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, '', 'utf8');
    }
    return tools.relPath(workspaceRoot, abs);
  });
  handle('fs:rename', async (from, to) => {
    const a = inside(from);
    const b = inside(to);
    if (fs.existsSync(b)) throw new Error('Nama tujuan sudah dipakai.');
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.rename(a, b);
    return tools.relPath(workspaceRoot, b);
  });
  handle('fs:delete', async (rel) => {
    const abs = inside(rel);
    try { await shell.trashItem(abs); } catch { await fsp.rm(abs, { recursive: true, force: true }); }
    return true;
  });
  handle('fs:allFiles', async () => {
    const files = [];
    for await (const f of tools.walk(workspaceRoot, workspaceRoot, { n: 0, max: 50000 })) {
      files.push(tools.relPath(workspaceRoot, f));
      if (files.length >= 20000) break;
    }
    return files;
  });
  handle('fs:search', async (query, opts = {}) => {
    if (!query) return { matches: [] };
    const pattern = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return tools.execute(workspaceRoot, 'grep', { pattern: opts.wholeWord ? `\\b${pattern}\\b` : pattern, case_insensitive: !opts.matchCase, include: opts.include || undefined });
  });
  handle('fs:reveal', (rel) => { shell.showItemInFolder(inside(rel)); return true; });
  handle('shell:open', (url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('URL tidak valid');
    return shell.openExternal(url);
  });

  handle('term:create', (id, opts = {}) => terminals.create(id, { ...opts, cwd: workspaceRoot }));
  ipcMain.on('term:write', (_e, id, data) => terminals.write(id, data));
  ipcMain.on('term:resize', (_e, id, cols, rows) => terminals.resize(id, cols, rows));
  handle('term:kill', (id) => { terminals.kill(id); return true; });

  const agentOr404 = (id) => {
    const a = agents.get(id);
    if (!a) throw new Error('Sesi agen tidak ditemukan.');
    return a;
  };
  handle('agent:list', () => [...agents.values()].map((a) => a.summary()).sort((x, y) => y.updatedAt - x.updatedAt));
  handle('agent:create', (opts) => newAgent(opts).state());
  handle('agent:get', (id) => agentOr404(id).state());
  handle('agent:send', (id, text, attachments, context) => {
    const a = agentOr404(id);
    a.run(text, { attachments: attachments || [], context: context || '' }).catch((e) => send('agent:event', { agentId: id, type: 'transcript', item: a.addTranscript({ kind: 'error', text: e.message }) }));
    return true;
  });
  handle('agent:stop', (id) => { agentOr404(id).stop(); return true; });
  handle('agent:permission', (id, requestId, decision) => agentOr404(id).respondPermission(requestId, decision));
  handle('agent:setMode', (id, mode) => { agentOr404(id).setMode(mode); scheduleSave(); return true; });
  handle('agent:setModel', (id, model) => { agentOr404(id).setModel(model); scheduleSave(); return true; });
  handle('agent:rename', (id, title) => { const a = agentOr404(id); a.title = String(title).slice(0, 80); a.emitEvent('title', { title: a.title }); return true; });
  handle('agent:undo', (id) => agentOr404(id).undoLast());
  handle('agent:clear', (id) => { agentOr404(id).clear(); return true; });
  handle('agent:delete', (id) => {
    const a = agentOr404(id);
    a.stop();
    agents.delete(id);
    if (agents.size === 0) newAgent();
    scheduleSave();
    return true;
  });

  handle('ai:inlineEdit', async ({ model, path: rel, language, before, selection, after, instruction }) => {
    const m = model || settings.get('defaultModel');
    if (!m) throw new Error('Pilih model terlebih dahulu.');
    const prompt = [
      `Berkas: ${rel} (bahasa: ${language}).`,
      'Ubah KODE TERPILIH sesuai instruksi. Balas HANYA dengan kode pengganti untuk bagian terpilih, tanpa penjelasan dan tanpa pagar ```.',
      `Instruksi: ${instruction}`,
      `--- KODE SEBELUM (konteks) ---\n${String(before || '').slice(-4000)}`,
      `--- KODE TERPILIH ---\n${selection || '(kosong: sisipkan kode baru di posisi kursor)'}`,
      `--- KODE SESUDAH (konteks) ---\n${String(after || '').slice(0, 4000)}`,
    ].join('\n\n');
    let out = await client().complete(m, [
      { role: 'system', content: 'Kamu asisten edit kode inline. Keluarkan kode saja.' },
      { role: 'user', content: prompt },
    ]);
    out = out.replace(/^\s*```[\w-]*\n/, '').replace(/\n```\s*$/, '');
    return out;
  });

  handle('git:status', () => git.status(workspaceRoot));
  handle('git:headFile', (rel) => git.fileAtHead(workspaceRoot, rel));
  handle('git:commit', (message, all) => git.commit(workspaceRoot, message, { all: all !== false }));
  handle('git:run', (args) => git.run(workspaceRoot, args));

  handle('dialog:confirm', async (message, detail) => {
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Ya', 'Batal'], defaultId: 0, cancelId: 1, message, detail });
    return r.response === 0;
  });
}

/* ---------------- window ---------------- */

function buildMenu() {
  const template = [
    {
      label: 'Berkas',
      submenu: [
        { label: 'Buka Folder...', accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'openFolder') },
        { label: 'Simpan', accelerator: 'CmdOrCtrl+S', click: () => send('menu', 'save') },
        { label: 'Pengaturan', accelerator: 'CmdOrCtrl+,', click: () => send('menu', 'settings') },
        { type: 'separator' },
        { role: 'quit', label: 'Keluar' },
      ],
    },
    { role: 'editMenu', label: 'Edit' },
    {
      label: 'Tampilan',
      submenu: [
        { label: 'Palet Perintah', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('menu', 'palette') },
        { label: 'Terminal', accelerator: 'Ctrl+`', click: () => send('menu', 'terminal') },
        { type: 'separator' },
        { role: 'reload', label: 'Muat Ulang' },
        { role: 'toggleDevTools', label: 'Developer Tools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { role: 'togglefullscreen', label: 'Layar Penuh' },
      ],
    },
    {
      label: 'Bantuan',
      submenu: [
        { label: 'Dokumentasi TokenomixAI', click: () => shell.openExternal('https://tokenomixai.com/docs') },
        { label: 'Tentang XZY IDE', click: () => dialog.showMessageBox(win, { message: `XZY IDE ${app.getVersion()}`, detail: 'Editor kode agentik dengan agen dari TokenomixAI.' }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    title: 'XZY IDE',
    backgroundColor: settings.get('theme') === 'light' ? '#f7f7fb' : '#0d0d12',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  win.loadURL('app://xzy/src/renderer/index.html');
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  settings = new Settings(app.getPath('userData'), safeStorage);
  nativeTheme.themeSource = settings.get('theme') === 'light' ? 'light' : 'dark';
  terminals = new TerminalManager(send);

  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const abs = path.normalize(path.join(APP_ROOT, rel));
    if (!abs.startsWith(APP_ROOT)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fsp.readFile(abs);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  registerIpc();
  buildMenu();
  createWindow();

  const startFolder = process.env.XZY_OPEN_FOLDER || (isE2E ? '' : settings.get('lastFolder'));
  if (startFolder && fs.existsSync(startFolder)) {
    try { await openWorkspace(startFolder); } catch { /* show welcome */ }
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => {
  saveSessions();
  for (const a of agents.values()) a.stop();
  if (terminals) terminals.killAll();
  tools.stopBackground();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Unused import guard for bundlers
void net; void pathToFileURL;
