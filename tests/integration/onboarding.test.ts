import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, copyFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const onboard=fileURLToPath(new URL('../../scripts/onboard.mjs',import.meta.url));
const template=fileURLToPath(new URL('../../config.example.json',import.meta.url));
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'qf-onboard-'));
  copyFileSync(template,join(dir,'config.example.json'));
  const run=(...args:string[])=>spawnSync(process.execPath,[
    '--disable-warning=ExperimentalWarning','--experimental-strip-types',onboard,...args],
    {cwd:dir,encoding:'utf8',env:{...process.env,OPENAI_API_KEY:'',OPENAI_ADMIN_KEY:''},timeout:15000});
  const read=()=>JSON.parse(readFileSync(join(dir,'config.json'),'utf8'));
  const close=()=>rmSync(dir,{recursive:true,force:true});
  return {dir,run,read,close};
}

test('onboarding is zero-question and preloads the entire reviewed eligible catalog',()=>{
  const f=fixture();
  try {
    const r=f.run();
    assert.equal(r.status,0,r.stderr);
    const c=f.read();
    assert.equal(c.quotas.premium.models.length,20);
    assert.equal(c.quotas.economy.models.length,13);
    assert.ok(c.quotas.premium.models.includes('gpt-6.1-sol'));
    assert.ok(c.quotas.economy.models.includes('gpt-5.6-terra'));
    assert.ok(!c.quotas.premium.models.includes('gpt-4.5-preview-2025-02-27'));
    assert.equal(c.dataSharing.tier,'build');
    assert.equal(c.policy.mode,'FREE_ONLY');
    assert.equal(c.policy.inputCounter,'reject');
    assert.equal(c.policy.preflightCostVerified,false);
    assert.equal(c.policy.eligibilityAttestedUntil,null);
    assert.equal(c.policy.manualCostsAuditedUntil,null);
    assert.ok(existsSync(join(f.dir,'.env.proxy')));
    assert.ok(existsSync(join(f.dir,'.env.collector')));
    assert.match(r.stdout,/All projects/);
    assert.doesNotMatch(r.stdout,/Paste your API key/i);
    assert.equal(f.run().status,0,'re-running setup must be idempotent');
    assert.deepEqual(f.read(),c);
  } finally {f.close();}
});

test('onboarding chooses an existing routing Project and adjusts confirmed org tier, not model lists',()=>{
  const f=fixture();
  try {
    assert.equal(f.run().status,0);
    const r=f.run('--project=proj_ExistingOrgProject','--tier=launch');
    assert.equal(r.status,0,r.stderr);
    const c=f.read();
    assert.equal(c.dataSharing.projectId,'proj_ExistingOrgProject');
    assert.equal(c.dataSharing.tier,'launch');
    assert.equal(c.quotas.premium.dailyTokens,1000000);
    assert.equal(c.quotas.economy.dailyTokens,10000000);
    assert.equal(c.quotas.premium.models.length,20);
    assert.equal(c.quotas.economy.models.length,13);
    assert.equal(c.policy.preflightCostVerified,false);
    assert.equal(c.policy.eligibilityAttestedUntil,null);
  } finally {f.close();}
});

test('allowlist mode is opt-in and only accepts reviewed eligible exact IDs',()=>{
  const f=fixture();
  try {
    assert.equal(f.run().status,0);
    assert.equal(f.run('--only=gpt-6-sol,gpt-5.6-terra').status,0);
    assert.deepEqual(f.read().quotas.premium.models,['gpt-6-sol']);
    assert.deepEqual(f.read().quotas.economy.models,['gpt-5.6-terra']);
    const denied=f.run('--only=unverified-paid-model');
    assert.equal(denied.status,1);
    assert.match(denied.stderr,/Not in the reviewed Data Sharing model catalog/);
    assert.deepEqual(f.read().quotas.premium.models,['gpt-6-sol']);
    assert.equal(f.run('--only=all').status,0);
    assert.equal(f.read().quotas.premium.models.length,20);
  } finally {f.close();}
});

test('onboarding preserves policy and ledger state on existing installations',()=>{
  const f=fixture();
  try {
    assert.equal(f.run().status,0);
    const original=readFileSync(join(f.dir,'config.json'),'utf8');
    mkdirSync(join(f.dir,'data'),{recursive:true});
    writeFileSync(join(f.dir,'data','quota-guard.sqlite'),'do-not-overwrite');
    const denied=f.run('--tier=launch');
    assert.equal(denied.status,1);
    assert.match(denied.stderr,/Existing SQLite ledger detected/);
    assert.equal(readFileSync(join(f.dir,'config.json'),'utf8'),original);
    assert.equal(readFileSync(join(f.dir,'data','quota-guard.sqlite'),'utf8'),'do-not-overwrite');
    assert.equal(f.run().status,0,'ordinary rerun with ledger should not fail or mutate');
  } finally {f.close();}
});

test('doctor is read-only and never displays credentials',()=>{
  const f=fixture();
  try {
    const d=f.run('--doctor');
    assert.equal(d.status,1,'doctor must not create missing config files');
    assert.ok(!existsSync(join(f.dir,'config.json')));
    assert.equal(f.run().status,0);
    writeFileSync(join(f.dir,'.env.proxy'),'OPENAI_API_KEY=sk-SECRET-NOT-FOR-OUTPUT\nQG_PROXY_TOKEN=something\n');
    writeFileSync(join(f.dir,'.env.collector'),'OPENAI_ADMIN_KEY=sk-ADMIN-SECRET-NOT-FOR-OUTPUT\n');
    const r=f.run('--doctor');
    assert.equal(r.status,0,r.stderr);
    assert.match(r.stdout,/Project API key: present/);
    assert.match(r.stdout,/Organization Admin key: present/);
    assert.doesNotMatch(r.stdout,/sk-SECRET|sk-ADMIN-SECRET/);
  } finally {f.close();}
});
