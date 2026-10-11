import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { makeServer } from '../../src/server.ts';
import { verifiedLedger, cfg } from '../helpers.ts';

const token='mock-incomplete-settlement-proxy-token-1234567890';
process.env.QG_PROXY_TOKEN=token;
process.env.OPENAI_API_KEY='fake-upstream-key-incomplete-tests';
const key='incomplete-token-limit-001';
const headers={Authorization:'Bearer '+token,'Idempotency-Key':key,
  'X-Quota-Guard-Data-Classification':'public','Content-Type':'application/json'};
const model='gpt-test-2026-10-11';
const request={model,input:'Say OK',max_output_tokens:16};
const reply=()=>({id:'resp_incomplete_001',object:'response',model,status:'incomplete',
  error:null,incomplete_details:{reason:'max_output_tokens'},output:[],
  usage:{input_tokens:11,output_tokens:16,total_tokens:27,
    output_tokens_details:{reasoning_tokens:16},input_tokens_details:{cached_tokens:0}}});
function mockResponse(response: unknown, stream=false, calls:string[]=[]):typeof fetch {
  return (async (url:any)=>{
    calls.push(String(url));
    if(String(url).endsWith('/responses/input_tokens'))
      return new Response(JSON.stringify({object:'response.input_tokens',input_tokens:11}));
    if(stream) {
      const item=response as Record<string,unknown>;
      return new Response('event: response.created\ndata: {"type":"response.created"}\n\n'+
        'event: response.incomplete\ndata: '+JSON.stringify({type:'response.incomplete',response:item})+'\n\n',
        {status:200,headers:{'Content-Type':'text/event-stream'}});
    }
    return new Response(JSON.stringify(response),{status:200});
  }) as typeof fetch;
}
async function harness(f:typeof fetch) {
  const l=verifiedLedger(),s=makeServer(cfg(),l,{fetchImpl:f});
  s.listen(0,'127.0.0.1');await once(s,'listening');
  const base='http://127.0.0.1:'+(s.address() as any).port;
  const close=()=>new Promise<void>(r=>s.close(()=>{l.close();r();}));
  const send=(body:unknown=request,path='/v1/responses')=>
    fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  return {l,send,close};
}
function receipt(l:Awaited<ReturnType<typeof harness>>['l']) {
  return l.db.prepare('SELECT * FROM incomplete_settlements WHERE idempotency_key=?').get(key) as any;
}

test('terminal incomplete with exact verified usage settles once without pretending generation completed',async()=>{
  const calls:string[]=[];const h=await harness(mockResponse(reply(),false,calls));
  try {
    const r=await h.send();assert.equal(r.status,200);
    const body:any=await r.json();
    assert.equal(body.status,'incomplete');
    assert.equal(body.incomplete_details.reason,'max_output_tokens');
    assert.equal(body.output.length,0);
    assert.equal(h.l.find(key)?.state,'COMPLETED');
    assert.equal(h.l.find(key)?.actual,27);
    assert.equal(h.l.find(key)?.phase,'DISPATCHED');
    const saved=receipt(h.l);
    assert.equal(saved?.upstream_response_id,'resp_incomplete_001');
    assert.equal(saved?.reason,'max_output_tokens');
    assert.equal(saved?.total_tokens,27);
    assert.equal(h.l.snapshot(cfg(),new Date().toISOString().slice(0,10),'premium').local_settled,27);
    assert.equal(h.l.hasCrossDayUnknown('2099-01-01'),false);
    assert.equal((await h.send()).status,409);
    assert.equal(calls.length,2,'duplicate idempotency key never redispatches');
  }finally{await h.close();}
});

test('Chat response does not forge successful completion but still settles verified usage',async()=>{
  const h=await harness(mockResponse(reply()));
  try {
    const r=await h.send({model,messages:[{role:'user',content:'Say OK'}],max_completion_tokens:16},'/v1/chat/completions');
    assert.equal(r.status,503);
    const body:any=await r.json();
    assert.equal(body.error.code,'UPSTREAM_INCOMPLETE');
    assert.equal(h.l.find(key)?.state,'COMPLETED');
    assert.equal(h.l.find(key)?.actual,27);
    assert.ok(receipt(h.l));
  }finally{await h.close();}
});

test('streamed Responses forwards incomplete terminal event and settles only after stream end',async()=>{
  const h=await harness(mockResponse(reply(),true));
  try {
    const r=await h.send({...request,stream:true});
    assert.equal(r.status,200);
    assert.match(await r.text(),/event: response.incomplete/);
    assert.equal(h.l.find(key)?.state,'COMPLETED');
    assert.equal(h.l.find(key)?.actual,27);
    assert.ok(receipt(h.l));
  }finally{await h.close();}
});

test('streamed Chat reports an error, not a fabricated successful [DONE], while settling tokens',async()=>{
  const h=await harness(mockResponse(reply(),true));
  try {
    const r=await h.send({model,messages:[{role:'user',content:'Say OK'}],max_completion_tokens:16,stream:true},'/v1/chat/completions');
    assert.equal(r.status,200,'SSE headers are already sent');
    const text=await r.text();
    assert.match(text,/event: error/);
    assert.match(text,/UPSTREAM_INCOMPLETE/);
    assert.doesNotMatch(text,/\[DONE\]/);
    assert.equal(h.l.find(key)?.state,'COMPLETED');
    assert.ok(receipt(h.l));
  }finally{await h.close();}
});

test('invalid, missing, inconsistent or unsupported incomplete usage never releases reservations',async()=>{
  const bad=[
    {...reply(),usage:null},
    {...reply(),usage:{input_tokens:11,output_tokens:16}},
    {...reply(),usage:{input_tokens:11,output_tokens:16,total_tokens:28}},
    {...reply(),usage:{input_tokens:11,output_tokens:-1,total_tokens:10}},
    {...reply(),usage:{input_tokens:11,output_tokens:16.5,total_tokens:27.5}},
    {...reply(),usage:{input_tokens:11,output_tokens:17,total_tokens:28}},
    {...reply(),usage:{input_tokens:11,output_tokens:16,total_tokens:27,output_tokens_details:{reasoning_tokens:17}}},
    {...reply(),incomplete_details:{reason:'content_filter'}},
    {...reply(),id:undefined},
    {...reply(),status:'failed'},
    {...reply(),error:{code:'upstream_error',message:'provider failed'}},
  ];
  for(const caseData of bad) {
    const h=await harness(mockResponse(caseData));
    try {
      assert.equal((await h.send()).status,503);
      assert.equal(h.l.find(key)?.state,'UNKNOWN');
      assert.equal(h.l.find(key)?.actual,null);
      assert.equal(receipt(h.l),undefined);
      assert.ok(h.l.find(key)!.reserved>0);
    }finally{await h.close();}
  }
});

test('malformed or absent streamed incomplete receipt retains full UNKNOWN reservation',async()=>{
  for(const bad of [{...reply(),usage:null},{...reply(),incomplete_details:{reason:'content_filter'}}]) {
    const h=await harness(mockResponse(bad,true));
    try {
      await assert.rejects(async()=>{const r=await h.send({...request,stream:true});await r.text();});
      assert.equal(h.l.find(key)?.state,'UNKNOWN');
      assert.equal(receipt(h.l),undefined);
    }finally{await h.close();}
  }
});

test('abnormally high verified token usage triggers paused UNKNOWN, not accounting settlement',async()=>{
  const overflowing={...reply(),usage:{input_tokens:10000,output_tokens:16,total_tokens:10016}};
  const h=await harness(mockResponse(overflowing));
  try {
    assert.equal((await h.send()).status,503);
    assert.equal(h.l.find(key)?.state,'UNKNOWN');
    assert.equal(h.l.pauseReason(),'ACTUAL_EXCEEDS_RESERVED');
    assert.equal(receipt(h.l),undefined);
  }finally{await h.close();}
});

test('an already UNKNOWN generation cannot be retroactively completed by this code path',()=>{
  const l=verifiedLedger(),c=cfg();const day=new Date().toISOString().slice(0,10);
  try {
    l.admit(c,{key,hash:'hash',requestId:'request-1',model,group:'premium',day,reserve:280});
    l.prepareDispatch(c,key,11,16);
    l.unknown(key);
    assert.throws(()=>l.complete(key,27,{responseId:'resp_incomplete_001',reason:'max_output_tokens',inputTokens:11,outputTokens:16}),
      (e:any)=>e.code==='INVALID_TRANSITION');
    assert.equal(l.find(key)?.state,'UNKNOWN');
    assert.equal(l.find(key)?.reserved,11+16+c.policy.accountMargin);
    assert.equal(receipt(l),undefined);
  }finally{l.close();}
});
