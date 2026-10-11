import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
/** Prevent a second proxy process from converting active reservations to UNKNOWN. */
export function acquireInstanceLock(databasePath: string, role: 'proxy' | 'collector' = 'proxy'): () => void {
  if (databasePath === ':memory:') throw new Error('Production proxy requires persistent database');
  const path=resolve(databasePath)+'.'+role+'.lock';
  mkdirSync(dirname(path), { recursive:true, mode:0o700 });
  for (let attempts=0; attempts<2; attempts++) {
    try {
      const fd=openSync(path,'wx',0o600);
      writeFileSync(fd,String(process.pid)); closeSync(fd);
      return ()=>{ try { if (readFileSync(path,'utf8').trim()===String(process.pid)) unlinkSync(path); } catch {} };
    } catch (e:any) {
      if (e.code!=='EEXIST') throw e;
      let oldPid=0;
      try { oldPid=Number(readFileSync(path,'utf8').trim()); } catch { /* fail closed below */ }
      if (!Number.isSafeInteger(oldPid) || oldPid<=1) throw new Error('Invalid proxy lock; manual review required');
      try { process.kill(oldPid,0); throw new Error('Quota Guard instance already active'); }
      catch (check:any) {
        if(check.code==='ESRCH') { unlinkSync(path); continue; }
        throw check;
      }
    }
  }
  throw new Error('Could not acquire single-instance lock');
}
