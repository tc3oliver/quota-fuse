import { mkdtempSync, rmSync } from 'node:fs';
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
test('premium 85% cap includes pending reservations',()=> {
  const l=verifiedLedger(),c=cfg();reserve(l,c,850000,'top');
  assert.equal(l.snapshot(c,day,'premium').estimated_remaining,0);
  assert.throws(()=>reserve(l,c,1,'overflow'),(e:any)=>e.code==='FREE_QUOTA_EXHAUSTED');l.close();
});
test('economy cap is 8.5M not per model',()=> {
  const l=verifiedLedger(),c=cfg(); reserve(l,c,8500000,'big','economy');
  assert.throws(()=>reserve(l,c,1,'no','economy'),(e:any)=>e.code==='FREE_QUOTA_EXHAUSTED');l.close();
});
test('two agents racing remaining 50K do not double admit',async()=> {
  const l=verifiedLedger(),c=cfg();reserve(l,c,800000,'spent');
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
  assert.throws(()=>l.complete('bad',101));assert.equal(l.find('bad')?.state,'UNKNOWN');l.close();
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
  const l=verifiedLedger(),c=cfg();l.recordObservation(day,'premium',1000);
  assert.throws(()=>l.recordObservation(day,'premium',999),(e:any)=>e.code==='OFFICIAL_WATERMARK_REGRESSION');
  assert.equal(l.snapshot(c,day,'premium').official_observed,1000);l.close();
});
test('cross-day UNKNOWN causes next day fail-closed',()=> {
  const l=verifiedLedger(),c=cfg(),oldDay='2026-01-01';
  l.recordObservation(oldDay,'premium',0,new Date('2026-01-01T11:59:00Z'));
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
    l.recordObservation(day,'premium',0);l.recordObservation(day,'economy',0);l.setPause(null);
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
  l.recordObservation(oldDay,'premium',0,new Date('2026-01-01T10:00:00Z'));
  l.admit(c,{key:'unsettled-old',hash:'x',requestId:'old',model:c.quotas.premium.models[0],group:'premium',day:oldDay,reserve:100,now:new Date('2026-01-01T10:00:00Z')});
  assert.throws(()=>reserve(l,c,100,'new-day'),(e:any)=>e.code==='FREE_QUOTA_UNVERIFIED');
  l.close();
});
