'use strict';

/**
 * Tools the agent can call. Every path is resolved inside the open workspace folder.
 * Executors are plain Node so they can be unit-tested without Electron.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const IGNORED_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'out', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.gradle', '.idea', 'target', 'bin', 'obj', 'coverage', '.cache']);
const MAX_READ_LINES = 2000;
const MAX_OUTPUT = 30000;

const READ_TOOLS = new Set(['list_dir', 'read_file', 'glob', 'grep', 'todo_write', 'open_preview']);
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);
const EXEC_TOOLS = new Set(['run_command']);
const NET_TOOLS = new Set(['web_fetch']);

function definitions({ planMode = false } = {}) {
  const fn = (name, description, properties = {}, required = []) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  });
  const p = { type: 'string', description: 'Path relatif terhadap folder workspace (atau absolut di dalamnya)' };
  const all = [
    fn('list_dir', 'Daftar isi folder (nama, tipe, ukuran). Folder besar seperti node_modules ditandai tapi tidak dibuka.', { path: { ...p, description: 'Folder (default: root workspace)' } }),
    fn('read_file', `Membaca berkas teks dengan nomor baris (maks ${MAX_READ_LINES} baris per panggilan; gunakan offset/limit untuk berkas panjang).`, {
      path: p,
      offset: { type: 'integer', description: 'Baris awal (1-based)' },
      limit: { type: 'integer', description: 'Jumlah baris' },
    }, ['path']),
    fn('glob', 'Mencari berkas berdasarkan pola glob, mis. "src/**/*.ts" atau "**/*.vue".', { pattern: { type: 'string' } }, ['pattern']),
    fn('grep', 'Mencari teks/regex di isi berkas workspace. Mengembalikan path:baris: isi.', {
      pattern: { type: 'string', description: 'Regex JavaScript' },
      path: { ...p, description: 'Folder/berkas untuk dicari (default: root)' },
      include: { type: 'string', description: 'Filter nama berkas glob, mis. "*.php"' },
      case_insensitive: { type: 'boolean' },
    }, ['pattern']),
    fn('write_file', 'Membuat atau menimpa berkas dengan isi lengkap. Untuk perubahan kecil pada berkas yang ada, gunakan edit_file.', { path: p, content: { type: 'string', description: 'Isi lengkap berkas' } }, ['path', 'content']),
    fn('edit_file', 'Mengganti teks tepat (old_string) dengan new_string di sebuah berkas. old_string harus unik kecuali replace_all=true. Baca berkas dulu sebelum mengedit.', {
      path: p,
      old_string: { type: 'string', description: 'Teks persis yang diganti (termasuk spasi/indentasi)' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    }, ['path', 'old_string', 'new_string']),
    fn('delete_file', 'Menghapus sebuah berkas (bukan folder).', { path: p }, ['path']),
    fn('run_command', 'Menjalankan perintah shell di terminal workspace (Windows: PowerShell). Untuk build, test, git, npm, dll. Jangan untuk server yang berjalan terus (gunakan background=true).', {
      command: { type: 'string' },
      cwd: { ...p, description: 'Folder kerja (default: root workspace)' },
      timeout_seconds: { type: 'integer', description: 'Batas waktu (default 120, maks 1800)' },
      background: { type: 'boolean', description: 'Jalankan di latar belakang (dev server); output awal dikembalikan setelah beberapa detik' },
    }, ['command']),
    fn('todo_write', 'Menyimpan daftar tugas pekerjaan ini (ditampilkan ke pengguna). Kirim daftar lengkap setiap kali ada perubahan status.', {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    }, ['todos']),
    fn('web_fetch', 'Mengambil isi halaman web (teks) dari URL http/https, mis. dokumentasi.', { url: { type: 'string' } }, ['url']),
    fn('open_preview', 'Membuka URL (mis. http://localhost:5173) di panel pratinjau browser IDE agar pengguna bisa melihat hasilnya.', { url: { type: 'string' } }, ['url']),
  ];
  if (planMode) return all.filter((t) => READ_TOOLS.has(t.function.name) || NET_TOOLS.has(t.function.name));
  return all;
}

function category(name) {
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (EXEC_TOOLS.has(name)) return 'exec';
  if (NET_TOOLS.has(name)) return 'net';
  return 'read';
}

function describe(name, args = {}) {
  const pth = args.path ? String(args.path) : '';
  switch (name) {
    case 'list_dir': return `Melihat folder ${pth || '.'}`;
    case 'read_file': return `Membaca ${pth}`;
    case 'glob': return `Mencari berkas ${args.pattern || ''}`;
    case 'grep': return `Mencari "${String(args.pattern || '').slice(0, 40)}"`;
    case 'write_file': return `Menulis ${pth}`;
    case 'edit_file': return `Mengedit ${pth}`;
    case 'delete_file': return `Menghapus ${pth}`;
    case 'run_command': return `Menjalankan: ${String(args.command || '').slice(0, 80)}`;
    case 'todo_write': return 'Memperbarui daftar tugas';
    case 'web_fetch': return `Membuka ${args.url || ''}`;
    case 'open_preview': return `Pratinjau ${args.url || ''}`;
    default: return name;
  }
}

class ToolError extends Error {}

function resolveInside(root, p) {
  if (!root) throw new ToolError('Belum ada folder workspace yang dibuka.');
  const target = path.resolve(root, String(p || '.'));
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolError(`Path di luar workspace tidak diizinkan: ${p}`);
  }
  return target;
}

function relPath(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/') || '.';
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Glob to RegExp: supports **, *, ?, {a,b}. */
function globToRegExp(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) { re += '(?:' + g.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')'; i = end; } else re += '\\{';
    } else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}
function escapeRe(s) { return s.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }

async function* walk(dir, root, limit = { n: 0, max: 20000 }) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (limit.n++ > limit.max) return;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      yield* walk(abs, root, limit);
    } else if (e.isFile()) {
      yield abs;
    }
  }
}

function lineDiffStats(before, after) {
  const a = (before || '').split('\n');
  const b = (after || '').split('\n');
  const setA = new Map();
  a.forEach((l) => setA.set(l, (setA.get(l) || 0) + 1));
  let common = 0;
  for (const l of b) {
    const n = setA.get(l) || 0;
    if (n > 0) { common++; setA.set(l, n - 1); }
  }
  return { added: b.length - common, removed: a.length - common };
}

/**
 * Plan an edit without writing: returns { abs, before, after } (before null for new files).
 */
async function planEdit(root, name, args) {
  const abs = resolveInside(root, args.path);
  const had = await exists(abs);
  const before = had ? await fsp.readFile(abs, 'utf8') : null;
  if (name === 'write_file') {
    if (typeof args.content !== 'string') throw new ToolError('Argumen content wajib berupa teks lengkap berkas.');
    return { abs, before, after: args.content };
  }
  if (name === 'delete_file') {
    if (!had) throw new ToolError(`Berkas tidak ada: ${args.path}`);
    return { abs, before, after: null };
  }
  if (name === 'edit_file') {
    if (!had) throw new ToolError(`Berkas tidak ada: ${args.path}. Gunakan write_file untuk membuat berkas baru.`);
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    if (oldStr === '') throw new ToolError('old_string kosong. Gunakan write_file untuk menulis ulang seluruh berkas.');
    if (oldStr === newStr) throw new ToolError('old_string dan new_string sama, tidak ada perubahan.');
    // Tolerate CRLF files when the model sends LF text
    let content = before;
    const crlf = content.includes('\r\n') && !oldStr.includes('\r\n');
    if (crlf) content = content.replace(/\r\n/g, '\n');
    const count = content.split(oldStr).length - 1;
    if (count === 0) throw new ToolError('old_string tidak ditemukan di berkas. Baca ulang berkas (read_file) dan salin teksnya persis, termasuk indentasi.');
    if (count > 1 && !args.replace_all) throw new ToolError(`old_string muncul ${count} kali. Tambahkan konteks agar unik, atau set replace_all=true.`);
    let after = args.replace_all ? content.split(oldStr).join(newStr) : content.replace(oldStr, () => newStr);
    if (crlf) after = after.replace(/\n/g, '\r\n');
    return { abs, before, after };
  }
  throw new ToolError(`Bukan tool edit: ${name}`);
}

async function applyEdit(plan) {
  if (plan.after === null) {
    await fsp.unlink(plan.abs);
    return;
  }
  await fsp.mkdir(path.dirname(plan.abs), { recursive: true });
  await fsp.writeFile(plan.abs, plan.after, 'utf8');
}

function shellFor(command) {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-lc', command] };
}

function truncateMiddle(s, max) {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + `\n...[${s.length - max} karakter dipotong]...\n` + s.slice(-half);
}

/** Processes started with background=true, so they can be listed/stopped. */
const backgroundProcs = new Map();

function runCommand(root, args, { signal, onOutput = () => {} } = {}) {
  const cwd = resolveInside(root, args.cwd || '.');
  const timeout = Math.min(Math.max(Number(args.timeout_seconds) || 120, 5), 1800) * 1000;
  const { file, args: shellArgs } = shellFor(String(args.command || ''));
  return new Promise((resolve) => {
    let out = '';
    let killed = false;
    const child = spawn(file, shellArgs, { cwd, env: { ...process.env, FORCE_COLOR: '0', CI: process.env.CI || '' }, windowsHide: true });
    const push = (d) => {
      const s = d.toString('utf8');
      out += s;
      if (out.length > MAX_OUTPUT * 4) out = out.slice(-MAX_OUTPUT * 2);
      onOutput(s);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);

    const kill = () => {
      killed = true;
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
      } else {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
    };

    if (args.background) {
      const id = `bg_${child.pid}`;
      backgroundProcs.set(id, { child, command: args.command, kill });
      child.on('exit', () => backgroundProcs.delete(id));
      setTimeout(() => resolve({
        background_id: id,
        pid: child.pid,
        running: child.exitCode === null,
        output: truncateMiddle(stripAnsi(out), 6000),
        note: 'Proses berjalan di latar belakang. Gunakan open_preview untuk melihat hasilnya di browser IDE.',
      }), 6000);
      return;
    }

    const timer = setTimeout(kill, timeout);
    const onAbort = () => kill();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exit_code: -1, error: `Gagal menjalankan perintah: ${e.message}`, output: stripAnsi(out) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        exit_code: code,
        timed_out: killed && !(signal && signal.aborted),
        output: truncateMiddle(stripAnsi(out), MAX_OUTPUT) || '(tanpa output)',
      });
    });
  });
}

function stopBackground() {
  for (const p of backgroundProcs.values()) p.kill();
  backgroundProcs.clear();
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n');
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Run a non-edit tool. Edit tools go through planEdit/applyEdit so the agent can ask
 * for approval with a diff first.
 */
async function execute(root, name, args, ctx = {}) {
  switch (name) {
    case 'list_dir': {
      const abs = resolveInside(root, args.path || '.');
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      const items = [];
      for (const e of entries.slice(0, 500)) {
        if (e.isDirectory()) items.push({ name: e.name + '/', type: 'dir', skipped: IGNORED_DIRS.has(e.name) || undefined });
        else {
          let size = 0;
          try { size = (await fsp.stat(path.join(abs, e.name))).size; } catch { /* ignore */ }
          items.push({ name: e.name, type: 'file', size });
        }
      }
      items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      return { path: relPath(root, abs), entries: items, truncated: entries.length > 500 || undefined };
    }
    case 'read_file': {
      const abs = resolveInside(root, args.path);
      const buf = await fsp.readFile(abs);
      if (isBinary(buf)) return { path: relPath(root, abs), binary: true, size: buf.length, note: 'Berkas biner, isi tidak ditampilkan.' };
      const lines = buf.toString('utf8').split(/\r?\n/);
      const start = Math.max(1, Number(args.offset) || 1);
      const limit = Math.min(Number(args.limit) || MAX_READ_LINES, MAX_READ_LINES);
      const slice = lines.slice(start - 1, start - 1 + limit);
      const width = String(start + slice.length).length;
      const content = slice.map((l, i) => `${String(start + i).padStart(width)}\t${l.length > 2000 ? l.slice(0, 2000) + '...' : l}`).join('\n');
      return {
        path: relPath(root, abs),
        total_lines: lines.length,
        from: start,
        to: start + slice.length - 1,
        content,
        more: start - 1 + slice.length < lines.length ? `Masih ada baris ${start + slice.length}-${lines.length}; panggil lagi dengan offset.` : undefined,
      };
    }
    case 'glob': {
      const re = globToRegExp(args.pattern || '**/*');
      const files = [];
      for await (const f of walk(root, root)) {
        const rel = relPath(root, f);
        if (re.test(rel) || (!String(args.pattern).includes('/') && re.test(path.basename(f)))) {
          files.push(rel);
          if (files.length >= 500) break;
        }
      }
      return { pattern: args.pattern, count: files.length, files };
    }
    case 'grep': {
      let re;
      try { re = new RegExp(String(args.pattern), args.case_insensitive ? 'i' : ''); } catch (e) { throw new ToolError(`Regex tidak valid: ${e.message}`); }
      const base = resolveInside(root, args.path || '.');
      const include = args.include ? globToRegExp(args.include) : null;
      const matches = [];
      let filesSearched = 0;
      const stat = await fsp.stat(base);
      const iter = stat.isFile() ? [base] : walk(base, root);
      for await (const f of iter) {
        if (include && !include.test(path.basename(f))) continue;
        let buf;
        try {
          const st = await fsp.stat(f);
          if (st.size > 2 * 1024 * 1024) continue;
          buf = await fsp.readFile(f);
        } catch { continue; }
        if (isBinary(buf)) continue;
        filesSearched++;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push(`${relPath(root, f)}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
            if (matches.length >= 300) break;
          }
        }
        if (matches.length >= 300) break;
      }
      return { pattern: args.pattern, files_searched: filesSearched, count: matches.length, matches, truncated: matches.length >= 300 || undefined };
    }
    case 'run_command':
      return runCommand(root, args, ctx);
    case 'todo_write': {
      const todos = Array.isArray(args.todos) ? args.todos.filter((t) => t && t.content).map((t) => ({
        content: String(t.content),
        status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending',
      })) : [];
      return { ok: true, todos };
    }
    case 'web_fetch': {
      const url = String(args.url || '');
      if (!/^https?:\/\//i.test(url)) throw new ToolError('URL harus diawali http:// atau https://');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'XZY-IDE/1.0' } });
        const type = res.headers.get('content-type') || '';
        const body = await res.text();
        const text = /html/i.test(type) ? htmlToText(body) : body;
        return { url, status: res.status, content: truncateMiddle(text, 25000) };
      } finally {
        clearTimeout(timer);
      }
    }
    case 'open_preview': {
      const url = String(args.url || '');
      if (!/^https?:\/\//i.test(url)) throw new ToolError('URL harus diawali http:// atau https://');
      return { ok: true, url };
    }
    default:
      throw new ToolError(`Tool tidak dikenal: ${name}`);
  }
}

module.exports = {
  definitions,
  category,
  describe,
  execute,
  planEdit,
  applyEdit,
  lineDiffStats,
  resolveInside,
  relPath,
  globToRegExp,
  walk,
  stopBackground,
  ToolError,
  EDIT_TOOLS,
  IGNORED_DIRS,
};
