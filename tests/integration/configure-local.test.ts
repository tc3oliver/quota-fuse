import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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


test('local TTY wizard stores separate keys without ever echoing secret values', {skip: process.platform !== 'linux' || spawnSync('which',['script']).status!==0}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'qf-configure-tty-'));
  try{
    copyFileSync(example,join(dir,'config.example.json'));
    assert.equal(spawnSync(process.execPath,[setup],{cwd:dir,encoding:'utf8'}).status,0);
    const projectKey='sk-PROJECT-NOT-ECHOED-987654321';
    const adminKey='sk-ADMIN-NOT-ECHOED-987654321';
    const command=process.execPath+' '+configure;
    const child=spawn('script',['-q','-c',command,'/dev/null'],{cwd:dir,stdio:['pipe','pipe','pipe']});
    let output='',sent=0,closed=false;
    const patterns=[
      ['Existing routing Project ID','proj_ExistingForWizard123\n'],
      ['Organization Data Sharing tier','\n'],
      ['Paste Project API key here',projectKey+'\n'],
      ['Paste Organization Admin API key here',adminKey+'\n']
    ] as const;
    let stage=0;
    const terminal=(chunk:Buffer)=>{
      output+=chunk.toString('utf8');
      if(stage<patterns.length && output.includes(patterns[stage][0])){
        const value=patterns[stage][1];
        stage++;
        setTimeout(()=>{if(!closed)child.stdin.write(value);},20);
      }
    };
    child.stdout.on('data',terminal);
    child.stderr.on('data',terminal);
    const status=await new Promise<number|null>((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('PTY wizard timed out; output: '+output.slice(-900)));},15000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.once('close',code=>{closed=true;clearTimeout(timer);resolve(code);});
    });
    assert.equal(status,0,output);
    assert.equal(stage,patterns.length,output);
    assert.match(output,/Read Only or Restricted \/ Organization Usage: Read/);
    assert.match(output,/Read Only will not work/);
    assert.doesNotMatch(output,/sk-PROJECT-NOT-ECHOED|sk-ADMIN-NOT-ECHOED/);
    assert.match(readFileSync(join(dir,'.env.proxy'),'utf8'),/OPENAI_API_KEY=sk-PROJECT-NOT-ECHOED/);
    assert.match(readFileSync(join(dir,'.env.collector'),'utf8'),/OPENAI_ADMIN_KEY=sk-ADMIN-NOT-ECHOED/);
    assert.match(readFileSync(join(dir,'config.json'),'utf8'),/proj_ExistingForWizard123/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
