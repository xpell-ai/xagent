import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
function run(parent,stage){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[new URL('./plugins-integration-scenario.mjs',import.meta.url).pathname,parent,stage],{env:{PATH:process.env.PATH,NODE_ENV:'test',NODE_OPTIONS:process.env.NODE_OPTIONS??''}});let output='';p.stdout.on('data',x=>output+=x);p.stderr.on('data',x=>output+=x);p.on('error',reject);const timer=setTimeout(()=>p.kill('SIGKILL'),20000);p.on('close',(exit,signal)=>{clearTimeout(timer);try{assert.equal(exit,0,output+'\n'+signal);assert.match(output,/PLUGIN_INTEGRATION_PASS/);resolve();}catch(e){reject(e);}});});}
for(const mode of ['run','read-allowed','read-denied'])test('Plugin T1/T2/T3 integration and fresh-process restart: '+mode,async()=>{const p=await mkdtemp(join(tmpdir(),'adk-plugin-fixture-'));try{if(mode!=='run')await run(p,'seed');await run(p,mode);}finally{await rm(p,{recursive:true,force:true});}});
