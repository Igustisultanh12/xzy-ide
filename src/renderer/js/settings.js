// Settings dialog: TokenomixAI API key, base URL, default model and editor preferences.

import { api, state, emit, command } from './state.js';
import { h, modal, toast, errorToast } from './ui.js';

export async function loadModels({ silent = true } = {}) {
  if (!state.settings || !state.settings.hasApiKey) { state.models = []; emit('models', []); return []; }
  try {
    state.models = await api.models();
  } catch (e) {
    state.models = [];
    if (!silent) errorToast(e);
  }
  emit('models', state.models);
  return state.models;
}

export function openSettings() {
  const s = state.settings;
  const m = modal({ title: 'Pengaturan' });
  const field = (label, input, hint = '') => h('div', { class: 'field' }, h('label', { text: label }), input, hint ? h('div', { class: 'hint', text: hint }) : '');

  const apiKey = h('input', { class: 'input', type: 'password', placeholder: s.hasApiKey ? `Tersimpan (${s.apiKeyHint}). Isi untuk mengganti.` : 'sk-tkx-...', spellcheck: 'false', autocomplete: 'off' });
  const baseUrl = h('input', { class: 'input', value: s.baseUrl, spellcheck: 'false' });
  const model = h('select', { class: 'select' });
  const fillModels = (list) => {
    model.innerHTML = '';
    model.append(h('option', { value: '', text: list.length ? '(pilih model default)' : '(muat model dengan tombol Tes koneksi)' }));
    for (const mm of list) model.append(h('option', { value: mm.id, text: mm.multiplier ? `${mm.id} ×${mm.multiplier}` : mm.id, selected: mm.id === s.defaultModel }));
    if (s.defaultModel && !list.some((x) => x.id === s.defaultModel)) model.append(h('option', { value: s.defaultModel, text: s.defaultModel, selected: true }));
  };
  fillModels(state.models);
  const mode = h('select', { class: 'select' },
    ...[['ask', 'Tanya dulu sebelum mengubah berkas / menjalankan perintah'], ['acceptEdits', 'Terima edit otomatis, tanya untuk perintah'], ['auto', 'Otomatis penuh'], ['plan', 'Rencana (baca saja)']]
      .map(([v, t]) => h('option', { value: v, text: t, selected: v === s.defaultMode })));
  const theme = h('select', { class: 'select' }, h('option', { value: 'dark', text: 'Gelap', selected: s.theme !== 'light' }), h('option', { value: 'light', text: 'Terang', selected: s.theme === 'light' }));
  const fontSize = h('input', { class: 'input', type: 'number', min: '10', max: '28', value: s.fontSize });
  const wrap = h('select', { class: 'select' }, h('option', { value: 'off', text: 'Mati', selected: s.wordWrap !== 'on' }), h('option', { value: 'on', text: 'Nyala', selected: s.wordWrap === 'on' }));
  const autoSave = h('select', { class: 'select' }, h('option', { value: 'false', text: 'Mati', selected: !s.autoSave }), h('option', { value: 'true', text: 'Nyala', selected: !!s.autoSave }));
  const maxSteps = h('input', { class: 'input', type: 'number', min: '5', max: '500', value: s.maxSteps });
  const maxTokens = h('input', { class: 'input', type: 'number', min: '1024', max: '128000', step: '1024', value: s.maxTokens });
  const custom = h('textarea', { class: 'textarea', rows: '4', placeholder: 'Mis. "Selalu jawab dalam bahasa Indonesia. Gunakan TypeScript strict."', spellcheck: 'false' });
  custom.value = s.customInstructions || '';

  const testOut = h('span', { class: 'muted small' });
  const testBtn = h('button', { class: 'btn btn-sm', text: 'Tes koneksi & muat model' });
  testBtn.onclick = async () => {
    testBtn.disabled = true;
    testOut.textContent = 'Menghubungi TokenomixAI...';
    try {
      const r = await api.settings.test({ apiKey: apiKey.value.trim() || undefined, baseUrl: baseUrl.value.trim() });
      testOut.textContent = `Terhubung. ${r.count} model tersedia.`;
      testOut.style.color = 'var(--ok)';
      if (apiKey.value.trim()) {
        state.settings = await api.settings.set({ apiKey: apiKey.value.trim(), baseUrl: baseUrl.value.trim() });
        apiKey.value = '';
        apiKey.placeholder = `Tersimpan (${state.settings.apiKeyHint}). Isi untuk mengganti.`;
      }
      fillModels(await loadModels({ silent: false }));
    } catch (e) {
      testOut.textContent = e.message;
      testOut.style.color = 'var(--err)';
    } finally {
      testBtn.disabled = false;
    }
  };

  // GitHub token
  const ghToken = h('input', { class: 'input', type: 'password', placeholder: s.hasGithubToken ? `Tersimpan (${s.githubTokenHint}). Isi untuk mengganti.` : 'ghp_... atau github_pat_...', spellcheck: 'false', autocomplete: 'off' });
  const ghOut = h('span', { class: 'muted small' });
  const ghBtn = h('button', { class: 'btn btn-sm', text: 'Tes token GitHub' });
  ghBtn.onclick = async () => {
    ghBtn.disabled = true;
    ghOut.textContent = 'Memeriksa...';
    ghOut.style.color = '';
    try {
      const r = await api.github.test(ghToken.value.trim() || undefined);
      ghOut.textContent = `Terhubung sebagai @${r.login}${r.fineGrained ? ' (fine-grained token)' : ''}${r.missing.length ? `. Scope kurang: ${r.missing.join(', ')}` : ''}`;
      ghOut.style.color = r.missing.length ? 'var(--warn)' : 'var(--ok)';
    } catch (e) {
      ghOut.textContent = e.message;
      ghOut.style.color = 'var(--err)';
    } finally { ghBtn.disabled = false; }
  };
  const ghLink = h('a', { href: '#', text: 'Buat token (classic, centang repo + workflow)', onclick: (e) => { e.preventDefault(); api.openExternal('https://github.com/settings/tokens/new?scopes=repo,workflow&description=XZY%20IDE'); } });
  const ciWait = h('input', { class: 'input', type: 'number', min: '60', max: '3600', step: '60', value: s.ciWaitSeconds || 1200 });

  // Installed runtimes
  const tools = h('div', { class: 'tool-list' }, h('span', { class: 'muted', text: 'Memeriksa...' }));
  const fillTools = (list) => {
    tools.innerHTML = '';
    for (const t of list) {
      tools.append(h('span', { text: t.label }), h('span', { class: t.installed ? 'ok' : 'no', text: t.installed ? (t.version || 'terpasang') : (t.winget ? `belum (winget ${t.winget})` : 'belum') }));
    }
  };
  api.toolchain(false).then(fillTools).catch(() => { tools.innerHTML = ''; });
  const toolsBtn = h('button', { class: 'btn btn-sm', text: 'Periksa ulang', onclick: async () => { tools.innerHTML = '<span class="muted">Memeriksa...</span>'; fillTools(await api.toolchain(true)); } });

  const keyLink = h('a', { href: '#', text: 'Dapatkan API key di tokenomixai.com', onclick: (e) => { e.preventDefault(); api.openExternal('https://tokenomixai.com/'); } });
  m.body.append(
    h('div', { class: 'field' }, h('label', { text: 'API key TokenomixAI' }), apiKey, h('div', { class: 'hint' }, 'Disimpan terenkripsi (Windows DPAPI) di profil pengguna. ', keyLink)),
    field('Base URL', baseUrl, 'Default: https://api.tokenomixai.com/v1'),
    h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, testBtn, testOut),
    h('div', { class: 'field-row' }, field('Model default', model), field('Mode izin default', mode)),
    h('div', { class: 'field-row' }, field('Maks langkah agen per pesan', maxSteps), field('Maks token output', maxTokens)),
    field('Instruksi tambahan untuk agen', custom, 'Ditambahkan ke setiap percakapan. Instruksi khusus proyek bisa ditaruh di XZY.md di root proyek.'),
    h('div', { class: 'field' }, h('label', { text: 'Token GitHub (untuk push, pantau Actions, dan rilis oleh agen)' }), ghToken, h('div', { class: 'hint' }, 'Disimpan terenkripsi. ', ghLink, '. Fine-grained token: beri akses repo dengan Contents, Actions, Workflows = Read and write, dan Administration = Read and write untuk membuat repo baru.')),
    h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, ghBtn, ghOut),
    field('Maks waktu tunggu GitHub Actions per panggilan (detik)', ciWait, 'Agen memanggil lagi otomatis jika workflow belum selesai.'),
    h('div', { class: 'field' }, h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, h('label', { text: 'Runtime terpasang di komputer ini' }), toolsBtn), tools,
      h('div', { class: 'hint', text: 'Dipakai tombol Jalankan (F5) dan agen. Runtime yang belum ada bisa dipasang agen lewat winget.' })),
    h('div', { class: 'field-row' }, field('Tema', theme), field('Ukuran font editor', fontSize)),
    h('div', { class: 'field-row' }, field('Word wrap', wrap), field('Simpan otomatis', autoSave)),
  );
  const save = h('button', { class: 'btn btn-primary', text: 'Simpan' });
  save.onclick = async () => {
    save.disabled = true;
    try {
      const patch = {
        baseUrl: baseUrl.value.trim() || 'https://api.tokenomixai.com/v1',
        defaultModel: model.value,
        defaultMode: mode.value,
        theme: theme.value,
        fontSize: Number(fontSize.value),
        wordWrap: wrap.value,
        autoSave: autoSave.value === 'true',
        maxSteps: Number(maxSteps.value),
        maxTokens: Number(maxTokens.value),
        customInstructions: custom.value,
      };
      if (apiKey.value.trim()) patch.apiKey = apiKey.value.trim();
      if (ghToken.value.trim()) patch.githubToken = ghToken.value.trim();
      patch.ciWaitSeconds = Number(ciWait.value) || 1200;
      const hadKey = state.settings.hasApiKey;
      state.settings = await api.settings.set(patch);
      emit('settings', state.settings);
      if (!hadKey || patch.apiKey) loadModels({ silent: false });
      toast('Pengaturan disimpan', 'ok', 1500);
      m.close();
    } catch (e) {
      errorToast(e);
      save.disabled = false;
    }
  };
  m.foot.append(h('button', { class: 'btn', text: 'Batal', onclick: () => m.close() }), save);
  if (!s.hasApiKey) setTimeout(() => apiKey.focus(), 20);
}

command('settings', 'Buka pengaturan', () => openSettings(), 'Ctrl+,');
command('reloadModels', 'Muat ulang daftar model TokenomixAI', () => loadModels({ silent: false }).then((l) => toast(`${l.length} model dimuat`, 'ok')));
