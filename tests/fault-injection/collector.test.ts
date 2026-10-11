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
const row=(model:string,n:number)=>({model,project_id:'proj-test',input_tokens:n,output_tokens:n});
test('complete paginated usage aggregates groups then unpauses',async()=>{
  const l=new Ledger(':memory:'),c=cfg(),pages=[page([row(c.quotas.premium.models[0],100)],'cursor'),page([row(c.quotas.economy.models[0],200)])];
  let calls=0;
  const fetchImpl=(async()=>new Response(JSON.stringify(pages[calls++]),{status:200})) as typeof fetch;
  try {const result=await collectOnce(c,l,{fetchImpl,adminKey:'fake-admin-test'});
    assert.deepEqual(result,{premium:200,economy:400});assert.equal(calls,2);assert.equal(l.isPaused(),false);
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
test('foreign-project usage fails collector even when model is allowed',async()=>{
  const l=new Ledger(':memory:'),c=cfg(),one=page([row(c.quotas.premium.models[0],100)]);one.data[0].results[0].project_id='another-project';
  const fetchImpl=(async()=>new Response(JSON.stringify(one))) as typeof fetch;
  try {await assert.rejects(()=>collectOnce(c,l,{fetchImpl,adminKey:'fake'}));assert.equal(l.isPaused(),true);}finally{l.close();}
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
