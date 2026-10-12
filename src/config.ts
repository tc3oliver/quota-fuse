import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Group = 'premium' | 'economy';
/** Empty model lists mean no model-specific filter. */
export function unrestrictedModels(c: Config): boolean {
  return c.quotas.premium.models.length === 0 && c.quotas.economy.models.length === 0;
}
/** Organization incentive tier, not a model/processing service_tier. */
export type DataSharingTier = 'build' | 'launch' | 'grow';
export const DATA_SHARING_LIMITS: Readonly<Record<DataSharingTier, Readonly<Record<Group, number>>>> = {
  build: { premium: 250_000, economy: 2_500_000 },
  launch: { premium: 1_000_000, economy: 10_000_000 },
  grow: { premium: 1_000_000, economy: 10_000_000 }
};
export interface Config {
  server: { host: string; port: number; storage: string; maxRequestBytes: number; maxConcurrentRequests: number };
  upstream: { baseUrl: string };
  /** Explicitly selected Data Sharing project and operator-confirmed org tier. */
  dataSharing: { projectId: string; tier: DataSharingTier; modelGroupAccounting?: 'official_v1' };
  policy: {
    mode: 'FREE_ONLY'; safetyPct: number; maxOutputTokens: number; accountMargin: number;
    inputCounter: 'reject' | 'responses_preflight'; preflightCostVerified: boolean;
    eligibilityAttestedUntil: string | null; exclusiveOrgTrafficAttestedUntil: string | null;
    manualCostsAuditedUntil: string | null; reconcileMaxAgeSeconds: number;
    /**
     * Proxy-project dedication attestation (operator-verified, expiring).
     * The routing project must be used ONLY by QuotaFuse: no other service,
     * key, or workspace may send traffic under this project ID. The
     * max()-dedup in effective_used is only sound under this premise.
     * Scoped to the proxy project ONLY — other org projects may legally
     * share the pool. Null or expired fails closed. Evidence (Dashboard
     * activity review + ticket) is kept out-of-repo. This intentionally does
     * NOT restore the old org-wide no-bypass requirement.
     */
    proxyProjectDedicatedAttestedUntil: string | null;
    /** Format-specific audit, distinct from general token incentive enrollment. */
    structuredTextVerified?: boolean; structuredTextAttestedUntil?: string | null;
    /**
     * Organization-aware shared-quota guard: conservative upper bound (tokens)
     * per group for external-service consumption during official visibility
     * delay + poll interval. External services may legally bypass the proxy;
     * this reserve is added to effective_used on every admission decision.
     * Missing or negative values fail closed; zero is only valid when the
     * operator has independently bounded external traffic to ~zero.
     */
    externalSafetyReserve: Record<Group, number>;
  };
  quotas: Record<Group, { dailyTokens: number; models: string[] }>;
}
export function validateConfig(c: Config): Config {
  if (c.policy?.mode !== 'FREE_ONLY') throw new Error('FREE_ONLY is the only permitted mode');
  if (c.server?.host !== '127.0.0.1') throw new Error('Only 127.0.0.1 binding supported');
  if (!Number.isInteger(c.server.port) || c.server.port < 0 || c.server.port > 65535) throw new Error('Invalid port');
  if (!/^https:\/\/api\.openai\.com\/v1$/.test(c.upstream?.baseUrl)) throw new Error('Upstream must be https://api.openai.com/v1');
  if (Object.hasOwn(c.upstream, 'projectId')) throw new Error('Move upstream.projectId to dataSharing.projectId; do not configure conflicting project sources');
  if (!c.dataSharing || !Object.hasOwn(DATA_SHARING_LIMITS, c.dataSharing.tier))
    throw new Error('Explicit Data Sharing tier required (build, launch, or grow)');
  if (c.dataSharing.modelGroupAccounting !== undefined && c.dataSharing.modelGroupAccounting !== 'official_v1')
    throw new Error('Unknown model-group accounting version');
  if (typeof c.dataSharing.projectId !== 'string' || !/^proj_[a-zA-Z0-9_-]{3,}$/.test(c.dataSharing.projectId))
    throw new Error('Dedicated Data Sharing project ID must begin with proj_');
  if (c.policy.safetyPct < 1 || c.policy.safetyPct > 85 || !Number.isInteger(c.policy.safetyPct)) throw new Error('Safety percentage must be 1-85');
  for (const key of ['maxOutputTokens', 'accountMargin', 'reconcileMaxAgeSeconds'] as const) {
    if (!Number.isSafeInteger(c.policy[key]) || c.policy[key] < (key === 'accountMargin' ? 0 : 1)) throw new Error('Invalid policy ' + key);
  }
  if (!['reject', 'responses_preflight'].includes(c.policy.inputCounter)) throw new Error('Unknown input counter');
  for (const key of ['maxRequestBytes', 'maxConcurrentRequests'] as const) {
    if (!Number.isSafeInteger(c.server[key]) || c.server[key] < 1) throw new Error('Invalid server ' + key);
  }
  const seen = new Set<string>();
  for (const group of ['premium', 'economy'] as const) {
    const q = c.quotas?.[group];
    if (!q || !Number.isSafeInteger(q.dailyTokens) || q.dailyTokens < 1 || !Array.isArray(q.models)) throw new Error('Invalid quota ' + group);
    // The org-level complimentary pool is shared across all eligible projects
    // and models in this group; dailyTokens may be LOWER, never higher.
    if (q.dailyTokens > DATA_SHARING_LIMITS[c.dataSharing.tier][group])
      throw new Error('Quota ' + group + ' exceeds ' + c.dataSharing.tier + ' Data Sharing tier entitlement');
    for (const model of q.models) {
      if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model) || seen.has(model) || (model.endsWith('-latest') && !['gpt-5-chat-latest','codex-mini-latest'].includes(model))) throw new Error('Model IDs must be unique and explicit, not aliases');
      seen.add(model);
    }
  }
  for (const prop of ['eligibilityAttestedUntil', 'exclusiveOrgTrafficAttestedUntil', 'manualCostsAuditedUntil', 'structuredTextAttestedUntil', 'proxyProjectDedicatedAttestedUntil'] as const) {
    const val = c.policy[prop];
    if (val !== null && val !== undefined && (typeof val !== 'string' || !Number.isFinite(Date.parse(val)))) throw new Error('Invalid attestation timestamp: ' + prop);
  }
  for (const feature of ['structuredTextVerified'] as const)
    if (c.policy[feature] !== undefined && typeof c.policy[feature] !== 'boolean') throw new Error('Invalid feature gate ' + feature);
  // Organization-aware shared quota: per-group conservative external reserve.
  // The org pool is shared with production services that bypass the proxy, so
  // admission must always add this bound. Absent/invalid config fails closed.
  if (!c.policy.externalSafetyReserve || typeof c.policy.externalSafetyReserve !== 'object')
    throw new Error('policy.externalSafetyReserve with per-group conservative bounds is required');
  for (const group of ['premium', 'economy'] as const) {
    const r = (c.policy.externalSafetyReserve as Record<string, unknown>)[group];
    if (!Number.isSafeInteger(r) || (r as number) < 0) throw new Error('Invalid externalSafetyReserve.' + group);
    if ((r as number) > c.quotas[group].dailyTokens) throw new Error('externalSafetyReserve.' + group + ' exceeds group dailyTokens');
  }
  return c;
}
export function loadConfig(path = process.env.QG_CONFIG ?? './config.json'): Config {
  return validateConfig(JSON.parse(readFileSync(resolve(path), 'utf8')) as Config);
}
export function utcDay(d = new Date()): string { return d.toISOString().slice(0, 10); }

/** Enforced upstream time bounds (single source of truth; NOT fingerprinted).
 * The proxy aborts the preflight counter after PREFLIGHT_TIMEOUT_MS and the
 * generation request after UPSTREAM_TIMEOUT_MS (client disconnect aborts even
 * earlier). EXECUTION_WINDOW_MS = preflight + upstream + clock-skew margin is
 * therefore a CREDIBLE, locally-enforced upper bound on how long a request
 * admitted at time T can still produce billable tokens (nothing billable
 * after T + window: the connection is aborted and store:false runs do not
 * continue server-side). The ledger's cross-day carry uses exactly this
 * bound — never an assumed official-delay bound, never an arbitrary TTL. */
export const PREFLIGHT_TIMEOUT_MS = 30000;
export const UPSTREAM_TIMEOUT_MS = 120000;
const CLOCK_SKEW_MS = 5000;
export const EXECUTION_WINDOW_MS = PREFLIGHT_TIMEOUT_MS + UPSTREAM_TIMEOUT_MS + CLOCK_SKEW_MS;
export function nextReset(day: string): string { return new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString(); }
export function attestedUntil(date: string | null, now: Date): boolean { return !!date && Date.parse(date) > now.getTime(); }
