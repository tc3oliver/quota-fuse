import { attestedUntil, utcDay, type Config, type Group } from './config.ts';
import { Ledger } from './ledger.ts';

export class Denial extends Error {
  readonly status: number; readonly code: string; readonly group?: Group;
  constructor(status: number, code: string, message: string, group?: Group) { super(message); this.status = status; this.code = code; this.group = group; }
}
export function gate(config: Config, ledger: Ledger, now = new Date()): void {
  const p = config.policy;
  if ((!config.quotas.premium.models.length && !config.quotas.economy.models.length) || !attestedUntil(p.eligibilityAttestedUntil, now) || !attestedUntil(p.exclusiveOrgTrafficAttestedUntil, now) ||
      !attestedUntil(p.manualCostsAuditedUntil, now) || !process.env.OPENAI_API_KEY || !process.env.QG_PROXY_TOKEN || ledger.isPaused() ||
      !p.preflightCostVerified || p.inputCounter !== 'responses_preflight' || ledger.hasCrossDayUnknown(utcDay(now))) {
    throw new Denial(503, 'FREE_QUOTA_UNVERIFIED', 'Production safety gates are not verified');
  }
  for (const group of ['premium', 'economy'] as const) {
    const obs = ledger.snapshot(config, utcDay(now), group, now);
    if (obs.confidence === 'UNVERIFIED') throw new Denial(503, 'FREE_QUOTA_UNVERIFIED', 'Official usage collector unhealthy', group);
  }
}
export function classify(config: Config, model: unknown): Group {
  if (typeof model !== 'string') throw new Denial(403, 'MODEL_NOT_ELIGIBLE', 'Exact model ID required');
  for (const group of ['premium', 'economy'] as const) if (config.quotas[group].models.includes(model)) return group;
  throw new Denial(403, 'MODEL_NOT_ELIGIBLE', 'Model is not manually approved');
}
const responseKeys = new Set(['model','input','instructions','max_output_tokens','stream','store']);
export function validateRequest(config: Config, endpoint: string, raw: unknown): { body: Record<string, unknown>; group: Group; maxOutput: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Denial(400, 'BAD_REQUEST', 'JSON object required');
  const body = raw as Record<string, unknown>;
  const group = classify(config, body.model);
  if (endpoint === '/v1/chat/completions') {
    // Chat framing, tools, and hidden token overhead require an independently audited counter.
    throw new Denial(503, 'FREE_QUOTA_UNVERIFIED', 'Chat input token counter is not validated', group);
  }
  for (const key of Object.keys(body)) if (!responseKeys.has(key)) throw new Denial(403, 'PAID_FEATURE_BLOCKED', 'Unsupported parameter: ' + key, group);
  if (typeof body.input !== 'string' || !body.input.length || (body.instructions !== undefined && typeof body.instructions !== 'string'))
    throw new Denial(403, 'PAID_FEATURE_BLOCKED', 'Only standalone text-only Responses inputs supported', group);
  if (body.store !== undefined && body.store !== false) throw new Denial(403, 'PAID_FEATURE_BLOCKED', 'Stored responses disabled', group);
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new Denial(400, 'BAD_REQUEST', 'stream must be boolean', group);
  const max = body.max_output_tokens;
  if (!Number.isSafeInteger(max) || (max as number) < 1 || (max as number) > config.policy.maxOutputTokens)
    throw new Denial(403, 'PAID_FEATURE_BLOCKED', 'Explicit bounded max_output_tokens required', group);
  return { body: { ...body, store: false }, group, maxOutput: max as number };
}
