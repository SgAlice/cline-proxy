// cline-proxy — 把 Cline (api.cline.bot) 包装成标准 OpenAI 接口，供 Aether 调用。
//
//   POST /v1/chat/completions  流式：透传 SSE（补 usage、去掉 provider_metadata）
//                              非流式：拆掉 Cline 的 {"data":…, "success":true} 外壳
//   POST /v1/responses         Responses ⇄ Chat 双向转换，上游始终走流式
//   GET  /v1/models            透传并拆壳
//   GET  /health
//
// API Key 不在本服务保存：直接透传调用方（Aether）发来的 Authorization。
// 零依赖，Node >= 22。

import http from 'node:http';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { prepareResponsesCompatibility } from './responses-compat.mjs';

const PORT = Number(process.env.PORT || 3060);
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM = (process.env.UPSTREAM_BASE_URL || 'https://api.cline.bot/api/v1').replace(/\/+$/, '');
const MODEL_PREFIX = process.env.MODEL_PREFIX ?? 'cline-pass/';
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 300_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 64 * 1024 * 1024);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// ───────────────────────── utils ─────────────────────────

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function log(level, msg, data) {
  if (LEVELS[level] < (LEVELS[LOG_LEVEL] ?? 20)) return;
  const line = { t: new Date().toISOString(), level, msg, ...(data || {}) };
  (level === 'error' || level === 'warn' ? console.error : console.log)(JSON.stringify(line));
}

const nowUnix = () => Math.floor(Date.now() / 1000);
const newId = (prefix) => prefix + randomUUID().replace(/-/g, '').slice(0, 24);

function sendJSON(res, status, obj) {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, message, type) {
  sendJSON(res, status, {
    error: { message, type: type || errorTypeFor(status), code: null, param: null },
  });
}

function errorTypeFor(status) {
  if (status === 400 || status === 404 || status === 413 || status === 422) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  return 'api_error';
}

function decompress(buf, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!enc || enc === 'identity') return buf;
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
  if (enc === 'deflate') return zlib.inflateSync(buf);
  if (enc === 'br') return zlib.brotliDecompressSync(buf);
  if (enc === 'zstd' && typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buf);
  throw Object.assign(new Error('Unsupported content-encoding: ' + enc), { statusCode: 415 });
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = decompress(Buffer.concat(chunks), req.headers['content-encoding']);
        resolve(raw.length ? JSON.parse(raw.toString('utf8')) : {});
      } catch (e) {
        reject(Object.assign(e, { statusCode: e.statusCode || 400 }));
      }
    });
    req.on('error', reject);
  });
}

function authHeader(headers) {
  const a = headers['authorization'];
  if (a) return /^bearer\s/i.test(a) ? a : 'Bearer ' + a;
  const x = headers['x-api-key'];
  return x ? 'Bearer ' + x : null;
}

function upstreamModel(model) {
  if (!model || typeof model !== 'string') return model;
  return model.includes('/') || !MODEL_PREFIX ? model : MODEL_PREFIX + model;
}

// Cline 的错误格式是 {"error":"text","success":false}；统一成 OpenAI 格式的文本。
function upstreamErrorMessage(text) {
  try {
    const j = JSON.parse(text);
    const e = j.error ?? j.data?.error ?? j.message;
    if (typeof e === 'string') return e;
    if (e && typeof e.message === 'string') return e.message;
  } catch {}
  return (text || '').slice(0, 500) || 'Upstream error';
}

// 拆 Cline 外壳：{"data":{...},"success":true} → {...}
function unwrap(j) {
  if (j && typeof j === 'object' && !Array.isArray(j) && 'success' in j && 'data' in j) return j.data;
  return j;
}

function stripProviderMetadata(obj) {
  if (!obj || !Array.isArray(obj.choices)) return obj;
  for (const ch of obj.choices) {
    if (ch?.delta) delete ch.delta.provider_metadata;
    if (ch?.message) delete ch.message.provider_metadata;
  }
  return obj;
}

async function callUpstream(path, body, auth, signal) {
  return fetch(UPSTREAM + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: body.stream ? 'text/event-stream' : 'application/json',
      Authorization: auth,
    },
    body: JSON.stringify(body),
    signal,
  });
}

// 逐行读取 SSE 的 data: 负载；带空闲超时
async function* sseData(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      let timer;
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej(Object.assign(new Error('Upstream idle timeout'), { idle: true })), IDLE_TIMEOUT_MS);
      });
      let r;
      try { r = await Promise.race([reader.read(), timeout]); } finally { clearTimeout(timer); }
      if (r.done) break;
      if (signal?.aborted) break;
      buf += decoder.decode(r.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trimStart();
      }
    }
    buf += decoder.decode();
    const last = buf.trim();
    if (last.startsWith('data:')) yield last.slice(5).trimStart();
  } finally {
    try { reader.cancel(); } catch {}
  }
}

function writeAndDrain(res, chunk) {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.on('drain', done);
    res.on('close', done);
  });
}

function withAbort(req, res) {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded && !ac.signal.aborted) ac.abort(); });
  return ac;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

// ───────────────────── /v1/chat/completions ─────────────────────

async function handleChat(req, res) {
  const auth = authHeader(req.headers);
  if (!auth) return sendError(res, 401, 'Missing API key');
  let body;
  try { body = await readJSON(req); } catch (e) { return sendError(res, e.statusCode || 400, e.message); }

  const clientModel = body.model;
  body.model = upstreamModel(body.model);
  const stream = body.stream === true;
  if (stream) body.stream_options = { ...(body.stream_options || {}), include_usage: true };

  const ac = withAbort(req, res);
  const t0 = Date.now();
  let up;
  try {
    up = await callUpstream('/chat/completions', body, auth, ac.signal);
  } catch (e) {
    if (ac.signal.aborted) return;
    log('error', 'upstream fetch failed', { path: 'chat', error: e.message });
    return sendError(res, 502, 'Upstream request failed: ' + e.message);
  }

  if (!up.ok) {
    const text = await up.text().catch(() => '');
    log('warn', 'upstream error', { path: 'chat', status: up.status, body: text.slice(0, 300) });
    return sendError(res, up.status, upstreamErrorMessage(text));
  }

  if (!stream) {
    const text = await up.text();
    let j;
    try { j = JSON.parse(text); } catch { return sendError(res, 502, 'Invalid upstream JSON'); }
    if (j && j.success === false) return sendError(res, 502, upstreamErrorMessage(text));
    const out = stripProviderMetadata(unwrap(j));
    log('info', 'chat done', { stream: false, model: clientModel, ms: Date.now() - t0, usage: out?.usage?.total_tokens });
    return sendJSON(res, 200, out);
  }

  // 流式：逐条改写，补齐缺失的 id/object/model，去掉 provider_metadata
  res.writeHead(200, SSE_HEADERS);
  let meta = { id: null, object: 'chat.completion.chunk', created: nowUnix(), model: clientModel };
  let usage = null;
  try {
    for await (const data of sseData(up, ac.signal)) {
      if (data === '[DONE]') { await writeAndDrain(res, 'data: [DONE]\n\n'); continue; }
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      j = unwrap(j);
      if (j?.error && !j.choices) {
        await writeAndDrain(res, 'data: ' + JSON.stringify({ error: { message: upstreamErrorMessage(JSON.stringify(j)), type: 'api_error' } }) + '\n\n');
        continue;
      }
      if (j.id) meta.id = j.id;
      if (j.model) meta.model = j.model;
      if (j.created) meta.created = j.created;
      if (!j.id) j.id = meta.id || newId('chatcmpl-');
      if (!j.object) j.object = meta.object;
      if (!j.created) j.created = meta.created;
      if (!j.model) j.model = meta.model;
      if (j.usage) usage = j.usage;
      stripProviderMetadata(j);
      await writeAndDrain(res, 'data: ' + JSON.stringify(j) + '\n\n');
    }
  } catch (e) {
    if (!ac.signal.aborted) {
      log('warn', 'chat stream error', { error: e.message });
      try { res.write('data: ' + JSON.stringify({ error: { message: e.message, type: 'api_error' } }) + '\n\n'); } catch {}
    }
  }
  log('info', 'chat done', { stream: true, model: clientModel, ms: Date.now() - t0, usage: usage?.total_tokens });
  if (!res.writableEnded) res.end();
}

// ───────────────────── Responses → Chat ─────────────────────

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p === 'object' ? (typeof p.text === 'string' ? p.text : (typeof p.refusal === 'string' ? p.refusal : '')) : ''))
    .join('');
}

// 用户消息：保留图片，其余转成文本 part
function userContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const hasImage = content.some((p) => p?.type === 'input_image');
  if (!hasImage) return textOfContent(content);
  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'input_image') {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
      if (url) parts.push({ type: 'image_url', image_url: { url, ...(p.detail ? { detail: p.detail } : {}) } });
    } else if (typeof p.text === 'string') {
      parts.push({ type: 'text', text: p.text });
    }
  }
  return parts;
}

// reasoning item → 文本。优先使用我们自己塞进 encrypted_content 的完整推理。
const ENC_PREFIX = 'clinepx1:';
function reasoningText(item) {
  if (typeof item.encrypted_content === 'string' && item.encrypted_content.startsWith(ENC_PREFIX)) {
    try { return Buffer.from(item.encrypted_content.slice(ENC_PREFIX.length), 'base64').toString('utf8'); } catch {}
  }
  if (Array.isArray(item.content) && item.content.length) return item.content.map((p) => p?.text || '').join('');
  if (Array.isArray(item.summary) && item.summary.length) return item.summary.map((p) => p?.text || '').join('\n');
  return '';
}

function toolOutputContent(output) {
  if (typeof output === 'string') return { text: output, images: [] };
  if (Array.isArray(output)) {
    const images = [];
    const texts = [];
    for (const p of output) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'input_image') {
        const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
        if (url) images.push({ type: 'image_url', image_url: { url } });
      } else if (typeof p.text === 'string') texts.push(p.text);
    }
    return { text: texts.join('\n'), images };
  }
  if (output && typeof output === 'object') {
    if (typeof output.content === 'string') return { text: output.content, images: [] };
    return { text: JSON.stringify(output), images: [] };
  }
  return { text: output === undefined || output === null ? '' : String(output), images: [] };
}

// Reuse the deployed Command Code Responses Lite registry. Keep Cline's
// legacy local_shell declaration as a JSON function on the upstream wire.
function prepareClineCompatibility(r) {
  let localShell = false;
  const normalizeTools = tools => {
    if (tools == null) return tools;
    if (!Array.isArray(tools)) throw new Error('Responses tools must be an array');
    return tools.map(t => {
      if (t?.type === 'namespace') return { ...t, tools: normalizeTools(t.tools) };
      if (t?.type === 'local_shell') {
        localShell = true;
        return { type: 'function', name: 'local_shell', description: 'Run a shell command locally.',
          parameters: { type: 'object', properties: {
            command: { type: 'array', items: { type: 'string' } },
            workdir: { type: 'string' }, timeout_ms: { type: 'number' },
          }, required: ['command'] } };
      }
      if (t?.type === 'function' && t.function) return { ...t.function, type: 'function' };
      if (t && !t.type && t.name) return { ...t, type: 'function' };
      return t;
    });
  };
  const request = { ...r, tools: normalizeTools(r.tools),
    input: Array.isArray(r.input) ? r.input.map(item => item?.type === 'additional_tools'
      ? { ...item, tools: normalizeTools(item.tools) } : item) : r.input };
  if (request.input != null && typeof request.input !== 'string' && !Array.isArray(request.input)) {
    throw new Error('Responses input must be a string or array');
  }
  return { ...prepareResponsesCompatibility(request), localShell };
}

function responsesToChat(r) {
  const messages = [];
  const ctx = prepareClineCompatibility(r);

  if (r.instructions) {
    const sys = textOfContent(r.instructions);
    if (sys) messages.push({ role: 'system', content: sys });
  }

  if (ctx.capabilityNotice) messages.push({ role: 'system', content: ctx.capabilityNotice });

  // reasoning / assistant message / tool calls 在 Responses 里是并列 item，
  // 在 Chat 里要合并到同一条 assistant 消息上。
  let pending = null;
  let pendingImages = [];
  const ensure = () => (pending ||= { role: 'assistant', content: null, tool_calls: [] });
  const flush = () => {
    if (!pending) return;
    if (!pending.tool_calls.length) delete pending.tool_calls;
    if (!pending.reasoning_content) delete pending.reasoning_content;
    if (pending.content !== null || pending.tool_calls) messages.push(pending);
    pending = null;
  };
  const flushImages = () => {
    if (pendingImages.length) {
      messages.push({ role: 'user', content: [{ type: 'text', text: '[Images returned by the preceding tool call(s)]' }, ...pendingImages] });
      pendingImages = [];
    }
  };
  const pushToolResult = (callId, output) => {
    flush();
    const { text, images } = toolOutputContent(output);
    messages.push({ role: 'tool', tool_call_id: callId || '', content: text || (images.length ? '[image output attached below]' : '') });
    pendingImages.push(...images);
  };

  const input = typeof ctx.input === 'string' ? [{ type: 'message', role: 'user', content: ctx.input }] : (ctx.input || []);
  for (const item of input) {
    if (!item || typeof item !== 'object') throw new Error('Invalid Responses input item');
    const type = item.type ?? (item.role ? 'message' : undefined);
    if (!/_output$/.test(type || '')) flushImages();
    switch (type) {
      case 'message': {
        if (item.role === 'assistant') {
          const t = textOfContent(item.content);
          if (t) {
            const p = ensure();
            // 同一轮 assistant 在工具调用之后又输出文本：新开一条
            if (p.tool_calls.length) { flush(); ensure().content = t; } else p.content = (p.content || '') + t;
          }
        } else if (item.role === 'system' || item.role === 'developer') {
          flush();
          messages.push({ role: 'system', content: textOfContent(item.content) });
        } else {
          flush();
          messages.push({ role: 'user', content: userContent(item.content) });
        }
        break;
      }
      case 'reasoning': {
        const t = reasoningText(item);
        if (t) {
          if (pending && (pending.content || pending.tool_calls.length)) flush();
          const p = ensure();
          p.reasoning_content = (p.reasoning_content ? p.reasoning_content + '\n' : '') + t;
        }
        break;
      }
      case 'function_call':
        ensure().tool_calls.push({
          id: item.call_id || item.id || newId('call_'),
          type: 'function',
          function: {
            name: item.name || '',
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
          },
        });
        break;
      case 'local_shell_call':
        ensure().tool_calls.push({
          id: item.call_id || item.id || newId('call_'),
          type: 'function',
          function: { name: 'local_shell', arguments: JSON.stringify(item.action || {}) },
        });
        break;
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output':
        pushToolResult(item.call_id, item.output);
        break;
      default:
        throw new Error(`Unsupported Responses input item type: ${type}`);
    }
  }
  flush();
  flushImages();

  // Chat 要求 tool 消息与前面的 tool_calls 一一对应：补齐缺失的结果，删掉孤立的结果
  const fixed = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') {
      const prev = [...fixed].reverse().find((x) => x.role === 'assistant' && x.tool_calls);
      if (!prev || !prev.tool_calls.some((tc) => tc.id === m.tool_call_id)) continue;
    }
    fixed.push(m);
    if (m.role === 'assistant' && m.tool_calls) {
      const answered = new Set();
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') answered.add(messages[j++].tool_call_id);
      for (let k = i + 1; k < j; k++) fixed.push(messages[k]);
      for (const tc of m.tool_calls) {
        if (!answered.has(tc.id)) fixed.push({ role: 'tool', tool_call_id: tc.id, content: '[no output: call was aborted]' });
      }
      i = j - 1;
    }
  }

  const chat = {
    model: upstreamModel(r.model),
    messages: fixed,
    stream: true,
    stream_options: { include_usage: true },
  };
  const tools = ctx.tools;
  if (tools.length) {
    chat.tools = tools;
    if (ctx.toolChoice != null) chat.tool_choice = ctx.toolChoice;
    if (r.parallel_tool_calls !== undefined) chat.parallel_tool_calls = r.parallel_tool_calls;
  }
  if (r.max_output_tokens != null) chat.max_tokens = r.max_output_tokens;
  if (r.temperature != null) chat.temperature = r.temperature;
  if (r.top_p != null) chat.top_p = r.top_p;
  if (r.reasoning?.effort) chat.reasoning_effort = r.reasoning.effort;
  const fmt = r.text?.format;
  if (fmt?.type === 'json_schema') {
    chat.response_format = { type: 'json_schema', json_schema: { name: fmt.name || 'output', schema: fmt.schema, ...(fmt.strict !== undefined ? { strict: fmt.strict } : {}) } };
  } else if (fmt?.type === 'json_object') {
    chat.response_format = { type: 'json_object' };
  }
  return { chat, ctx };
}

// ───────────────────── Chat stream → Responses ─────────────────────

function mapUsage(u) {
  u = u || {};
  const inTok = u.prompt_tokens || 0;
  const outTok = u.completion_tokens || 0;
  return {
    input_tokens: inTok,
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens || 0 },
    output_tokens: outTok,
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 },
    total_tokens: u.total_tokens || inTok + outTok,
  };
}

class ResponsesBuilder {
  constructor(req, ctx, emit) {
    this.req = req;
    this.ctx = ctx;
    this.emit = emit; // (eventType, payload) => void|Promise；非流式时为 null
    this.seq = 0;
    this.id = newId('resp_');
    this.created = nowUnix();
    this.model = req.model;
    this.output = [];
    this.current = null; // { kind, item, index, text }
    this.toolInputBytes = 0;
    this.toolCalls = new Map(); // index -> {id,name,args}
    this.usage = null;
    this.finishReason = null;
    this.outputText = '';
    this.started = false;
  }

  baseResponse(status) {
    const r = this.req;
    return {
      id: this.id,
      object: 'response',
      created_at: this.created,
      status,
      error: null,
      incomplete_details: null,
      instructions: r.instructions ?? null,
      max_output_tokens: r.max_output_tokens ?? null,
      model: this.model,
      output: [],
      parallel_tool_calls: r.parallel_tool_calls ?? true,
      previous_response_id: null,
      reasoning: r.reasoning ?? null,
      store: false,
      temperature: r.temperature ?? 1,
      text: r.text ?? { format: { type: 'text' } },
      tool_choice: r.tool_choice ?? 'auto',
      tools: r.tools ?? [],
      top_p: r.top_p ?? 1,
      truncation: 'disabled',
      usage: null,
      user: null,
      metadata: r.metadata ?? {},
    };
  }

  async ev(type, payload) {
    if (!this.emit) return;
    await this.emit(type, { type, sequence_number: this.seq++, ...payload });
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.ev('response.created', { response: this.baseResponse('in_progress') });
    await this.ev('response.in_progress', { response: this.baseResponse('in_progress') });
  }

  async closeCurrent() {
    const c = this.current;
    if (!c) return;
    this.current = null;
    const { item, index } = c;
    if (c.kind === 'message') {
      const part = { type: 'output_text', text: c.text, annotations: [], logprobs: [] };
      await this.ev('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: c.text, logprobs: [] });
      await this.ev('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part });
      item.content = [part];
    } else if (c.kind === 'reasoning') {
      await this.ev('response.reasoning_summary_text.done', { item_id: item.id, output_index: index, summary_index: 0, text: c.text });
      await this.ev('response.reasoning_summary_part.done', { item_id: item.id, output_index: index, summary_index: 0, part: { type: 'summary_text', text: c.text } });
      item.summary = [{ type: 'summary_text', text: c.text }];
      item.encrypted_content = ENC_PREFIX + Buffer.from(c.text, 'utf8').toString('base64');
    }
    item.status = 'completed';
    if (c.kind === 'reasoning') delete item.status;
    await this.ev('response.output_item.done', { output_index: index, item });
  }

  async open(kind) {
    await this.closeCurrent();
    const index = this.output.length;
    const item = kind === 'message'
      ? { id: newId('msg_'), type: 'message', status: 'in_progress', role: 'assistant', content: [] }
      : { id: newId('rs_'), type: 'reasoning', summary: [] };
    this.output.push(item);
    this.current = { kind, item, index, text: '' };
    await this.ev('response.output_item.added', { output_index: index, item: { ...item } });
    if (kind === 'message') {
      await this.ev('response.content_part.added', { item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
    } else {
      await this.ev('response.reasoning_summary_part.added', { item_id: item.id, output_index: index, summary_index: 0, part: { type: 'summary_text', text: '' } });
    }
  }

  async onChunk(j) {
    if (j.model) this.model = this.req.model || j.model;
    if (j.usage) this.usage = j.usage;
    for (const ch of j.choices || []) {
      const d = ch.delta || ch.message || {};
      const reasoning = d.reasoning_content ?? d.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        await this.start();
        if (this.current?.kind !== 'reasoning') await this.open('reasoning');
        this.current.text += reasoning;
        await this.ev('response.reasoning_summary_text.delta', { item_id: this.current.item.id, output_index: this.current.index, summary_index: 0, delta: reasoning });
      }
      if (typeof d.content === 'string' && d.content) {
        await this.start();
        if (this.current?.kind !== 'message') await this.open('message');
        this.current.text += d.content;
        this.outputText += d.content;
        await this.ev('response.output_text.delta', { item_id: this.current.item.id, output_index: this.current.index, content_index: 0, delta: d.content, logprobs: [] });
      }
      for (const tc of d.tool_calls || []) {
        await this.start();
        const idx = tc.index ?? this.toolCalls.size;
        let acc = this.toolCalls.get(idx);
        if (!acc) { acc = { id: tc.id || newId('call_'), name: '', args: '' }; this.toolCalls.set(idx, acc); }
        if (tc.id) acc.id = tc.id;
        this.toolInputBytes += Buffer.byteLength(JSON.stringify(tc));
        if (this.toolInputBytes > 16 * 1024 * 1024) throw new Error('Upstream tool input exceeds the compatibility buffer limit');
        if (tc.function?.name) acc.name += tc.function.name;
        if (typeof tc.function?.arguments === 'string') acc.args += tc.function.arguments;
        else if (tc.function?.arguments && typeof tc.function.arguments === 'object') acc.args = JSON.stringify(tc.function.arguments);
      }
      if (ch.finish_reason) this.finishReason = ch.finish_reason;
    }
  }

  async flushToolCalls() {
    await this.closeCurrent();
    const entries = [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0]);
    this.toolCalls.clear();
    for (const [, tc] of entries) {
      const index = this.output.length;
      let item;
      if (this.ctx.isCustomTool(tc.name)) {
        item = this.ctx.outputCall(tc.name, tc.args, tc.id, newId('ctc_'));
        const input = item.input;
        this.output.push(item);
        await this.ev('response.output_item.added', { output_index: index, item: { ...item, input: '', status: 'in_progress' } });
        await this.ev('response.custom_tool_call_input.delta', { item_id: item.id, output_index: index, delta: input });
        await this.ev('response.custom_tool_call_input.done', { item_id: item.id, output_index: index, input });
      } else if (tc.name === 'local_shell' && this.ctx.localShell) {
        let action = {};
        try { action = JSON.parse(tc.args || '{}'); } catch {}
        item = { id: newId('lsh_'), type: 'local_shell_call', status: 'completed', call_id: tc.id, action: { type: 'exec', ...action } };
        this.output.push(item);
        await this.ev('response.output_item.added', { output_index: index, item });
      } else {
        const args = tc.args || '{}';
        item = this.ctx.outputCall(tc.name, args, tc.id, newId('fc_'));
        this.output.push(item);
        await this.ev('response.output_item.added', { output_index: index, item: { ...item, arguments: '', status: 'in_progress' } });
        await this.ev('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: args });
        await this.ev('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: args, name: item.name });
      }
      await this.ev('response.output_item.done', { output_index: index, item });
    }
  }

  isEmpty() {
    return this.output.length === 0 && this.toolCalls.size === 0;
  }

  async finish() {
    await this.flushToolCalls();
    const truncated = this.finishReason === 'length';
    const resp = {
      ...this.baseResponse(truncated ? 'incomplete' : 'completed'),
      completed_at: nowUnix(),
      incomplete_details: truncated ? { reason: 'max_output_tokens' } : null,
      output: this.output,
      output_text: this.outputText,
      usage: mapUsage(this.usage),
    };
    await this.ev(truncated ? 'response.incomplete' : 'response.completed', { response: resp });
    return resp;
  }

  async fail(message) {
    await this.closeCurrent().catch(() => {});
    await this.ev('response.failed', {
      response: { ...this.baseResponse('failed'), output: this.output, error: { code: 'server_error', message } },
    });
  }
}

// ───────────────────── /v1/responses ─────────────────────

async function handleResponses(req, res) {
  const auth = authHeader(req.headers);
  if (!auth) return sendError(res, 401, 'Missing API key');
  let r;
  try { r = await readJSON(req); } catch (e) { return sendError(res, e.statusCode || 400, e.message); }

  if (r.previous_response_id) {
    return sendError(res, 400, 'previous_response_id is not supported by this stateless proxy; send full input (store=false)');
  }

  let chat, ctx;
  try { ({ chat, ctx } = responsesToChat(r)); } catch (e) { return sendError(res, 400, e.message); }
  if (!chat.messages.some((m) => m.role !== 'system')) return sendError(res, 400, 'input is required');

  const stream = r.stream === true;
  const ac = withAbort(req, res);
  const t0 = Date.now();
  log('debug', 'responses request', {
    model: r.model, stream, messages: chat.messages.length, tools: chat.tools?.length || 0,
    toolTypes: [...new Set((r.tools || []).map((t) => t.type))],
    itemTypes: [...new Set((Array.isArray(r.input) ? r.input : []).map((i) => i.type || 'message'))],
  });

  let up;
  try {
    up = await callUpstream('/chat/completions', chat, auth, ac.signal);
  } catch (e) {
    if (ac.signal.aborted) return;
    log('error', 'upstream fetch failed', { path: 'responses', error: e.message });
    return sendError(res, 502, 'Upstream request failed: ' + e.message);
  }
  if (!up.ok) {
    const text = await up.text().catch(() => '');
    log('warn', 'upstream error', { path: 'responses', status: up.status, body: text.slice(0, 300) });
    return sendError(res, up.status, upstreamErrorMessage(text));
  }

  // 流式输出在收到第一个有效内容后才写响应头，这样空响应/早期错误还能返回正常的 HTTP 错误码，
  // 让 Aether 可以重试或切换候选。
  let headersSent = false;
  const emit = stream
    ? async (type, payload) => {
        if (!headersSent) { res.writeHead(200, SSE_HEADERS); headersSent = true; }
        await writeAndDrain(res, `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    : null;
  const b = new ResponsesBuilder(r, ctx, emit);

  let upstreamErr = null;
  try {
    for await (const data of sseData(up, ac.signal)) {
      if (data === '[DONE]') break;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      j = unwrap(j);
      if (j?.error && !j.choices) { upstreamErr = upstreamErrorMessage(JSON.stringify(j)); break; }
      await b.onChunk(j);
    }
  } catch (e) {
    if (ac.signal.aborted) return;
    upstreamErr = e.message;
  }
  if (ac.signal.aborted) return;
  if (!upstreamErr && !b.finishReason) upstreamErr = 'Upstream stream ended without a finish reason';

  if (upstreamErr) {
    log('warn', 'responses upstream stream error', { error: upstreamErr, ms: Date.now() - t0 });
    if (!headersSent) return sendError(res, 502, 'Upstream error: ' + upstreamErr);
    await b.fail(upstreamErr);
    return res.end();
  }
  if (b.isEmpty()) {
    log('warn', 'empty upstream response', { ms: Date.now() - t0, finish: b.finishReason });
    if (!headersSent) return sendError(res, 502, 'Empty response from upstream');
  }

  let resp;
  try { resp = await b.finish(); } catch (e) {
    log('warn', 'responses compatibility error', { error: e.message });
    if (!headersSent) return sendError(res, 502, e.message);
    await b.fail(e.message);
    return res.end();
  }
  log('info', 'responses done', {
    stream, model: r.model, ms: Date.now() - t0, items: resp.output.map((o) => o.type).join(','),
    in: resp.usage.input_tokens, out: resp.usage.output_tokens, finish: b.finishReason,
  });
  if (stream) return res.end();
  return sendJSON(res, 200, resp);
}

// ───────────────────── /v1/models ─────────────────────

async function handleModels(req, res) {
  const auth = authHeader(req.headers);
  try {
    const up = await fetch(UPSTREAM + '/models', { headers: auth ? { Authorization: auth } : {} });
    const text = await up.text();
    if (!up.ok) return sendError(res, up.status, upstreamErrorMessage(text));
    let j = unwrap(JSON.parse(text));
    if (Array.isArray(j)) j = { object: 'list', data: j };
    return sendJSON(res, 200, j);
  } catch (e) {
    return sendError(res, 502, e.message);
  }
}

// ───────────────────── server ─────────────────────

const server = http.createServer(async (req, res) => {
  const path = (req.url || '').split('?')[0].replace(/\/+$/, '');
  try {
    if (req.method === 'GET' && (path === '/health' || path === '')) return sendJSON(res, 200, { ok: true, upstream: UPSTREAM });
    if (req.method === 'POST' && /^(\/v1)?\/chat\/completions$/.test(path)) return await handleChat(req, res);
    if (req.method === 'POST' && /^(\/v1)?\/responses$/.test(path)) return await handleResponses(req, res);
    if (req.method === 'GET' && /^(\/v1)?\/models$/.test(path)) return await handleModels(req, res);
    return sendError(res, 404, `Not found: ${req.method} ${path}`);
  } catch (e) {
    log('error', 'unhandled', { path, error: e.stack || e.message });
    if (!res.headersSent) sendError(res, 500, 'Internal proxy error: ' + e.message);
    else try { res.end(); } catch {}
  }
});
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;
server.listen(PORT, HOST, () => log('info', 'cline-proxy listening', { host: HOST, port: PORT, upstream: UPSTREAM }));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); setTimeout(() => process.exit(0), 2000).unref(); });
}
