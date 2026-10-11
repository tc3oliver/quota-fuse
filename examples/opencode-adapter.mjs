#!/usr/bin/env node
/**
 * QuotaFuse OpenCode adapter (minimal, local-only).
 *
 * Why this exists: QuotaFuse requires a UNIQUE `Idempotency-Key` per logical
 * request (reuse is rejected, not replayed) plus an explicit
 * `X-Quota-Guard-Data-Classification: public` attestation and a bounded
 * `max_completion_tokens`. OpenCode's static provider `headers` config cannot
 * mint a fresh key per request, so this tiny shim sits between OpenCode and
 * the proxy on 127.0.0.1 and stamps those headers per HTTP request.
 *
 * It never sees your OpenAI keys: Authorization passes through untouched, and
 * it only forwards to the local QuotaFuse proxy (default http://127.0.0.1:8787).
 *
 * Usage:
 *   node examples/opencode-adapter.mjs [--listen 127.0.0.1:18878] [--target http://127.0.0.1:8787]
 *   QF_DEFAULT_MAX_TOKENS=256 node examples/opencode-adapter.mjs
 *
 * Then point OpenCode at http://127.0.0.1:18878/v1 with your QG_PROXY_TOKEN
 * as the provider credential. See docs/opencode-agent.md.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const [listenHost, listenPort] = (opt('--listen', '127.0.0.1:18878')).split(':');
const target = new URL(opt('--target', process.env.QF_TARGET ?? 'http://127.0.0.1:8787'));
const defaultMaxTokens = Number(process.env.QF_DEFAULT_MAX_TOKENS ?? '256');
if (target.hostname !== '127.0.0.1' || (target.protocol !== 'http:' && target.protocol !== 'https:'))
  throw new Error('Refusing non-local adapter target');

const KEY_RE = /^[a-zA-Z0-9._:-]{8,128}$/;

const server = http.createServer((clientReq, clientRes) => {
  if (clientReq.socket.remoteAddress !== '127.0.0.1' && clientReq.socket.remoteAddress !== '::ffff:127.0.0.1') {
    clientRes.writeHead(403, { 'Content-Type': 'application/json' });
    clientRes.end('{"error":"local only"}');
    clientReq.resume();
    return;
  }
  const chunks = [];
  clientReq.on('data', (c) => chunks.push(c));
  clientReq.on('end', () => {
    const raw = Buffer.concat(chunks);
    const headers = { ...clientReq.headers };
    delete headers.host;
    delete headers['content-length'];
    // Per-request uniqueness: QuotaFuse rejects key reuse, so a static
    // configured header can never work for an agent loop. Mint one per POST
    // unless the client already supplied a valid stable key.
    if (clientReq.method === 'POST' && (typeof headers['idempotency-key'] !== 'string' || !KEY_RE.test(headers['idempotency-key'])))
      headers['idempotency-key'] = randomUUID();
    if (typeof headers['x-quota-guard-data-classification'] !== 'string')
      headers['x-quota-guard-data-classification'] = 'public';
    let body = raw;
    // OpenCode's title/summary calls omit max_completion_tokens; QuotaFuse
    // fail-closed requires an explicit bound, so apply a small default.
    if (clientReq.method === 'POST' && clientReq.url === '/v1/chat/completions' && raw.length) {
      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        if (parsed && typeof parsed === 'object' && parsed.max_completion_tokens === undefined) {
          parsed.max_completion_tokens = defaultMaxTokens;
          body = Buffer.from(JSON.stringify(parsed));
        }
      } catch { /* leave body untouched; proxy will return 400 */ }
    }
    const upstream = http.request({
      hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: clientReq.url, method: clientReq.method, headers,
    }, (upRes) => {
      clientRes.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(clientRes);
    });
    upstream.on('error', () => {
      if (!clientRes.headersSent) clientRes.writeHead(503, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { type: 'adapter_upstream_unreachable', code: 'FREE_QUOTA_UNVERIFIED', message: 'QuotaFuse proxy unreachable; failing closed.' } }));
    });
    upstream.end(body);
  });
});

server.listen(Number(listenPort), listenHost, () => {
  console.error(`quota-fuse opencode adapter: ${listenHost}:${listenPort} -> ${target}`);
});
