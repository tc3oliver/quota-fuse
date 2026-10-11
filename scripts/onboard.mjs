#!/usr/bin/env node
/**
 * Offline, zero-question onboarding. It neither calls OpenAI nor changes
 * billing attestations, credentials, or an existing SQLite accounting ledger.
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig, DATA_SHARING_LIMITS, unrestrictedModels } from '../src/config.ts';
import { Ledger } from '../src/ledger.ts';
import { acquireInstanceLock } from '../src/instance-lock.ts';

const MODEL_DOC = 'https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai';
const PROJECTS = 'https://platform.openai.com/settings/organization/projects';
const args = process.argv.slice(2);
const has = value => args.includes(value);
const opt = flag => args.find(x => x.startsWith(flag + '='))?.slice(flag.length + 1);
const doctor = has('--doctor');
const help = has('--help') || has('-h');
const projectValid = v => typeof v === 'string' &&
  /^proj_[A-Za-z0-9_-]{3,}$/.test(v) && !/replace|your|select|placeholder|example/i.test(v);

function keyPresent(name, file) {
  if (!existsSync(file)) return false;
  const match = readFileSync(file, 'utf8').match(new RegExp('^' + name + '=(.*)$', 'm'));
  return Boolean(match?.[1]?.trim() && !/^(todo|replace|placeholder)$/i.test(match[1].trim()));
}
function parseModels(value, flag) {
  if (!value) throw new Error(flag + ' needs comma-separated exact model IDs');
  const models = value.split(',').map(x => x.trim());
  if (models.length > 100 || new Set(models).size !== models.length ||
      models.some(x => x.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(x)))
    throw new Error('Invalid or duplicate model ID in ' + flag);
  return models;
}
function saveConfig(c, file) {
  validateConfig(c);
  const temp = file + '.onboard-' + randomUUID();
  try {
    writeFileSync(temp, JSON.stringify(c, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* no leftover temp */ }
    throw error;
  }
}
if (help) {
  console.log('QuotaFuse offline onboarding (zero API calls):');
  console.log('  npm run onboard              # prepare missing local files, show checklist');
  console.log('  npm run doctor               # read-only checklist');
  console.log('  npm run onboard -- --project=proj_EXISTING --tier=launch');
  console.log('  npm run onboard -- --premium=one,two --economy=three');
  console.log('  npm run onboard -- --allow-all   # clear model whitelist');
  console.log('No model whitelist = all exact IDs accepted, counted against Premium cap.');
  console.log('WARNING: unlisted/non-eligible models can still be billable. ' + MODEL_DOC);
  process.exit(0);
}
try {
  const file = resolve('config.json');
  if (!doctor) await import('./setup.mjs');
  if (!existsSync(file)) throw new Error('No config.json. Run npm run onboard first.');
  const current = validateConfig(JSON.parse(readFileSync(file, 'utf8')));
  const next = structuredClone(current);
  let modified = false;
  if (!doctor) {
    const allowed = new Set(['--project','--tier','--premium','--economy']);
    for (const a of args) if (!(a === '--allow-all' ||
        [...allowed].some(k => a.startsWith(k + '='))))
      throw new Error('Unknown argument ' + a);
    if (has('--allow-all') && (opt('--premium') !== undefined || opt('--economy') !== undefined))
      throw new Error('Choose --allow-all OR --premium/--economy, not both');
    const project = opt('--project'), tier = opt('--tier');
    if (project !== undefined) {
      if (!projectValid(project)) throw new Error('Select an existing proj_... from ' + PROJECTS);
      if (next.dataSharing.projectId !== project) { next.dataSharing.projectId = project; modified = true; }
    }
    if (tier !== undefined) {
      if (!Object.hasOwn(DATA_SHARING_LIMITS, tier)) throw new Error('Tier must be build, launch, or grow');
      if (next.dataSharing.tier !== tier) {
        const old = DATA_SHARING_LIMITS[next.dataSharing.tier];
        const updated = DATA_SHARING_LIMITS[tier];
        for (const group of ['premium','economy']) {
          const cap = next.quotas[group].dailyTokens;
          next.quotas[group].dailyTokens = cap === old[group] ? updated[group] : Math.min(cap, updated[group]);
        }
        next.dataSharing.tier = tier; modified = true;
      }
    }
    if (has('--allow-all')) {
      for (const group of ['premium','economy']) {
        if (next.quotas[group].models.length) { next.quotas[group].models=[]; modified = true; }
      }
    }
    for (const group of ['premium','economy']) {
      const selected = opt('--' + group);
      if (selected === undefined) continue;
      const ids = parseModels(selected, '--' + group);
      if (JSON.stringify(next.quotas[group].models) !== JSON.stringify(ids)) {
        next.quotas[group].models = ids; modified = true;
      }
    }
    if (modified) {
      const db=next.server.storage;
      if (db !== ':memory:' && existsSync(resolve(db))) {
        // Bootstrapping a PAUSED empty ledger is safe; usage-bearing ledgers
        // still fail closed. Neither running service may hold an instance lock.
        const release=[];
        let ledger;
        try {
          release.push(acquireInstanceLock(db,'proxy'));
          release.push(acquireInstanceLock(db,'collector'));
          ledger=new Ledger(db,{recoverPending:false});
          ledger.rebindPristinePolicy(next);
          try { saveConfig(next,file); }
          catch(e) {
            // Retain the original config and fingerprint together if writing fails.
            ledger.rebindPristinePolicy(current);
            throw e;
          }
          console.log('Updated policy fingerprint for a verified empty, paused ledger; no usage rows removed.');
        } catch(e) {
          throw new Error('Existing SQLite ledger: ' + e.message +
            '. Stop Proxy/Collector and retry only if it is a fresh unused ledger.');
        } finally {
          try { ledger?.close(); } finally { for(const unlock of release.reverse())unlock(); }
        }
      } else {
        saveConfig(next,file);
      }
      console.log('Updated local config.json; billing policy and credentials unchanged.');
    }
  }
  const c = modified ? next : current;
  const unfiltered = unrestrictedModels(c);
  const eligible = projectValid(c.dataSharing.projectId);
  const proxyKey = keyPresent('OPENAI_API_KEY','.env.proxy');
  const adminKey = keyPresent('OPENAI_ADMIN_KEY','.env.collector');
  const future = ['eligibilityAttestedUntil','exclusiveOrgTrafficAttestedUntil','manualCostsAuditedUntil']
    .every(k => typeof c.policy[k] === 'string' && Date.parse(c.policy[k]) > Date.now());
  console.log('\nQuotaFuse setup (' + (doctor ? 'read-only' : 'offline') + ')');
  console.log('  Data Sharing scope: All projects OR Selected projects; this must already cover the routing Project.');
  console.log('  Selected projects users: choose an already opted-in Project (no special Project required for All projects).');
  console.log('  Routing Project: ' + (eligible ? 'selected' : 'missing (All projects: any existing; Selected projects: already opted-in only)'));
  console.log('  Organization tier: ' + c.dataSharing.tier + ' (confirm actual tier)');
  console.log('  Group accounting: '+(c.dataSharing.modelGroupAccounting==='official_v1'
    ? 'official_v1 exact IDs / unknown Premium' : 'legacy Premium-only (operator-reviewed migration required)'));
  console.log('  Model filter: ' + (unfiltered ? 'OFF — all valid model IDs accepted' :
    'ON — premium=' + c.quotas.premium.models.length + ', economy=' + c.quotas.economy.models.length));
  console.log('  Daily caps: premium ' + c.quotas.premium.dailyTokens.toLocaleString() +
    ', economy ' + c.quotas.economy.dailyTokens.toLocaleString() +
    ' at ' + c.policy.safetyPct + '% admission ceiling.');
  console.log('  Project API key: ' + (proxyKey ? 'present' : 'missing — edit .env.proxy locally'));
  console.log('  Admin API key: ' + (adminKey ? 'present' : 'missing — edit .env.collector locally'));
  console.log('  Admission: ' + (future && c.policy.preflightCostVerified &&
    c.policy.inputCounter === 'responses_preflight' ? 'operator gates declared (collector still required)' :
    'PAUSED until evidence-backed safety gates are configured'));
  const pending=[];
  if (!eligible) pending.push('ROUTING_PROJECT_UNSET — choose an existing API Project');
  if (!proxyKey) pending.push('PROJECT_KEY_MISSING — enter a scoped Project API key');
  if (!adminKey) pending.push('ADMIN_KEY_MISSING — enter an Organization Admin API key');
  if (c.policy.inputCounter !== 'responses_preflight') pending.push('PREFLIGHT_COUNTER_DISABLED — requires reviewed input-token counter billing');
  if (!c.policy.preflightCostVerified) pending.push('PREFLIGHT_COST_UNVERIFIED — do not enable without evidence');
  for (const [key,description] of [
    ['eligibilityAttestedUntil','ELIGIBILITY_ATTESTATION_MISSING'],
    ['exclusiveOrgTrafficAttestedUntil','TRAFFIC_ISOLATION_UNVERIFIED'],
    ['manualCostsAuditedUntil','COST_AUDIT_UNVERIFIED']]) {
    if (!c.policy[key] || Date.parse(c.policy[key]) <= Date.now()) pending.push(description + ' — use existing evidence if still valid');
  }
  if (pending.length) {
    console.log('  Pending prerequisites:');
    for (const issue of pending) console.log('    - '+issue);
  }
  if (!eligible || !proxyKey || !adminKey)
    console.log('  NEXT STEP: In your own Terminal (not an agent tool), run npm run configure:local');
  else
    console.log('  NEXT STEP: Start Proxy and Collector; run npm run status:local for exact readiness reasons');
  console.log('  Details: docs/agent-install.md');
  console.log('  Official eligible model groups: ' + MODEL_DOC);
  if (unfiltered) console.log('  WARNING: Unfiltered model IDs are NOT verified complimentary. ' +
    'Unknown models use Premium; official-group mapping (if enabled) does not prove free eligibility; unsupported/paid models could incur charges.');
  console.log('  QuotaFuse currently routes ONE project; other-project usage may PAUSE the collector.');
  console.log('  No API calls, billing attestation changes, or secret disclosures were made.');
} catch (error) {
  console.error('Onboarding stopped safely: ' + error.message);
  process.exitCode=1;
}
