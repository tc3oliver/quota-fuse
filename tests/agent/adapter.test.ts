/** HTTP adapter regression: no real API traffic, all network stays on 127.0.0.1. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}
async function unusedPort(): Promise<number> {
  const s = createServer();
  const port = await listen(s);
  await new Promise<void>(resolve => s.close(() => resolve()));
  return port;
}
test('adapter requires explicit public classification, bounds titles and reuses keys on immediate retries', async () => {
  const events: {headers: Record<string,unknown>; body: string}[] = [];
  const accepted = new Set<string>();
  let generations = 0;
  const origin = createServer(async (req,res) => {
    if (req.method === 'GET') { res.writeHead(200); res.end('ready'); return; }
    const bytes: Buffer[] = [];
    for await (const b of req) bytes.push(Buffer.from(b));
    events.push({headers:req.headers,body:Buffer.concat(bytes).toString('utf8')});
    const key = String(req.headers['idempotency-key'] ?? '');
    if (req.headers['x-quota-guard-data-classification'] !== 'public') {
      res.writeHead(403,{'content-type':'application/json'});
      res.end(JSON.stringify({error:'public data must be attested by client'}));
      return;
    }
    if (accepted.has(key)) {
      res.writeHead(409,{'content-type':'application/json'});
      res.end(JSON.stringify({error:'DUPLICATE_REQUEST'}));
      return;
    }
    accepted.add(key); generations++;
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({ok:true}));
  });
  const originPort = await listen(origin);
  const adapterPort = await unusedPort();
  const script = fileURLToPath(new URL('../../examples/opencode-adapter.mjs', import.meta.url));
  const child = spawn(process.execPath,[script,'--listen','127.0.0.1:'+adapterPort,'--target','http://127.0.0.1:'+originPort],
    {stdio:['ignore','ignore','pipe'],env:{...process.env,QF_DEFAULT_MAX_TOKENS:'128'}});
  let errors = '';
  child.stderr?.on('data', chunk => { errors += chunk.toString(); });
  const adapter = 'http://127.0.0.1:'+adapterPort;
  const token = 'local-testing-proxy-token-not-real';
  const headers = {authorization:'Bearer '+token,'content-type':'application/json'};
  const body = JSON.stringify({model:'dummy',messages:[{role:'user',content:'public test fixture'}]});
  try {
    let ready = false;
    for (let i=0;i<80;i++) {
      if (child.exitCode !== null) throw new Error('adapter exited during startup');
      try {
        const health = await fetch(adapter+'/health/live');
        if (health.ok) { ready=true; break; }
      } catch { /* startup in progress */ }
      await sleep(25);
    }
    assert.equal(ready,true,'adapter startup failed: '+errors.slice(0,200));

    const unclassified = await fetch(adapter+'/v1/chat/completions',
      {method:'POST',headers,body});
    assert.equal(unclassified.status,403);
    assert.equal(events.length,1);
    assert.equal(events[0].headers['x-quota-guard-data-classification'],undefined);
    assert.equal(JSON.parse(events[0].body).max_completion_tokens,128);
    assert.match(String(events[0].headers['idempotency-key']),/^[a-f0-9-]{36}$/);
    assert.equal(generations,0);

    const publicHeaders = {...headers,'x-quota-guard-data-classification':'public'};
    const first = await fetch(adapter+'/v1/chat/completions',
      {method:'POST',headers:publicHeaders,body});
    assert.equal(first.status,200);
    assert.equal(generations,1);
    const firstKey=events[1].headers['idempotency-key'];

    const retry = await fetch(adapter+'/v1/chat/completions',
      {method:'POST',headers:publicHeaders,body});
    assert.equal(retry.status,409);
    assert.equal(events[2].headers['idempotency-key'],firstKey);
    assert.equal(generations,1,'replayed request must not reach another generation');

    const newBody=JSON.stringify({model:'dummy',messages:[{role:'user',content:'different public test'}]});
    const second=await fetch(adapter+'/v1/chat/completions',
      {method:'POST',headers:publicHeaders,body:newBody});
    assert.equal(second.status,200);
    assert.notEqual(events[3].headers['idempotency-key'],firstKey);
    assert.equal(generations,2);

    const beforeOversize=events.length;
    const huge=await fetch(adapter+'/v1/chat/completions',
      {method:'POST',headers:publicHeaders,body:'x'.repeat(2*1024*1024+1)});
    assert.equal(huge.status,413);
    assert.equal(events.length,beforeOversize,'oversized body must not reach proxy');
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit',()=>resolve());
    });
    await new Promise<void>(resolve => origin.close(()=>resolve()));
  }
});
