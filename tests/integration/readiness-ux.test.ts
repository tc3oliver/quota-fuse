import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { makeServer } from '../../src/server.ts';
import { gate, readinessIssues } from '../../src/policy.ts';
import { cfg, verifiedLedger } from '../helpers.ts';

test('readiness issues describe missing counter and operator evidence without secrets',()=>{
 const c=cfg(); const ledger=verifiedLedger();
 try {
   c.policy.inputCounter='reject';
   c.policy.preflightCostVerified=false;
   c.policy.eligibilityAttestedUntil=null;
   c.policy.exclusiveOrgTrafficAttestedUntil=null;
   // Retired attestations are compat-only: null costs/dedication must NOT
   // appear as issues and must not block admission.
   c.policy.manualCostsAuditedUntil=null;
   (c.policy as any).proxyProjectDedicatedAttestedUntil=null;
   const issues=readinessIssues(c,ledger);
   for(const code of [
    'PREFLIGHT_COUNTER_DISABLED','PREFLIGHT_COST_UNVERIFIED',
    'ELIGIBILITY_ATTESTATION_MISSING'
   ])assert.ok(issues.includes(code),code);
   assert.ok(!issues.includes('COST_AUDIT_UNVERIFIED'));
   assert.ok(!issues.includes('PROXY_PROJECT_DEDICATION_UNVERIFIED'));
   assert.ok(!issues.includes('PRIOR_DAY_UNKNOWN'));
   assert.ok(!JSON.stringify(issues).includes('sk-'));
 }finally{ledger.close();}
});

test('eligibility expiry stays fail-closed but warns 72h ahead, never auto-extends',()=>{
 const ledger=verifiedLedger();
 const oldToken=process.env.QG_PROXY_TOKEN,oldKey=process.env.OPENAI_API_KEY;
 process.env.QG_PROXY_TOKEN='eligibility-test-token-1234567890123456';
 process.env.OPENAI_API_KEY='sk-test-only';
 try {
   // Expiring soon: gate still passes, warning present (no surprise outage).
   const soon=cfg() as any;
   soon.policy.eligibilityAttestedUntil=new Date(Date.now()+3600000).toISOString();
   assert.doesNotThrow(()=>gate(soon,ledger));
   assert.ok(readinessIssues(soon,ledger).includes('ELIGIBILITY_ATTESTATION_EXPIRING'));
   assert.ok(!readinessIssues(soon,ledger).includes('ELIGIBILITY_ATTESTATION_MISSING'));
   // Far-future attestation: no warning, no missing.
   const fresh=cfg();
   assert.ok(!readinessIssues(fresh,ledger).includes('ELIGIBILITY_ATTESTATION_EXPIRING'));
   // Expired: hard fail-closed, never admitted as free.
   const expired=cfg() as any;
   expired.policy.eligibilityAttestedUntil=new Date(Date.now()-1000).toISOString();
   assert.throws(()=>gate(expired,ledger),(e:any)=>e.code==='FREE_QUOTA_UNVERIFIED');
   assert.ok(readinessIssues(expired,ledger).includes('ELIGIBILITY_ATTESTATION_MISSING'));
   assert.ok(!readinessIssues(expired,ledger).includes('ELIGIBILITY_ATTESTATION_EXPIRING'));
 }finally{
   ledger.close();
   if(oldToken===undefined) delete process.env.QG_PROXY_TOKEN;else process.env.QG_PROXY_TOKEN=oldToken;
   if(oldKey===undefined) delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;
 }
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
