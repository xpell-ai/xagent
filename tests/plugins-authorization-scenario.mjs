import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import net from 'node:net';import http from 'node:http';import https from 'node:https';
let prohibited=0;const deny=()=>{prohibited++;throw Error('offline fixture blocked network');};
globalThis.fetch=deny;net.Socket.prototype.connect=deny;http.request=http.get=https.request=https.get=deny;syncBuiltinESMExports();
const {defineAgentPlugin,createAgentPluginRegistry,AgentPluginError}=await import('@xpell/agent/adk/plugins');
const {defineAction,createDurableActions}=await import('@xpell/agent/adk/actions');
const {_x}=await import('@xpell/node');
const Database=createRequire(import.meta.url)('better-sqlite3');
const [mode,parent,stage='run']=process.argv.slice(2),target=new Database(join(parent,'synthetic-target.sqlite'));
target.pragma('journal_mode = WAL');target.pragma('synchronous = FULL');target.exec('CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, receipt TEXT NOT NULL)');
const schema={type:'object',additionalProperties:false,properties:{text:{type:'string',minLength:1,maxLength:32}},required:['text']};
const empty={_host:[],_agent:[]},grants={_host:['fixture.local'],_agent:['fixture.use']};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const entered=deferred(),release=deferred();let block=false,denyAction,globalCalls=0,confirmedFault=false,scanPause=false;
let rowCalls=0,evidenceReads=0,effects=0;
const spoof=()=>mode.endsWith('lookalike')?new AgentPluginError('E_ADK_PLUGIN_DENIED'):{_code:'E_ADK_PLUGIN_DENIED'};
const r=createAgentPluginRegistry({_peers:{'@xpell/agent':'2.0.8'}});
for(const id of ['alpha','beta'])r.register(defineAgentPlugin({_id:id,_version:'1.0.0',_contract:1,_peers:{},_dependencies:[],_permissions:grants,_actions:[defineAction({
 _id:id+'.record',_description:'Neutral synthetic Action',_revision:'1',_input_schema:schema,
 async _prepare_action({_arguments}){
  if(mode.startsWith('spoof-prepare'))throw spoof();
  if(mode==='prepare-revoke'&&block){entered.resolve();await release.promise;}
  return {_arguments,_authorized_scope:{resource:'synthetic'},_confirmation_summary:'Synthetic proposal'};
 },
 async _handler(input){
  effects++;
  const receipt={_action_id:input._action_id,_binding_hash:input._binding_hash,_idempotency_key:input._idempotency_key,_outcome:{_status:'succeeded',_result:{text:'synthetic'}}};
  target.prepare('INSERT INTO receipts VALUES (?,?)').run(input._idempotency_key,JSON.stringify(receipt));
  if(mode==='handler-revoke'&&block){entered.resolve();await release.promise;return receipt._outcome;}
  // A committed fixture effect with lost acknowledgement requires reconciliation.
  throw Error('SYNTHETIC_ACK_LOST');
 },
 async _read_committed_outcome(input){
  evidenceReads++;
  if(mode.startsWith('spoof-evidence'))throw spoof();
  if(mode==='evidence-revoke'&&block){entered.resolve();await release.promise;}
  const v=target.prepare('SELECT receipt FROM receipts WHERE id=?').get(input._idempotency_key);return v?JSON.parse(v.receipt):null;
 },
})]}));
r.setGrants('alpha',grants);if(!(mode==='cold-ungranted'&&stage==='read'))r.setGrants('beta',grants);
const policy=r.actionPolicy(async i=>{
 if(i._phase==='reconcile'){
  if(i._capability_id==='actions.reconcile'){
   globalCalls++;
   if(mode.startsWith('terminal-')&&globalCalls===2){entered.resolve();await release.promise;if(mode==='terminal-scan-deny')return false;}
  }else rowCalls++;
 }
 return i._capability_id!==denyAction;
});
const app=createDurableActions({_name:'plugin-authorization',_instance_id:'plugin-authorization',_application_scope:{_env:'test',_app_id:'plugin-authorization'},_host:{_work_folder:join(parent,'instance'),_listen:{_host:'127.0.0.1',_port:0}},_actions:r.getContributions()._actions,_policy:policy,_limits:{_timeout_ms:2000,_max_json_bytes:4096}});
const ctx=d=>app.bindContext({_actor_id:'actor',_conversation_id:'conversation',_delivery_id:d});
const prepare=(id,d)=>app.prepare({_capability_id:id+'.record',_arguments:{text:'fixture'}},ctx(d));
const params=p=>({_action_id:p._action_id,_binding_hash:p._binding_hash});
const original=_x.execute;
_x.execute=async function(c){const v=await original.call(this,c);
 if(confirmedFault&&c._module==='entity-manager'&&c._op==='update'&&c._params?._entity==='agent_action'&&c._params._updates?._state==='confirmed'&&v?._result?._updated===1)throw Error('SYNTHETIC_CONFIRM_ACK_LOST');
 if(scanPause&&c._module==='entity-manager'&&c._op==='find'&&c._params?._entity==='agent_action'){scanPause=false;entered.resolve();await release.promise;}
 return v;
};
try{
 await app.start();await r.start();const operator=ctx('operator');
 if(mode==='prepare-revoke'||mode.startsWith('spoof-prepare')){
  block=true;const pending=prepare('beta','request');const expected=assert.rejects(pending,{_code:mode==='prepare-revoke'?'E_ADK_ACTION_DENIED':'E_ADK_ACTION_RESULT'});
  if(mode==='prepare-revoke'){await entered.promise;r.setGrants('beta',empty);release.resolve();}
  await expected;assert.equal(effects,0);
 }else if(['evidence-revoke','handler-revoke','authorized-evidence'].includes(mode)||mode.startsWith('spoof-evidence')){
  const p=await prepare('beta','request');block=mode==='handler-revoke';const pending=app.confirm(params(p),operator),uncertain=assert.rejects(pending,{_code:'E_ADK_ACTION_UNCERTAIN'});
  if(mode==='handler-revoke'){await entered.promise;r.setGrants('beta',empty);release.resolve();}
  await uncertain;assert.equal(effects,1);r.setGrants('beta',grants);assert.equal((await app.get(p._action_id,operator))._state,'executing');
  if(mode==='evidence-revoke'){
   block=true;const pending=app.reconcile({_limit:4},operator),denied=assert.rejects(pending,{_code:'E_ADK_ACTION_DENIED'});await entered.promise;r.setGrants('beta',empty);release.resolve();await denied;r.setGrants('beta',grants);block=false;assert.equal((await app.get(p._action_id,operator))._state,'executing');
  }
  if(mode.startsWith('spoof-evidence')){await assert.rejects(app.reconcile({_limit:4},operator),{_code:'E_ADK_ACTION_STORAGE'});assert.equal((await app.get(p._action_id,operator))._state,'executing');}
  else{assert.equal((await app.reconcile({_limit:4},operator))._completed,1);assert.equal((await app.get(p._action_id,operator))._state,'succeeded');}
  assert.equal(effects,1);assert.equal(target.prepare('SELECT count(*) AS n FROM receipts').get().n,1);
 }else if(mode==='preflight-no-repair'){
  const a=await prepare('alpha','alpha-request');await assert.rejects(app.confirm(params(a),operator),{_code:'E_ADK_ACTION_UNCERTAIN'});
  const b=await prepare('beta','beta-request');confirmedFault=true;await assert.rejects(app.confirm(params(b),operator));confirmedFault=false;
  r.setGrants('beta',empty);await assert.rejects(app.reconcile({_limit:4},operator),{_code:'E_ADK_ACTION_DENIED'});assert.equal(evidenceReads,0);assert.equal((await app.get(a._action_id,operator))._state,'executing');assert.equal(effects,1);
  r.setGrants('beta',grants);assert.equal((await app.reconcile({_limit:4},operator))._completed,1);assert.equal(effects,1);
 }else{
  let ps;
  if(stage==='read')ps=JSON.parse(await readFile(join(parent,'proposals.json'),'utf8'));
  else{
   ps=[await prepare(mode==='lookahead-denied'?'alpha':'beta','request-1'),await prepare('beta','request-2')];
   confirmedFault=true;for(const p of ps){await assert.rejects(app.confirm(params(p),operator));assert.equal((await app.get(p._action_id,operator))._state,'confirmed');}confirmedFault=false;
   await writeFile(join(parent,'proposals.json'),JSON.stringify(ps));
  }
  assert.equal(effects,0);
  if(stage!=='seed'){
   if(mode==='grant-denied')r.setGrants('beta',empty);
   if(mode==='policy-denied')denyAction='beta.record';
   if(mode==='lookahead-denied'){
    const ordered=ps.toSorted((a,b)=>a._action_id.localeCompare(b._action_id));
    // Use two distinct plugin owners; the selected owner remains authorized.
    if(ordered[0]._capability_id===ordered[1]._capability_id)throw Error('lookahead fixture owners must differ');
    r.setGrants(ordered[1]._capability_id.split('.')[0],empty);assert.equal((await app.get(ordered[0]._action_id,operator))._state,'confirmed');
   }
   if(['stop-during-scan','revoke-restore-during-scan'].includes(mode))scanPause=true;
   const work=app.reconcile({_limit:mode==='lookahead-denied'?1:mode==='authorized-page'?1:4},operator);
   const denied=!['authorized-page','authorized-empty'].includes(mode);
   const outcome=denied?assert.rejects(work,{_code:'E_ADK_ACTION_DENIED'}):work;
   if(scanPause||['stop-during-scan','revoke-restore-during-scan'].includes(mode)){
    await entered.promise;if(mode==='stop-during-scan')await r.stop();else{r.setGrants('beta',empty);r.setGrants('beta',grants);}release.resolve();
   }
   if(mode.startsWith('terminal-')){
    await entered.promise;
    if(mode==='terminal-stop'){
     let stopped=false;const stopping=r.stop().then(()=>{stopped=true;});await new Promise(r=>setImmediate(r));assert.equal(stopped,false);release.resolve();await outcome;await stopping;
    }else{
     if(mode==='terminal-revoke'){r.setGrants('beta',empty);r.setGrants('beta',grants);}
     if(mode==='terminal-row-deny')denyAction='beta.record';
     release.resolve();
    }
   }
   const value=await outcome;
   if(!denied){assert.equal(value._confirmed,1);assert.equal(value._scan_truncated,true);assert.ok(ps.some(p=>p._action_id===value._next_after_id));assert.ok(rowCalls>=4);}
   assert.equal(effects,0);assert.equal(evidenceReads,0);
   if(['grant-denied','policy-denied','cold-ungranted','lookahead-denied'].includes(mode))assert.ok(globalCalls>=1);
  }
 }
 assert.equal(prohibited,0);console.log('PLUGIN_AUTHORIZATION_PASS',mode,stage,JSON.stringify({rowCalls,globalCalls,evidenceReads,effects}));
}finally{release.resolve();_x.execute=original;await r.dispose();await app.close();target.close();}
