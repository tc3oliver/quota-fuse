import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, gate } from '../../src/policy.ts';
import { unrestrictedModels, type Config } from '../../src/config.ts';
import { collectOnce } from '../../src/collector.ts';
import { Ledger } from '../../src/ledger.ts';
import { cfg, verifiedLedger } from '../helpers.ts';

test('empty model lists accept arbitrary syntactically valid IDs as Premium, not as certified-free',()=>{
 const c=cfg();
 c.quotas.premium.models=[];c.quotas.economy.models=[];
 c.dataSharing.modelGroupAccounting='official_v1';
 assert.equal(unrestrictedModels(c),true);
 assert.equal(classify(c,'gpt-6-sol'),'premium');
 assert.equal(classify(c,'gpt-4.1-mini-2025-04-14'),'economy');
 assert.equal(classify(c,'some-unknown-or-billable-model'),'premium');
 assert.throws(()=>classify(c,'bad model ID'),(e:any)=>e.code==='MODEL_NOT_ELIGIBLE');
 assert.throws(()=>classify(c,''),(e:any)=>e.code==='MODEL_NOT_ELIGIBLE');
 assert.throws(()=>classify(c,123),(e:any)=>e.code==='MODEL_NOT_ELIGIBLE');
});

test('populated whitelist is strict; approved economy models retain economy budgets',()=>{
 const c=cfg();
 assert.equal(unrestrictedModels(c),false);
 assert.equal(classify(c,'gpt-test-2026-10-11'),'premium');
 assert.equal(classify(c,'gpt-test-mini-2026-10-11'),'economy');
 assert.throws(()=>classify(c,'unreviewed-model'),(e:any)=>e.code==='MODEL_NOT_ELIGIBLE');
 c.quotas.premium.models=[];
 assert.equal(unrestrictedModels(c),false,'a one-group whitelist still denies unknown models');
 assert.throws(()=>classify(c,'gpt-test-2026-10-11'),(e:any)=>e.code==='MODEL_NOT_ELIGIBLE');
});

test('official_v1 separates model allowlisting from billing group for both group lists',()=>{
 const c=cfg();
 c.dataSharing.modelGroupAccounting='official_v1';
 c.quotas.premium.models=['gpt-4.1-mini-2025-04-14'];
 c.quotas.economy.models=['gpt-6-sol','unknown-potentially-billable'];
 assert.equal(classify(c,'gpt-4.1-mini-2025-04-14'),'economy','documented Economy must stay Economy even in the Premium filter');
 assert.equal(classify(c,'gpt-6-sol'),'premium','documented Premium must not receive Economy allowance');
 assert.equal(classify(c,'unknown-potentially-billable'),'premium','unknown allowed IDs get the smaller budget');
 assert.throws(()=>classify(c,'gpt-5.6-terra'),(e:any)=>e.code==='MODEL_NOT_ELIGIBLE','strict allowlist still denies other documented IDs');
});

test('collector uses the same official group map despite deliberately reversed allowlist labels',async()=>{
 const c=cfg();
 c.dataSharing.modelGroupAccounting='official_v1';
 c.quotas.premium.models=['gpt-4.1-mini-2025-04-14'];
 c.quotas.economy.models=['gpt-6-sol'];
 const now=new Date('2026-10-11T12:00:00Z');
 const today=Math.floor(Date.parse('2026-10-11T00:00:00Z')/1000);
 const end=Math.floor(now.getTime()/1000);
 const fetchImpl=(async()=>new Response(JSON.stringify({
   object:'page',
   data:[{object:'bucket',start_time:today,end_time:end,results:[
     {project_id:'proj_test',model:'gpt-6-sol',input_tokens:12,output_tokens:8},
     {project_id:'proj_test',model:'gpt-4.1-mini-2025-04-14',input_tokens:4,output_tokens:3}
   ]}],
   has_more:false
 }),{status:200})) as typeof fetch;
 const ledger=new Ledger(':memory:');
 try {
   assert.deepEqual(await collectOnce(c,ledger,{fetchImpl,now,adminKey:'mock-admin-key'}),{proxy:{premium:20,economy:7},external:{premium:0,economy:0},unknownModels:{}});
   assert.equal(ledger.pauseReason(),null);
 }finally{ledger.close();}
});

test('unrestricted models do not bypass unverified policy/attestation gates',()=>{
 const c=cfg();
 c.quotas.premium.models=[];c.quotas.economy.models=[];
 c.policy.preflightCostVerified=false;
 const l=verifiedLedger();
 try{
   assert.throws(()=>gate(c,l),(e:any)=>e.code==='FREE_QUOTA_UNVERIFIED');
 }finally{l.close();}
});

test('collector reconciles unfiltered model usage to Premium, never treats it as free economy',async()=>{
 const c=cfg();
 c.quotas.premium.models=[];c.quotas.economy.models=[];
 c.dataSharing.modelGroupAccounting='official_v1';
 const now=new Date('2026-10-11T12:00:00Z');
 const today=Math.floor(Date.parse('2026-10-11T00:00:00Z')/1000);
 const end=Math.floor(now.getTime()/1000);
 let requests=0;
 const fetchImpl=(async()=>{
   requests++;
   return new Response(JSON.stringify({
     object:'page',
     data:[{object:'bucket',start_time:today,end_time:end,
       results:[{project_id:'proj_test',model:'arbitrary-model-not-in-a-list',input_tokens:15,output_tokens:9},
         {project_id:'proj_test',model:'gpt-4.1-mini-2025-04-14',input_tokens:10,output_tokens:6}]}],
     has_more:false
   }),{status:200});
 }) as typeof fetch;
 const ledger=new Ledger(':memory:');
 try{
   const result=await collectOnce(c,ledger,{fetchImpl,now,adminKey:'mock-admin-key'});
   assert.deepEqual(result,{proxy:{premium:24,economy:16},external:{premium:0,economy:0},unknownModels:{}});
   assert.equal(requests,1);
   assert.equal(ledger.pauseReason(),null);
 }finally{ledger.close();}
});

test('existing unversioned accounting stays Premium-only until explicit migration',()=>{
 const c=cfg();c.quotas.premium.models=[];c.quotas.economy.models=[];
 assert.equal(classify(c,'gpt-4.1-mini-2025-04-14'),'premium');
 const ledger=new Ledger(':memory:');
 try {
   ledger.assertPolicy(c);
   c.dataSharing.modelGroupAccounting='official_v1';
   assert.throws(()=>ledger.verifyPolicy(c),(e:any)=>e.code==='POLICY_CHANGED');
 } finally {ledger.close();}
});
