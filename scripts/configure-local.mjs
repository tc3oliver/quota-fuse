#!/usr/bin/env node
/**
 * Local terminal-only credential setup. Never send keys through an agent chat,
 * shell command-line flags, stdin pipes or subprocess arguments.
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';

const PROJECTS='https://platform.openai.com/settings/organization/projects';
const KEYS='https://platform.openai.com/api-keys';
const ADMIN='https://platform.openai.com/settings/organization/admin-keys';
const file=resolve('config.json');
const cfg=JSON.parse(readFileSync(file,'utf8'));
if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode!=='function') {
  console.error('Open a SEPARATE local Terminal and run npm run configure:local yourself. Do not run this through an agent tool or pipe secrets.');
  process.exit(1);
}
function isProject(s){return /^proj_[a-zA-Z0-9_-]{3,}$/.test(s) && !/select|replace|your|placeholder/i.test(s);}
function secretPresent(path,name){
  if (!existsSync(path)) throw new Error('Missing '+path+'; run npm run onboard first');
  const st=lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)!==0)
    throw new Error(path+' must be a regular owner-only file (chmod 600); no symlinks allowed');
  const m=readFileSync(path,'utf8').match(new RegExp('^'+name+'=(.*)$','m'));
  return Boolean(m && m[1].trim());
}
function saveKey(path,name,key){
  if (/[^\x21-\x7e]/.test(key) || key.length < 8 || key.length > 512 || !key.startsWith('sk-'))
    throw new Error('Invalid OpenAI key format; no file changed');
  const old=readFileSync(path,'utf8');
  const re=new RegExp('^'+name+'=.*$','m');
  if(!re.test(old))throw new Error('Missing '+name+' entry in '+path);
  const revised=old.replace(re,name+'='+key);
  const temp=path+'.secure-'+randomUUID();
  try{
    writeFileSync(temp,revised,{mode:0o600,flag:'wx'});
    chmodSync(temp,0o600);
    renameSync(temp,path);
  }catch(e){try{unlinkSync(temp);}catch{}throw e;}
}
const rl=createInterface({input:process.stdin,output:process.stdout,terminal:true});
function ask(label){return new Promise(resolve=>rl.question(label,answer=>resolve(answer.trim())));}
function hidden(label){
  // Raw mode disables TTY echo. No masking stars and no logging of keystrokes.
  // Avoid readline listeners while accepting raw input.
  return new Promise((resolve,reject)=>{
    process.stdout.write(label);
    const original=process.stdin.isRaw===true;
    let chars='';
    function cleanup(){
      process.stdin.off('data',onData);
      process.stdin.setRawMode(original);
      process.stdin.pause();
      process.stdout.write('\n');
    }
    function onData(buf){
      for(const byte of buf){
        if(byte===3){cleanup();reject(new Error('Cancelled'));return;}
        if(byte===13 || byte===10){cleanup();resolve(chars.trim());return;}
        if(byte===127 || byte===8){chars=chars.slice(0,-1);continue;}
        if(byte>=32 && byte<=126 && chars.length<512)chars+=String.fromCharCode(byte);
      }
    }
    // readline was closed before entering the secret-input stage.
    process.stdin.setRawMode(true);
    process.stdin.on('data',onData);
    process.stdin.resume();
  });
}
try{
  console.log('QuotaFuse — local-only settings. Nothing is sent to ChatGPT or an agent.');
  console.log('Scope: All projects => any existing Project; Selected projects => one already opted in.');
  console.log('Projects: '+PROJECTS);
  const project=cfg.dataSharing?.projectId;
  const missingProject=!isProject(project);
  if(missingProject){
    const answer=await ask('Existing routing Project ID (proj_...; Enter to skip): ');
    if(answer){
      if(!isProject(answer))throw new Error('Project ID must be an existing valid proj_... value');
      console.log('Applying non-secret routing Project ID...');
      const result=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--experimental-strip-types',
        resolve('scripts/onboard.mjs'),'--project='+answer],{stdio:'inherit',cwd:process.cwd()});
      if(result.status!==0)throw new Error('Project configuration rejected; see policy reconciliation guidance');
    }
  }
  const tier=cfg.dataSharing?.tier;
  const choice=await ask('Organization Data Sharing tier (build/launch/grow; Enter keeps '+tier+'): ');
  if(choice && choice!==tier){
    if(!['build','launch','grow'].includes(choice))throw new Error('Invalid tier');
    const result=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--experimental-strip-types',
      resolve('scripts/onboard.mjs'),'--tier='+choice],{stdio:'inherit',cwd:process.cwd()});
    if(result.status!==0)throw new Error('Tier configuration rejected; see policy reconciliation guidance');
  }
  const stages=[
    {path:resolve('.env.proxy'),name:'OPENAI_API_KEY',label:'Project API key',link:KEYS},
    {path:resolve('.env.collector'),name:'OPENAI_ADMIN_KEY',label:'Organization Admin API key',link:ADMIN}
  ];
  rl.close(); // Prevent readline's TTY echo handler from observing secret keystrokes.
  for(const stage of stages){
    if(secretPresent(stage.path,stage.name)){
      console.log(stage.label+': already configured; preserving existing value.');
      continue;
    }
    console.log(stage.label+': '+stage.link);
    const value=await hidden('Paste '+stage.label+' here (hidden; Enter skips): ');
    if(!value){console.log('Skipped.');continue;}
    saveKey(stage.path,stage.name,value);
    console.log(stage.label+': saved securely to '+stage.path.replace(process.cwd()+'/',''));
  }
  console.log('Local configuration complete. Run npm run doctor, then ask your agent to continue.');
  console.log('The live billing/collector gates remain untouched; no OpenAI API calls were sent.');
}catch(e){console.error('Local configuration stopped: '+e.message);process.exitCode=1;}
finally{rl.close();}
