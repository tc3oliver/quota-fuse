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
 * It never sees OpenAI project/Admin keys: Authorization passes through
 * untouched as the QuotaFuse proxy token, and it only forwards to the local
 * QuotaFuse proxy (default http://127.0.0.1:8787).
 * If the client retries a byte-identical POST within 10 minutes, the adapter
 * reuses its idempotency key so QuotaFuse rejects duplicate dispatch. That
 * best-effort guard is not durable across restarts: never blindly retry an
 * uncertain request, including after an adapter restart.
 *
 * Usage:
 *   node examples/opencode-adapter.mjs [--listen 127.0.0.1:18878] [--target http://127.0.0.1:8787]
 *   QF_DEFAULT_MAX_TOKENS=256 node examples/opencode-adapter.mjs
 *
 * Then point OpenCode at http://127.0.0.1:18878/v1 with your QG_PROXY_TOKEN
 * as the provider credential. The agent MUST explicitly attest public-only
 * request data in its provider headers; this adapter never silently labels
 * arbitrary workspace files as public. See docs/opencode-agent.md.
 */
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const [listenHost, listenPort] = (opt('--listen', '127.0.0.1:18878')).split(':');
const target = new URL(opt('--target', process.env.QF_TARGET ?? 'http://127.0.0.1:8787'));
const defaultMaxTokens = Number(process.env.QF_DEFAULT_MAX_TOKENS ?? '256');
const maxBodyBytes = 2 * 1024 * 1024; // never buffer more than QuotaFuse's default maxRequestBytes
if (listenHost !== '127.0.0.1' || !Number.isInteger(Number(listenPort)) ||
    Number(listenPort) < 1 || Number(listenPort) > 65535)
  throw new Error('Adapter must bind to a valid 127.0.0.1 port');
if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:' ||
    target.username || target.password || target.search || target.hash || target.pathname !== '/')
  throw new Error('Adapter only forwards to a local HTTP QuotaFuse origin');
if (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens < 1 || defaultMaxTokens > 4096)
  throw new Error('QF_DEFAULT_MAX_TOKENS must be an integer between 1 and 4096');
 
// A blind HTTP retry does not necessarily mean a new logical model request.
// Reuse the same admission key for identical requests within a short window:
// QuotaFuse will respond 409 after the first admission rather than double-dispatch.
// This in-memory protection is NOT durable across adapter restarts.
const replayWindowMs = 10 * 60 * 1000;
const replayKeys = new Map(); // fingerprint -> {key, expires}
function admissionKey(req, body, headers) {
  const fingerprint = createHash('sha256')
    .update(req.method ?? '').update('\0').update(req.url ?? '').update('\0')
    .update(typeof headers.authorization === 'string' ? headers.authorization : '')
    .update('\0').update(body).digest('hex');
  const now = Date.now();
  const seen = replayKeys.get(fingerprint);
  if (seen && seen.expires > now) return seen.key;
  if (replayKeys.size >= 10000) {
    for (const [f, entry] of replayKeys) if (entry.expires <= now) replayKeys.delete(f);
    // Never evict an active key and risk treating an old retry as new.
    if (replayKeys.size >= 10000) return null;
  }
  const key = randomUUID();
  replayKeys.set(fingerprint, { key, expires: now + replayWindowMs });
  return key;
}

const KEY_RE = /^[a-zA-Z0-9._:-]{8,128}$/;

const server = http.createServer((clientReq, clientRes) => {
  if (clientReq.socket.remoteAddress !== '127.0.0.1' && clientReq.socket.remoteAddress !== '::ffff:127.0.0.1') {
    clientRes.writeHead(403, { 'Content-Type': 'application/json' });
    clientRes.end('{"error":"local only"}');
    clientReq.resume();
    return;
  }
  const chunks = [];
  let received = 0, tooLarge = false;
  clientReq.on('data', (c) => {
    received += c.length;
    if (received > maxBodyBytes) {
      if (!tooLarge) {
        tooLarge = true;
        clientRes.writeHead(413, { 'Content-Type': 'application/json' });
        clientRes.end('{"error":"request body too large"}');
      }
    } else if (!tooLarge) chunks.push(c);
  });
  clientReq.on('end', () => {
    if (tooLarge) return;
    const raw = Buffer.concat(chunks);
    const headers = { ...clientReq.headers };
    delete headers.host;
    delete headers['content-length'];
    // Never invent a public-data classification: the calling agent/user
    // must explicitly attest that the material is safe for Data Sharing.
    // The upstream QuotaFuse policy rejects requests missing that header.
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
    // Mint a stable key for the logical request after applying any title cap.
    // A byte-identical retry within the replay window reuses this key and
    // therefore cannot silently dispatch a second generation.
    if (clientReq.method === 'POST' &&
        (typeof headers['idempotency-key'] !== 'string' || !KEY_RE.test(headers['idempotency-key']))) {
      const key = admissionKey(clientReq, body, headers);
      if (key === null) {
        clientRes.writeHead(503, { 'Content-Type': 'application/json' });
        clientRes.end('{"error":"adapter replay guard full; failing closed"}');
        return;
      }
      headers['idempotency-key'] = key;
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
