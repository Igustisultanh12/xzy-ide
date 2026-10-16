'use strict';

/**
 * TokenomixAI client (https://tokenomixai.com/docs).
 *
 * - OpenAI-compatible /v1/chat/completions with streaming and tool calling.
 * - Claude models go through /v1/messages (Anthropic format) so tool results arrive
 *   as native tool_result blocks; falls back to chat completions if refused.
 *
 * Every stream returns { text, toolCalls, finishReason, usage } with tool calls in
 * OpenAI shape: { id, type: 'function', function: { name, arguments } }.
 */

const DEFAULT_BASE_URL = 'https://api.tokenomixai.com/v1';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

class LlmError extends Error {
  constructor(message, { status = 0, code = '', retryable = false, retryAfter = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

function normalizeBaseUrl(url) {
  let u = String(url || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!/\/v1$/.test(u)) u += '/v1';
  return u;
}

function describeError(status, code, message) {
  if (status === 401 || code === 'invalid_api_key') return 'API key TokenomixAI ditolak (401). Periksa API key di Pengaturan.';
  if (status === 403 || code === 'key_disabled') return 'Akses ditolak (403). API key dinonaktifkan atau tidak punya akses ke model ini.';
  if (code === 'model_not_available') return `Model tidak tersedia di TokenomixAI. Pilih model lain. (${message})`;
  if (status === 429) return 'Batas laju permintaan tercapai (429). Mencoba lagi sebentar lagi.';
  if (status === 502 || code === 'upstream_unavailable') return 'Upstream TokenomixAI sementara tidak bisa dihubungi (502).';
  return `TokenomixAI error HTTP ${status}${code ? ` (${code})` : ''}: ${message}`;
}

/** Read an SSE response body line by line. */
async function* sseLines(body, signal) {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  try {
    while (true) {
      if (signal && signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        yield line;
      }
    }
    if (buffer.trim()) yield buffer;
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

/** Rebuild streamed OpenAI tool-call deltas into complete calls. */
class ToolCallAccumulator {
  constructor() { this.calls = []; this.lastIndex = null; }

  add(deltas) {
    for (const tc of deltas || []) {
      if (!tc || typeof tc !== 'object') continue;
      let i;
      if (tc.id && this.calls.some((c) => c.id === tc.id)) {
        i = this.calls.findIndex((c) => c.id === tc.id);
      } else if (Number.isInteger(tc.index)) {
        i = tc.index;
        if (tc.id && this.calls[i] && this.calls[i].id && this.calls[i].id !== tc.id) i = this.calls.length;
      } else if (tc.id || this.lastIndex === null) {
        i = this.lastIndex === null ? 0 : this.calls.length;
      } else {
        i = this.lastIndex;
      }
      const call = this.calls[i] || (this.calls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) call.id = tc.id;
      const fn = tc.function || {};
      if (fn.name && (!call.function.name || call.function.name === fn.name)) call.function.name = fn.name;
      if (fn.arguments !== undefined && fn.arguments !== null) {
        const piece = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments);
        const cur = call.function.arguments;
        if (cur && isJson(cur) && isJson(piece)) {
          if (piece.length >= cur.length) call.function.arguments = piece; // full args resent at the end
        } else {
          call.function.arguments += piece;
        }
      }
      this.lastIndex = i;
    }
  }

  result() {
    return this.calls.filter((c) => c && c.function.name).map((c, n) => ({
      id: c.id || `call_${n}_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name: c.function.name, arguments: c.function.arguments || '{}' },
    }));
  }

  argumentChars() { return this.calls.reduce((s, c) => s + (c ? c.function.arguments.length : 0), 0); }
}

function isJson(s) {
  try { const v = JSON.parse(s); return v !== null && typeof v === 'object'; } catch { return false; }
}

/**
 * Repair message shapes that providers (Anthropic behind the gateway) reject with HTTP 400:
 * invalid tool arguments, orphan tool results, missing results, empty turns, same role twice.
 */
function sanitizeMessages(messages) {
  const out = [];
  const idMap = new Map();
  let open = new Set();
  const closeOpen = () => {
    for (const id of open) out.push({ role: 'tool', tool_call_id: id, content: '(tidak ada hasil: langkah ini terputus)' });
    open = new Set();
  };
  for (const m of messages) {
    if (!m || !m.role) continue;
    if (m.role === 'tool') {
      const id = idMap.get(m.tool_call_id) || m.tool_call_id;
      if (!open.has(id)) continue;
      open.delete(id);
      out.push({ role: 'tool', tool_call_id: id, content: String(m.content ?? '').trim() ? String(m.content) : '(hasil kosong)' });
      continue;
    }
    closeOpen();
    const content = typeof m.content === 'string' ? m.content : (m.content == null ? null : String(m.content));
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.filter((c) => c && c.function && c.function.name).map((c) => {
        let args = c.function.arguments || '{}';
        try { const v = JSON.parse(args); if (!v || typeof v !== 'object' || Array.isArray(v)) args = '{}'; } catch { args = '{}'; }
        const id = String(c.id || '').replace(/[^A-Za-z0-9_-]/g, '_') || `call_${Math.random().toString(36).slice(2, 10)}`;
        return { id, type: 'function', function: { name: c.function.name, arguments: args } };
      });
      // Keep tool results pointing at the cleaned ids
      m.tool_calls.filter((c) => c && c.function && c.function.name).forEach((c, k) => idMap.set(c.id, calls[k].id));
      calls.forEach((c) => open.add(c.id));
      out.push({ role: 'assistant', content: content && content.trim() ? content.trimEnd() : null, tool_calls: calls });
      continue;
    }
    if (!['system', 'user', 'assistant'].includes(m.role) || !content || !content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role && m.role !== 'system' && !last.tool_calls) {
      last.content += '\n\n' + content;
      continue;
    }
    out.push({ role: m.role, content });
  }
  closeOpen();
  return out;
}

/** OpenAI payload -> Anthropic Messages payload. */
function toAnthropic(payload, defaultMaxTokens) {
  const messages = sanitizeMessages(payload.messages || []);
  const system = [];
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') system.push(m.content);
    else if (m.role === 'user') push('user', [{ type: 'text', text: m.content }]);
    else if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }]);
    else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content && m.content.trim()) blocks.push({ type: 'text', text: m.content.trimEnd() });
      for (const c of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(c.function.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
      }
      push('assistant', blocks);
    }
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(lanjutkan)' }] });
  const body = { model: payload.model, max_tokens: payload.max_tokens || defaultMaxTokens, messages: out, stream: true };
  if (system.length) body.system = system.join('\n\n');
  if (payload.temperature !== undefined) body.temperature = Math.min(1, payload.temperature);
  if (payload.tools && payload.tools.length) {
    body.tools = payload.tools.map((t) => ({ name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object', properties: {} } }));
    body.tool_choice = { type: 'auto' };
  }
  return body;
}

class TokenomixClient {
  constructor({ apiKey, baseUrl, maxTokens = 16384, messagesApiPattern = /^claude/i, fetchImpl } = {}) {
    this.apiKey = apiKey || '';
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.maxTokens = maxTokens;
    this.messagesApiPattern = messagesApiPattern;
    this.fetch = fetchImpl || globalThis.fetch;
    this.messagesApiOff = new Map(); // model -> until timestamp
  }

  headers(extra = {}) {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...extra };
  }

  async listModels() {
    if (!this.apiKey) throw new LlmError('API key TokenomixAI belum diisi. Buka Pengaturan untuk mengisinya.', { status: 401 });
    const res = await this.fetch(`${this.baseUrl}/models`, { headers: this.headers() });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = json.error || {};
      throw new LlmError(describeError(res.status, e.code || '', e.message || res.statusText), { status: res.status, code: e.code });
    }
    return (json.data || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      ownedBy: m.owned_by || '',
      multiplier: m.multiplier ?? m.pricing?.multiplier ?? null,
      contextLength: m.context_length ?? m.context_window ?? null,
    })).sort((a, b) => a.id.localeCompare(b.id));
  }

  useMessagesApi(model) {
    if (!this.messagesApiPattern || !this.messagesApiPattern.test(model || '')) return false;
    const until = this.messagesApiOff.get(model);
    return !(until && until > Date.now());
  }

  /**
   * Stream one model turn. onText(chunk) for visible text; onProgress({toolChars, toolName}).
   */
  async stream(payload, { onText = () => {}, onProgress = () => {}, signal } = {}) {
    if (!this.apiKey) throw new LlmError('API key TokenomixAI belum diisi. Buka Pengaturan untuk mengisinya.', { status: 401 });
    if (this.useMessagesApi(payload.model)) {
      try {
        return await this.streamMessages(payload, { onText, onProgress, signal });
      } catch (e) {
        if (!(e instanceof LlmError) || ![400, 401, 403, 404, 405, 415, 422].includes(e.status) || e.textStarted) throw e;
        this.messagesApiOff.set(payload.model, Date.now() + 30 * 60 * 1000);
      }
    }
    return this.streamChat(payload, { onText, onProgress, signal });
  }

  async post(path, body, extraHeaders, signal) {
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers({ Accept: 'text/event-stream', ...extraHeaders }),
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      throw new LlmError(`Gagal terhubung ke TokenomixAI: ${e.message}`, { retryable: true });
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      let err = {};
      try { err = JSON.parse(raw).error || {}; } catch { /* plain text */ }
      const code = String(err.code || err.type || '');
      const retryAfter = Number(res.headers.get('retry-after')) || null;
      throw new LlmError(describeError(res.status, code, err.message || raw.slice(0, 500) || res.statusText), {
        status: res.status,
        code,
        retryable: RETRYABLE_STATUS.has(res.status) || code === 'upstream_unavailable' || code === 'overloaded_error',
        retryAfter,
      });
    }
    return res;
  }

  async streamChat(payload, { onText, onProgress, signal }) {
    const body = { ...payload, messages: sanitizeMessages(payload.messages), stream: true, stream_options: { include_usage: true } };
    if (!body.max_tokens) body.max_tokens = this.maxTokens;
    if (!body.tools || !body.tools.length) { delete body.tools; delete body.tool_choice; }
    const res = await this.post('/chat/completions', body, {}, signal);

    const acc = new ToolCallAccumulator();
    let text = '';
    let finishReason = null;
    let usage = null;
    let done = false;
    for await (const line of sseLines(res.body, signal)) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') { done = true; break; }
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.error) {
        const e = json.error;
        throw new LlmError(describeError(502, e.code || '', e.message || 'stream error'), { status: 502, code: e.code, retryable: !text });
      }
      const choice = (json.choices || [])[0] || {};
      const delta = choice.delta || choice.message || {};
      if (delta.tool_calls) {
        acc.add(delta.tool_calls);
        onProgress({ toolChars: acc.argumentChars(), toolName: (acc.result().slice(-1)[0] || {}).function?.name });
      }
      if (delta.content) { text += delta.content; onText(delta.content); }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (json.usage) usage = { prompt: json.usage.prompt_tokens || 0, completion: json.usage.completion_tokens || 0 };
    }
    if (signal && signal.aborted) return { text, toolCalls: [], finishReason: 'aborted', usage };
    if (!done && !finishReason) throw new LlmError('Koneksi ke TokenomixAI terputus di tengah jawaban.', { retryable: !text });
    return { text, toolCalls: acc.result(), finishReason, usage };
  }

  async streamMessages(payload, { onText, onProgress, signal }) {
    const body = toAnthropic(payload, this.maxTokens);
    const res = await this.post('/messages', body, { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }, signal);
    const blocks = [];
    let text = '';
    let stopReason = null;
    let done = false;
    const usage = { prompt: 0, completion: 0 };
    let argChars = 0;
    for await (const line of sseLines(res.body, signal)) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      let ev;
      try { ev = JSON.parse(t.slice(5).trim()); } catch { continue; }
      switch (ev.type) {
        case 'error': {
          const e = ev.error || {};
          const err = new LlmError(describeError(502, e.type || '', e.message || 'stream error'), { status: 502, code: e.type, retryable: !text });
          err.textStarted = !!text;
          throw err;
        }
        case 'message_start': {
          const u = (ev.message || {}).usage || {};
          usage.prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          usage.completion = u.output_tokens || 0;
          break;
        }
        case 'content_block_start': {
          const b = ev.content_block || {};
          blocks[ev.index ?? blocks.length] = { type: b.type, id: b.id, name: b.name, json: '', input: b.input };
          if (b.type === 'text' && b.text) { text += b.text; onText(b.text); }
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta || {};
          if (d.type === 'text_delta' && d.text) { text += d.text; onText(d.text); }
          if (d.type === 'input_json_delta' && blocks[ev.index]) {
            blocks[ev.index].json += d.partial_json || '';
            argChars += (d.partial_json || '').length;
            onProgress({ toolChars: argChars, toolName: blocks[ev.index].name });
          }
          break;
        }
        case 'message_delta':
          if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
          if (ev.usage && ev.usage.output_tokens) usage.completion = ev.usage.output_tokens;
          break;
        case 'message_stop':
          done = true;
          break;
        default:
      }
    }
    if (signal && signal.aborted) return { text, toolCalls: [], finishReason: 'aborted', usage };
    if (!done && !stopReason) {
      const err = new LlmError('Koneksi ke TokenomixAI terputus di tengah jawaban.', { retryable: !text });
      err.textStarted = !!text;
      throw err;
    }
    const toolCalls = blocks.filter((b) => b && b.type === 'tool_use' && b.name).map((b) => ({
      id: b.id || `toolu_${Math.random().toString(36).slice(2, 12)}`,
      type: 'function',
      function: { name: b.name, arguments: b.json || (b.input && Object.keys(b.input).length ? JSON.stringify(b.input) : '{}') },
    }));
    const finishReason = { tool_use: 'tool_calls', max_tokens: 'length', end_turn: 'stop', stop_sequence: 'stop' }[stopReason] || stopReason;
    return { text, toolCalls, finishReason, usage };
  }

  /** Plain (non-agent) completion, used for inline edit and titles. */
  async complete(model, messages, { signal, maxTokens } = {}) {
    let text = '';
    const r = await this.stream({ model, messages, temperature: 0.2, max_tokens: maxTokens || 8192 }, { onText: (t) => { text += t; }, signal });
    return r.text || text;
  }
}

module.exports = { TokenomixClient, LlmError, ToolCallAccumulator, sanitizeMessages, toAnthropic, normalizeBaseUrl, DEFAULT_BASE_URL };
