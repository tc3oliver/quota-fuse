import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { utcDay, type Config } from './config.ts';
import { Ledger, LedgerError } from './ledger.ts';
import { Denial, classify, gate, validateRequest } from './policy.ts';

const statusCode = (e: unknown) => e instanceof LedgerError ? (
  e.code === 'FREE_QUOTA_EXHAUSTED' ? 429 : e.code === 'DUPLICATE_REQUEST' || e.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 503
) : e instanceof Denial ? e.status : 503;
const errorCode = (e: unknown) => e instanceof LedgerError || e instanceof Denial ? e.code : 'FREE_QUOTA_UNVERIFIED';
const nextMidnight = (d: Date) => new Date(Date.parse(utcDay(d) + 'T00:00:00Z') + 86400000).toISOString();
function writeJson(res: ServerResponse, status: number, obj: unknown, headers: Record<string,string> = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function deny(res: ServerResponse, error: unknown, id: string, now: Date) {
  const status = statusCode(error), code = errorCode(error);
  const group = error instanceof Denial ? error.group : undefined;
  const retryAt = code === 'FREE_QUOTA_EXHAUSTED' ? nextMidnight(now) : undefined;
  writeJson(res, status, { error: { type: 'quota_guard_denied', code, message: 'Quota Guard blocked this OpenAI request before dispatch or could not confirm its outcome.', ...(group ? { group } : {}), ...(retryAt ? { retry_at: retryAt } : {}) } }, {
    'X-Request-ID': id, 'X-Quota-Guard-Reason': code
  });
}
async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Denial(413, 'BODY_TOO_LARGE', 'Request body exceeds maximum');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) throw new Error('Missing upstream response');
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length; if (size > max) throw new Error('Upstream response too large');
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts).toString('utf8');
}
function parseUsage(raw: any, endpoint: string): number | null {
  const u = raw?.usage;
  const input = endpoint === '/v1/responses' ? u?.input_tokens : u?.prompt_tokens;
  const output = endpoint === '/v1/responses' ? u?.output_tokens : u?.completion_tokens;
  return Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0 ? input + output : null;
}
function secureAuth(value: string | undefined, secret: string): boolean {
  if (!value?.startsWith('Bearer ')) return false;
  const a = createHash('sha256').update(value.slice(7)).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}
export interface ServeOptions { fetchImpl?: typeof fetch; now?: () => Date; allowMockUpstream?: boolean }
export function makeServer(config: Config, ledger: Ledger, opts: ServeOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowFn = opts.now ?? (() => new Date());
  let active = 0;
  const server = createServer(async (req, res) => {
    const now = nowFn(); const id = randomUUID();
    res.setHeader('X-Request-ID', id);
    try {
      if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') throw new Denial(403, 'LOCAL_ONLY', 'Only local clients permitted');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (url.search) throw new Denial(403, 'PAID_FEATURE_BLOCKED', 'Query parameters not supported');
      if (req.method === 'GET' && path === '/health/live') return writeJson(res, 200, { status: 'alive' });
      const access = process.env.QG_PROXY_TOKEN;
      if (!access || access.length < 32 || !secureAuth(req.headers.authorization, access)) throw new Denial(401, 'UNAUTHORIZED', 'Access token required');
      if (req.method === 'GET' && path === '/health/ready') {
        try { gate(config, ledger, now); return writeJson(res, 200, { status: 'ready' }); }
        catch { return writeJson(res, 503, { status: 'paused_unverified' }); }
      }
      if (req.method === 'GET' && path === '/quota') {
        const guarded = (() => { try { gate(config, ledger, now); return true; } catch { return false; } })();
        const groups = (['premium','economy'] as const).map(g => {
          const snap = ledger.snapshot(config, utcDay(now), g, now);
          return { ...snap, state: guarded ? snap.state : 'PAUSED_UNVERIFIED', confidence: guarded ? snap.confidence : 'UNVERIFIED', estimated_remaining: guarded ? snap.estimated_remaining : 0 };
        });
        return writeJson(res, 200, { groups });
      }
      if (req.method === 'GET' && path === '/v1/models') {
        gate(config, ledger, now);
        const data = (['premium','economy'] as const).flatMap(g => config.quotas[g].models.map(id => ({ id, object: 'model', owned_by: 'quota-guard' })));
        return writeJson(res, 200, { object: 'list', data });
      }
      if (req.method !== 'POST' || !['/v1/responses','/v1/chat/completions'].includes(path)) throw new Denial(403, 'PAID_FEATURE_BLOCKED', 'Endpoint not permitted');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new Denial(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only JSON request bodies are supported');
      if (active >= config.server.maxConcurrentRequests) throw new Denial(429, 'CONCURRENCY_LIMIT', 'Busy');
      active++;
      try {
        gate(config, ledger, now);
        if (req.headers['x-quota-guard-data-classification'] !== 'public') throw new Denial(403, 'DATA_POLICY_DENIED', 'Public-only attestation required');
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) throw new Denial(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A stable client idempotency key is mandatory');
        const raw = await readBody(req, config.server.maxRequestBytes);
        let body: unknown;
        try { body = JSON.parse(raw.toString('utf8')); } catch { throw new Denial(400, 'BAD_JSON', 'Invalid JSON'); }
        const { body: approved, group, maxOutput } = validateRequest(config, path, body);
        const hash = createHash('sha256').update(raw).digest('hex');
        const inputBytes = Buffer.byteLength(approved.input as string) + Buffer.byteLength((approved.instructions as string | undefined) ?? '');
        // Preflight reservation is intentionally pessimistic. NOT used as the final trusted input count.
        const provisionalInput = inputBytes * 8 + 4096;
        const provisional = provisionalInput + maxOutput + config.policy.accountMargin;
        if (!Number.isSafeInteger(provisional) || provisional <= 0) throw new Denial(503, 'FREE_QUOTA_UNVERIFIED', 'Cannot reserve input bound', group);
        const admitNow = nowFn();
        if (utcDay(admitNow) !== utcDay(now)) throw new Denial(503, 'FREE_QUOTA_UNVERIFIED', 'UTC day changed before admission', group);
        gate(config, ledger, admitNow);
        const reservation = ledger.admit(config, { key, hash, requestId: id, model: approved.model as string, group, day: utcDay(admitNow), reserve: provisional, now: admitNow });
        let finished = false;
        const disconnect = new AbortController();
        const onClose = () => {
          if (!finished) {
            try { ledger.unknown(key); } catch { /* original failure still fails closed */ }
            disconnect.abort();
          }
        };
        res.once('close', onClose);
        try {
          const headers: Record<string,string> = {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Project': config.upstream.projectId,
            'Content-Type': 'application/json'
          };
          // This preflight network operation is ONLY allowed after explicit operator audit
          // of its own incentive/billing status. Admission has already been reserved.
          const counter = await fetchImpl(config.upstream.baseUrl + '/responses/input_tokens', {
            method: 'POST', headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30000), disconnect.signal]),
            body: JSON.stringify({ model: approved.model, input: approved.input, ...(approved.instructions ? { instructions: approved.instructions } : {}) })
          });
          if (!counter.ok) throw new Error('Preflight counter unavailable');
          const counted = JSON.parse(await readLimited(counter, 65536));
          const inputTokens = counted?.input_tokens;
          if (counted?.object !== 'response.input_tokens' || !Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > provisionalInput) throw new Error('Invalid preflight counter');
          if (inputTokens + maxOutput + config.policy.accountMargin > reservation.reserved) throw new Error('Insufficient reservation');
          if (utcDay(nowFn()) !== reservation.utc_day) throw new Error('UTC rollover during preflight');
          // The state transition commits BEFORE attempting the generation request.
          // Any later failure remains UNKNOWN; unconsumed provisional capacity is released.
          // Operator attestations and collector health can expire during preflight.
          // Revalidate before committing the generation-dispatch phase.
          gate(config, ledger, nowFn());
          ledger.prepareDispatch(config, key, inputTokens, maxOutput, nowFn());
          // Reusing only the server-provided approved values, never client auth headers.
          const upstream = await fetchImpl(config.upstream.baseUrl + path.slice(3), {
            method: 'POST', headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(120000), disconnect.signal]),
            body: JSON.stringify(approved)
          });
          if (!upstream.ok) throw new Error('OpenAI upstream did not return success');
          if (approved.stream === true) {
            if (!upstream.body) throw new Error('No SSE body');
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', 'X-Request-ID': id, 'X-Accel-Buffering': 'no' });
            let buffer = '', completedUsage: number | null = null, sawComplete = false;
            const decoder = new TextDecoder();
            for await (const chunk of upstream.body) {
              if (res.destroyed) throw new Error('Client disconnected');
              const piece = decoder.decode(chunk, {stream:true});
              buffer += piece;
              // Do not allow an upstream that never emits an SSE frame separator to
              // accumulate unbounded memory. Failure retains UNKNOWN reservation.
              if (buffer.length > 1024 * 1024) throw new Error('SSE frame exceeds bounded buffer');
              while (/\r?\n\r?\n/.test(buffer)) {
                const match = /\r?\n\r?\n/.exec(buffer)!;
                const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
                const event = frame.split(/\r?\n/).find(s => s.startsWith('event:'))?.slice(6).trim();
                const data = frame.split(/\r?\n/).filter(s => s.startsWith('data:')).map(s => s.slice(5).trimStart()).join('\n');
                if (event === 'response.completed') {
                  const parsed = JSON.parse(data);
                  if (parsed.response?.status !== 'completed') throw new Error('Unverified terminal response status');
                  completedUsage = parseUsage(parsed.response, path); sawComplete = true;
                }
                if (event === 'response.failed' || event === 'response.incomplete') throw new Error('Incomplete response');
              }
              if (!res.write(chunk)) await once(res, 'drain');
            }
            if (!sawComplete || completedUsage === null || res.destroyed) throw new Error('Stream missing final usage');
            ledger.complete(key, completedUsage);
            finished = true;
            res.end();
          } else {
            const text = await readLimited(upstream, 8 * 1024 * 1024);
            const parsed = JSON.parse(text);
            if (parsed?.status !== 'completed') throw new Error('Upstream response is not completed');
            const usage = parseUsage(parsed, path);
            if (usage === null) throw new Error('Provider missing complete usage');
            ledger.complete(key, usage);
            finished = true;
            writeJson(res, 200, parsed, { 'X-Request-ID': id });
          }
        } catch {
          if (!finished) ledger.unknown(key);
          if (!res.headersSent) throw new Denial(503, 'FREE_QUOTA_UNVERIFIED', 'Upstream outcome unconfirmed', group);
          res.destroy();
        } finally { res.off('close', onClose); }
      } finally { active--; }
    } catch (e) { deny(res, e, id, now); }
  });
  return server;
}
