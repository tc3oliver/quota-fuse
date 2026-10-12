import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOnce } from '../../src/collector.ts';
import { Ledger } from '../../src/ledger.ts';
import { cfg } from '../helpers.ts';
function page(rows:any[],next:string|null=null) {
  const today=Math.floor(Date.parse(new Date().toISOString().slice(0,10)+'T00:00:00Z')/1000);
  return {object:'page',data:[{object:'bucket',start_time:today,end_time:today+86400,results:rows}],has_more:!!next,next_page:next};
}
const row=(model:string,n:number)=>({model,project_id:'proj_test',input_tokens:n,output_tokens:n});
test('complete paginated usage aggregates groups then unpauses',async()=>{
  const l=new Ledger(':memory:'),c=cfg(),pages=[page([row(c.quotas.premium.models[0],100)],'cursor'),page([row(c.quotas.economy.models[0],200)])];
  let calls=0;
  const fetchImpl=(async()=>new Response(JSON.stringify(pages[calls++]),{status:200})) as typeof fetch;
  try {const result=await collectOnce(c,l,{fetchImpl,adminKey:'fake-admin-test'});
    assert.deepEqual(result,{proxy:{premium:200,economy:400},external:{premium:0,economy:0},unknownModels:{}});assert.equal(calls,2);assert.equal(l.isPaused(),false);
  }finally{l.close();}
});
test('failed page closes admission and preserves old watermark',async()=>{
  const l=new Ledger(':memory:'),c=cfg();
  l.recordObservation(new Date().toISOString().slice(0,10),'premium',500);
  const fetchImpl=(async()=>new Response(JSON.stringify(page([row(c.quotas.premium.models[0],100)],'next')))) as typeof fetch;
  try {await assert.rejects(()=>collectOnce(c,l,{fetchImpl,adminKey:'fake'}));assert.equal(l.isPaused(),true);
    assert.equal(l.observation(new Date().toISOString().slice(0,10),'premium')?.official_high_watermark,500);
  }finally{l.close();}
});
test('foreign-project usage is recorded as external scope, not a collector failure',async()=>{
  const l=new Ledger(':memory:'),c=cfg(),one=page([row(c.quotas.premium.models[0],100)]);one.data[0].results[0].project_id='another-project';
  const fetchImpl=(async()=>new Response(JSON.stringify(one))) as typeof fetch;
  try {const result=await collectOnce(c,l,{fetchImpl,adminKey:'fake'});
    // The whitelisted-but-officially-unmapped test model is group-unconfirmed:
    // excluded from per-group external sums, counted via unknown diagnostics.
    assert.deepEqual(result,{proxy:{premium:0,economy:0},external:{premium:0,economy:0},unknownModels:{'gpt-test-2026-10-11':{group:'premium',tokens:200}}});
    assert.equal(l.isPaused(),false);
    assert.equal(l.observation(new Date().toISOString().slice(0,10),'premium')?.official_external,0);
    // ...yet both groups' conservative estimates absorb it (see unknown-economy tests).
    assert.equal(l.snapshot(c,new Date().toISOString().slice(0,10),'premium').effective_used,200+10000);
    assert.equal(l.snapshot(c,new Date().toISOString().slice(0,10),'economy').effective_used,200+100000);
  }finally{l.close();}
});
test('usage endpoint failure pauses immediately',async()=>{
  const l=new Ledger(':memory:'),c=cfg();
  try {await assert.rejects(()=>collectOnce(c,l,{fetchImpl:(async()=>new Response('',{status:401})) as typeof fetch,adminKey:'fake'}));
    assert.equal(l.isPaused(),true);
  }finally{l.close();}
});
test('corrupt SQLite cannot silently reset ledger and start serving',()=>{
  const dir=mkdtempSync(join(tmpdir(),'qg-corrupt-'));const file=join(dir,'broken.sqlite');
  try {writeFileSync(file,Buffer.alloc(2048,0xff));assert.throws(()=>new Ledger(file));}
  finally{rmSync(dir,{recursive:true,force:true});}
});

test('empty official usage page is not trusted as zero usage', async()=> {
  const l=new Ledger(':memory:'),c=cfg();
  const fake=(async()=>new Response(JSON.stringify({object:'page',data:[],has_more:false,next_page:null}))) as typeof fetch;
  try { await assert.rejects(()=>collectOnce(c,l,{fetchImpl:fake,adminKey:'test-admin'}),/Missing official day bucket/);
    assert.equal(l.isPaused(),true);
    assert.equal(l.observation(new Date().toISOString().slice(0,10),'premium'),undefined);
  } finally {l.close();}
});

test('proxy usage within committed bounds is accepted; collector keeps polling after transport failure',async()=>{
 const l=new Ledger(':memory:'),c=cfg();
 const day=new Date().toISOString().slice(0,10);
 l.publishSharedUsage(day,{premium:0,economy:0},{premium:0,economy:0});
 l.admit(c,{key:'local',hash:'local',requestId:'local',model:c.quotas.premium.models[0],group:'premium',day,reserve:10});
 l.complete('local',2);
 // Official aggregate reflects the settled 2 (dedicated project, delayed).
 const fake=(async()=>new Response(JSON.stringify(page([row(c.quotas.premium.models[0],1)])))) as typeof fetch;
 try{
  const result=await collectOnce(c,l,{fetchImpl:fake,adminKey:'test-admin'});
  assert.deepEqual(result.proxy,{premium:2,economy:0});
  assert.equal(l.isPaused(),false);
  assert.equal(l.observation(day,'premium')?.official_high_watermark,2);
  // A later transport failure pauses admission but stays recoverable:
  // the next cycle still polls instead of locking permanently.
  await assert.rejects(()=>collectOnce(c,l,{fetchImpl:(async()=>new Response('',{status:503})) as typeof fetch,adminKey:'test-admin'}),/Admin Usage API unsuccessful/);
  assert.equal(l.pauseReason(),'COLLECTOR_UNVERIFIED');
  const retry=await collectOnce(c,l,{fetchImpl:fake,adminKey:'test-admin'});
  assert.equal(retry.proxy.premium,2);
  assert.equal(l.isPaused(),false);
 }finally{l.close();}
});
test('proxy official above local upper bound trips sticky project-sharing pause',async()=>{
 const l=new Ledger(':memory:'),c=cfg();
 const day=new Date().toISOString().slice(0,10);
 l.publishSharedUsage(day,{premium:0,economy:0},{premium:0,economy:0});
 // No local traffic, yet the dedicated project reports 200 tokens:
 // foreign use of the proxy project (or a broken baseline). Sticky.
 const fake=(async()=>new Response(JSON.stringify(page([row(c.quotas.premium.models[0],100)])))) as typeof fetch;
 try{
  await assert.rejects(()=>collectOnce(c,l,{fetchImpl:fake,adminKey:'test-admin'}),/dedicated/);
  assert.equal(l.pauseReason(),'PROXY_PROJECT_SHARED');
  assert.equal(l.observation(day,'premium')?.official_high_watermark,0);
  // External-only growth never trips: same tokens from another project record cleanly.
  const ext=page([row(c.quotas.premium.models[0],100)]);
  ext.data[0].results[0].project_id='proj_external';
  const l2=new Ledger(':memory:');
  try {
    const r=await collectOnce(c,l2,{fetchImpl:(async()=>new Response(JSON.stringify(ext))) as typeof fetch,adminKey:'test-admin'});
    assert.deepEqual(r.external,{premium:0,economy:0});
    assert.deepEqual(r.unknownModels,{'gpt-test-2026-10-11':{group:'premium',tokens:200}});
    assert.equal(l2.isPaused(),false);
  } finally { l2.close(); }
 }finally{l.close();}
});
test('collector cannot clear breached per-request usage bound',async()=>{
 const l=new Ledger(':memory:'),c=cfg(),day=new Date().toISOString().slice(0,10);
 try{
  l.publishSharedUsage(day,{premium:0,economy:0},{premium:0,economy:0});
  l.admit(c,{key:'excess',hash:'h',requestId:'r',model:c.quotas.premium.models[0],group:'premium',day,reserve:10});
  assert.throws(()=>l.complete('excess',11));
  assert.equal(l.pauseReason(),'ACTUAL_EXCEEDS_RESERVED');
  // The collector still attempts its read-only poll, but the sticky
  // accounting hold is preserved and admission stays closed.
  await assert.rejects(()=>collectOnce(c,l,{adminKey:'fake',fetchImpl:(async()=>{throw new Error('unexpected request');}) as typeof fetch}),/unexpected request/);
  assert.equal(l.pauseReason(),'ACTUAL_EXCEEDS_RESERVED');
 }finally{l.close();}
});
