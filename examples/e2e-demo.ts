/** Run with npm run demo. No real provider credential or internet access is used. */
import { once } from 'node:events';
import { makeServer } from '../src/server.ts';
import { Ledger } from '../src/ledger.ts';
import { validateConfig, utcDay, type Config } from '../src/config.ts';
import { chooseAfterQuotaGuard } from './omp-fallback.ts';
process.env.OPENAI_API_KEY = 'DEMO-NEVER-SENT';
process.env.QG_PROXY_TOKEN = 'demo-proxy-token-length-more-than-32';
const tomorrow = new Date(Date.now() + 86400000).toISOString();
const config: Config = validateConfig({
  server:{host:'127.0.0.1',port:0,storage:':memory:',maxRequestBytes:65536,maxConcurrentRequests:2},
  upstream:{baseUrl:'https://api.openai.com/v1'},
  dataSharing:{projectId:'proj_demo-no-network',tier:'launch'},
  policy:{mode:'FREE_ONLY',safetyPct:85,maxOutputTokens:256,accountMargin:10,inputCounter:'responses_preflight',preflightCostVerified:true,eligibilityAttestedUntil:tomorrow,exclusiveOrgTrafficAttestedUntil:tomorrow,manualCostsAuditedUntil:tomorrow,reconcileMaxAgeSeconds:600,externalSafetyReserve:{premium:50,economy:50}},
  quotas:{premium:{dailyTokens:1000,models:['demo-premium-2026-10-11']},economy:{dailyTokens:1000,models:[]}}
});
const ledger=new Ledger(':memory:');
ledger.publishSharedUsage(utcDay(),{premium:845,economy:0},{premium:0,economy:0});
let actualNetworkCalls=0;
const server=makeServer(config,ledger,{fetchImpl:(async()=>{actualNetworkCalls++;throw new Error('unexpected dispatch');}) as typeof fetch});
server.listen(0,'127.0.0.1');await once(server,'listening');
try {
  const address=server.address() as {port:number};
  const response=await fetch(`http://127.0.0.1:${address.port}/v1/responses`,{
    method:'POST',headers:{Authorization:`Bearer ${process.env.QG_PROXY_TOKEN}`,'Content-Type':'application/json','Idempotency-Key':'demo-request-000001','X-Quota-Guard-Data-Classification':'public'},
    body:JSON.stringify({model:'demo-premium-2026-10-11',input:'Short public summary',max_output_tokens:40})
  });
  const result:any=await response.json();
  const next=chooseAfterQuotaGuard(response.status,result.error?.code,{id:'demo-request-000001',publicOnly:true,hasSideEffects:false});
  console.log(JSON.stringify({proxyStatus:response.status,guardReason:result.error?.code,downstreamAction:next,upstreamCalls:actualNetworkCalls},null,2));
  if(response.status!==429 || next!=='codex-plus' || actualNetworkCalls!==0) process.exitCode=1;
} finally {await new Promise<void>(r=>server.close(()=>r()));ledger.close();}
