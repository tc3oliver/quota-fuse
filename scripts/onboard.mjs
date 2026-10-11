#!/usr/bin/env node
/**
 * One-command, offline QuotaFuse onboarding.
 * Does not call OpenAI, disclose keys, change billing attestations, or reset SQLite.
 * Full eligible model catalog comes from the reviewed config.example.json snapshot.
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig, DATA_SHARING_LIMITS } from '../src/config.ts';

const HELP = 'https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai';
const PROJECTS = 'https://platform.openai.com/settings/organization/projects';
const DATA_SHARING = 'https://platform.openai.com/settings/organization/data-controls';
const COSTS = 'https://platform.openai.com/usage';
const args = process.argv.slice(2);
const has = name => args.includes(name);
const opt = name => {
  const value = args.find(a => a.startsWith(name+'='));
  return value === undefined ? undefined : value.slice(name.length+1);
};
const doctor = has('--doctor');
const showHelp = has('--help') || has('-h');
function isProject(p) { return typeof p === 'string' && /^proj_[A-Za-z0-9_-]{3,}$/.test(p) && !/replace|your|select|example|placeholder/i.test(p); }
function hasEnvKey(name,file) {
  if (!existsSync(file)) return false;
  const match = readFileSync(file,'utf8').match(new RegExp('^'+name+'=(.*)$','m'));
  return !!(match && match[1].trim() && !/^(todo|replace|placeholder)$/i.test(match[1].trim()));
}
function storagePresent(c) { return c.server.storage !== ':memory:' && existsSync(resolve(c.server.storage)); }
function save(c,path) {
  validateConfig(c);
  const temp=path+'.onboard-'+randomUUID();
  try {
    writeFileSync(temp,JSON.stringify(c,null,2)+'\n',{flag:'wx',mode:0o600});
    chmodSync(temp,0o600);
    renameSync(temp,path);
  } catch(e) {
    try {unlinkSync(temp);} catch {}
    throw e;
  }
}
function printHelp() {
  console.log('QuotaFuse onboarding — no API requests, credentials, or billing changes');
  console.log('  npm run onboard                       guided checklist (no questions)');
  console.log('  npm run doctor                        read-only status');
  console.log('  npm run onboard -- --project=proj_... --tier=launch');
  console.log('  npm run onboard -- --only=gpt-6-sol,gpt-5.6-terra');
  console.log('  npm run onboard -- --only=all         restore all catalog models');
  console.log('Modes: all documented eligible models by default, opt-in custom allowlist.');
  console.log('Source: '+HELP);
}
if (showHelp) {printHelp();process.exit(0);}
try {
  const file=resolve('config.json');
  const example=resolve('config.example.json');
  if (!doctor) await import('./setup.mjs');
  if (!existsSync(file) || !existsSync(example)) throw new Error('Run from the QuotaFuse repository root; npm run onboard first.');
  const fresh=JSON.parse(readFileSync(example,'utf8'));
  const config=validateConfig(JSON.parse(readFileSync(file,'utf8')));
  const changed=structuredClone(config);
  let modified=false;
  if (!doctor) {
    const project=opt('--project');
    const tier=opt('--tier');
    const only=opt('--only');
    const unknown=args.filter(x=>!['--project','--tier','--only'].some(prefix=>x.startsWith(prefix+'=')));
    if (unknown.length) throw new Error('Unknown option(s): '+unknown.join(', '));
    if (project!==undefined) {
      if (!isProject(project)) throw new Error('Choose a REAL existing proj_... project ID from '+PROJECTS);
      if (changed.dataSharing.projectId!==project) {changed.dataSharing.projectId=project;modified=true;}
    }
    if (tier!==undefined) {
      if (!Object.hasOwn(DATA_SHARING_LIMITS,tier)) throw new Error('Tier must be build, launch, or grow.');
      if (changed.dataSharing.tier!==tier) {
        const old=DATA_SHARING_LIMITS[changed.dataSharing.tier];
        const next=DATA_SHARING_LIMITS[tier];
        for (const group of ['premium','economy']) {
          const current=changed.quotas[group].dailyTokens;
          changed.quotas[group].dailyTokens=current===old[group]? next[group] : Math.min(current,next[group]);
        }
        changed.dataSharing.tier=tier;modified=true;
      }
    }
    const snapshot={premium:fresh.quotas.premium.models,economy:fresh.quotas.economy.models};
    if (only!==undefined) {
      if (!only) throw new Error('--only needs comma-separated official model IDs or all.');
      let allowed;
      if (only==='all') allowed=snapshot;
      else {
        const selected=only.split(',').map(v=>v.trim());
        if (new Set(selected).size!==selected.length) throw new Error('Duplicate model in --only.');
        for (const model of selected)
          if (!snapshot.premium.includes(model) && !snapshot.economy.includes(model))
            throw new Error('Not in the reviewed Data Sharing model catalog: '+model);
        allowed={premium:selected.filter(x=>snapshot.premium.includes(x)),economy:selected.filter(x=>snapshot.economy.includes(x))};
      }
      for (const group of ['premium','economy']) {
        if (JSON.stringify(changed.quotas[group].models)!==JSON.stringify(allowed[group])) {
          changed.quotas[group].models=allowed[group].slice();modified=true;
        }
      }
    } else if (changed.quotas.premium.models.length===0 && changed.quotas.economy.models.length===0 &&
        !storagePresent(changed)) {
      // Upgrade untouched v0.1.x "no models" installations, but never mutate
      // an existing persisted ledger or an intentionally restricted selection.
      changed.quotas.premium.models=snapshot.premium.slice();
      changed.quotas.economy.models=snapshot.economy.slice();
      modified=true;
      console.log('Enabled the published eligible-model catalog in an unused local setup.');
    }
    if (modified) {
      if (storagePresent(config)) throw new Error('Existing SQLite ledger detected: refusing policy change. See docs/runbook.md (POLICY_CHANGED). No config written.');
      save(changed,file);
      console.log('Updated config.json locally; credentials and attestation flags unchanged.');
    }
  }
  const c=modified?changed:config;
  const chosen=isProject(c.dataSharing.projectId);
  const models=c.quotas.premium.models.length+c.quotas.economy.models.length;
  const proxyKey=hasEnvKey('OPENAI_API_KEY','.env.proxy');
  const adminKey=hasEnvKey('OPENAI_ADMIN_KEY','.env.collector');
  const dates=['eligibilityAttestedUntil','exclusiveOrgTrafficAttestedUntil','manualCostsAuditedUntil'];
  const audited=c.policy.preflightCostVerified===true && c.policy.inputCounter==='responses_preflight' &&
    dates.every(k=>c.policy[k] && Date.parse(c.policy[k])>Date.now());
  console.log('\nQuotaFuse local setup — '+(doctor?'read-only check':'prepared'));
  console.log('  Data Sharing scope: All projects needs no extra opt-in per project.');
  console.log('  API routing project: '+(chosen?'selected':'NOT SET (use any existing proj_... ID)'));
  console.log('  Tier: '+c.dataSharing.tier+' (confirm against your organization)');
  console.log('  Eligible catalog: '+models+' exact IDs ('+c.quotas.premium.models.length+' premium / '+c.quotas.economy.models.length+' economy)');
  console.log('  Quota: '+c.quotas.premium.dailyTokens.toLocaleString()+' / '+c.quotas.economy.dailyTokens.toLocaleString()+' tokens; safetyPct='+c.policy.safetyPct);
  console.log('  Project API key: '+(proxyKey?'present':'MISSING — edit .env.proxy on this machine'));
  console.log('  Organization Admin key: '+(adminKey?'present':'MISSING — edit .env.collector on this machine'));
  console.log('  Billing declarations: '+(audited?'recorded; requires fresh collector evidence':'pending; inference remains PAUSED'));
  console.log('\nWhat remains (no secrets need to be pasted in chat):');
  if (!chosen) console.log('  1. Choose an EXISTING Project ID: '+PROJECTS);
  if (!proxyKey || !adminKey) console.log('  2. Enter separate local project/admin API keys; see docs/deployment.md');
  console.log('  3. Confirm your actual organization tier in Data Controls: '+DATA_SHARING);
  console.log('  4. Eligible models/changes: '+HELP);
  console.log('  5. Complete only any unverified preflight, Costs and traffic-isolation gates: docs/billing-validation.md');
  console.log('  6. Start proxy + collector + OpenCode adapter; check npm run status:local. Costs: '+COSTS);
  console.log('\nOptional: restrict to a manual subset with npm run onboard -- --only=model_a,model_b');
  console.log('Note: All projects shares ONE org-wide token pool; QuotaFuse still routes through ONE selected project.');
  console.log('Other-project usage may pause the collector in this version. No live requests were made.');
} catch(e) {
  console.error('Onboarding stopped without bypassing quota safeguards: '+e.message);
  process.exitCode=1;
}
