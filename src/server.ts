import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { utcDay, type Config } from './config.ts';
import { Ledger, LedgerError } from './ledger.ts';
import { Denial, gate, readinessIssues, validateRequest } from './policy.ts';
import { chatResponse, chatStreamDelta, chatStreamEnd } from './chat.ts';

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
  return Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0 &&
    Number.isSafeInteger(input + output) ? input + output : null;
}
/** A provably terminal generation is not necessarily a successful generation.
 * Only max_output_tokens truncation with an internally consistent, complete
 * provider usage receipt is safe to settle. No fallback to estimated usage. */
function incompleteUsage(raw: any, outputCap: number, expectedModel: string): { total: number; receipt: {
  responseId: string; reason: 'max_output_tokens'; inputTokens: number; outputTokens: number
} } | null {
  if (raw?.status !== 'incomplete' || raw?.incomplete_details?.reason !== 'max_output_tokens' ||
      (raw.error !== null && raw.error !== undefined) ||
      typeof raw.id !== 'string' || !/^resp_[a-zA-Z0-9_-]{3,128}$/.test(raw.id) ||
      typeof raw.model !== 'string' || raw.model !== expectedModel) return null;
  const u = raw.usage;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  const input = u.input_tokens, output = u.output_tokens, total = u.total_tokens;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0 ||
      !Number.isSafeInteger(total) || total !== input + output || output > outputCap) return null;
  const reasoning = u.output_tokens_details?.reasoning_tokens;
  const cached = u.input_tokens_details?.cached_tokens;
  if ((reasoning !== undefined && (!Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > output)) ||
      (cached !== undefined && (!Number.isSafeInteger(cached) || cached < 0 || cached > input))) return null;
  return { total, receipt: {responseId:raw.id,reason:'max_output_tokens',inputTokens:input,outputTokens:output} };
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
        catch { return writeJson(res, 503, { status: 'paused_unverified', reasons: readinessIssues(config, ledger, now) }); }
      }
      if (req.method === 'GET' && path === '/quota') {
        // Conservative admission estimate, NOT an official free-balance promise.
        // Unknown figures are returned as null, never fabricated as zero.
        const pause = (() => { try { return ledger.pauseReason(); } catch { return 'LEDGER_UNAVAILABLE'; } })();
        const groups = (['premium','economy'] as const).map(g => {
          const snap = ledger.snapshot(config, utcDay(now), g, now);
          const held = pause !== null && pause !== undefined;
          return { ...snap, state: held ? (pause === 'MANUAL_REVIEW' ? 'MANUAL_HOLD' : 'PAUSED_UNVERIFIED') : snap.state, confidence: held ? 'UNVERIFIED' : snap.confidence, estimated_remaining: held ? 0 : snap.estimated_remaining, pause_reason: pause ?? null };
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
        const { body: approved, group, maxOutput, clientMode } = validateRequest(config, path, body, now);
        const hash = createHash('sha256').update(raw).digest('hex');
        // Reserve against EVERY text item, tool definition, schema and tool result, not
        // just message strings. The preflight is the authoritative input count.
        // This larger byte-based bound is intentionally conservative and may deny
        // otherwise eligible very large agent contexts before upstream dispatch.
        const counterRequest: Record<string,unknown> = {model:approved.model,input:approved.input};
        // The counter accepts only input-affecting fields. parallel_tool_calls is a generation-only switch.
        for (const field of ['instructions','tools','tool_choice','text'] as const)
          if (approved[field] !== undefined) counterRequest[field]=approved[field];
        const inputBytes = Buffer.byteLength(JSON.stringify(counterRequest));
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
            'OpenAI-Project': config.dataSharing.projectId,
            'Content-Type': 'application/json'
          };
          // This preflight network operation is ONLY allowed after explicit operator audit
          // of its own incentive/billing status. Admission has already been reserved.
          const counter = await fetchImpl(config.upstream.baseUrl + '/responses/input_tokens', {
            method: 'POST', headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30000), disconnect.signal]),
            body: JSON.stringify(counterRequest)
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
          // A feature-specific audit may expire while preflight is in flight.
          // Revalidate the original request before committing dispatch.
          validateRequest(config, path, body, nowFn());
          ledger.prepareDispatch(config, key, inputTokens, maxOutput, nowFn());
          // Reusing only the server-provided approved values, never client auth headers.
          const upstream = await fetchImpl(config.upstream.baseUrl + '/responses', {
            method: 'POST', headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(120000), disconnect.signal]),
            body: JSON.stringify(approved)
          });
          if (!upstream.ok) throw new Error('OpenAI upstream did not return success');
          if (approved.stream === true) {
            if (!upstream.body) throw new Error('No SSE body');
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', 'X-Request-ID': id, 'X-Accel-Buffering': 'no' });
            let buffer = '', finalUsage: number | null = null, terminal: 'completed' | 'incomplete' | null = null;
            let incompleteReceipt: ReturnType<typeof incompleteUsage> = null;
            let finalResponse: Record<string,unknown> | null = null;
            const chatToolIndices = new Map<number,number>();
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
                if (event === 'response.completed' || event === 'response.incomplete') {
                  if (terminal !== null) throw new Error('Conflicting terminal response events');
                  const parsed = JSON.parse(data);
                  if (event === 'response.completed') {
                    if (parsed.response?.status !== 'completed') throw new Error('Unverified terminal response status');
                    finalUsage = parseUsage(parsed.response, '/v1/responses');
                    if (finalUsage === null) throw new Error('Provider missing complete usage');
                    if (clientMode === 'chat') {
                      chatResponse(parsed.response);
                      finalResponse = parsed.response;
                    }
                    terminal = 'completed';
                  } else {
                    incompleteReceipt = incompleteUsage(parsed.response, maxOutput, approved.model as string);
                    if (!incompleteReceipt) throw new Error('Unverified incomplete response usage');
                    finalUsage = incompleteReceipt.total;
                    terminal = 'incomplete';
                  }
                }
                if (event === 'response.failed') throw new Error('Failed upstream response');
                if (clientMode === 'chat') {
                  const delta = chatStreamDelta(event, data && data !== '[DONE]' ? JSON.parse(data) : null, approved.model as string, chatToolIndices);
                  if (delta && !res.write(delta)) await once(res, 'drain');
                }
              }
              if (clientMode === 'responses' && !res.write(chunk)) await once(res, 'drain');
            }
            if (terminal === null || finalUsage === null || res.destroyed) throw new Error('Stream missing final usage');
            ledger.complete(key, finalUsage, incompleteReceipt?.receipt);
            finished = true;
            if (clientMode === 'chat') {
              if (terminal === 'incomplete') {
                // Chat cannot report a complete tool call/assistant message; do not
                // emit a fabricated finish_reason=stop or a success [DONE] marker.
                res.write('event: error\ndata: '+JSON.stringify({error:{type:'upstream_incomplete',
                  code:'UPSTREAM_INCOMPLETE',message:'Generation stopped at max_output_tokens; usage was settled.'}})+'\n\n');
              } else if (finalResponse) res.write(chatStreamEnd(finalResponse));
            }
            res.end();
          } else {
            const text = await readLimited(upstream, 8 * 1024 * 1024);
            const parsed = JSON.parse(text);
            if (parsed?.status === 'incomplete') {
              const incomplete = incompleteUsage(parsed, maxOutput, approved.model as string);
              if (!incomplete) throw new Error('Unverified incomplete response usage');
              ledger.complete(key, incomplete.total, incomplete.receipt);
              finished = true;
              if (clientMode === 'chat') {
                // The Chat adapter must not claim that truncated generations
                // completed successfully, even though their tokens are settled.
                writeJson(res, 503, {error:{type:'upstream_incomplete',code:'UPSTREAM_INCOMPLETE',
                  message:'Generation stopped at max_output_tokens; usage was settled. Do not replay this idempotency key.'}},
                  {'X-Request-ID':id,'X-Quota-Guard-Reason':'UPSTREAM_INCOMPLETE'});
              } else writeJson(res, 200, parsed, {'X-Request-ID':id});
            } else {
              if (parsed?.status !== 'completed') throw new Error('Upstream response is not completed');
              const usage = parseUsage(parsed, '/v1/responses');
              if (usage === null) throw new Error('Provider missing complete usage');
              const outgoing = clientMode === 'chat' ? chatResponse(parsed) : parsed;
              ledger.complete(key, usage);
              finished = true;
              writeJson(res, 200, outgoing, { 'X-Request-ID': id });
            }
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
