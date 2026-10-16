// Run button: run the current file or a detected project configuration in a terminal.

import { api, state, emit, on, command } from './state.js';
import { $, h, icon, toast, errorToast } from './ui.js';
import { activePath } from './editor.js';
import { runInNamedTerminal, interruptNamedTerminal } from './terminal.js';

let configs = [];
let toolchain = null;

async function loadToolchain() {
  try { toolchain = await api.toolchain(false); } catch { toolchain = null; }
  emit('toolchain', toolchain);
  return toolchain;
}

function missing(needs) {
  if (!needs || !toolchain) return null;
  const t = toolchain.find((x) => x.id === needs);
  return t && !t.installed ? t : null;
}

export async function refreshRunConfigs() {
  const sel = $('#run-config');
  const prev = sel.value;
  try { configs = state.workspace ? await api.run.configs() : []; } catch { configs = []; }
  sel.innerHTML = '';
  sel.append(h('option', { value: 'file', text: 'Berkas aktif' }));
  configs.forEach((c) => sel.append(h('option', { value: c.id, text: c.label })));
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else if (configs.length && !activePath()) sel.value = configs[0].id;
}

function warnMissing(tool) {
  const how = tool.winget ? `winget install --id ${tool.winget} -e` : tool.hint || 'pemasang resminya';
  toast(`${tool.label} sepertinya belum terpasang. Jika perintah gagal, pasang dengan ${how} atau minta agen memasangnya.`, 'error', 8000);
}

export async function run() {
  if (!state.workspace) { toast('Buka folder dulu.'); return; }
  const choice = $('#run-config').value;
  let cfg;
  if (choice === 'file') {
    const p = activePath();
    if (!p) {
      if (configs.length) cfg = configs[0];
      else { toast('Buka berkas yang ingin dijalankan, atau pilih konfigurasi proyek.', 'info'); return; }
    } else {
      emit('saveActiveSilently');
      try { cfg = await api.run.file(p); } catch (e) { errorToast(e); return; }
      if (!cfg) { toast(`Tipe berkas ${p.split('.').pop()} belum bisa dijalankan langsung. Pilih konfigurasi proyek atau minta agen.`, 'info', 6000); return; }
      cfg.label = p;
    }
  } else {
    cfg = configs.find((c) => c.id === choice);
  }
  if (!cfg) return;
  if (cfg.preview) { emit('preview:open', cfg.preview); return; }
  // Detection only warns: the terminal shows the real error if the runtime is missing
  const miss = missing(cfg.needs);
  if (miss) warnMissing(miss);
  if (cfg.note) toast(cfg.note, 'info', 5000);
  await runInNamedTerminal('Run', cfg.command);
  if (cfg.server) {
    toast(`Server dijalankan. Membuka pratinjau ${cfg.server}...`, 'info', 4000);
    setTimeout(() => emit('preview:open', cfg.server), 5000);
  }
}

export function initRun() {
  $('#run-stop').innerHTML = icon('stop');
  $('#run-btn').addEventListener('click', () => run());
  $('#run-stop').addEventListener('click', () => interruptNamedTerminal('Run'));
  on('workspace', () => { refreshRunConfigs(); loadToolchain(); });
  on('activeFile', () => { if (!$('#run-config').value) $('#run-config').value = 'file'; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5' && !e.ctrlKey) {
      e.preventDefault();
      if (e.shiftKey) interruptNamedTerminal('Run');
      else run();
    }
  }, true);
  command('run', 'Jalankan berkas/proyek', () => run(), 'F5');
  command('runStop', 'Hentikan proses yang dijalankan', () => interruptNamedTerminal('Run'), 'Shift+F5');
  command('runRefresh', 'Muat ulang konfigurasi run', () => refreshRunConfigs());
  command('toolchain', 'Periksa runtime terpasang (PHP, Java, Python, ...)', async () => {
    const list = await api.toolchain(true);
    toolchain = list;
    emit('toolchain', list);
    const have = list.filter((t) => t.installed).map((t) => `${t.label} ${t.version || ''}`);
    toast(`Terpasang: ${have.join(', ') || '-'}`, 'ok', 9000);
  });
}
