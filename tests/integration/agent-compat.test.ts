import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { makeServer } from '../../src/server.ts';
import { cfg, verifiedLedger } from '../helpers.ts';

const model='gpt-test-2026-10-11';
const token='safe-local-proxy-token-long-enough-123456';
process.env.QG_PROXY_TOKEN=token;
process.env.OPENAI_API_KEY='mock-key-guard-only';
const headers={'Authorization':'Bearer '+token,'Idempotency-Key':'multi-turn-001',
  'X-Quota-Guard-Data-Classification':'public','Content-Type':'application/json'};
const textOutput=(message='ok')=>({id:'resp_123',model,status:'completed',
  output:[{type:'message',role:'assistant',content:[{type:'output_text',text:message}]}],
  usage:{input_tokens:20,output_tokens:8}});
const callOutput=()=>({id:'resp_call',model,status:'completed',
  output:[{type:'function_call',id:'fc_01',call_id:'call_001',name:'read_file',arguments:'{"path":"a.ts"}'}],
  usage:{input_tokens:35,output_tokens:18}});
async function start(opts: {structured?: boolean;mode?: 'text'|'call'|'stream'}={}) {
  const c=cfg();
  const future=new Date(Date.now()+1000*60*60).toISOString();
  if(opts.structured) {c.policy.structuredTextVerified=true;c.policy.structuredTextAttestedUntil=future;}
  const l=verifiedLedger();
  const seen:{url:string,body:any}[]=[];
  const f=(async (url:any,init:any)=>{
    const body=JSON.parse(init.body);
    seen.push({url:String(url),body});
    if(String(url).endsWith('/input_tokens')) return new Response(JSON.stringify({object:'response.input_tokens',input_tokens:20}));
    const reply=opts.mode==='call'?callOutput():textOutput();
    if(opts.mode==='stream') return new Response('event: response.created\ndata: {"type":"response.created"}\n\n'+
      'event: response.output_text.delta\ndata: {"delta":"ok"}\n\n'+
      'event: response.completed\ndata: '+JSON.stringify({response:reply})+'\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}});
    return new Response(JSON.stringify(reply),{status:200});
  }) as typeof fetch;
  const server=makeServer(c,l,{fetchImpl:f});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as any).port;
  const close=()=>new Promise<void>(resolve=>server.close(()=>{l.close();resolve();}));
  return {base,seen,close,l};
}
async function send(base:string,body:any,path='/v1/responses') {
  return fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
}

test('stateless multi-turn text and content arrays go into the complete preflight',async()=>{
  const h=await start();
  try {
    const body={model,input:[{role:'system',content:'You are concise.'},
      {role:'user',content:[{type:'input_text',text:'Hello'}]},
      {role:'assistant',content:[{type:'output_text',text:'Hi'}]},
      {role:'user',content:'Why?'}],max_output_tokens:256};
    const r=await send(h.base,body);
    assert.equal(r.status,200);
    assert.equal(h.seen.length,2);
    assert.deepEqual(h.seen[0].body.input,body.input);
    assert.deepEqual(h.seen[1].body.input,body.input);
    assert.equal(h.seen[1].body.store,false);
    assert.equal(h.l.find('multi-turn-001')?.state,'COMPLETED');
  } finally {await h.close();}
});
test('hosted tools and image/audio blocks are denied without upstream calls',async()=>{
  const h=await start({});
  try {
    assert.equal((await send(h.base,{model,input:'hello',tools:[{type:'web_search'}],max_output_tokens:64})).status,403);
    assert.equal((await send(h.base,{model,input:[{role:'user',content:[{type:'input_image',image_url:'https://x'}]}],max_output_tokens:64})).status,403);
    assert.equal((await send(h.base,{model,input:'hello',tools:[{type:'mcp',server_url:'https://x'}],max_output_tokens:64})).status,403);
    assert.equal(h.seen.length,0);
  } finally {await h.close();}
});
test('native local functions are supported without a separate feature attestation',async()=>{
  const h=await start();
  try {
    const body={model,input:'hello',max_output_tokens:64,tools:[{type:'function',name:'read_file',parameters:{type:'object',properties:{}},strict:true}]};
    const r=await send(h.base,body);
    assert.equal(r.status,200);
    assert.equal(h.seen.length,2);
    assert.equal(h.seen[0].body.tools[0].name,'read_file');
  } finally {await h.close();}
});
test('local function schema and tool result round trip with bounded preflight',async()=>{
  const h=await start({mode:'call'});
  const tools=[{type:'function',name:'read_file',description:'Read local public file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},strict:true}];
  try {
    let r=await send(h.base,{model,input:'Which file?',max_output_tokens:128,tools,tool_choice:'auto',parallel_tool_calls:true});
    assert.equal(r.status,200);
    const first=await r.json();
    assert.equal(first.output[0].type,'function_call');
    assert.equal(h.seen[0].body.tools[0].name,'read_file');
    assert.equal(h.seen[0].body.tool_choice,'auto');
    assert.equal(h.seen[1].body.tools[0].name,'read_file');
  }finally{await h.close();}
  const next=await start({});
  try {
    const input=[{role:'user',content:'Which file?'},{type:'function_call',name:'read_file',call_id:'call_001',arguments:'{"path":"a.ts"}'},
      {type:'function_call_output',call_id:'call_001',output:'export const x = 1;'}, {role:'user',content:'Summarize it'}];
    const r=await send(next.base,{model,input,max_output_tokens:128});
    assert.equal(r.status,200);
    assert.deepEqual(next.seen[0].body.input,input);
  } finally {await next.close();}
});
test('structured JSON output requires independent audit, and schema is counted',async()=>{
  const request={model,input:[{role:'user',content:'Return JSON'}],max_output_tokens:64,
    text:{format:{type:'json_schema',name:'Answer',strict:true,schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false}}}};
  const denied=await start();
  try {assert.equal((await send(denied.base,request)).status,503);assert.equal(denied.seen.length,0);}finally{await denied.close();}
  const allowed=await start({structured:true});
  try {
    const r=await send(allowed.base,request);
    assert.equal(r.status,200);
    assert.deepEqual(allowed.seen[0].body.text,request.text);
  }finally{await allowed.close();}
});
test('Chat Completions maps to Responses, returns Chat JSON and streaming SSE',async()=>{
  const msg={model,messages:[{role:'system',content:'concise'},{role:'user',content:'hello'}],max_completion_tokens:64,n:1};
  for (const streaming of [false,true]) {
    const h=await start({mode:streaming?'stream':'text'});
    try {
      const r=await send(h.base,{...msg,stream:streaming},'/v1/chat/completions');
      assert.equal(r.status,200);
      if(streaming) {
        const t=await r.text();
        assert.match(t,/chat.completion.chunk/);
        assert.match(t,/\[DONE\]/);
      } else {
        const j=await r.json();
        assert.equal(j.object,'chat.completion');
        assert.equal(j.choices[0].message.content,'ok');
        assert.equal(j.usage.total_tokens,28);
      }
      assert.equal(h.seen[0].url.endsWith('/responses/input_tokens'),true);
      assert.equal(h.seen[1].url.endsWith('/responses'),true);
      assert.equal(h.l.find('multi-turn-001')?.state,'COMPLETED');
    }finally{await h.close();}
  }
});
test('Chat local tool results map to function_call_output, hosted tools reject',async()=>{
  const h=await start({mode:'call'});
  const tools=[{type:'function',function:{name:'read_file',parameters:{type:'object',properties:{},additionalProperties:false},strict:true}}];
  try {
    const msg={model,messages:[{role:'user',content:'read'}],tools,max_completion_tokens:128};
    const r=await send(h.base,msg,'/v1/chat/completions');
    assert.equal(r.status,200);
    const j=await r.json();
    assert.equal(j.choices[0].finish_reason,'tool_calls');
    assert.equal(j.choices[0].message.tool_calls[0].function.name,'read_file');
    assert.equal(h.seen[0].body.tools[0].name,'read_file');
  }finally{await h.close();}
});

test('external JSON schema reference and unsupported chat function mode are rejected',async()=>{
  const h=await start({structured:true,});
  try {
    const external={model,input:'json please',max_output_tokens:64,
      text:{format:{type:'json_schema',name:'Unsafe',strict:true,schema:{type:'object',properties:{x:{$ref:'https://example.com/schema.json'}}}}}};
    assert.equal((await send(h.base,external)).status,403);
    const chat={model,messages:[{role:'user',content:'hello'}],max_completion_tokens:32,
      tool_choice:{type:'function',function:{name:'missing'}}};
    assert.equal((await send(h.base,chat,'/v1/chat/completions')).status,403);
    assert.equal(h.seen.length,0);
  }finally{await h.close();}
});
