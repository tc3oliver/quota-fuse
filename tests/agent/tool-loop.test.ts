/**
 * Agent tool-loop E2E (QuotaFuse upstream is ALWAYS a mock; zero real OpenAI traffic).
 *
 * This file drives COMPLETE agent loops through the proxy the way OpenCode does
 * over POST /v1/chat/completions (store:false, stream_options, chat-format local
 * function tools), plus the native POST /v1/responses loop:
 *
 *   declare local functions -> model returns function_call(s) ->
 *   execute REAL local tools (fs read + real subprocess) ->
 *   return function_call_output / role:tool -> model continues -> final answer
 *
 * Every logical request uses a unique Idempotency-Key. The mock upstream counts
 * every call; any test that expects zero dispatch asserts seen.length === 0.
 * process.env.OPENAI_API_KEY is always a fake value in this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeServer } from '../../src/server.ts';
import { cfg, verifiedLedger } from '../helpers.ts';
import { Ledger } from '../../src/ledger.ts';
import { utcDay } from '../../src/config.ts';

const MODEL = 'gpt-test-2026-10-11';
const TOKEN = 'agent-e2e-proxy-token-long-enough-1234567890';
process.env.QG_PROXY_TOKEN = TOKEN;
process.env.OPENAI_API_KEY = 'mock-key-never-sent-anywhere';

const children: ChildProcess[] = [];
const servers: { close: () => Promise<void> }[] = [];
test.after(async () => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const s of servers) { try { await s.close(); } catch { /* gone */ } }
  assert.equal(process.env.OPENAI_API_KEY, 'mock-key-never-sent-anywhere');
});

// ---- mock upstream -------------------------------------------------------
interface Seen { url: string; headers: any; body: any }
function mockUpstream(seen: Seen[], behavior: (n: number, url: string, body: any) => Response): typeof fetch {
  let n = 0;
  return (async (url: any, init: any) => {
    const u = String(url);
    // Fail-closed test invariant: the ONLY network the proxy may touch is the
    // stubbed upstream. This stub performs zero real I/O by construction.
    assert.match(u, /^https:\/\/api\.openai\.com\/v1\//);
    const body = init?.body ? JSON.parse(init.body) : null;
    if (u.endsWith('/responses/input_tokens')) {
      seen.push({ url: u, headers: init?.headers, body });
      return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 25 }), { status: 200 });
    }
    n++;
    seen.push({ url: u, headers: init?.headers, body });
    // Only server-side credentials may leave the proxy.
    assert.equal(init?.headers?.Authorization, 'Bearer mock-key-never-sent-anywhere');
    return behavior(n, u, body);
  }) as typeof fetch;
}
const textResp = (message: string, input = 40, output = 12) => ({
  id: 'resp_' + randomUUID().slice(0, 8), object: 'response', model: MODEL, status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message }] }],
  usage: { input_tokens: input, output_tokens: output },
});
const callResp = (calls: { call_id: string; name: string; args: unknown }[]) => ({
  id: 'resp_call', object: 'response', model: MODEL, status: 'completed',
  output: calls.map((c) => ({ type: 'function_call', id: c.call_id, call_id: c.call_id, name: c.name, arguments: JSON.stringify(c.args) })),
  usage: { input_tokens: 40, output_tokens: 12 },
});
/** Scripted "model": tool result in history -> final text, else -> function call(s).
 *  Speaks Responses SSE when the client asked for stream:true (like OpenAI). */
function agenticBehavior(calls: { call_id: string; name: string; args: unknown }[], finalText: string) {
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return (_n: number, _url: string, body: any): Response => {
    const blob = JSON.stringify(body?.input ?? body);
    const hasResult = blob.includes('function_call_output') || blob.includes('"role":"tool"');
    const full = hasResult ? textResp(finalText) : callResp(calls);
    if (body?.stream === true) {
      const head = frame('response.created', { type: 'response.created' });
      const tail = frame('response.completed', { response: full });
      const mid = hasResult
        ? frame('response.output_text.delta', { delta: finalText })
        : (full as any).output.map((c: any) =>
          frame('response.output_item.added', { output_index: 0, item: { type: 'function_call', name: c.name, call_id: c.call_id } })
          + frame('response.function_call_arguments.delta', { output_index: 0, delta: c.arguments })).join('');
      return new Response(head + mid + tail, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(full), { status: 200 });
  };
}
// ---- proxy harness ---------------------------------------------------------
async function startProxy(behavior: (n: number, url: string, body: any) => Response, mutateCfg?: (c: any) => void, baselinePremium?: number) {
  const c = cfg();
  mutateCfg?.(c);
  const ledger = baselinePremium === undefined ? verifiedLedger() : (() => {
    const l = new Ledger(':memory:');
    l.recordObservation(utcDay(), 'premium', baselinePremium);
    l.recordObservation(utcDay(), 'economy', 0);
    l.setPause(null);
    return l;
  })();
  const seen: Seen[] = [];
  const server = makeServer(c, ledger, { fetchImpl: mockUpstream(seen, behavior) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  let closed = false;
  const rec = { base, seen, ledger, close: () => new Promise<void>((r) => {
    if (closed) return r();
    closed = true;
    server.close(() => { try { ledger.close(); } catch { /* already closed */ } r(); });
  }) };
  servers.push(rec);
  return rec;
}
const baseHeaders = () => ({
  Authorization: `Bearer ${TOKEN}`,
  'Idempotency-Key': randomUUID(), // every logical request unique
  'X-Quota-Guard-Data-Classification': 'public',
  'Content-Type': 'application/json',
});
async function postChat(base: string, body: any, stream = false) {
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: baseHeaders(), body: JSON.stringify(body) });
  return stream ? r : { status: r.status, json: async () => r.json() as any, text: async () => r.text() };
}
// ---- REAL local tools (executed by the harness, not mocked) ----------------
const fixtureDir = mkdtempSync(join(tmpdir(), 'qf-agent-'));
const PUBLIC_FILE = join(fixtureDir, 'public-notes.txt');
const FILE_CONTENT = 'QF public fixture alpha bravo 42';
writeFileSync(PUBLIC_FILE, FILE_CONTENT);
function runLocalTool(name: string, args: any): string {
  if (name === 'read_file') return readFileSync(String(args.path), 'utf8'); // real fs read
  if (name === 'run_cmd') return execFileSync('/bin/echo', [String(args.text ?? '')], { encoding: 'utf8' }).trim(); // real subprocess
  throw new Error('unknown tool ' + name);
}
const CHAT_TOOLS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a local public file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, strict: true } },
  { type: 'function', function: { name: 'run_cmd', description: 'Echo text via subprocess', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, strict: true } },
];
const chatBase = (messages: any[], extra: any = {}) => ({
  model: MODEL, messages, max_completion_tokens: 512, stream: false,
  stream_options: { include_usage: true }, store: false, tools: CHAT_TOOLS, ...extra,
});
/** Read a fetch Response body exactly once, then parse (avoids double-read). */
async function readJson(r: Response): Promise<any> {
  const t = await r.text();
  assert.equal(r.status, 200, t.slice(0, 300));
  return JSON.parse(t);
}
/** Minimal chat-SSE parser for the adapter streaming turn. */
function parseChatSSE(t: string): any {
  assert.match(t, /\[DONE\]/);
  let content = '';
  let finish = '';
  for (const part of t.split('\n\n')) {
    const line = part.split('\n').find((l) => l.startsWith('data:'));
    if (!line || line.includes('[DONE]')) continue;
    const chunk = JSON.parse(line.slice(5).trim());
    content += chunk.choices[0].delta?.content ?? '';
    for (const tc of chunk.choices[0].delta?.tool_calls ?? []) content += tc.function?.arguments ?? '';
    if (chunk.choices[0].finish_reason) finish = chunk.choices[0].finish_reason;
  }
  return { choices: [{ finish_reason: finish || 'stop', message: { content, tool_calls: undefined } }] };
}
async function agentLoop(base: string, firstUser: string, keys: string[]): Promise<string> {
  const messages: any[] = [{ role: 'user', content: firstUser }];
  for (let turn = 0; turn < 4; turn++) {
    const key = randomUUID();
    keys.push(key);
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...baseHeaders(), 'Idempotency-Key': key },
      body: JSON.stringify(chatBase(messages)),
    });
    const j = await readJson(r);
    const msg = j.choices[0].message;
    if (j.choices[0].finish_reason === 'stop') return msg.content as string;
    assert.equal(j.choices[0].finish_reason, 'tool_calls');
    messages.push({ role: 'assistant', content: null, tool_calls: msg.tool_calls });
    for (const tc of msg.tool_calls) {
      const out = runLocalTool(tc.function.name, JSON.parse(tc.function.arguments));
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out });
    }
  }
  throw new Error('loop did not converge');
}

// ---- tests -----------------------------------------------------------------
test('agent loop: declare -> function_call -> REAL fs read -> tool result -> final answer', async () => {
  const keys: string[] = [];
  const h = await startProxy(agenticBehavior(
    [{ call_id: 'call_1', name: 'read_file', args: { path: PUBLIC_FILE } }],
    `Summary: ${FILE_CONTENT}`,
  ));
  try {
    const final = await agentLoop(h.base, 'Summarize the fixture file.', keys);
    assert.match(final, /alpha bravo 42/); // model continued with the real tool output
    assert.equal(new Set(keys).size, keys.length); // every logical request unique
    assert.equal(h.seen.filter((s) => s.url.endsWith('/responses')).length, 2);
    // history + tool schema went through preflight and generation intact
    const gen = h.seen.find((s) => s.url.endsWith('/responses'))!;
    assert.equal(gen.body.tools[0].name, 'read_file');
    const second = h.seen.filter((s) => s.url.endsWith('/responses'))[1];
    assert.match(JSON.stringify(second.body.input), /alpha bravo 42/);
    // usage settled from the mock provider numbers
    for (const k of keys) assert.equal(h.ledger.find(k)?.state, 'COMPLETED');
    assert.equal(h.ledger.find(keys[1])?.actual, 52);
  } finally { await h.close(); }
});

test('agent loop: parallel function calls execute and both results return', async () => {
  const keys: string[] = [];
  const h = await startProxy(agenticBehavior(
    [
      { call_id: 'call_a', name: 'read_file', args: { path: PUBLIC_FILE } },
      { call_id: 'call_b', name: 'run_cmd', args: { text: 'qp-parallel' } },
    ],
    'combined done',
  ));
  try {
    const messages: any[] = [{ role: 'user', content: 'Do both things.' }];
    const r1 = await postChat(h.base, { ...chatBase(messages), parallel_tool_calls: true }) as any;
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.equal(j1.choices[0].finish_reason, 'tool_calls');
    assert.equal(j1.choices[0].message.tool_calls.length, 2);
    messages.push({ role: 'assistant', content: null, tool_calls: j1.choices[0].message.tool_calls });
    for (const tc of j1.choices[0].message.tool_calls)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: runLocalTool(tc.function.name, JSON.parse(tc.function.arguments)) });
    const r2 = await postChat(h.base, chatBase(messages)) as any;
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).choices[0].message.content, 'combined done');
    const secondGen = h.seen.filter((s) => s.url.endsWith('/responses'))[1];
    assert.match(JSON.stringify(secondGen.body.input), /alpha bravo 42/);
    assert.match(JSON.stringify(secondGen.body.input), /qp-parallel/);
    keys.push('k1', 'k2');
  } finally { await h.close(); }
});

test('native Responses loop with function_call items and real subprocess output', async () => {
  const h = await startProxy(agenticBehavior(
    [{ call_id: 'rc1', name: 'run_cmd', args: { text: 'real-subprocess-ok' } }],
    'got real-subprocess-ok back',
  ));
  try {
    const tools = [{ type: 'function', name: 'run_cmd', description: 'Echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, strict: true }];
    const h1 = { ...baseHeaders(), 'Idempotency-Key': randomUUID() };
    const r1 = await fetch(h.base + '/v1/responses', { method: 'POST', headers: h1, body: JSON.stringify({ model: MODEL, input: 'Echo something.', max_output_tokens: 128, tools, tool_choice: 'auto' }) });
    assert.equal(r1.status, 200);
    const j1 = await r1.json() as any;
    assert.equal(j1.output[0].type, 'function_call');
    const out = runLocalTool(j1.output[0].name, JSON.parse(j1.output[0].arguments));
    assert.equal(out, 'real-subprocess-ok');
    const r2 = await fetch(h.base + '/v1/responses', {
      method: 'POST', headers: { ...baseHeaders(), 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        model: MODEL, max_output_tokens: 128,
        input: [{ role: 'user', content: 'Echo something.' }, { type: 'function_call', name: 'run_cmd', call_id: 'rc1', arguments: JSON.stringify({ text: 'real-subprocess-ok' }) }, { type: 'function_call_output', call_id: 'rc1', output: out }],
      }),
    });
    assert.equal(r2.status, 200);
    assert.match((await r2.json() as any).output[0].content[0].text, /real-subprocess-ok/);
  } finally { await h.close(); }
});

test('chat JSON + SSE streaming stay compatible (text and tool-call deltas)', async () => {
  // text stream
  const sseText = 'event: response.created\ndata: {"type":"response.created"}\n\n'
    + 'event: response.output_text.delta\ndata: {"delta":"hel"}\n\n'
    + 'event: response.output_text.delta\ndata: {"delta":"lo"}\n\n'
    + `event: response.completed\ndata: ${JSON.stringify({ response: textResp('hello') })}\n\n`;
  const h = await startProxy((_n, url) => new Response(sseText, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  try {
    const r = await fetch(h.base + '/v1/chat/completions', { method: 'POST', headers: baseHeaders(), body: JSON.stringify(chatBase([{ role: 'user', content: 'hi' }], { stream: true })) });
    assert.equal(r.status, 200);
    const t = await r.text();
    assert.match(t, /chat\.completion\.chunk/);
    assert.match(t, /\[DONE\]/);
  } finally { await h.close(); }
  // tool-call stream: proxy reindexes parallel chunks for chat
  const complete = {
    id: 'rp', model: MODEL, status: 'completed',
    output: [{ type: 'function_call', name: 'read_file', call_id: 'c1', arguments: '{"path":"p"}' }],
    usage: { input_tokens: 40, output_tokens: 12 },
  };
  const frames = [
    { type: 'response.created' },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'read_file', call_id: 'c1' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"p"}' },
    { type: 'response.completed', response: complete },
  ].map((f: any) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('');
  const h2 = await startProxy((_n, url) => {
    if (String(url).endsWith('/responses')) return new Response(frames, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    throw new Error('unreachable');
  });
  try {
    const r = await fetch(h2.base + '/v1/chat/completions', { method: 'POST', headers: baseHeaders(), body: JSON.stringify(chatBase([{ role: 'user', content: 'read it' }], { stream: true })) });
    assert.equal(r.status, 200);
    const t = await r.text();
    assert.match(t, /tool_calls/);
    assert.match(t, /read_file/);
    assert.match(t, /\[DONE\]/);
  } finally { await h2.close(); }
});

test('idempotency: every logical request unique; reuse is 409 with zero redispatch', async () => {
  const h = await startProxy(agenticBehavior([], 'done'));
  try {
    const fixed = { ...baseHeaders(), 'Idempotency-Key': 'agent-logical-req-0001' };
    const body = chatBase([{ role: 'user', content: 'hi' }]);
    // prime history so the scripted model answers text immediately: no tools declared
    const { tools: _t, ...noTools } = body;
    const r1 = await fetch(h.base + '/v1/chat/completions', { method: 'POST', headers: fixed, body: JSON.stringify(noTools) });
    assert.equal(r1.status, 200);
    const before = h.seen.length;
    const r2 = await fetch(h.base + '/v1/chat/completions', { method: 'POST', headers: fixed, body: JSON.stringify(noTools) });
    assert.equal(r2.status, 409);
    assert.equal(((await r2.json()) as any).error.code, 'DUPLICATE_REQUEST');
    assert.equal(h.seen.length, before);
  } finally { await h.close(); }
});

test('hosted tools, remote MCP and multimodal are rejected with zero upstream calls', async () => {
  const h = await startProxy(() => { throw new Error('must not dispatch'); });
  try {
    const msg = [{ role: 'user', content: 'hi' }];
    const cases: any[] = [
      chatBase(msg, { tools: [{ type: 'web_search' }] }),
      chatBase(msg, { tools: [{ type: 'mcp', server_url: 'https://x.example' }] }),
      chatBase([{ role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_image', image_url: 'https://x' }] }]),
      { model: MODEL, input: [{ role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_audio', audio: 'x' }] }], max_output_tokens: 32 },
    ];
    for (const [i, b] of cases.entries()) {
      const path = i < 3 ? '/v1/chat/completions' : '/v1/responses';
      const r = await fetch(h.base + path, { method: 'POST', headers: baseHeaders(), body: JSON.stringify(b) });
      assert.equal(r.status, 403, `case ${i}: ` + await r.text().then((t) => t.slice(0, 200)));
    }
    assert.equal(h.seen.length, 0);
  } finally { await h.close(); }
});

test('quota exhausted and upstream/timeout failures stay fail-closed (UNKNOWN kept)', async () => {
  // exhausted: 85% ceiling of 1M already committed
  const full = await startProxy(agenticBehavior([], 'never'), undefined, 850000);
  try {
    const r = await postChat(full.base, chatBase([{ role: 'user', content: 'hi' }])) as any;
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error.code, 'FREE_QUOTA_EXHAUSTED');
    assert.equal(full.seen.length, 0);
  } finally { await full.close(); }
  // upstream 500 -> 503 + UNKNOWN reservation retained
  const bad = await startProxy((_n, url) => {
    if (String(url).endsWith('/responses')) return new Response('oops', { status: 500 });
    throw new Error('unreachable');
  });
  const badKey = randomUUID();
  try {
    const r = await fetch(bad.base + '/v1/chat/completions', { method: 'POST', headers: { ...baseHeaders(), 'Idempotency-Key': badKey }, body: JSON.stringify(chatBase([{ role: 'user', content: 'hi' }])) });
    assert.equal(r.status, 503);
    assert.equal(bad.ledger.find(badKey)?.state, 'UNKNOWN');
  } finally { await bad.close(); }
  // timeout-style abort -> 503 + UNKNOWN
  const slow = await startProxy(() => { throw new DOMException('The operation timed out', 'TimeoutError'); });
  const slowKey = randomUUID();
  try {
    const r = await fetch(slow.base + '/v1/chat/completions', { method: 'POST', headers: { ...baseHeaders(), 'Idempotency-Key': slowKey }, body: JSON.stringify(chatBase([{ role: 'user', content: 'hi' }])) });
    assert.equal(r.status, 503);
    assert.equal(slow.ledger.find(slowKey)?.state, 'UNKNOWN');
  } finally { await slow.close(); }
});

test('OpenCode-shaped request passes: store:false + stream_options accepted, unbounded output still blocked', async () => {
  const h = await startProxy(agenticBehavior([], 'title-ok'));
  try {
    // exact OpenCode wire shape (title call has no max_completion_tokens)
    const bare: any = { model: MODEL, messages: [{ role: 'user', content: 't' }], stream: false, stream_options: { include_usage: true }, store: false };
    const r0 = await fetch(h.base + '/v1/chat/completions', { method: 'POST', headers: baseHeaders(), body: JSON.stringify(bare) });
    assert.equal(r0.status, 403); // fail-closed: no silent default bound in the proxy
    assert.equal(h.seen.length, 0);
    const bounded = { ...bare, max_completion_tokens: 64 };
    const r1 = await fetch(h.base + '/v1/chat/completions', { method: 'POST', headers: baseHeaders(), body: JSON.stringify(bounded) });
    assert.equal(r1.status, 200);
    assert.equal(h.seen.length, 2); // preflight + generation, nothing else
  } finally { await h.close(); }
});

test('adapter: full agent loop through the header shim with zero client-side keys', async () => {
  const h = await startProxy(agenticBehavior(
    [{ call_id: 'ak1', name: 'read_file', args: { path: PUBLIC_FILE } }],
    `Summary: ${FILE_CONTENT}`,
  ));
  const port = 18878 + (process.pid % 1000);
  const adapter = spawn('node', ['--disable-warning=ExperimentalWarning', 'examples/opencode-adapter.mjs', '--listen', `127.0.0.1:${port}`, '--target', h.base], { cwd: join(import.meta.dirname, '..', '..') });
  children.push(adapter);
  try {
    await sleep(800);
    // client sends NO Idempotency-Key and NO max_completion_tokens: adapter stamps both.
    // Second turn streams (like OpenCode) to cover SSE piping through the shim.
    const messages: any[] = [{ role: 'user', content: 'Summarize the fixture.' }];
    let final = '';
    for (let turn = 0; turn < 4; turn++) {
      const stream = turn === 1;
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, stream, stream_options: { include_usage: true }, store: false, tools: CHAT_TOOLS }),
      });
      const t = await r.text();
      assert.equal(r.status, 200, `adapter turn ${turn}: ` + t.slice(0, 300));
      const j = stream ? parseChatSSE(t) : JSON.parse(t);
      if (j.choices[0].finish_reason === 'stop') { final = j.choices[0].message.content; break; }
      messages.push({ role: 'assistant', content: null, tool_calls: j.choices[0].message.tool_calls });
      for (const tc of j.choices[0].message.tool_calls)
        messages.push({ role: 'tool', tool_call_id: tc.id, content: runLocalTool(tc.function.name, JSON.parse(tc.function.arguments)) });
    }
    assert.match(final, /alpha bravo 42/);
    assert.ok(h.seen.filter((s) => s.url.endsWith('/responses')).length >= 2);
  } finally {
    adapter.kill('SIGKILL');
    await h.close();
  }
});
