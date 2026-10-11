import { utcDay, validateConfig, type Config } from '../src/config.ts';
import { Ledger } from '../src/ledger.ts';
const day = utcDay();
const future = new Date(Date.now() + 365 * 86400000).toISOString();
export function cfg(): Config {
  return validateConfig({
    server: { host:'127.0.0.1', port:0, storage:':memory:', maxRequestBytes:102400, maxConcurrentRequests:4 },
    upstream: { baseUrl:'https://api.openai.com/v1' },
    dataSharing: { projectId:'proj_test', tier:'launch' },
    policy: { mode:'FREE_ONLY', safetyPct:85, maxOutputTokens:4096, accountMargin:16, inputCounter:'responses_preflight', preflightCostVerified:true, eligibilityAttestedUntil:future, exclusiveOrgTrafficAttestedUntil:future, manualCostsAuditedUntil:future, reconcileMaxAgeSeconds:600 },
    quotas: { premium:{dailyTokens:1000000,models:['gpt-test-2026-10-11']}, economy:{dailyTokens:10000000,models:['gpt-test-mini-2026-10-11']} }
  });
}
export function verifiedLedger(): Ledger {
  const l = new Ledger(':memory:');
  l.recordObservation(day,'premium',0); l.recordObservation(day,'economy',0); l.setPause(null);
  return l;
}
