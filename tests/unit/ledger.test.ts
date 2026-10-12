import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../../src/ledger.ts';
import { utcDay, validateConfig, type Config } from '../../src/config.ts';
import { cfg, verifiedLedger } from '../helpers.ts';
const day = utcDay();
function reserve(l: Ledger, c: Config, amount: number, key: string, group:'premium'|'economy'='premium') {
  return l.admit(c,{key,hash:key,requestId:key,model:c.quotas[group].models[0],group,day,reserve:amount});
}
test('default deny absent official observation',()=> {
  const l = new Ledger(':memory:');
  assert.throws(()=> reserve(l,cfg(),100,'noreading'), (e:any)=>e.code==='FREE_QUOTA_UNVERIFIED');l.close();
});
test('premium 85% cap includes pending reservations and external reserve',()=> {
  const l=verifiedLedger(),c=cfg();reserve(l,c,840000,'top');
  assert.equal(l.snapshot(c,day,'premium').estimated_remaining,0);
  assert.throws(()=>reserve(l,c,1,'overflow'),(e:any)=>e.code==='FREE_QUOTA_EXHAUSTED');l.close();
});
test('economy cap is 8.5M not per model',()=> {
  const l=verifiedLedger(),c=cfg(); reserve(l,c,8400000,'big','economy');
  assert.throws(()=>reserve(l,c,1,'no','economy'),(e:any)=>e.code==='FREE_QUOTA_EXHAUSTED');l.close();
});
test('two agents racing remaining 50K do not double admit',async()=> {
  const l=verifiedLedger(),c=cfg();reserve(l,c,790000,'spent');
  const results=await Promise.allSettled([Promise.resolve().then(()=>reserve(l,c,50000,'agent-a')),Promise.resolve().then(()=>reserve(l,c,50000,'agent-b'))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);l.close();
});
test('settlement releases excess reservation only with complete usage',()=> {
  const l=verifiedLedger(),c=cfg();reserve(l,c,10000,'good');l.complete('good',200);
  assert.equal(l.snapshot(c,day,'premium').local_settled,200);
  assert.equal(l.snapshot(c,day,'premium').admitted_reserved,0);l.close();
});
test('actual usage above reservation keeps unknown allocation',()=> {
  const l=verifiedLedger(),c=cfg();reserve(l,c,100,'bad');
  assert.throws(()=>l.complete('bad',101));assert.equal(l.find('bad')?.state,'UNKNOWN');assert.equal(l.isPaused(),true);l.close();
});
test('uncertain upstream outcomes never release reserves',()=> {
  const l=verifiedLedger(),c=cfg();reserve(l,c,100,'unknown');l.unknown('unknown');
  assert.equal(l.snapshot(c,day,'premium').admitted_reserved,100);l.close();
});
test('duplicate idempotency key denies replay including completed',()=> {
  const l=verifiedLedger(),c=cfg();reserve(l,c,100,'same');l.complete('same',30);
  assert.throws(()=>reserve(l,c,100,'same'),(e:any)=>e.code==='DUPLICATE_REQUEST');l.close();
});
test('watermark regression is rejected, remaining unchanged',()=> {
  const l=new Ledger(':memory:'),c=cfg();
  l.publishSharedUsage(day,{premium:1000,economy:0},{premium:0,economy:0});
  assert.throws(()=>l.publishSharedUsage(day,{premium:999,economy:0},{premium:0,economy:0}),(e:any)=>e.code==='OFFICIAL_WATERMARK_REGRESSION');
  assert.equal(l.snapshot(c,day,'premium').official_observed,1000);l.close();
});
test('cross-day UNKNOWN causes next day fail-closed',()=> {
  const l=verifiedLedger(),c=cfg(),oldDay='2026-01-01';
  l.publishSharedUsage(oldDay,{premium:0,economy:0},{premium:0,economy:0},new Date('2026-01-01T11:59:00Z'));
  l.admit(c,{key:'yesterday',hash:'x',requestId:'x',model:c.quotas.premium.models[0],group:'premium',day:oldDay,reserve:100,now:new Date('2026-01-01T12:00:00Z')});
  l.unknown('yesterday');
  assert.throws(()=>reserve(l,c,50,'new'),(e:any)=>e.code==='FREE_QUOTA_UNVERIFIED');l.close();
});
test('reject model aliases, duplicate allowlists, nonlocal bind and dangerous configs',()=> {
  const c=cfg();c.quotas.premium.models=['gpt-latest'];assert.throws(()=>validateConfig(c));
  c.quotas.premium.models=['a'];c.quotas.economy.models=['a'];assert.throws(()=>validateConfig(c));
  c.quotas.economy.models=['b'];c.server.host='0.0.0.0';assert.throws(()=>validateConfig(c));
});

test('opening readonly collector does not alter in-flight proxy reservations',()=>{
  const dir=mkdtempSync(join(tmpdir(),'qg-proxy-'));
  try {
    const path=join(dir,'guard.sqlite'),c=cfg(),l=new Ledger(path);
    l.publishSharedUsage(day,{premium:0,economy:0},{premium:0,economy:0});
    reserve(l,c,100,'active');
    const collector=new Ledger(path,{recoverPending:false});
    assert.equal(collector.find('active')?.state,'PENDING');collector.close();l.close();
    const restarted=new Ledger(path);
    assert.equal(restarted.find('active')?.state,'UNKNOWN');restarted.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('quota/model/project policy changes fail closed across shared DB',()=>{
  const l=new Ledger(':memory:'),c=cfg();
  l.assertPolicy(c);
  c.quotas.premium.models.push('unreviewed-2026-10-12');
  assert.throws(()=>l.assertPolicy(c),(e:any)=>e.code==='POLICY_CHANGED');l.close();
});


test('collector pause inside atomic admit denies without a reservation',()=> {
  const l=verifiedLedger(),c=cfg();
  l.setPause('COLLECTOR_REFRESHING');
  assert.throws(()=>reserve(l,c,100,'paused'),(e:any)=>e.code==='FREE_QUOTA_UNVERIFIED');
  assert.equal(l.find('paused'),undefined);
  l.close();
});
test('previous-day PENDING blocks new-day admission, not just UNKNOWN',()=> {
  const l=verifiedLedger(),c=cfg(),oldDay='2026-01-01';
  l.publishSharedUsage(oldDay,{premium:0,economy:0},{premium:0,economy:0},new Date('2026-01-01T10:00:00Z'));
  l.admit(c,{key:'unsettled-old',hash:'x',requestId:'old',model:c.quotas.premium.models[0],group:'premium',day:oldDay,reserve:100,now:new Date('2026-01-01T10:00:30Z')});
  assert.throws(()=>reserve(l,c,100,'new-day'),(e:any)=>e.code==='FREE_QUOTA_UNVERIFIED');
  l.close();
});

test('official baseline plus local settled is not hidden by later stale official observation',()=> {
  const l=new Ledger(':memory:'),c=cfg();
  l.publishSharedUsage(day,{premium:700000,economy:0},{premium:0,economy:0});
  reserve(l,c,100000,'post-baseline');
  l.prepareDispatch(c,'post-baseline',98240,1744);
  l.complete('post-baseline',100000);
  assert.equal(l.snapshot(c,day,'premium').baseline_observed,700000);
  // effective = 0 external + max(700000, 700000+100000) + 10000 reserve = 810000
  assert.equal(l.snapshot(c,day,'premium').estimated_remaining,40000);
  assert.throws(()=>reserve(l,c,40001,'would-charge'),(e:any)=>e.code==='FREE_QUOTA_EXHAUSTED');
  // Later official aggregate contains those tokens; must not double count.
  l.publishSharedUsage(day,{premium:800000,economy:0},{premium:0,economy:0});
  assert.equal(l.snapshot(c,day,'premium').estimated_remaining,40000);
  l.close();
});

test('cannot establish a late baseline after any local admitted request',()=> {
  const l=verifiedLedger(),c=cfg();
  const tomorrow='2026-12-31';
  // Existing verified baseline is not reset even if a new official value arrives.
  reserve(l,c,100,'one');
  l.recordObservation(day,'premium',50);
  assert.equal(l.observation(day,'premium')?.anchor_tokens,0);
  // Simulate a missing-first-observation for an already admitted group on another day.
  l.db.prepare('INSERT INTO reservations(idempotency_key,request_id,body_hash,model,group_name,utc_day,reserved,actual,state,admitted_at,updated_at,phase) VALUES(?,?,?,?,?,?,?,NULL,?,?,?,?)')
    .run('old','old','old',c.quotas.premium.models[0],'premium',tomorrow,100,'UNKNOWN',new Date().toISOString(),new Date().toISOString(),'DISPATCHED');
  assert.throws(()=>l.recordObservation(tomorrow,'premium',1),(e:any)=>e.code==='ANCHOR_UNVERIFIED');
  l.close();
});

test('preflight provisional capacity shrinks atomically and never reenables dispatch',()=> {
  const l=verifiedLedger(),c=cfg();
  reserve(l,c,80000,'counter-phase');
  assert.equal(l.find('counter-phase')?.phase,'PREFLIGHT');
  l.prepareDispatch(c,'counter-phase',100,400);
  assert.equal(l.find('counter-phase')?.phase,'DISPATCHED');
  assert.equal(l.find('counter-phase')?.reserved,500+c.policy.accountMargin);
  assert.throws(()=>l.prepareDispatch(c,'counter-phase',100,400),(e:any)=>e.code==='INVALID_TRANSITION');
  l.unknown('counter-phase');
  assert.throws(()=>l.reconcilePreflight('counter-phase','operator','review-ticket-000123456789'),(e:any)=>e.code==='PAUSE_REQUIRED');
  l.setPause('MANUAL_REVIEW');
  assert.throws(()=>l.reconcilePreflight('counter-phase','operator','review-ticket-000123456789'),(e:any)=>e.code==='INVALID_TRANSITION');
  l.close();
});

test('audited preflight-only manual reconciliation retains deduplication and audit evidence',()=> {
  const l=verifiedLedger(),c=cfg();
  reserve(l,c,10000,'preflight-unknown');l.unknown('preflight-unknown');
  l.setPause('MANUAL_REVIEW');
  assert.throws(()=>l.reconcilePreflight('preflight-unknown','operator','short'),(e:any)=>e.code==='INVALID_EVIDENCE');
  l.reconcilePreflight('preflight-unknown','operator','costs-verified-ticket-000123456789');
  assert.equal(l.find('preflight-unknown')?.state,'RECONCILED');
  assert.equal(l.find('preflight-unknown')?.actual,0);
  assert.equal((l.db.prepare('SELECT COUNT(*) AS n FROM reconciliation_audit').get() as any).n,1);
  l.setPause(null);
  assert.throws(()=>reserve(l,c,100,'preflight-unknown'),(e:any)=>e.code==='DUPLICATE_REQUEST');
  l.close();
});

test('legacy observation without verified baseline fails closed after schema migration',()=> {
  const dir=mkdtempSync(join(tmpdir(),'qf-migrate-'));
  const path=join(dir,'legacy.sqlite');
  try {
    const l=new Ledger(path);l.recordObservation(day,'premium',700000);l.close();
    const raw=new DatabaseSync(path);
    raw.exec('UPDATE observations SET anchor_tokens=NULL WHERE utc_day=\''+day+'\'');raw.close();
    const migrated=new Ledger(path);
    assert.equal(migrated.snapshot(cfg(),day,'premium').confidence,'UNVERIFIED');
    assert.throws(()=>migrated.recordObservation(day,'premium',700001),(e:any)=>e.code==='ANCHOR_UNVERIFIED');
    migrated.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('read-only quota access never migrates, recovers, or modifies pending reservations',()=> {
  const dir=mkdtempSync(join(tmpdir(),'qf-readonly-'));
  const path=join(dir,'guard.sqlite');
  try {
    const l=new Ledger(path),c=cfg();l.assertPolicy(c);
    l.publishSharedUsage(day,{premium:0,economy:0},{premium:0,economy:0});
    reserve(l,c,1000,'inflight');l.close();
    const reader=new Ledger(path,{readOnly:true});
    reader.verifyPolicy(c);
    assert.equal(reader.find('inflight')?.state,'PENDING');
    assert.equal(reader.snapshot(c,day,'premium').admitted_reserved,1000);
    assert.throws(()=>reader.setPause('WRITE_FORBIDDEN'));
    reader.close();
    const verify=new Ledger(path,{recoverPending:false});
    assert.equal(verify.find('inflight')?.state,'PENDING');verify.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('external org usage above local ledger is recorded, not an invariant failure',()=>{
 const l=verifiedLedger(),c=cfg();
 // External production traffic legitimately exceeds everything local.
 l.publishSharedUsage(day,{premium:0,economy:0},{premium:500000,economy:0});
 assert.equal(l.isPaused(),false);
 assert.equal(l.snapshot(c,day,'premium').official_external_usage,500000);
 assert.equal(l.snapshot(c,day,'premium').state,'READY');
 // ...and it tightens admission instead of locking the collector.
 assert.throws(()=>reserve(l,c,340001,'too-big'),(e:any)=>e.code==='FREE_QUOTA_EXHAUSTED');
 l.close();
});
