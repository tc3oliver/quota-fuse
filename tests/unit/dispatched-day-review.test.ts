import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../../src/ledger.ts';
import { cfg } from '../helpers.ts';

const oldDay='2025-01-01';
const rollover='2025-01-02';
const audited='2025-01-03';
const terminal='2025-01-01T11:00:05.000Z';
const evidence='response log request ID req_xyz confirms status incomplete at 11:00 UTC; independently audited finalized old+new UTC day usage, all project traffic and Costs dashboard after the required delay: audit-ticket-0059';
function setup(phase:'DISPATCHED'|'PREFLIGHT'='DISPATCHED') {
  const l=new Ledger(':memory:'),c=cfg();
  l.assertPolicy(c);
  l.recordObservation(oldDay,'premium',0,new Date(oldDay+'T11:00:00Z'));
  l.setPause(null);
  l.admit(c,{key:'live-trial-000001',hash:'hash-test',requestId:'req-unique',
    model:c.quotas.premium.models[0],group:'premium',day:oldDay,
    reserve:280,now:new Date(oldDay+'T11:00:01Z')});
  if(phase==='DISPATCHED')l.prepareDispatch(c,'live-trial-000001',7,257,new Date(oldDay+'T11:00:02Z'));
  l.unknown('live-trial-000001');
  l.db.prepare('UPDATE reservations SET updated_at=? WHERE idempotency_key=?').run('2025-01-01T11:00:10.000Z','live-trial-000001');
  l.recordObservation(audited,'premium',0,new Date(audited+'T10:00:00Z'));
  l.recordObservation(audited,'economy',0,new Date(audited+'T10:00:00Z'));
  l.setPause('MANUAL_REVIEW');
  return {l,c};
}
test('DISPATCHED UNKNOWN blocks at UTC rollover; audited terminal-day review preserves UNKNOWN and full reservation',()=>{
 const {l,c}=setup();
 try{
   assert.equal(l.hasCrossDayUnknown(rollover),true);
   assert.equal(l.hasCrossDayUnknown(audited),true);
   l.reviewDispatchedDay('live-trial-000001','operator1',terminal,evidence,new Date('2025-01-03T10:01:00Z'));
   assert.equal(l.hasCrossDayUnknown(audited),false);
   assert.equal(l.find('live-trial-000001')?.state,'UNKNOWN');
   assert.equal(l.find('live-trial-000001')?.actual,null);
   assert.equal(l.find('live-trial-000001')?.reserved,280);
   assert.equal(l.snapshot(c,oldDay,'premium',new Date(oldDay+'T11:02:00Z')).admitted_reserved,280);
   const saved=l.db.prepare('SELECT operator,evidence,reserved FROM dispatched_day_reviews WHERE idempotency_key=?').get('live-trial-000001') as any;
   assert.equal(saved.reserved,280);
   assert.equal(saved.operator,'operator1');
   assert.equal(saved.evidence,evidence);
   assert.equal((l.db.prepare('SELECT COUNT(*) AS n FROM reconciliation_audit WHERE idempotency_key=?').get('live-trial-000001') as any).n,1);
   assert.throws(()=>l.reviewDispatchedDay('live-trial-000001','operator1',terminal,evidence,new Date('2025-01-03T10:01:00Z')),(x:any)=>x.code==='DUPLICATE_REVIEW');
 }finally{l.close();}
});
test('cooldown blocks reviews until a full UTC day after old day end',()=>{
 const {l}=setup();
 try{
   assert.throws(()=>l.reviewDispatchedDay('live-trial-000001','operator1',terminal,evidence,new Date('2025-01-02T23:59:59Z')),(e:any)=>e.code==='AUDIT_COOLDOWN');
   assert.equal(l.hasCrossDayUnknown(audited),true);
 }finally{l.close();}
});
test('no audit when terminal proof is beyond UTC day or recorded after midnight',()=>{
 const {l}=setup();
 try{
   for(const timestamp of ['2025-01-02T00:00:00Z','2025-01-01T10:00:00Z']){
     assert.throws(()=>l.reviewDispatchedDay('live-trial-000001','operator1',timestamp,evidence,new Date('2025-01-03T10:01:00Z')),(e:any)=>e.code==='DAY_BOUNDARY_UNVERIFIED');
   }
   l.db.prepare('UPDATE reservations SET updated_at=? WHERE idempotency_key=?').run('2025-01-02T00:00:05Z','live-trial-000001');
   assert.throws(()=>l.reviewDispatchedDay('live-trial-000001','operator1',terminal,evidence,new Date('2025-01-03T10:01:00Z')),(e:any)=>e.code==='DAY_BOUNDARY_UNVERIFIED');
   assert.equal(l.hasCrossDayUnknown(audited),true);
 }finally{l.close();}
});
test('PRE-FLIGHT UNKNOWN cannot be granted DISPATCHED rollover exemption',()=>{
 const {l}=setup('PREFLIGHT');
 try{
   assert.throws(()=>l.reviewDispatchedDay('live-trial-000001','operator1',terminal,evidence,new Date('2025-01-03T10:01:00Z')),(e:any)=>e.code==='INVALID_TRANSITION');
   assert.equal(l.hasCrossDayUnknown(audited),true);
 }finally{l.close();}
});
test('unknown without fresh BOTH next-day group observations cannot be reviewed',()=>{
 const {l}=setup();
 try{
   l.db.prepare("DELETE FROM observations WHERE utc_day=? AND group_name='economy'").run(audited);
   assert.throws(()=>l.reviewDispatchedDay('live-trial-000001','operator1',terminal,evidence,new Date('2025-01-03T10:01:00Z')),(e:any)=>e.code==='COLLECTOR_UNVERIFIED');
   assert.equal(l.hasCrossDayUnknown(audited),true);
 }finally{l.close();}
});
test('review requires paused ledger and substantive independently verified evidence',()=>{
 const {l}=setup();
 try{
   assert.throws(()=>l.reviewDispatchedDay('live-trial-000001','operator1',terminal,'trust me',new Date('2025-01-03T10:01:00Z')),(e:any)=>e.code==='INVALID_EVIDENCE');
   l.setPause(null);
   assert.throws(()=>l.reviewDispatchedDay('live-trial-000001','operator1',terminal,evidence,new Date('2025-01-03T10:01:00Z')),(e:any)=>e.code==='PAUSE_REQUIRED');
 }finally{l.close();}
});
test('reviewed dispatched request does not hide another older unreconciled reservation',()=>{
 const {l}=setup();
 try{
   l.reviewDispatchedDay('live-trial-000001','operator1',terminal,evidence,new Date('2025-01-03T10:01:00Z'));
   l.db.prepare(`INSERT INTO reservations
     (idempotency_key,request_id,body_hash,model,group_name,utc_day,reserved,actual,state,admitted_at,updated_at,phase)
     VALUES('second','req-2','hash','gpt-test-2026-10-11','premium','2025-01-01',90,NULL,'UNKNOWN','2025-01-01T10:00:00Z','2025-01-01T11:00:00Z','PREFLIGHT')`).run();
   assert.equal(l.hasCrossDayUnknown(audited),true);
 }finally{l.close();}
});

test('a stopped empty new UTC day can migrate group mapping after separately audited prior-day UNKNOWN',()=>{
 const {l,c}=setup();
 try{
   l.reviewDispatchedDay('live-trial-000001','operator1',terminal,evidence,new Date('2025-01-03T10:01:00Z'));
   const updated=structuredClone(c);
   updated.dataSharing.modelGroupAccounting='official_v1';
   l.upgradeOfficialGroupAccounting(c,updated,'operator1',evidence,new Date('2025-01-04T00:01:00Z'));
   assert.doesNotThrow(()=>l.verifyPolicy(updated));
   assert.equal(l.hasCrossDayUnknown('2025-01-04'),false);
   assert.equal(l.find('live-trial-000001')?.state,'UNKNOWN');
   const row=l.db.prepare('SELECT * FROM accounting_migration_audit').get() as any;
   assert.equal(row.effective_utc_day,'2025-01-04');
   assert.equal(row.operator,'operator1');
 }finally{l.close();}
});
test('existing current-day official baseline prevents group reclassification',()=>{
 const {l,c}=setup();
 try{
   const updated=structuredClone(c);updated.dataSharing.modelGroupAccounting='official_v1';
   assert.throws(()=>l.upgradeOfficialGroupAccounting(c,updated,'operator1',evidence,new Date('2025-01-03T10:01:00Z')),(e:any)=>e.code==='PRIOR_DAY_UNKNOWN');
   l.reviewDispatchedDay('live-trial-000001','operator1',terminal,evidence,new Date('2025-01-03T10:01:00Z'));
   assert.throws(()=>l.upgradeOfficialGroupAccounting(c,updated,'operator1',evidence,new Date('2025-01-03T10:01:00Z')),(e:any)=>e.code==='DAY_ALREADY_STARTED');
   assert.doesNotThrow(()=>l.verifyPolicy(c));
 }finally{l.close();}
});

test('manual review entry does not erase an existing critical collector pause',()=>{
 const l=new Ledger(':memory:');
 try {
   l.setPause('UNACCOUNTED_OFFICIAL_USAGE');
   l.enterManualReview();
   assert.equal(l.pauseReason(),'UNACCOUNTED_OFFICIAL_USAGE');
   l.setPause('ANCHOR_UNVERIFIED');
   l.enterManualReview();
   assert.equal(l.pauseReason(),'ANCHOR_UNVERIFIED');
   l.setPause(null);
   l.enterManualReview();
   assert.equal(l.pauseReason(),'MANUAL_REVIEW');
 }finally{l.close();}
});
