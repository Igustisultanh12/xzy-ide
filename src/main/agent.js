'use strict';

/**
 * One agent session: conversation with a TokenomixAI model that can read and change the
 * workspace through tools. Emits 'event' objects that the UI renders live.
 *
 * Permission modes (like Claude Code):
 *   ask         - ask before every file change and every command
 *   acceptEdits - apply file changes directly, ask before commands
 *   auto        - do everything without asking
 *   plan        - read-only: investigate and write a plan, no changes
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const tools = require('./tools');
const { LlmError } = require('./llm');

const MODES = ['ask', 'acceptEdits', 'auto', 'plan'];
const OLD_RESULT_CHARS = 3000;
const MAX_RESULT_CHARS = 40000;
const MEMORY_FILES = ['XZY.md', 'AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'];

let seq = 0;
const newId = (p) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

class Agent extends EventEmitter {
  constructor({ id, title, model, mode = 'ask', getRoot, getClient, getSettings, getGitHub, getEnvInfo }) {
    super();
    this.id = id || newId('agent');
    this.title = title || 'Agen baru';
    this.model = model || '';
    this.mode = MODES.includes(mode) ? mode : 'ask';
    this.getRoot = getRoot;
    this.getClient = getClient;
    this.getSettings = getSettings || (() => ({}));
    this.getGitHub = getGitHub || (() => null);
    this.getEnvInfo = getEnvInfo || (async () => ({}));
    this.envInfo = {};
    this.messages = [];        // OpenAI-format history (without system prompt)
    this.transcript = [];      // UI items, so a session can be shown again later
    this.todos = [];
    this.checkpoints = [];     // [{ id, files: { absPath: originalContent|null } }]
    this.status = 'idle';
    this.usage = { prompt: 0, completion: 0 };
    this.pending = new Map();  // permission requestId -> resolve
    this.alwaysAllow = { edit: false, exec: false, publish: false };
    this.abort = null;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  emitEvent(type, data = {}) {
    this.updatedAt = Date.now();
    this.emit('event', { agentId: this.id, type, ...data });
  }

  setStatus(status, detail = '') {
    this.status = status;
    this.emitEvent('status', { status, detail });
  }

  summary() {
    return {
      id: this.id,
      title: this.title,
      model: this.model,
      mode: this.mode,
      status: this.status,
      todos: this.todos,
      usage: this.usage,
      updatedAt: this.updatedAt,
      createdAt: this.createdAt,
      canUndo: this.checkpoints.length > 0,
    };
  }

  state() {
    return { ...this.summary(), transcript: this.transcript };
  }

  serialize() {
    return {
      id: this.id, title: this.title, model: this.model, mode: this.mode,
      messages: this.messages, transcript: this.transcript.slice(-400), todos: this.todos,
      usage: this.usage, createdAt: this.createdAt, updatedAt: this.updatedAt,
    };
  }

  restore(data) {
    Object.assign(this, {
      title: data.title || this.title,
      model: data.model || this.model,
      mode: MODES.includes(data.mode) ? data.mode : this.mode,
      messages: Array.isArray(data.messages) ? data.messages : [],
      transcript: Array.isArray(data.transcript) ? data.transcript : [],
      todos: Array.isArray(data.todos) ? data.todos : [],
      usage: data.usage || this.usage,
      createdAt: data.createdAt || this.createdAt,
      updatedAt: data.updatedAt || this.updatedAt,
    });
    // A run cannot survive a restart: close dangling tool calls
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant' && last.tool_calls) {
      for (const c of last.tool_calls) this.messages.push({ role: 'tool', tool_call_id: c.id, content: '(dibatalkan: aplikasi ditutup)' });
    }
    return this;
  }

  setMode(mode) {
    if (MODES.includes(mode)) {
      this.mode = mode;
      this.emitEvent('mode', { mode });
    }
  }

  setModel(model) {
    this.model = model;
    this.emitEvent('model', { model });
  }

  systemPrompt() {
    const root = this.getRoot();
    const s = this.getSettings();
    let memory = '';
    if (root) {
      for (const f of MEMORY_FILES) {
        try {
          const txt = fs.readFileSync(path.join(root, f), 'utf8');
          memory += `\n\n### Instruksi proyek dari ${f}\n${txt.slice(0, 12000)}`;
        } catch { /* not present */ }
      }
    }
    const isWin = process.platform === 'win32';
    const modeText = {
      ask: 'Mode izin: TANYA. Setiap perubahan berkas dan perintah akan dimintakan persetujuan pengguna (mereka melihat diff). Jika ditolak, ikuti masukan mereka.',
      acceptEdits: 'Mode izin: TERIMA EDIT. Perubahan berkas langsung diterapkan; perintah terminal dimintakan persetujuan.',
      auto: 'Mode izin: OTOMATIS. Semua aksi langsung dijalankan. Tetap hati-hati dengan perintah yang merusak (hapus massal, force push, format disk) - jangan jalankan tanpa diminta jelas.',
      plan: 'Mode RENCANA: hanya boleh membaca dan menyelidiki (tool baca saja). JANGAN mengubah berkas atau menjalankan perintah. Selidiki kode, lalu tulis rencana implementasi yang jelas dalam markdown (berkas yang diubah, langkah-langkah, risiko, cara verifikasi). Akhiri dengan meminta pengguna menyetujui rencana.',
    }[this.mode];

    return [
      'Kamu adalah XZY Agent, asisten pemrograman agentik di dalam XZY IDE (editor desktop untuk Windows). Kamu bekerja langsung pada folder workspace pengguna dengan tool: membaca, mencari, menulis/mengedit berkas, dan menjalankan perintah terminal.',
      `Workspace: ${root || '(belum ada folder dibuka)'}`,
      `Sistem: ${isWin ? 'Windows' : os.platform()} ${os.release()}, shell untuk run_command: ${isWin ? 'PowerShell (gunakan sintaks PowerShell, mis. `;` bukan `&&` pada PowerShell 5)' : 'bash'}. Tanggal: ${new Date().toISOString().slice(0, 10)}.`,
      modeText,
      '',
      'Cara kerja:',
      '- Jawab dalam bahasa yang dipakai pengguna. Ringkas dan langsung; tanpa emoji.',
      '- Pahami dulu: gunakan list_dir, glob, grep, read_file sebelum mengubah kode. Jangan mengarang isi berkas.',
      '- Untuk pekerjaan beberapa langkah, buat daftar tugas dengan todo_write dan perbarui statusnya saat bekerja (satu tugas in_progress pada satu waktu).',
      '- Untuk mengubah berkas yang ada gunakan edit_file (old_string persis dari read_file). Gunakan write_file untuk berkas baru atau penulisan ulang total. Pertahankan gaya kode yang ada.',
      '- Setelah mengubah kode, verifikasi: jalankan build/test/lint yang relevan dengan run_command dan perbaiki error sampai bersih.',
      '- Untuk dev server gunakan run_command dengan background=true, lalu open_preview ke URL-nya.',
      '- Hasil setiap tool dikirim kepadamu tepat setelah panggilannya; gunakan hasil itu. Jika error, baca pesannya dan perbaiki pendekatanmu.',
      '- Jangan pernah mengaku sudah melakukan sesuatu tanpa hasil tool yang sukses. Di akhir, ringkas apa yang diubah (berkas) dan cara mencobanya.',
      '',
      'Menjalankan kode (PHP, Java, Python, Node, Go, Rust, C/C++, .NET, Kotlin, Dart, dll):',
      `- ${this.envInfo.toolchain || 'Gunakan check_toolchain untuk melihat runtime yang terpasang.'}`,
      '- Gunakan run_configs untuk tahu cara menjalankan proyek, lalu jalankan dengan run_command (dev server: background=true lalu open_preview).',
      '- Jika runtime yang dibutuhkan belum terpasang, pasang dengan winget (mis. `winget install --id Microsoft.OpenJDK.21 -e --accept-source-agreements --accept-package-agreements`), lalu lanjutkan; PATH baru otomatis terbaca. Untuk PHP di Windows tanpa winget, jelaskan langkah dari windows.php.net bila pemasangan gagal.',
      '',
      'GitHub (push, Actions, release):',
      `- ${this.envInfo.github || 'Token GitHub: gunakan github_repo_info untuk memeriksa.'}`,
      '- Untuk menyimpan ke GitHub SELALU gunakan github_push / github_pull (memakai token dari Pengaturan XZY IDE). JANGAN menjalankan git push/pull/commit lewat run_command: itu memakai kredensial Windows yang berbeda dan sering tidak punya izin workflow. Jika repo git berada di subfolder workspace, isi parameter path (mis. path: "ai"). Buat repo baru dengan github_create_repo hanya bila belum ada.',
      '- Jika github_push gagal karena izin token (mis. scope workflow), JANGAN mencoba ulang atau mencari jalan memutar (git CLI, menghapus berkas workflow, reset commit). Berhenti, kutip pesan error-nya apa adanya (termasuk scope token saat ini), dan minta pengguna memperbarui token di Pengaturan XZY IDE.',
      '- Pantau GitHub Actions sampai benar-benar selesai: setelah github_push, jika repo punya .github/workflows, panggil github_wait_workflow dengan head_sha = commit_sha. Jika conclusion "failure": github_workflow_logs untuk run yang gagal, baca berkas terkait, perbaiki akar masalahnya, uji lokal bila bisa, github_push lagi, lalu tunggu lagi. Ulangi sampai success. Jika "still_running", panggil github_wait_workflow lagi dengan run_id.',
      '- Jika diminta membuat build/rilis otomatis tapi belum ada workflow, buat .github/workflows/<nama>.yml yang sesuai jenis proyek (mis. build APK/EXE/JAR, test), push, lalu pantau sampai hijau.',
      '- Rilis: jika workflow tidak membuat release sendiri, gunakan github_create_release (tag versi, catatan rilis, unggah berkas hasil build bila ada). Laporkan link release dan unduhan.',
      '- Gunakan github_rerun_workflow hanya untuk kegagalan sementara (jaringan/runner). Jika error yang sama muncul 3 kali berturut-turut atau penyebabnya di luar kode (secret belum diisi, izin token, kuota Actions), berhenti dan jelaskan apa yang perlu dilakukan pengguna.',
      s.customInstructions ? `\nInstruksi tambahan pengguna:\n${s.customInstructions}` : '',
      memory,
    ].filter(Boolean).join('\n');
  }

  /** Shrink old tool results and old file-writing arguments to save tokens. */
  compactMessages(messages, keepRecent = 4) {
    const toolIdx = [];
    messages.forEach((m, i) => { if (m.role === 'tool') toolIdx.push(i); });
    const old = new Set(toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent)));
    const lastAssistantWithTools = messages.map((m, i) => (m.role === 'assistant' && m.tool_calls ? i : -1)).filter((i) => i >= 0).pop();
    return messages.map((m, i) => {
      if (old.has(i) && typeof m.content === 'string' && m.content.length > OLD_RESULT_CHARS) {
        return { ...m, content: m.content.slice(0, OLD_RESULT_CHARS) + '\n...[hasil lama diringkas; panggil tool lagi bila perlu]' };
      }
      if (m.role === 'assistant' && m.tool_calls && i !== lastAssistantWithTools) {
        return {
          ...m,
          tool_calls: m.tool_calls.map((c) => {
            const a = c.function.arguments || '';
            if (a.length <= OLD_RESULT_CHARS) return c;
            try {
              const o = JSON.parse(a);
              if (typeof o.content === 'string') o.content = `[isi berkas ${o.content.length} karakter sudah ditulis]`;
              if (typeof o.new_string === 'string' && o.new_string.length > 1500) o.new_string = o.new_string.slice(0, 1500) + '...';
              if (typeof o.old_string === 'string' && o.old_string.length > 1500) o.old_string = o.old_string.slice(0, 1500) + '...';
              return { ...c, function: { ...c.function, arguments: JSON.stringify(o) } };
            } catch {
              return { ...c, function: { ...c.function, arguments: '{}' } };
            }
          }),
        };
      }
      return m;
    });
  }

  addTranscript(item) {
    const entry = { id: newId('t'), at: Date.now(), ...item };
    this.transcript.push(entry);
    return entry;
  }

  async run(userText, { attachments = [], context = '' } = {}) {
    if (this.status === 'running' || this.status === 'waiting') throw new Error('Agen masih bekerja. Tunggu atau tekan Berhenti.');
    const client = this.getClient();
    if (!this.model) throw new Error('Pilih model terlebih dahulu.');

    let content = String(userText || '').trim();
    if (context) content += `\n\n${context}`;
    if (attachments.length) {
      content += '\n\n' + attachments.map((a) => `<berkas path="${a.path}">\n${a.content}\n</berkas>`).join('\n\n');
    }
    if (!content) return;

    if (this.messages.length === 0 && (this.title === 'Agen baru' || !this.title)) {
      this.title = String(userText).replace(/\s+/g, ' ').trim().slice(0, 48) || 'Agen baru';
      this.emitEvent('title', { title: this.title });
    }

    this.messages.push({ role: 'user', content });
    const userItem = this.addTranscript({ kind: 'user', text: String(userText), attachments: attachments.map((a) => a.path) });
    this.emitEvent('transcript', { item: userItem });

    const checkpoint = { id: newId('cp'), files: {} };
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const settings = this.getSettings();
    const maxSteps = Math.max(5, Number(settings.maxSteps) || 200);
    try {
      this.envInfo = (await Promise.race([this.getEnvInfo(), new Promise((r) => setTimeout(() => r({}), 12000))])) || {};
    } catch { this.envInfo = {}; }
    this.setStatus('running', 'Berpikir');

    let reducedRetry = false;
    try {
      for (let step = 1; step <= maxSteps; step++) {
        if (signal.aborted) break;
        const assistantItem = this.addTranscript({ kind: 'assistant', text: '' });
        this.emitEvent('transcript', { item: assistantItem });

        const payload = {
          model: this.model,
          temperature: 0.3,
          messages: [{ role: 'system', content: this.systemPrompt() }, ...this.compactMessages(this.messages)],
          tools: tools.definitions({ planMode: this.mode === 'plan' }),
          tool_choice: 'auto',
        };

        let result;
        for (let attempt = 1; ; attempt++) {
          try {
            assistantItem.text = '';
            result = await client.stream(payload, {
              signal,
              onText: (t) => {
                assistantItem.text += t;
                this.emitEvent('text', { itemId: assistantItem.id, delta: t });
              },
              onProgress: ({ toolChars, toolName }) => {
                this.emitEvent('progress', { toolChars, toolName, label: toolName ? `${tools.describe(toolName, {})}` : '' });
              },
            });
            break;
          } catch (e) {
            if (signal.aborted) throw e;
            const status = e instanceof LlmError ? e.status : 0;
            if (e instanceof LlmError && [400, 413, 422].includes(status) && !reducedRetry) {
              reducedRetry = true;
              payload.messages = [payload.messages[0], ...this.compactMessages(this.messages, 1).slice(-40)];
              this.emitEvent('notice', { text: 'Permintaan ditolak gateway; mencoba ulang dengan riwayat yang diringkas.' });
              continue;
            }
            if (!(e instanceof LlmError) || !e.retryable || attempt >= 4) throw e;
            const wait = Math.min(30, Math.max(e.retryAfter || 0, 2 ** attempt));
            if (assistantItem.text) this.emitEvent('text_reset', { itemId: assistantItem.id });
            this.setStatus('running', `${e.message} Mencoba lagi dalam ${wait} detik (${attempt + 1}/4)`);
            await sleep(wait * 1000, signal);
          }
        }

        if (result.usage) {
          this.usage.prompt += result.usage.prompt || 0;
          this.usage.completion += result.usage.completion || 0;
          this.emitEvent('usage', { usage: this.usage });
        }

        const toolCalls = result.toolCalls || [];
        this.messages.push({ role: 'assistant', content: result.text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
        if (!assistantItem.text.trim()) {
          this.transcript = this.transcript.filter((t) => t.id !== assistantItem.id);
          this.emitEvent('transcript_remove', { itemId: assistantItem.id });
        }

        if (signal.aborted || !toolCalls.length || result.finishReason === 'aborted') break;

        for (const call of toolCalls) {
          const toolMsg = await this.runTool(call, result.finishReason, checkpoint, signal);
          this.messages.push(toolMsg);
        }

        if (step === maxSteps) {
          const note = this.addTranscript({ kind: 'notice', text: `Batas ${maxSteps} langkah tercapai. Kirim "lanjutkan" untuk meneruskan.` });
          this.emitEvent('transcript', { item: note });
        }
      }
    } catch (e) {
      if (!signal.aborted) {
        const item = this.addTranscript({ kind: 'error', text: e.message || String(e) });
        this.emitEvent('transcript', { item });
      }
    } finally {
      for (const [, resolve] of this.pending) resolve({ allow: false, feedback: 'Dibatalkan.' });
      this.pending.clear();
      if (Object.keys(checkpoint.files).length) {
        this.checkpoints.push(checkpoint);
        if (this.checkpoints.length > 30) this.checkpoints.shift();
      }
      if (signal.aborted) {
        const item = this.addTranscript({ kind: 'notice', text: 'Dihentikan oleh pengguna.' });
        this.emitEvent('transcript', { item });
      }
      this.abort = null;
      this.setStatus('idle');
      this.emitEvent('turn_end', { summary: this.summary() });
    }
  }

  async runTool(call, finishReason, checkpoint, signal) {
    const name = call.function.name;
    let args = {};
    let badArgs = false;
    try {
      args = JSON.parse(call.function.arguments || '{}');
      if (!args || typeof args !== 'object' || Array.isArray(args)) { args = {}; badArgs = true; }
    } catch { badArgs = true; }

    const label = tools.describe(name, args);
    const cat = tools.category(name);
    const item = this.addTranscript({ kind: 'tool', callId: call.id, name, label, status: 'running', args: summarizeArgs(name, args) });
    this.emitEvent('transcript', { item });
    this.setStatus('running', label);

    const finish = (status, result, extra = {}) => {
      Object.assign(item, { status, ...extra });
      this.emitEvent('tool_end', { itemId: item.id, status, ...extra });
      let content = JSON.stringify(result);
      if (content.length > MAX_RESULT_CHARS) content = content.slice(0, MAX_RESULT_CHARS) + '...[hasil dipotong; baca lebih sedikit sekaligus]';
      return { role: 'tool', tool_call_id: call.id, content };
    };

    if (finishReason === 'length') {
      return finish('error', { error: 'Jawabanmu terpotong karena batas output, tool TIDAK dijalankan. Bagi pekerjaan menjadi bagian kecil (edit_file per bagian).' }, { error: 'Output terpotong' });
    }
    if (badArgs) {
      return finish('error', { error: 'Argumen tool bukan JSON objek yang valid (mungkin terpotong). Kirim ulang dengan argumen lebih kecil.' }, { error: 'Argumen tidak valid' });
    }
    if (this.mode === 'plan' && (cat === 'edit' || cat === 'exec' || cat === 'publish')) {
      return finish('error', { error: 'Mode Rencana aktif: perubahan dan perintah tidak diizinkan. Tulis rencananya saja.' }, { error: 'Mode Rencana' });
    }

    const root = this.getRoot();
    try {
      if (cat === 'edit') {
        const plan = await tools.planEdit(root, name, args);
        const rel = tools.relPath(root, plan.abs);
        const stats = tools.lineDiffStats(plan.before || '', plan.after || '');
        if (this.needsApproval('edit')) {
          const decision = await this.askPermission({ itemId: item.id, name, label, category: 'edit', path: rel, before: plan.before, after: plan.after, stats });
          if (!decision.allow) {
            return finish('denied', { error: `Pengguna menolak perubahan pada ${rel}.${decision.feedback ? ` Masukan: ${decision.feedback}` : ''}` }, { error: 'Ditolak' });
          }
        }
        if (!(plan.abs in checkpoint.files)) checkpoint.files[plan.abs] = plan.before;
        await tools.applyEdit(plan);
        this.emitEvent('file_changed', { path: plan.abs, rel, deleted: plan.after === null });
        return finish('done', { ok: true, path: rel, action: plan.after === null ? 'deleted' : plan.before === null ? 'created' : 'updated', lines_added: stats.added, lines_removed: stats.removed },
          { diff: { path: rel, added: stats.added, removed: stats.removed } });
      }

      if (cat === 'exec') {
        if (this.needsApproval('exec')) {
          const decision = await this.askPermission({ itemId: item.id, name, label, category: 'exec', command: args.command, cwd: args.cwd || '.' });
          if (!decision.allow) {
            return finish('denied', { error: `Pengguna menolak menjalankan perintah ini.${decision.feedback ? ` Masukan: ${decision.feedback}` : ''}` }, { error: 'Ditolak' });
          }
        }
        let output = '';
        const res = await tools.execute(root, name, args, {
          signal,
          onOutput: (chunk) => {
            output += chunk;
            this.emitEvent('tool_output', { itemId: item.id, chunk });
          },
        });
        item.output = (res.output || output).slice(-20000);
        const ok = res.background_id ? true : res.exit_code === 0;
        return finish(ok ? 'done' : 'error', res, { exitCode: res.exit_code, output: item.output });
      }

      const ctx = {
        signal,
        github: this.getGitHub(),
        ciWaitSeconds: Number(this.getSettings().ciWaitSeconds) || 1200,
        onOutput: (chunk) => {
          item.output = ((item.output || '') + chunk).slice(-20000);
          this.emitEvent('tool_output', { itemId: item.id, chunk });
        },
        onStatus: (text) => {
          this.setStatus('running', `${label} · ${text}`);
        },
      };
      if (cat === 'publish' && this.needsApproval('publish')) {
        const decision = await this.askPermission({ itemId: item.id, name, label, category: 'publish', command: publishSummary(name, args) });
        if (!decision.allow) {
          return finish('denied', { error: `Pengguna menolak aksi GitHub ini.${decision.feedback ? ` Masukan: ${decision.feedback}` : ''}` }, { error: 'Ditolak' });
        }
      }
      const res = await tools.execute(root, name, args, ctx);
      if (name === 'github_wait_workflow') {
        const ci = res.conclusion || res.status;
        const extra = { preview: { success: 'berhasil', failure: 'GAGAL', still_running: 'masih berjalan', not_found: 'tidak ada workflow', stopped: 'dihentikan' }[ci] || ci, link: res.runs && res.runs[0] ? res.runs[0].url : undefined };
        return finish(ci === 'success' ? 'done' : ci === 'failure' || ci === 'not_found' ? 'error' : 'done', res, extra);
      }
      if (name === 'github_push' || name === 'github_create_release' || name === 'github_create_repo') {
        return finish('done', res, { preview: res.commit_sha ? `commit ${res.commit_sha.slice(0, 7)}` : res.tag || res.repo, link: res.commit_url || res.url, output: item.output });
      }
      if (name === 'todo_write') {
        this.todos = res.todos;
        this.emitEvent('todos', { todos: this.todos });
      }
      if (name === 'open_preview') this.emitEvent('preview', { url: res.url });
      return finish('done', res, { preview: resultPreview(name, res) });
    } catch (e) {
      return finish('error', { error: e.message || String(e) }, { error: e.message || String(e) });
    }
  }

  needsApproval(category) {
    if (this.alwaysAllow[category]) return false;
    if (this.mode === 'auto') return false;
    if (category === 'edit') return this.mode === 'ask';
    if (category === 'exec' || category === 'publish') return this.mode === 'ask' || this.mode === 'acceptEdits';
    return false;
  }

  askPermission(request) {
    const requestId = newId('perm');
    this.setStatus('waiting', 'Menunggu persetujuan');
    return new Promise((resolve) => {
      this.pending.set(requestId, (decision) => {
        this.pending.delete(requestId);
        if (decision.allow && decision.always) this.alwaysAllow[request.category] = true;
        this.emitEvent('permission_resolved', { requestId, allow: !!decision.allow });
        this.setStatus('running', request.label);
        resolve(decision);
      });
      const MAX = 400000;
      this.emitEvent('permission', {
        requestId,
        ...request,
        before: request.before != null ? String(request.before).slice(0, MAX) : request.before,
        after: request.after != null ? String(request.after).slice(0, MAX) : request.after,
      });
    });
  }

  respondPermission(requestId, decision) {
    const r = this.pending.get(requestId);
    if (r) r(decision || { allow: false });
    return !!r;
  }

  stop() {
    if (this.abort) this.abort.abort();
    for (const [, resolve] of this.pending) resolve({ allow: false, feedback: 'Dihentikan.' });
  }

  /** Revert the files changed in the most recent turn that changed files. */
  async undoLast() {
    const cp = this.checkpoints.pop();
    if (!cp) return { reverted: [] };
    const reverted = [];
    for (const [abs, before] of Object.entries(cp.files)) {
      try {
        if (before === null) await fs.promises.unlink(abs).catch(() => {});
        else {
          await fs.promises.mkdir(path.dirname(abs), { recursive: true });
          await fs.promises.writeFile(abs, before, 'utf8');
        }
        reverted.push(abs);
        this.emitEvent('file_changed', { path: abs, rel: tools.relPath(this.getRoot(), abs), deleted: before === null });
      } catch { /* keep going */ }
    }
    const item = this.addTranscript({ kind: 'notice', text: `Perubahan dibatalkan: ${reverted.length} berkas dikembalikan.` });
    this.emitEvent('transcript', { item });
    this.messages.push({ role: 'user', content: `[Catatan sistem] Pengguna membatalkan perubahan terakhirmu; berkas berikut dikembalikan ke isi sebelumnya: ${reverted.map((a) => tools.relPath(this.getRoot(), a)).join(', ')}` });
    this.emitEvent('turn_end', { summary: this.summary() });
    return { reverted };
  }

  clear() {
    this.messages = [];
    this.transcript = [];
    this.todos = [];
    this.checkpoints = [];
    this.alwaysAllow = { edit: false, exec: false, publish: false };
    this.usage = { prompt: 0, completion: 0 };
    this.emitEvent('cleared', {});
    this.emitEvent('turn_end', { summary: this.summary() });
  }
}

function summarizeArgs(name, args) {
  const out = {};
  for (const k of ['path', 'pattern', 'command', 'url', 'cwd', 'include', 'repo', 'branch', 'message', 'tag', 'head_sha', 'run_id', 'name']) if (args[k] !== undefined) out[k] = String(args[k]).slice(0, 300);
  if (name === 'todo_write' && Array.isArray(args.todos)) out.todos = args.todos.length;
  return out;
}

function publishSummary(name, a) {
  switch (name) {
    case 'github_push': return `Commit "${a.message || ''}" lalu push ke ${a.repo || 'origin'}${a.branch ? ` (branch ${a.branch})` : ''}`;
    case 'github_pull': return `git pull --rebase dari ${a.repo || 'origin'}${a.branch ? ` (${a.branch})` : ''}`;
    case 'github_create_repo': return `Buat repo GitHub "${a.name}" (${a.private === false ? 'publik' : 'privat'})`;
    case 'github_create_release': return `Buat release ${a.tag}${a.files && a.files.length ? ` dan unggah ${a.files.join(', ')}` : ''}`;
    case 'github_rerun_workflow': return `Jalankan ulang workflow run ${a.run_id}`;
    case 'github_dispatch_workflow': return `Picu workflow ${a.workflow}${a.ref ? ` di ${a.ref}` : ''}`;
    default: return name;
  }
}

function resultPreview(name, res) {
  if (name === 'read_file') return res.binary ? 'berkas biner' : `${res.to - res.from + 1} baris`;
  if (name === 'grep') return `${res.count} hasil`;
  if (name === 'glob') return `${res.count} berkas`;
  if (name === 'list_dir') return `${res.entries.length} item`;
  if (name === 'web_fetch') return `HTTP ${res.status}`;
  return '';
}

module.exports = { Agent, MODES };
