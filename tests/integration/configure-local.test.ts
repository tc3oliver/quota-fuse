import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const setup=fileURLToPath(new URL('../../scripts/setup.mjs',import.meta.url));
const configure=fileURLToPath(new URL('../../scripts/configure-local.mjs',import.meta.url));
const example=fileURLToPath(new URL('../../config.example.json',import.meta.url));

test('local credential wizard refuses non-TTY and does not read piped key material',()=>{
  const dir=mkdtempSync(join(tmpdir(),'qf-configure-'));
  try {
    copyFileSync(example,join(dir,'config.example.json'));
    const prepared=spawnSync(process.execPath,[setup],{cwd:dir,encoding:'utf8'});
    assert.equal(prepared.status,0,prepared.stderr);
    const priorProxy=readFileSync(join(dir,'.env.proxy'),'utf8');
    const priorAdmin=readFileSync(join(dir,'.env.collector'),'utf8');
    const result=spawnSync(process.execPath,[configure],{
      cwd:dir,encoding:'utf8',input:'sk-NOT-AN-API-KEY-DO-NOT-READ\n'
    });
    assert.equal(result.status,1);
    assert.match(result.stderr,/SEPARATE local Terminal/);
    assert.doesNotMatch(result.stdout+result.stderr,/sk-NOT-AN-API-KEY/);
    assert.equal(readFileSync(join(dir,'.env.proxy'),'utf8'),priorProxy);
    assert.equal(readFileSync(join(dir,'.env.collector'),'utf8'),priorAdmin);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
