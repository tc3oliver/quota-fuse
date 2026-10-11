import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOnce } from '../../src/collector.ts';
import { Ledger } from '../../src/ledger.ts';
import { cfg, verifiedLedger } from '../helpers.ts';

const today=new Date().toISOString().slice(0,10);
const utcStart=Math.floor(Date.parse(today+'T00:00:00Z')/1000);
const page=(rows:any[])=>({object:'page',data:[{object:'bucket',start_time:utcStart,end_time:utcStart+86400,results:rows}],has_more:false,next_page:null});
const row=(model:string,input_tokens:number,output_tokens=0)=>({model,project_id:'proj_test',input_tokens,output_tokens});
const stub=(rows:any[]):typeof fetch=>(async()=>new Response(JSON.stringify(page(rows)))) as typeof fetch;
const args=(l:Ledger,c=cfg())=>({key:'concurrent-request',hash:'req',requestId:'req',
  model:c.quotas.premium.models[0],group:'premium' as const,day:today,reserve:100});

function deferred<T>() {
  let resolve!: (v:T)=>void;
  const promise=new Promise<T>(r=>{resolve=r;});
  return {promise,resolve};
}

test('slow healthy poll does not pause admissions or hold a SQLite write transaction',async()=>{
  const c=cfg(),l=verifiedLedger(),started=deferred<void>(),pending=deferred<Response>();
  const fetchImpl=(async()=>{started.resolve();return pending.promise;}) as typeof fetch;
  try {
    const poll=collectOnce(c,l,{fetchImpl,adminKey:'mock-key'});
    await started.promise;
    assert.equal(l.pauseReason(),null);
    const admitted=l.admit(c,args(l,c));
    assert.equal(admitted.state,'PENDING');
    l.complete('concurrent-request',18);
    assert.equal(l.snapshot(c,today,'premium').local_settled,18);
    pending.resolve(new Response(JSON.stringify(page([row(c.quotas.premium.models[0],18)]))));
    assert.deepEqual(await poll,{premium:18,economy:0});
    assert.equal(l.pauseReason(),null);
    assert.equal(l.observation(today,'premium')?.official_high_watermark,18);
    assert.equal(l.snapshot(c,today,'premium').local_settled,18);
    assert.equal(l.snapshot(c,today,'premium').estimated_remaining,850000-18);
  }finally{l.close();}
});

test('slow unsuccessful poll only stops admission when failure is observed',async()=>{
  const c=cfg(),l=verifiedLedger(),started=deferred<void>(),pending=deferred<Response>();
  const fetchImpl=(async()=>{started.resolve();return pending.promise;}) as typeof fetch;
  try {
    const poll=collectOnce(c,l,{fetchImpl,adminKey:'mock-key'});
    await started.promise;
    assert.equal(l.pauseReason(),null);
    l.admit(c,args(l,c));
    pending.resolve(new Response('',{status:503}));
    await assert.rejects(poll,/Admin Usage API unsuccessful/);
    assert.equal(l.pauseReason(),'COLLECTOR_UNVERIFIED');
    assert.throws(()=>l.admit(c,{...args(l,c),key:'new-after-failure',requestId:'new'}),
      (e:any)=>e.code==='FREE_QUOTA_UNVERIFIED');
  }finally{l.close();}
});

test('operator pause introduced during in-flight network call survives successful fetch',async()=>{
  const c=cfg(),l=verifiedLedger(),started=deferred<void>(),pending=deferred<Response>();
  const fetchImpl=(async()=>{started.resolve();return pending.promise;}) as typeof fetch;
  try {
    const poll=collectOnce(c,l,{fetchImpl,adminKey:'mock-key'});
    await started.promise;
    l.setPause('MANUAL_REVIEW');
    pending.resolve(new Response(JSON.stringify(page([]))));
    await assert.rejects(poll,/Collector cannot replace an operator hold/);
    assert.equal(l.pauseReason(),'MANUAL_REVIEW');
    assert.equal(l.observation(today,'premium')?.official_high_watermark,0);
  }finally{l.close();}
});

test('manual review at polling start prevents even fetching an Admin API page',async()=>{
  const l=verifiedLedger(),c=cfg();let count=0;
  try {
    l.setPause('MANUAL_REVIEW');
    await assert.rejects(()=>collectOnce(c,l,{adminKey:'mock-key',
      fetchImpl:(async()=>{count++;throw new Error('not expected');}) as typeof fetch}),/Manual operator review required/);
    assert.equal(count,0);
    assert.equal(l.pauseReason(),'MANUAL_REVIEW');
  }finally{l.close();}
});

test('atomic publication rolls back both groups and preserves sticky cause if second group regresses',async()=>{
  const c=cfg(),l=new Ledger(':memory:');
  try {
    l.recordObservation(today,'premium',100);
    l.recordObservation(today,'economy',100);
    l.setPause(null);
    l.admit(c,{...args(l,c),reserve:50});
    await assert.rejects(()=>collectOnce(c,l,{adminKey:'mock-key',fetchImpl:stub([
      row(c.quotas.premium.models[0],110),
      row(c.quotas.economy.models[0],90)
    ])}),/Official reading decreased/);
    assert.equal(l.observation(today,'premium')?.official_high_watermark,100);
    assert.equal(l.observation(today,'economy')?.official_high_watermark,100);
    assert.equal(l.pauseReason(),'OFFICIAL_WATERMARK_REGRESSION');
    await assert.rejects(()=>collectOnce(c,l,{adminKey:'mock-key',fetchImpl:stub([])}),/Manual operator review required/);
    assert.equal(l.pauseReason(),'OFFICIAL_WATERMARK_REGRESSION');
  }finally{l.close();}
});

test('unaccounted official use is paused atomically and cannot publish either group',async()=>{
  const c=cfg(),l=verifiedLedger();
  try {
    await assert.rejects(()=>collectOnce(c,l,{adminKey:'mock-key',
      fetchImpl:stub([row(c.quotas.premium.models[0],1)])}),/Official reading exceeds/);
    assert.equal(l.pauseReason(),'UNACCOUNTED_OFFICIAL_USAGE');
    assert.equal(l.observation(today,'premium')?.official_high_watermark,0);
    assert.equal(l.observation(today,'economy')?.official_high_watermark,0);
  }finally{l.close();}
});

test('missing new-day baseline and stale checkpoint both block admission during polling',async()=>{
  const c=cfg(),l=new Ledger(':memory:'),started=deferred<void>(),pending=deferred<Response>();
  const fetchImpl=(async()=>{started.resolve();return pending.promise;}) as typeof fetch;
  try {
    const poll=collectOnce(c,l,{fetchImpl,adminKey:'mock-key'});
    await started.promise;
    assert.throws(()=>l.admit(c,args(l,c)),(e:any)=>e.code==='FREE_QUOTA_UNVERIFIED');
    pending.resolve(new Response(JSON.stringify(page([]))));
    await poll;
    assert.equal(l.pauseReason(),null);
    l.recordObservation(today,'premium',0,new Date(Date.now()-12000));
    l.recordObservation(today,'economy',0,new Date(Date.now()-12000));
    c.policy.reconcileMaxAgeSeconds=1;
    assert.throws(()=>l.admit(c,args(l,c)),(e:any)=>e.code==='FREE_QUOTA_UNVERIFIED');
  }finally{l.close();}
});

test('recoverable collector transport pause clears only after successful atomic snapshot',async()=>{
  const c=cfg(),l=verifiedLedger();
  try {
    l.setPause('COLLECTOR_UNVERIFIED');
    assert.throws(()=>l.admit(c,args(l,c)),(e:any)=>e.code==='FREE_QUOTA_UNVERIFIED');
    await collectOnce(c,l,{adminKey:'mock-key',fetchImpl:stub([])});
    assert.equal(l.pauseReason(),null);
    const a=l.admit(c,args(l,c));
    assert.equal(a.state,'PENDING');
  }finally{l.close();}
});
