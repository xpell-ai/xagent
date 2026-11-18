import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import net from 'node:net';import http from 'node:http';import https from 'node:https';
const [mode,parent,stage='run']=process.argv.slice(2);
let denied=0;const ports=new Set(),fetch=globalThis.fetch,connect=net.Socket.prototype.connect;
const block=()=>{denied++;throw Error('offline collision fixture blocked network');};
globalThis.fetch=(url,...a)=>{const u=new URL(url);if(u.hostname!=='127.0.0.1'||!ports.has(+u.port)||[3001,3100].includes(+u.port))return block();return fetch(url,...a);};
net.Socket.prototype.connect=function(...a){const v=Array.isArray(a[0])?a[0][0]:a[0];if(!ports.has(+(v?.port??v))||![undefined,'127.0.0.1','::1'].includes(v?.host))return block();return connect.apply(this,a);};
http.request=http.get=https.request=https.get=block;syncBuiltinESMExports();
const require=createRequire(import.meta.url),root=dirname(require.resolve('@xpell/agent/package.json'));
const {startToolLoopFixture,echoSchema,TOOL_LOOP_FIXTURE_KEY}=await import(pathToFileURL(join(root,'examples/model-tool-loop.mjs')));
const {createRouterToolLoop}=await import('@xpell/agent/adk/tool-loop');const {routerTextModel}=await import('@xpell/agent/adk');
const {defineTool,createToolRegistry}=await import('@xpell/agent/adk/tools');const {defineAction,createDurableActions}=await import('@xpell/agent/adk/actions');const {_x}=await import('@xpell/node');
const cold=mode.startsWith('legacy-')||mode.startsWith('catalog-');
const colliding=['hidden-action','denied-read','hidden-read','both-hidden','both-exposed','allowlist-removal'].includes(mode);
const actionId=colliding?'sample.echo':'sample.record';
const wantsAction=cold&&!['legacy-read','catalog-read-kind'].includes(mode);
const call=(name,id)=>({_id:id,_name:name,_arguments:{text:'fixture'}});
const calls=wantsAction? mode==='catalog-late-mismatch'?[call('sample.record','a1'),call('sample.other','a2')]:[call('sample.record','a1')]:[call('sample.echo','r1')];
let fixture,endpoint;
if(stage==='read')endpoint=await readFile(join(parent,'endpoint'),'utf8');else{fixture=await startToolLoopFixture([{_ok:true,_text:'',_finish_reason:'tool_calls',_tool_calls:calls},{_ok:true,_text:'neutral completion',_finish_reason:'stop'}]);endpoint=fixture.endpoint;ports.add(+new URL(endpoint).port);await writeFile(join(parent,'endpoint'),endpoint);}
process.env.COLLISION_FIXTURE=TOOL_LOOP_FIXTURE_KEY;
let reads=0,prepares=0,effects=0,invokePolicies=0,discovery=0,loop;
const action=id=>defineAction({_id:id,_description:'Neutral collision Action',_revision:'1',_input_schema:echoSchema,
 _prepare_action:({_arguments})=>{prepares++;return {_arguments,_authorized_scope:{resource:'synthetic'},_confirmation_summary:'Synthetic proposal'};},
 _handler:()=>{effects++;return {_status:'succeeded',_result:{text:'synthetic outcome'}};}});
const host=createDurableActions({_name:'collision-test',_instance_id:'collision-test',_application_scope:{_env:'test',_app_id:'collision-test'},
 _host:{_work_folder:join(parent,'instance'),_listen:{_host:'127.0.0.1',_port:0}},_actions:[action(actionId),action('sample.other')],_policy:()=>true,_limits:{_timeout_ms:1000,_max_json_bytes:8192}});
const registry=createToolRegistry({_tools:[defineTool({_id:'sample.echo',_description:'Neutral collision Read',_input_schema:echoSchema,_effect:'read',_confirmation:'none',_handler:()=>{reads++;return {text:'fixture'};}})],
 _policy:({_phase,_context})=>{if(_phase==='invoke')invokePolicies++;return ['hidden-read','both-hidden'].includes(mode)||mode==='denied-read'&&_phase==='invoke'?{_allow:false}:{_allow:true,_policy_revision:'1',_authorized_scope:_context};},
 _limits:{_timeout_ms:1000,_max_input_bytes:4096,_max_output_bytes:8192,_max_invocations:32,_max_contexts:32}});
const options={_actions:host,_reads:registry,_action_ids:mode==='allowlist-removal'?[]:[actionId,...(mode==='catalog-late-mismatch'?['sample.other']:[])],_system:'Neutral collision fixture.',
 _model:routerTextModel({_endpoint:endpoint,_model:'fixture',_credential:{_env:'COLLISION_FIXTURE'},_timeout_ms:1000,_error_policy:'fail-closed',_allow_requests:true}),
 _policy:({_phase})=>{if(_phase==='expose-action')discovery++;return !(['hidden-action','denied-read','both-hidden'].includes(mode)&&_phase==='expose-action');},
 _limits:{_max_rounds:3,_max_calls:4,_max_calls_per_round:4,_max_transcript_bytes:8192,_max_output_tokens:64,_max_total_tokens:30000,_timeout_ms:3000}};
const input={_text:'synthetic request'},identity={_actor_id:'actor',_conversation_id:'conversation',_delivery_id:'delivery'};
// Only the owned fixture's terminal receipt is transformed to a historical or
// inconsistent data shape. No production state or library code is modified.
const execute=_x.execute;let saved;
_x.execute=async function(cmd){
 if(cmd._module==='xai'&&mode.startsWith('catalog-')){assert.ok(Object.isFrozen(cmd._params._tools));for(const t of cmd._params._tools){assert.ok(Object.isFrozen(t));assert.ok(Object.isFrozen(t._input_schema));}}
 if(stage==='seed'&&cmd._module==='entity-manager'&&cmd._op==='add'&&cmd._params?._data?._dedupe_key?.startsWith('adk-tool-loop-result:')){
  const receipt=JSON.parse(cmd._params._data._text);assert.equal(receipt._format,'adk-tool-loop/2');assert.ok(Object.isFrozen(cmd._params._data)===false);
  if(mode.startsWith('legacy-')){receipt._format='adk-tool-loop/1';delete receipt._catalog;}
  if(mode==='catalog-action-kind')receipt._catalog.find(e=>e._name==='sample.record')._kind='read';
  if(mode==='catalog-read-kind')receipt._catalog.find(e=>e._name==='sample.echo')._kind='action';
  if(mode==='catalog-missing')delete receipt._catalog;
  if(mode==='catalog-duplicate')receipt._catalog.push({...receipt._catalog[0]});
  if(mode==='catalog-late-mismatch')receipt._catalog.find(e=>e._name==='sample.other')._kind='read';
  cmd={...cmd,_params:{...cmd._params,_data:{...cmd._params._data,_text:JSON.stringify(receipt)}}};saved=cmd._params._data._text;
 }
 return execute.call(this,cmd);
};
try{
 if(colliding&&mode!=='allowlist-removal'){
  assert.throws(()=>createRouterToolLoop(options),{_code:'E_ADK_LOOP_CONFIG'});
  assert.equal(fixture.requests.length,0);assert.equal(discovery,0);assert.equal(reads+prepares+effects+invokePolicies,0);
 }else{
  loop=createRouterToolLoop(options);await host.start();await loop.start();const context=loop.bindContext(identity);
  if(stage==='read'){
   const rows=await _x.execute({_module:'entity-manager',_op:'find',_params:{_app_id:'xpell-agent-starter',_env:'default',_entity:'message',_filter:{_direction:'outbound'},_skip:0,_limit:10}});
   const before=rows._result._records._data.map(r=>r._text);
   if(mode==='legacy-read'||mode==='catalog-valid'){const r=await loop.run(input,context);assert.equal(r._status,mode==='legacy-read'?'completed':'requires_confirmation');assert.equal(prepares,mode==='catalog-valid'?1:0);}
   else {await assert.rejects(loop.run(input,context),{_code:'E_ADK_LOOP_UNCERTAIN'});assert.equal(prepares,0);}
   assert.equal(reads,0);assert.equal(effects,0);assert.equal(denied,0);
   const after=await _x.execute({_module:'entity-manager',_op:'find',_params:{_app_id:'xpell-agent-starter',_env:'default',_entity:'message',_filter:{_direction:'outbound'},_skip:0,_limit:10}});
   assert.deepEqual(after._result._records._data.map(r=>r._text),before,'replay never migrates/rewrites receipt');
  }else{
   const r=await loop.run(input,context);assert.equal(r._status,wantsAction?'requires_confirmation':'completed');assert.equal(effects,0);
   if(mode==='allowlist-removal'){assert.equal(reads,1);assert.equal(prepares,0);assert.equal(fixture.requests.length,2);}
   if(stage==='seed'){assert.ok(saved);await writeFile(join(parent,'saved-receipt.json'),saved);}
  }
 }
 assert.equal(denied,0);console.log('COLLISION_REGRESSION_PASS',mode,stage,JSON.stringify({reads,prepares,effects,invokePolicies,requests:fixture?.requests.length??0}));
}finally{_x.execute=execute;await loop?.close();registry.close();await host.close();await fixture?.close();delete process.env.COLLISION_FIXTURE;}
