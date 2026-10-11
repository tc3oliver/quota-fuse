import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock } from '../../src/instance-lock.ts';
test('first launch creates DB directory, locks single proxy and releases lock',()=>{
  const dir=mkdtempSync(join(tmpdir(),'qg-lock-'));const path=join(dir,'nested','data.sqlite');
  try {const release=acquireInstanceLock(path);
    assert.ok(existsSync(path+'.proxy.lock'));
    assert.throws(()=>acquireInstanceLock(path));
    release();assert.ok(!existsSync(path+'.proxy.lock'));
  }finally{rmSync(dir,{recursive:true,force:true});}
});


test('collector lock excludes duplicate collectors',()=> {
  const dir=mkdtempSync(join(tmpdir(),'quota-guard-collector-lock-'));
  try {
    const db=join(dir,'guard.sqlite'), release=acquireInstanceLock(db,'collector');
    assert.throws(()=>acquireInstanceLock(db,'collector'),/already active/);
    release();
    const releaseAgain=acquireInstanceLock(db,'collector');releaseAgain();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
