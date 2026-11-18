import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
const worker=new URL('./tool-loop-collision-scenario.mjs',import.meta.url);
for(const mode of ['hidden-action','denied-read','hidden-read','both-hidden','both-exposed','allowlist-removal','legacy-action','legacy-read','catalog-valid','catalog-action-kind','catalog-read-kind','catalog-missing','catalog-duplicate','catalog-late-mismatch']){
 test(`Model Tool Loop collision/catalog: ${mode}`,async()=>{
  const parent=await mkdtemp(join(tmpdir(),'adk-collision-'));
  try{for(const stage of mode.startsWith('legacy-')||mode.startsWith('catalog-')?['seed','read']:['run']){
   const r=spawnSync(process.execPath,[worker.pathname,mode,parent,stage],{encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:process.env.NODE_OPTIONS,LANG:'C',NODE_ENV:'test'}});
   assert.equal(r.status,0,`${mode}/${stage}\n${r.stdout}\n${r.stderr}`);assert.match(r.stdout,/COLLISION_REGRESSION_PASS/);
  }}finally{await rm(parent,{recursive:true,force:true});}
 });
}
