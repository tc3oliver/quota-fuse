#!/usr/bin/env node
/**
 * Explicit offline migration of legacy, premium-only accounting.
 * Requires both services stopped. No migration on a day with existing
 * reservations or official collector baselines.
 */
import { readFileSync,writeFileSync,renameSync,unlinkSync,lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig,validateConfig } from '../src/config.ts';
import { Ledger } from '../src/ledger.ts';
import { acquireInstanceLock } from '../src/instance-lock.ts';

const [operator,...details] = process.argv.slice(2);
const evidence=details.join(' ');
if (!/^[a-zA-Z0-9_.@-]{3,100}$/.test(operator??'') || evidence.trim().length<80 || evidence.length>4096) {
  console.error('Usage: npm run accounting:upgrade -- <operator-id> <detailed independent old-day & new-day billing/audit reference>');
  console.error('Requires services STOPPED, a new UTC day WITHOUT usage/collector observations, and reviewed older UNKNOWNs.');
  process.exit(2);
}
const path=resolve(process.env.QG_CONFIG??'./config.json');
const st=lstatSync(path);
if(!st.isFile() || st.isSymbolicLink() || (st.mode&0o077)!==0)
  throw new Error('Refusing to modify non-private or symlinked config.json');
const raw=readFileSync(path,'utf8');
const current=loadConfig(path);
if(current.dataSharing.modelGroupAccounting==='official_v1')throw new Error('Group mapping already enabled');
const next=validateConfig(structuredClone(current));
next.dataSharing.modelGroupAccounting='official_v1';
const release=[];
let ledger;
try{
  release.push(acquireInstanceLock(current.server.storage,'proxy'));
  release.push(acquireInstanceLock(current.server.storage,'collector'));
  ledger=new Ledger(current.server.storage,{recoverPending:false});
  ledger.verifyPolicy(current);
  ledger.enterManualReview();
  const temp=path+'.upgrade-'+randomUUID();
  try{
    writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'});
    // Database transaction first: crash between the two updates yields
    // POLICY_CHANGED / PAUSED, never an automatically unguarded service.
    ledger.upgradeOfficialGroupAccounting(current,next,operator,evidence);
    renameSync(temp,path);
    console.log('Audited accounting cutover to official_v1. All past reservations/observations preserved.');
    console.log('Restart Collector for a fresh group-aware baseline, then Proxy; check npm run status:local.');
  }finally{try{unlinkSync(temp);}catch{}}
}finally{
  try{ledger?.close();}finally{for(const u of release.reverse())u();}
}
