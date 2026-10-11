import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA_SHARING_LIMITS, validateConfig, type Config } from '../../src/config.ts';
import { Ledger } from '../../src/ledger.ts';
import { cfg } from '../helpers.ts';

test('organization Data Sharing tier caps are explicit and shared across models',()=>{
 assert.deepEqual(DATA_SHARING_LIMITS.build, {premium:250_000,economy:2_500_000});
 assert.deepEqual(DATA_SHARING_LIMITS.launch, {premium:1_000_000,economy:10_000_000});
 assert.deepEqual(DATA_SHARING_LIMITS.grow, DATA_SHARING_LIMITS.launch);
 const build=cfg();
 build.dataSharing.tier='build';
 build.quotas.premium.dailyTokens=250_000;
 build.quotas.economy.dailyTokens=2_500_000;
 assert.equal(validateConfig(build).dataSharing.tier,'build');
 const l=new Ledger(':memory:');const day=new Date().toISOString().slice(0,10);
 l.recordObservation(day,'premium',0);l.recordObservation(day,'economy',0);l.setPause(null);
 assert.equal(l.snapshot(build,day,'premium').safety_cap,212_500);
 assert.equal(l.snapshot(build,day,'economy').safety_cap,2_125_000);
 l.close();
});
test('build cannot be configured with launch/grow entitlements',()=>{
 const c=cfg();c.dataSharing.tier='build';
 assert.throws(()=>validateConfig(c),/exceeds build Data Sharing tier entitlement/);
 c.quotas.premium.dailyTokens=250_000;
 c.quotas.economy.dailyTokens=2_500_000;
 assert.doesNotThrow(()=>validateConfig(c));
});
test('operator may set lower local ceiling but cannot inflate an incentive tier',()=>{
 const c=cfg();c.quotas.premium.dailyTokens=123_456;
 assert.equal(validateConfig(c).quotas.premium.dailyTokens,123_456);
 c.quotas.economy.dailyTokens=10_000_001;
 assert.throws(()=>validateConfig(c),/exceeds launch Data Sharing tier entitlement/);
});
test('unknown or missing tier and non-project IDs fail closed',()=>{
 const c=cfg();
 (c.dataSharing as any).tier='enterprise';
 assert.throws(()=>validateConfig(c),/Explicit Data Sharing tier required/);
 c.dataSharing.tier='launch';
 c.dataSharing.projectId='default';
 assert.throws(()=>validateConfig(c),/project ID must begin with proj_/);
 c.dataSharing.projectId='proj_valid_123';
 delete (c as any).dataSharing;
 assert.throws(()=>validateConfig(c),/Explicit Data Sharing tier required/);
});
test('legacy upstream project ID is explicitly rejected',()=>{
 const c=cfg();
 (c.upstream as any).projectId='proj_another';
 assert.throws(()=>validateConfig(c),/Move upstream.projectId/);
});
test('project or tier policy changes invalidate existing ledger fingerprint',()=>{
 const l=new Ledger(':memory:'),c=cfg();
 try {
  l.assertPolicy(c);
  const swapped=cfg();swapped.dataSharing.projectId='proj_another';
  assert.throws(()=>l.assertPolicy(swapped),(e:any)=>e.code==='POLICY_CHANGED');
  const downgraded=cfg();downgraded.dataSharing.tier='build';
  downgraded.quotas.premium.dailyTokens=250_000;
  downgraded.quotas.economy.dailyTokens=2_500_000;
  assert.throws(()=>l.assertPolicy(downgraded),(e:any)=>e.code==='POLICY_CHANGED');
 }finally{l.close();}
});
