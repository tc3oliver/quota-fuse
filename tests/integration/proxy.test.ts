import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { makeServer } from '../../src/server.ts';
import { verifiedLedger, cfg } from '../helpers.ts';
const auth = 'this-is-a-safe-test-proxy-token-long-enough';
process.env.QG_PROXY_TOKEN=auth;
process.env.OPENAI_API_KEY='fake-upstream-test-only';
const headers = { Authorization:`Bearer ${auth}`, 'Idempotency-Key':'unique-request-123', 'X-Quota-Guard-Data-Classification':'public', 'Content-Type':'application/json' };
const payload = { model:'gpt-test-2026-10-11', input:'hello', max_output_tokens:64 };
function fake(opts:{missingUsage?:boolean;stream?:boolean;error?:boolean}={}, seen:string[]=[]):typeof fetch {
  return (async (url: any, init?:any) => {
    seen.push(String(url));
    if(opts.error) throw new Error('network error');
    if(String(url).endsWith('/responses/input_tokens')) return new Response(JSON.stringify({object:'response.input_tokens',input_tokens:11}),{status:200});
    if(opts.stream) return new Response('event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":11,"output_tokens":7}}}\n\n', {status:200,headers:{'Content-Type':'text/event-stream'}});
    return new Response(JSON.stringify(opts.missingUsage?{id:'resp'}:{id:'resp',status:'completed',usage:{input_tokens:11,output_tokens:7}}),{status:200});
  }) as typeof fetch;
}
async function harness(fn:typeof fetch = fake()) {
  const c=cfg(),l=verifiedLedger(),s=makeServer(c,l,{fetchImpl:fn});
  s.listen(0,'127.0.0.1'); await once(s,'listening');
  const addr=s.address() as any;
  const base=`http://127.0.0.1:${addr.port}`;
  const close=()=>new Promise<void>(r=>s.close(()=>{l.close();r();}));
  return {base,l,close};
}
async function post(base:string,body:unknown=payload, h:Record<string,string>=headers) {
  return fetch(base+'/v1/responses',{method:'POST',headers:h,body:JSON.stringify(body)});
}
test('JSON requests settle and forward only server credentials',async()=>{
  const seen:string[]=[], f=async (url:any,init?:any) => {
    seen.push(String(url));assert.equal(init?.headers?.Authorization,'Bearer fake-upstream-test-only');
    assert.equal(init?.headers?.['OpenAI-Project'],'proj_test');
    assert.equal(init?.headers?.['OpenAI-Organization'],undefined);
    return fake() (url, init);
  };
  const h=await harness(f as typeof fetch);
  try {
    const res=await post(h.base);assert.equal(res.status,200);assert.equal((await res.json()).id,'resp');
    assert.equal(h.l.find('unique-request-123')?.actual,18);
    assert.equal(h.l.find('unique-request-123')?.state,'COMPLETED');
    assert.equal(h.l.find('unique-request-123')?.phase,'DISPATCHED');
    assert.equal(seen.length,2);
  } finally {await h.close();}
});
test('duplicate key never dispatches again',async()=>{
  const seen:string[]=[];const h=await harness(fake({},seen));
  try {assert.equal((await post(h.base)).status,200);const second=await post(h.base);
    assert.equal(second.status,409);assert.equal((await second.json()).error.code,'DUPLICATE_REQUEST');assert.equal(seen.length,2);
  } finally {await h.close();}
});
test('invalid models, hosted tools, forbidden endpoints dispatch zero upstream calls',async()=>{
  const seen:string[]=[];const h=await harness(fake({},seen));
  try {
    const r1=await post(h.base,{...payload,model:'new-model-unverified'});assert.equal(r1.status,403);
    const r2=await post(h.base,{...payload,tools:[{type:'web_search'}]});assert.equal(r2.status,403);
    const r3=await fetch(h.base+'/v1/images/generations',{method:'POST',headers,body:'{}'});assert.equal(r3.status,403);
    assert.equal(seen.length,0);
  } finally {await h.close();}
});
test('missing proxy auth, data classification, idempotency key are rejected',async()=>{
  const seen:string[]=[],h=await harness(fake({},seen));
  try {
    assert.equal((await post(h.base,payload,{'Content-Type':'application/json'})).status,401);
    const { 'X-Quota-Guard-Data-Classification': cls, ...withoutCls}=headers;
    assert.equal((await post(h.base,payload,withoutCls)).status,403);
    const {'Idempotency-Key':key,...withoutKey}=headers;
    assert.equal((await post(h.base,payload,withoutKey)).status,400);
    assert.equal(seen.length,0);
  } finally {await h.close();}
});
test('chat without verified counter fails closed',async()=>{
  const seen:string[]=[],h=await harness(fake({},seen));
  try {
    const r=await fetch(h.base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:payload.model,messages:[{role:'user',content:'hello'}],max_completion_tokens:100,n:1})});
    assert.equal(r.status,503);assert.equal(seen.length,0);
  }finally{await h.close();}
});
test('unknown outcome retains reservation, provider cannot retry',async()=>{
  const seen:string[]=[],h=await harness(fake({error:true},seen));
  try {
    const r=await post(h.base);assert.equal(r.status,503);
    assert.equal(h.l.find('unique-request-123')?.state,'UNKNOWN');assert.equal(h.l.find('unique-request-123')?.phase,'PREFLIGHT');assert.ok(h.l.find('unique-request-123')!.reserved>0);
    assert.equal((await post(h.base)).status,409);assert.equal(seen.length,1);
  }finally{await h.close();}
});
test('missing usage keeps unknown reservation',async()=>{
  const h=await harness(fake({missingUsage:true}));
  try {assert.equal((await post(h.base)).status,503);assert.equal(h.l.find('unique-request-123')?.state,'UNKNOWN');}finally{await h.close();}
});
test('SSE forwards raw events and settles on completed usage',async()=>{
  const h=await harness(fake({stream:true}));
  try {const r=await post(h.base,{...payload,stream:true});assert.equal(r.status,200);
    const output=await r.text();assert.match(output,/event: response.completed/);
    assert.equal(h.l.find('unique-request-123')?.actual,18);
  }finally{await h.close();}
});
test('reserve before preflight: quota too low means zero upstream calls',async()=>{
  const seen:string[]=[],h=await harness(fake({},seen));
  try {
    const c=cfg();
    h.l.admit(c,{key:'previous-local-work',hash:'previous',requestId:'previous',model:payload.model,group:'premium',day:new Date().toISOString().slice(0,10),reserve:849990});
    h.l.complete('previous-local-work',849990);
    const r=await post(h.base);assert.equal(r.status,429);assert.equal(seen.length,0);
  }finally{await h.close();}
});
test('collector pause causes readiness failure and zero upstream calls',async()=>{
  const seen:string[]=[],h=await harness(fake({},seen));
  try {h.l.setPause('COLLECTOR_DOWN');
    assert.equal((await post(h.base)).status,503);
    const r=await fetch(h.base+'/health/ready',{headers});assert.equal(r.status,503);
    assert.equal(seen.length,0);
  }finally{await h.close();}
});
test('quota uses conservative terminology and has zero remaining if not attested',async()=>{
  const h=await harness();
  try {
    let r=await fetch(h.base+'/quota',{headers});assert.equal(r.status,200);
    let j:any=await r.json();assert.equal(j.groups.length,2);assert.equal(j.groups[0].confidence,'CONDITIONAL');
    h.l.setPause('COLLECTOR_DOWN');r=await fetch(h.base+'/quota',{headers});j=await r.json();
    assert.equal(j.groups[0].estimated_remaining,0);assert.equal(j.groups[0].confidence,'UNVERIFIED');
  }finally{await h.close();}
});

test('SSE CRLF framing is correctly parsed and settled',async()=>{
  const f=(async (url:any, init:any)=>String(url).endsWith('/input_tokens')
    ?new Response(JSON.stringify({object:'response.input_tokens',input_tokens:11}))
    :new Response('event: response.completed\r\ndata: {"response":{"status":"completed","usage":{"input_tokens":11,"output_tokens":4}}}\r\n\r\n',{status:200})) as typeof fetch;
  const h=await harness(f);
  try {const r=await post(h.base,{...payload,stream:true});assert.equal(r.status,200);await r.text();
    assert.equal(h.l.find('unique-request-123')?.actual,15);
  }finally{await h.close();}
});
test('SSE client disconnect retains UNKNOWN without waiting for upstream completion',async()=>{
  const f=(async (url:any,init:any)=> {
    if(String(url).endsWith('/input_tokens')) return new Response(JSON.stringify({object:'response.input_tokens',input_tokens:11}));
    const stream=new ReadableStream({start(c){
      c.enqueue(new TextEncoder().encode('event: response.created\ndata: {}\n\n'));
      init.signal.addEventListener('abort',()=>c.error(new Error('aborted')), {once:true});
    }});
    return new Response(stream,{status:200});
  }) as typeof fetch;
  const h=await harness(f);
  try {
    const controller=new AbortController();
    const r=await fetch(h.base+'/v1/responses',{method:'POST',headers,body:JSON.stringify({...payload,stream:true}),signal:controller.signal});
    assert.equal(r.status,200);
    const reader=r.body!.getReader();await reader.read();controller.abort();
    for(let i=0;i<60 && h.l.find('unique-request-123')?.state!=='UNKNOWN';i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(h.l.find('unique-request-123')?.state,'UNKNOWN');
  }finally{await h.close();}
});
test('invalid preflight token response never dispatches generation',async()=>{
  const seen:string[]=[];
  const f=(async (url:any)=> {seen.push(String(url));return new Response(JSON.stringify({object:'error',input_tokens:10}));}) as typeof fetch;
  const h=await harness(f);
  try {const r=await post(h.base);assert.equal(r.status,503);assert.equal(seen.length,1);
    assert.equal(h.l.find('unique-request-123')?.state,'UNKNOWN');
  }finally{await h.close();}
});


test('invalid content type is rejected without an upstream request',async()=> {
  const seen:string[]=[],h=await harness(fake({},seen));
  try {
    const r=await post(h.base,payload,{...headers,'Content-Type':'text/plain'});
    assert.equal(r.status,415);assert.equal(seen.length,0);
  }finally{await h.close();}
});

test('oversized unframed SSE is aborted and reservation stays UNKNOWN',async()=> {
  const f=(async (url:any)=>String(url).endsWith('/input_tokens')
    ?new Response(JSON.stringify({object:'response.input_tokens',input_tokens:11}))
    :new Response('event: response.created\ndata: '+ 'x'.repeat(1024*1024+1),{status:200})) as typeof fetch;
  const h=await harness(f);
  try {
    await assert.rejects(async()=> {
      const r=await post(h.base,{...payload,stream:true});
      await r.text();
    });
    assert.equal(h.l.find('unique-request-123')?.state,'UNKNOWN');
  }finally{await h.close();}
});

test('expired attestation during preflight prevents generation dispatch',async()=>{
 const c=cfg(),l=verifiedLedger(),seen:string[]=[];
 let t=Date.now();
 c.policy.eligibilityAttestedUntil=new Date(t+1000).toISOString();
 const now=()=>new Date(t);
 const upstream=(async(url:any)=>{
  seen.push(String(url));
  if(String(url).endsWith('/responses/input_tokens')) {t+=2000;return new Response(JSON.stringify({object:'response.input_tokens',input_tokens:11}));}
  throw new Error('generation must not dispatch');
 }) as typeof fetch;
 const s=makeServer(c,l,{fetchImpl:upstream,now});s.listen(0,'127.0.0.1');await once(s,'listening');
 const addr=s.address() as any;
 try{
  assert.equal((await post(`http://127.0.0.1:${addr.port}`)).status,503);
  assert.equal(seen.length,1);
  assert.equal(l.find('unique-request-123')?.state,'UNKNOWN');
  assert.equal(l.find('unique-request-123')?.phase,'PREFLIGHT');
 }finally{await new Promise<void>(resolve=>s.close(()=>{l.close();resolve();}));}
});
test('non-completed JSON response with usage must stay UNKNOWN',async()=>{
 const seen:string[]=[];
 const upstream=(async(url:any)=>{
  seen.push(String(url));
  if(String(url).endsWith('/responses/input_tokens'))return new Response(JSON.stringify({object:'response.input_tokens',input_tokens:11}));
  return new Response(JSON.stringify({status:'incomplete',usage:{input_tokens:11,output_tokens:7}}));
 }) as typeof fetch;
 const h=await harness(upstream);
 try {
  assert.equal((await post(h.base)).status,503);
  assert.equal(seen.length,2);
  assert.equal(h.l.find('unique-request-123')?.state,'UNKNOWN');
  assert.equal(h.l.find('unique-request-123')?.phase,'DISPATCHED');
 }finally{await h.close();}
});
