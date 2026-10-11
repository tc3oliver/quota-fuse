import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Group = 'premium' | 'economy';
export interface Config {
  server: { host: string; port: number; storage: string; maxRequestBytes: number; maxConcurrentRequests: number };
  upstream: { baseUrl: string; projectId: string };
  policy: {
    mode: 'FREE_ONLY'; safetyPct: number; maxOutputTokens: number; accountMargin: number;
    inputCounter: 'reject' | 'responses_preflight'; preflightCostVerified: boolean;
    eligibilityAttestedUntil: string | null; exclusiveOrgTrafficAttestedUntil: string | null;
    manualCostsAuditedUntil: string | null; reconcileMaxAgeSeconds: number;
  };
  quotas: Record<Group, { dailyTokens: number; models: string[] }>;
}
export function validateConfig(c: Config): Config {
  if (c.policy?.mode !== 'FREE_ONLY') throw new Error('FREE_ONLY is the only permitted mode');
  if (c.server?.host !== '127.0.0.1') throw new Error('Only 127.0.0.1 binding supported');
  if (!Number.isInteger(c.server.port) || c.server.port < 0 || c.server.port > 65535) throw new Error('Invalid port');
  if (!/^https:\/\/api\.openai\.com\/v1$/.test(c.upstream?.baseUrl)) throw new Error('Upstream must be https://api.openai.com/v1');
  if (typeof c.upstream.projectId !== 'string' || !c.upstream.projectId.trim()) throw new Error('Dedicated OpenAI project ID required');
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
    for (const model of q.models) {
      if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model) || seen.has(model) || model.endsWith('-latest')) throw new Error('Model IDs must be unique and explicit, not aliases');
      seen.add(model);
    }
  }
  for (const prop of ['eligibilityAttestedUntil', 'exclusiveOrgTrafficAttestedUntil', 'manualCostsAuditedUntil'] as const) {
    const val = c.policy[prop];
    if (val !== null && (typeof val !== 'string' || !Number.isFinite(Date.parse(val)))) throw new Error('Invalid attestation timestamp: ' + prop);
  }
  return c;
}
export function loadConfig(path = process.env.QG_CONFIG ?? './config.json'): Config {
  return validateConfig(JSON.parse(readFileSync(resolve(path), 'utf8')) as Config);
}
export function utcDay(d = new Date()): string { return d.toISOString().slice(0, 10); }
export function nextReset(day: string): string { return new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString(); }
export function attestedUntil(date: string | null, now: Date): boolean { return !!date && Date.parse(date) > now.getTime(); }
