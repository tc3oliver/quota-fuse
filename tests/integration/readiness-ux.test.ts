import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { makeServer } from '../../src/server.ts';
import { readinessIssues } from '../../src/policy.ts';
import { cfg, verifiedLedger } from '../helpers.ts';

test('readiness issues describe missing counter, costs and operator evidence without secrets',()=>{
 const c=cfg(); const ledger=verifiedLedger();
 try {
   c.policy.inputCounter='reject';
   c.policy.preflightCostVerified=false;
   c.policy.eligibilityAttestedUntil=null;
   c.policy.exclusiveOrgTrafficAttestedUntil=null;
   c.policy.manualCostsAuditedUntil=null;
   const issues=readinessIssues(c,ledger);
   for(const code of [
    'PREFLIGHT_COUNTER_DISABLED','PREFLIGHT_COST_UNVERIFIED',
    'ELIGIBILITY_ATTESTATION_MISSING','COST_AUDIT_UNVERIFIED'
   ])assert.ok(issues.includes(code),code);
   assert.ok(!JSON.stringify(issues).includes('sk-'));
 }finally{ledger.close();}
});

test('authenticated readiness endpoint returns actionable reason codes but not credentials',async()=>{
 const c=cfg();
 c.policy.preflightCostVerified=false;
 const ledger=verifiedLedger();
 const oldToken=process.env.QG_PROXY_TOKEN,oldKey=process.env.OPENAI_API_KEY;
 process.env.QG_PROXY_TOKEN='integration-test-proxy-token-1234567890';
 process.env.OPENAI_API_KEY='sk-unit-secret-not-disclosed';
 const server=makeServer(c,ledger);
 try{
   server.listen(0,'127.0.0.1');await once(server,'listening');
   const address=server.address();
   if(!address || typeof address==='string')throw new Error('server address');
   const url='http://127.0.0.1:'+address.port+'/health/ready';
   const unauthorized=await fetch(url);
   assert.equal(unauthorized.status,401);
   const res=await fetch(url,{headers:{authorization:'Bearer '+process.env.QG_PROXY_TOKEN}});
   assert.equal(res.status,503);
   const body=await res.json() as {status:string;reasons:string[]};
   assert.equal(body.status,'paused_unverified');
   assert.ok(body.reasons.includes('PREFLIGHT_COST_UNVERIFIED'));
   assert.ok(!JSON.stringify(body).includes('sk-unit-secret-not-disclosed'));
 }finally{
   await new Promise<void>(done=>server.close(()=>done()));ledger.close();
   if(oldToken===undefined) delete process.env.QG_PROXY_TOKEN;else process.env.QG_PROXY_TOKEN=oldToken;
   if(oldKey===undefined) delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;
 }
});
