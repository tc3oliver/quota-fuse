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
  return {dir,run,read,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('fresh onboarding asks zero questions, retains empty model lists and defaults fail-closed',()=>{
 const f=fixture();
 try {
   const r=f.run();assert.equal(r.status,0,r.stderr);
   const c=f.read();
   assert.deepEqual(c.quotas.premium.models,[]);
   assert.deepEqual(c.quotas.economy.models,[]);
   assert.equal(c.dataSharing.tier,'build');
   assert.equal(c.policy.mode,'FREE_ONLY');
   assert.equal(c.policy.inputCounter,'reject');
   assert.equal(c.policy.preflightCostVerified,false);
   assert.equal(c.policy.eligibilityAttestedUntil,null);
   assert.equal(c.policy.manualCostsAuditedUntil,null);
   assert.match(r.stdout,/all valid model IDs accepted/);
   assert.match(r.stdout,/may still incur/i);
   assert.equal(existsSync(join(f.dir,'.env.proxy')),true);
   assert.equal(existsSync(join(f.dir,'.env.collector')),true);
   assert.equal(f.run().status,0);
   assert.deepEqual(f.read(),c);
 } finally{f.close();}
});
test('project and tier options do not introduce model whitelists or attestations',()=>{
 const f=fixture();
 try{
   assert.equal(f.run().status,0);
   const r=f.run('--project=proj_RoutingExisting123','--tier=launch');
   assert.equal(r.status,0,r.stderr);
   const c=f.read();
   assert.equal(c.dataSharing.projectId,'proj_RoutingExisting123');
   assert.equal(c.dataSharing.tier,'launch');
   assert.equal(c.quotas.premium.dailyTokens,1000000);
   assert.equal(c.quotas.economy.dailyTokens,10000000);
   assert.deepEqual(c.quotas.premium.models,[]);
   assert.deepEqual(c.quotas.economy.models,[]);
   assert.equal(c.policy.preflightCostVerified,false);
 }finally{f.close();}
});
test('optional whitelist can be enabled or reset; invalid model IDs are refused',()=>{
 const f=fixture();
 try{
   assert.equal(f.run().status,0);
   assert.equal(f.run('--premium=gpt-6-sol','--economy=gpt-5.6-terra').status,0);
   assert.deepEqual(f.read().quotas.premium.models,['gpt-6-sol']);
   assert.deepEqual(f.read().quotas.economy.models,['gpt-5.6-terra']);
   const r=f.run('--premium=good,id not valid');
   assert.equal(r.status,1);
   assert.match(r.stderr,/Invalid or duplicate/);
   assert.deepEqual(f.read().quotas.premium.models,['gpt-6-sol']);
   assert.equal(f.run('--allow-all').status,0);
   assert.deepEqual(f.read().quotas.premium.models,[]);
   assert.deepEqual(f.read().quotas.economy.models,[]);
 }finally{f.close();}
});
test('non-destructive onboarding refuses policy mutation after SQLite ledger exists',()=>{
 const f=fixture();
 try {
   assert.equal(f.run().status,0);
   const previous=readFileSync(join(f.dir,'config.json'),'utf8');
   mkdirSync(join(f.dir,'data'),{recursive:true});
   const db=join(f.dir,'data','quota-guard.sqlite');
   writeFileSync(db,'previous-ledger-untouched');
   const r=f.run('--tier=launch');
   assert.equal(r.status,1);
   assert.match(r.stderr,/Existing SQLite ledger/);
   assert.equal(readFileSync(db,'utf8'),'previous-ledger-untouched');
   assert.equal(readFileSync(join(f.dir,'config.json'),'utf8'),previous);
   assert.equal(f.run().status,0);
 }finally{f.close();}
});
test('doctor is read-only and does not print existing secrets',()=>{
 const f=fixture();
 try{
   const initial=f.run('--doctor');
   assert.equal(initial.status,1);
   assert.equal(existsSync(join(f.dir,'config.json')),false);
   assert.equal(f.run().status,0);
   writeFileSync(join(f.dir,'.env.proxy'),'OPENAI_API_KEY=sk-SECRET-NOT-FOR-OUTPUT\nQG_PROXY_TOKEN=private\n');
   writeFileSync(join(f.dir,'.env.collector'),'OPENAI_ADMIN_KEY=sk-ADMIN-SECRET-NOT-FOR-OUTPUT\n');
   const r=f.run('--doctor');
   assert.equal(r.status,0,r.stderr);
   assert.match(r.stdout,/Project API key: present/);
   assert.match(r.stdout,/Admin API key: present/);
   assert.doesNotMatch(r.stdout,/sk-SECRET|sk-ADMIN-SECRET/);
 }finally{f.close();}
});
