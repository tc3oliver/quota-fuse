import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const configPath = resolve(process.env.QG_CONFIG || './config.json');
let config;
try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
catch {
  console.error('Configuration not found. Run npm run onboard, then run npm run configure:local in your own terminal.');
  process.exit(1);
}
const token = process.env.QG_PROXY_TOKEN;
if (!token) {
  console.error('Proxy token is missing. Use npm run status:local to load .env.proxy.');
  process.exit(1);
}
const url = 'http://127.0.0.1:' + config.server.port;
async function get(path) {
  return fetch(url + path, {
    headers: { authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(3000)
  });
}
try {
  const live = await get('/health/live');
  if (!live.ok) throw new Error('Health endpoint unavailable');
  const ready = await get('/health/ready');
  const quota = await get('/quota');
  if (!quota.ok) throw new Error('Quota endpoint rejected the local proxy token');
  const body = await quota.json();
  console.log('QuotaFuse at ' + url);
  console.log('Admission: ' + (ready.ok ? 'READY' : 'PAUSED (fail-closed)'));
  for (const group of body.groups || []) {
    console.log(group.group + ': ' + group.estimated_remaining.toLocaleString('en-US') +
      ' estimated admissible tokens (' + group.state + ', UTC ' + group.utc_day + ')');
  }
  if (!ready.ok) {
    const diagnostic = await ready.json().catch(() => ({}));
    const help = {
      ROUTING_PROJECT_UNSET: 'Choose an existing Data Sharing-covered Project using npm run configure:local.',
      PROJECT_KEY_MISSING: 'Set the Project API key using npm run configure:local in a separate local terminal.',
      PROXY_TOKEN_MISSING: 'Run npm run onboard to generate the local proxy token.',
      PREFLIGHT_COUNTER_DISABLED: 'Counter mode is disabled: review docs/billing-validation.md; never toggle without evidence.',
      PREFLIGHT_COST_UNVERIFIED: 'Preflight billing is not confirmed: review docs/billing-validation.md.',
      ELIGIBILITY_ATTESTATION_MISSING: 'Enrollment attestation missing or expired; use existing evidence where valid.',
      TRAFFIC_ISOLATION_UNVERIFIED: 'Org-wide traffic isolation has not been attested.',
      COST_AUDIT_UNVERIFIED: 'Costs audit attestation missing or expired.',
      PRIOR_DAY_UNKNOWN: 'Previous UTC-day usage outcome unresolved; see docs/runbook.md.',
      LEDGER_UNAVAILABLE: 'SQLite ledger could not be read safely; see docs/runbook.md.'
    };
    const reasons = Array.isArray(diagnostic.reasons) ? diagnostic.reasons : [];
    if (!reasons.length) console.log('Admission reason unavailable. Run npm run doctor and inspect local collector status.');
    for (const reason of reasons) {
      if (typeof reason !== 'string') continue;
      const prefix = reason.split(':')[0];
      const detail = prefix === 'COLLECTOR_PAUSED'
        ? 'Collector is paused (' + (reason.split(':')[1] || 'UNVERIFIED') + '). Check Admin key, usage API, project isolation and collector logs.'
        : prefix === 'USAGE_BASELINE_UNVERIFIED'
        ? 'Fresh official usage baseline missing for ' + (reason.split(':')[1] || 'group') + '; start and check the collector.'
        : (help[reason] || 'Review docs/runbook.md for this admission issue.');
      console.log('  - ' + reason + ': ' + detail);
    }
    console.log('Local setup guide: docs/agent-install.md');
  }
} catch {
  console.error('Cannot reach the local QuotaFuse service at ' + url + '. Start it with npm run start:local.');
  process.exitCode = 1;
}
