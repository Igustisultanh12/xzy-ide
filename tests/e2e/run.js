'use strict';

/**
 * End-to-end test: starts a fake TokenomixAI server, launches XZY IDE (dev or packaged),
 * opens a workspace, checks the editor/terminal/agent UI load without errors, and lets
 * the agent write a file through the real tool loop.
 *
 *   node tests/e2e/run.js                      -> runs `electron .`
 *   node tests/e2e/run.js --packaged <exe>     -> runs the installed/unpacked app
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');

const args = process.argv.slice(2);
const packagedIdx = args.indexOf('--packaged');
const packagedExe = packagedIdx >= 0 ? args[packagedIdx + 1] : null;
const outDir = path.join(__dirname, '..', '..', 'e2e-output');
fs.mkdirSync(outDir, { recursive: true });

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) res.write(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  res.end();
}

function startFakeGateway() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      requests.push({ url: req.url, auth: req.headers.authorization, body: json });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'glm-test', owned_by: 'test' }, { id: 'kimi-test' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        const msgs = json.messages || [];
        let lastUser = -1;
        msgs.forEach((m, i) => { if (m.role === 'user') lastUser = i; });
        const toolMsgs = msgs.slice(lastUser + 1).filter((m) => m.role === 'tool');
        const userText = lastUser >= 0 ? String(msgs[lastUser].content) : '';
        if (userText.includes('Tambahkan baris')) {
          if (toolMsgs.length === 0) {
            sse(res, [
              { choices: [{ delta: { content: 'Saya tambahkan barisnya.' } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_e1', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'hello.txt', old_string: 'Halo dari agen XZY\n', new_string: 'Halo dari agen XZY\nBaris kedua\n' }) } }] } }] },
              { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
              '[DONE]',
            ]);
          } else {
            sse(res, [{ choices: [{ delta: { content: 'Baris kedua sudah ditambahkan ke **hello.txt**.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
          }
          return;
        }
        if (toolMsgs.length === 0) {
          sse(res, [
            { choices: [{ delta: { content: 'Saya buat berkasnya.' } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'todo_write', arguments: '{"todos":[{"content":"Buat hello.txt","status":"in_progress"}]}' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'write_file', arguments: '{"path":"hello.txt","content":"Halo dari agen XZY\\n"}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 30 } },
            '[DONE]',
          ]);
        } else if (toolMsgs.length === 2) {
          const ok = toolMsgs.some((m) => m.content.includes('"ok":true'));
          sse(res, [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_3', function: { name: 'read_file', arguments: '{"path":"hello.txt"}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: ok ? 'tool_calls' : 'stop' }] },
            '[DONE]',
          ]);
        } else {
          const read = toolMsgs[toolMsgs.length - 1].content;
          sse(res, [
            { choices: [{ delta: { content: read.includes('Halo dari agen XZY') ? 'Selesai. hello.txt sudah dibuat dan isinya sudah saya periksa.' : 'Hasil tool tidak sesuai.' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 20 } },
            '[DONE]',
          ]);
        }
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

function check(cond, msg) {
  if (!cond) throw new Error(`GAGAL: ${msg}`);
  console.log(`  ok  ${msg}`);
}

async function main() {
  const gw = await startFakeGateway();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xzy-e2e-data-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'xzy-e2e-ws-'));
  fs.writeFileSync(path.join(ws, 'readme.md'), '# Proyek uji\n\nIni berkas uji.\n');
  fs.mkdirSync(path.join(ws, 'src'));
  fs.writeFileSync(path.join(ws, 'src', 'app.js'), 'function halo() {\n  return "halo";\n}\n');
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    baseUrl: `http://127.0.0.1:${gw.port}/v1`,
    apiKeyEnc: 'b64:' + Buffer.from('sk-tkx-test').toString('base64'),
    defaultModel: 'glm-test',
    defaultMode: 'auto',
  }));

  const env = { ...process.env, XZY_E2E: '1', XZY_USER_DATA: userData, XZY_OPEN_FOLDER: ws, ELECTRON_ENABLE_LOGGING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = packagedExe
    ? { executablePath: path.resolve(packagedExe), args: [], env, timeout: 90000 }
    : { args: [path.join(__dirname, '..', '..')], env, timeout: 90000 };
  console.log(`Menjalankan ${packagedExe ? `aplikasi terpaket ${packagedExe}` : 'electron .'}`);
  const app = await electron.launch(launch);

  const tag = packagedExe ? 'packaged' : 'dev';
  const errors = [];
  const logs = [];
  let win;
  try {
    win = await app.firstWindow();
    win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    win.on('console', (m) => {
      logs.push(`[${m.type()}] ${m.text()}`);
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    win.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure() && r.failure().errorText}`));
    win.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`); });
    await win.waitForFunction(() => window.__xzyReady === true || window.__xzyBootError, null, { timeout: 90000 });
    const bootError = await win.evaluate(() => window.__xzyBootError || null);
    check(!bootError, `aplikasi boot tanpa error ${bootError || ''}`);

    const diag = await win.evaluate(() => ({
      monaco: !!window.monaco,
      editorDom: !!(window.monaco && window.monaco.editor.getEditors().length),
      amd: typeof window.require,
      define: typeof window.define,
      monacoError: window.__xzyMonacoError || null,
      toasts: document.querySelector('#toasts').innerText,
      href: location.href,
    }));
    console.log('  diag', JSON.stringify(diag));
    check(diag.monaco && diag.editorDom, 'editor Monaco termuat');
    await win.waitForSelector('.tree-row[data-path="readme.md"]', { timeout: 20000 });
    check(true, 'explorer menampilkan berkas workspace');

    await win.click('.tree-row[data-path="src"]');
    await win.waitForSelector('.tree-row[data-path="src/app.js"]', { timeout: 10000 });
    await win.click('.tree-row[data-path="src/app.js"]');
    await win.waitForSelector('.tab.active', { timeout: 10000 });
    await win.waitForSelector('#editor .monaco-editor .view-lines', { timeout: 10000 });
    const value = await win.evaluate(() => window.monaco.editor.getModels().map((m) => m.getValue()).join('\n'));
    check(value.includes('return "halo"'), 'berkas terbuka di editor');

    await win.waitForSelector('.panel-tab', { timeout: 20000 });
    const info = await win.evaluate(() => window.xzy.info());
    check(true, `terminal terbuka (mode ${info.terminalMode})`);

    await win.waitForFunction(() => document.querySelectorAll('#model-select option[value="glm-test"]').length > 0, null, { timeout: 20000 });
    check(true, 'daftar model dimuat dari gateway');

    await win.fill('#prompt', 'Buat berkas hello.txt berisi salam');
    await win.click('#send-btn');
    await win.waitForFunction(() => document.querySelector('#transcript').innerText.includes('isinya sudah saya periksa'), null, { timeout: 60000 });
    check(fs.existsSync(path.join(ws, 'hello.txt')) && fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8') === 'Halo dari agen XZY\n', 'agen menulis hello.txt lewat tool');
    check(await win.evaluate(() => !!document.querySelector('.todo')), 'daftar tugas agen tampil');
    check(gw.requests.every((r) => !r.url.startsWith('/v1/chat') || r.auth === 'Bearer sk-tkx-test'), 'API key dikirim ke gateway');
    await win.waitForSelector('.tree-row[data-path="hello.txt"]', { timeout: 15000 });
    check(true, 'explorer ikut menampilkan berkas baru dari agen');

    await win.screenshot({ path: path.join(outDir, `${tag}-1-agent.png`) });

    // Ask mode: the edit waits for approval with a diff
    await win.selectOption('#mode-select', 'ask');
    await win.fill('#prompt', 'Tambahkan baris kedua ke hello.txt');
    await win.click('#send-btn');
    await win.waitForSelector('.permission .mini-diff', { timeout: 30000 });
    check(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8') === 'Halo dari agen XZY\n', 'mode Tanya: berkas belum diubah sebelum disetujui');
    await win.screenshot({ path: path.join(outDir, `${tag}-2-permission.png`) });
    await win.click('.permission .btn-primary');
    await win.waitForFunction(() => document.querySelector('#transcript').innerText.includes('Baris kedua sudah ditambahkan'), null, { timeout: 30000 });
    check(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8') === 'Halo dari agen XZY\nBaris kedua\n', 'setelah disetujui, edit diterapkan');

    await win.keyboard.press('Control+Shift+P');
    await win.waitForSelector('.palette input', { timeout: 5000 });
    await win.keyboard.type('terminal');
    await win.screenshot({ path: path.join(outDir, `${tag}-3-palette.png`) });
    await win.keyboard.press('Escape');
    check(true, 'palet perintah bisa dibuka');

    await win.keyboard.press('Control+,');
    await win.waitForSelector('.modal', { timeout: 5000 });
    await win.screenshot({ path: path.join(outDir, `${tag}-4-settings.png`) });
    await win.keyboard.press('Escape');
    check(true, 'dialog pengaturan bisa dibuka');

    const real = errors.filter((e) => !/Autofill|DevTools|Electron Security Warning|favicon|ResizeObserver loop/i.test(e));
    check(real.length === 0, `tidak ada error di console${real.length ? `:\n${real.join('\n')}` : ''}`);
    console.log('\nE2E LULUS');
  } catch (e) {
    if (win) await win.screenshot({ path: path.join(outDir, `failure-${packagedExe ? 'packaged' : 'dev'}.png`) }).catch(() => {});
    console.error(e.message);
    if (errors.length) console.error('Error console:\n' + errors.join('\n'));
    console.error('Log renderer:\n' + logs.slice(-60).join('\n'));
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
    gw.server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
