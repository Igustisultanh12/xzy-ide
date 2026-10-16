'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Temporary workspace folder with some files. */
function tmpWorkspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xzy-ws-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

/** Response whose body streams the given SSE lines. */
function sseResponse(events, status = 200) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(ctrl) {
      for (const e of events) ctrl.enqueue(enc.encode(typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\n\n`));
      ctrl.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

/** OpenAI-style streamed turn: optional text, optional tool calls. */
function openAiTurn({ text = '', tools = [] } = {}) {
  const ev = [];
  if (text) ev.push({ choices: [{ delta: { content: text } }] });
  tools.forEach(([name, args], i) => {
    const json = JSON.stringify(args);
    ev.push({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${i}_${name}`, function: { name, arguments: '' } }] } }] });
    ev.push({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: json.slice(0, 5) } }] } }] });
    ev.push({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: json.slice(5) } }] } }] });
  });
  ev.push({ choices: [{ delta: {}, finish_reason: tools.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  ev.push('data: [DONE]\n\n');
  return sseResponse(ev);
}

/** fetch stub that serves scripted turns and records requests. */
function scriptedFetch(turns) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const t = turns.shift();
    if (!t) throw new Error('no more scripted turns');
    return typeof t === 'function' ? t(url, init) : t;
  };
  fn.calls = calls;
  return fn;
}

module.exports = { tmpWorkspace, sseResponse, openAiTurn, scriptedFetch };
