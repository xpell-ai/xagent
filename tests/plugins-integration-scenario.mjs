import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import net from 'node:net';import http from 'node:http';import https from 'node:https';
const [parent,stage='run']=process.argv.slice(2);
let denied=0;const ports=new Set(),fetch=globalThis.fetch,connect=net.Socket.prototype.connect;
const block=()=>{denied++;throw Error('offline plugin fixture blocked network');};
globalThis.fetch=(url,...a)=>{const u=new URL(url);if(u.hostname!=='127.0.0.1'||!ports.has(+u.port)||[3001,3100].includes(+u.port))return block();return fetch(url,...a);};
net.Socket.prototype.connect=function(...a){const v=Array.isArray(a[0])?a[0][0]:a[0];if(!ports.has(+(v?.port??v))||![undefined,'127.0.0.1','::1'].includes(v?.host))return block();return connect.apply(this,a);};
http.request=http.get=https.request=https.get=block;syncBuiltinESMExports();
const require=createRequire(import.meta.url),root=dirname(require.resolve('@xpell/agent/package.json'));
const {startToolLoopFixture,echoSchema,TOOL_LOOP_FIXTURE_KEY}=await import(pathToFileURL(join(root,'examples/model-tool-loop.mjs')));
const {createRouterToolLoop}=await import('@xpell/agent/adk/tool-loop');const {routerTextModel}=await import('@xpell/agent/adk');
const {defineTool,createToolRegistry}=await import('@xpell/agent/adk/tools');const {defineAction,createDurableActions}=await import('@xpell/agent/adk/actions');
const {defineAgentPlugin,createAgentPluginRegistry}=await import('@xpell/agent/adk/plugins');
const plugins=createAgentPluginRegistry({_peers:{'@xpell/agent':'2.0.8'}});
let reads=0,prepares=0,effects=0,preparedDelivery;const grant={_host:['fixture.local'],_agent:['fixture.use']},empty={_host:[],_agent:[]};
plugins.register(defineAgentPlugin({_id:'fixture',_version:'1.0.0',_contract:1,_peers:{'@xpell/agent':'2.0.8'},_dependencies:[],_permissions:grant,
 _tools:[defineTool({_id:'sample.echo',_description:'Neutral Read',_input_schema:echoSchema,_effect:'read',_confirmation:'none',_handler:({_arguments})=>{reads++;return {text:_arguments.text};}})],
 _actions:[defineAction({_id:'sample.record',_description:'Neutral Action',_revision:'1',_input_schema:echoSchema,
 _prepare_action:({_arguments,_context})=>{prepares++;preparedDelivery=_context._delivery_id;return {_arguments,_authorized_scope:{resource:'synthetic'},_confirmation_summary:'Synthetic proposal'};},
 _handler:()=>{effects++;return {_status:'succeeded',_result:{text:'synthetic outcome'}};}})]}));
plugins.setGrants('fixture',grant);
let fixture,endpoint;
if(stage.startsWith('read'))endpoint=await readFile(join(parent,'endpoint'),'utf8');else{
 fixture=await startToolLoopFixture([{_ok:true,_text:'',_finish_reason:'tool_calls',_tool_calls:[{_id:'read-1',_name:'sample.echo',_arguments:{text:'fixture'}},{_id:'action-1',_name:'sample.record',_arguments:{text:'fixture'}}]}]);
 endpoint=fixture.endpoint;ports.add(+new URL(endpoint).port);await writeFile(join(parent,'endpoint'),endpoint);
}
process.env.PLUGIN_FIXTURE=TOOL_LOOP_FIXTURE_KEY;
const host=createDurableActions({_name:'plugin-test',_instance_id:'plugin-test',_application_scope:{_env:'test',_app_id:'plugin-test'},
 _host:{_work_folder:join(parent,'instance'),_listen:{_host:'127.0.0.1',_port:0}},_actions:plugins.getContributions()._actions,_policy:plugins.actionPolicy(()=>true),_limits:{_timeout_ms:1000,_max_json_bytes:8192}});
const registry=createToolRegistry({_tools:plugins.getContributions()._tools,
 _policy:plugins.readPolicy(({_context})=>({_allow:true,_policy_revision:'1',_authorized_scope:_context})),
 _limits:{_timeout_ms:1000,_max_input_bytes:4096,_max_output_bytes:8192,_max_invocations:32,_max_contexts:32}});
const loop=createRouterToolLoop({_actions:host,_reads:registry,_action_ids:['sample.record'],_system:'Neutral plugin fixture.',
 _model:routerTextModel({_endpoint:endpoint,_model:'fixture',_credential:{_env:'PLUGIN_FIXTURE'},_timeout_ms:1000,_error_policy:'fail-closed',_allow_requests:true}),
 _policy:({_phase})=>_phase!=='expose-action'||plugins.isAvailable('fixture'),
 _limits:{_max_rounds:3,_max_calls:4,_max_calls_per_round:4,_max_transcript_bytes:8192,_max_output_tokens:64,_max_total_tokens:30000,_timeout_ms:3000}});
try{
 await host.start();await plugins.start();await loop.start();const ctx=loop.bindContext({_actor_id:'actor',_conversation_id:'conversation',_delivery_id:'delivery'}),input={_text:'synthetic request'};
 if(stage==='read-denied'){
  plugins.setGrants('fixture',empty);await assert.rejects(loop.run(input,ctx),{_code:'E_ADK_LOOP_DENIED'});assert.equal(prepares+reads+effects,0);
 }else{
  const result=await loop.run(input,ctx);assert.equal(result._status,'requires_confirmation');assert.equal(effects,0);const proposal=result._proposals[0];assert.equal(Object.keys(proposal).length,6);
  if(stage.startsWith('read')){assert.equal(reads,0);assert.equal(prepares,1);}else{assert.equal(reads,1);assert.equal(prepares,1);assert.equal(fixture.requests.length,1);}
  const confirm=host.bindContext({_actor_id:'actor',_conversation_id:'conversation',_delivery_id:'confirmation'});const params={_action_id:proposal._action_id,_binding_hash:proposal._binding_hash};
  if(stage==='run'){
   const same=host.bindContext({_actor_id:'actor',_conversation_id:'conversation',_delivery_id:preparedDelivery});await assert.rejects(host.confirm(params,same),{_code:'E_ADK_ACTION_BINDING'});assert.equal(effects,0);
   const done=await host.confirm(params,confirm);assert.equal(done._state,'succeeded');assert.deepEqual(done._result,{text:'synthetic outcome'});assert.equal(effects,1);
   plugins.setGrants('fixture',empty);await assert.rejects(host.get(proposal._action_id,confirm),{_code:'E_ADK_ACTION_DENIED'});await assert.rejects(loop.run(input,ctx),{_code:'E_ADK_LOOP_DENIED'});
   plugins.setGrants('fixture',grant);const replay=await loop.run(input,ctx);assert.equal(replay._status,'requires_confirmation');assert.equal(Object.keys(replay._proposals[0]).length,6);assert.equal('_result' in replay._proposals[0],false);assert.equal(effects,1);assert.equal(fixture.requests.length,1);
   await plugins.stop();await assert.rejects(host.get(proposal._action_id,confirm),{_code:'E_ADK_ACTION_DENIED'});await assert.rejects(loop.run(input,ctx),{_code:'E_ADK_LOOP_DENIED'});
  }
 }
 assert.equal(denied,0);console.log('PLUGIN_INTEGRATION_PASS',stage,JSON.stringify({reads,prepares,effects,requests:fixture?.requests.length??0}));
}finally{await loop.close();registry.close();await plugins.dispose();await host.close();await fixture?.close();delete process.env.PLUGIN_FIXTURE;}
