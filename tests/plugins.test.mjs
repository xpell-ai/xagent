import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineAgentPlugin, createAgentPluginRegistry } from '@xpell/agent/adk/plugins';
import { defineTool, createToolRegistry } from '@xpell/agent/adk/tools';
const no = () => ({_host: [], _agent: []});
const permission = () => ({_host: ['fixture.resource'], _agent: ['fixture.read']});
const schema = {type:'object', additionalProperties:false, properties:{text:{type:'string',minLength:1,maxLength:32}},required:['text']};
const tool = (id='fixture.echo', handler=({_arguments})=>({text:_arguments.text})) => defineTool({_id:id,_description:'Neutral fixture',_effect:'read',_confirmation:'none',_input_schema:schema,_handler:handler});
const plugin = (overrides={}) => defineAgentPlugin({_id:'fixture',_version:'1.0.0',_contract:1,_peers:{'@xpell/agent':'2.0.8'},_dependencies:[],_permissions:no(),...overrides});
const registry = () => createAgentPluginRegistry({_peers:{'@xpell/agent':'2.0.8'}});
const code = c => e => e?._code === 'E_ADK_PLUGIN_'+c;
const limits = {_timeout_ms:200,_max_input_bytes:128,_max_output_bytes:128,_max_invocations:10,_max_contexts:4};
const context = {_instance_id:'fixture',_application_scope:{_env:'test',_app_id:'fixture'},_actor_id:'actor',_conversation_id:'conversation',_delivery_id:'delivery'};
const allow = i => ({_allow:true,_policy_revision:'fixture-1',_authorized_scope:i._context});
const deferred = () => { let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}; };

test('explicit ordered lifecycle, reverse cleanup, immutable context and terminal stop', async()=>{
 const r=registry(),events=[];
 for (const id of ['one','two']) r.register(plugin({_id:id,_dependencies:id==='two'?[{_id:'one',_version:'1.0.0'}]:[],start(c){assert.ok(Object.isFrozen(c));events.push('start-'+id);},stop(c){assert.equal(c._signal.aborted,true);events.push('stop-'+id);},dispose(){events.push('dispose-'+id);}}));
 assert.equal(r.getStatus()[0]._state,'registered');
 assert.strictEqual(r.start(),r.start());await r.start();assert.ok(r.isAvailable('two'));
 assert.throws(()=>r.register(plugin({_id:'late'})),code('STATE'));
 await r.stop();await r.stop();assert.equal(r.isAvailable('one'),false);
 await assert.rejects(r.start(),code('STATE'));await r.dispose();await r.dispose();
 assert.deepEqual(events,['start-one','start-two','stop-two','stop-one','dispose-two','dispose-one']);
 assert.ok(r.getStatus().every(x=>x._state==='disposed'));
});

test('registration validates complete snapshot, duplicate IDs, hidden cross-kind names, atomic rejection',()=>{
 const r=registry();r.register(plugin({_tools:[tool()]}));
 assert.throws(()=>r.register(plugin()),code('DUPLICATE'));
 const action={_id:'fixture.echo',_description:'Fixture',_revision:'1',_input_schema:schema,_prepare_action:()=>{},_handler:()=>{}};
 assert.throws(()=>r.register(plugin({_id:'other',_actions:[action]})),code('DUPLICATE'));
 assert.equal(r.getStatus().length,1);assert.equal(r.getContributions()._actions.length,0);
 assert.throws(()=>plugin({_tools:[tool(),tool()]}),code('DUPLICATE'));
 assert.throws(()=>plugin({_tools:[tool()],_actions:[action]}),code('DUPLICATE'));
 const other=registry(), instance=plugin({_id:'shared'});r.register(instance);assert.throws(()=>other.register(instance),code('DUPLICATE'));
});

test('accessors/proxies/holes/unknown fields rejected without getters or registration side effects',()=>{
 let gets=0;const d={_id:'x',get _version(){gets++;return '1.0.0';}};
 assert.throws(()=>defineAgentPlugin(d),code('CONFIG'));assert.equal(gets,0);
 assert.throws(()=>defineAgentPlugin(new Proxy({}, {get(){gets++;throw Error();}})),code('CONFIG'));assert.equal(gets,0);
 assert.throws(()=>plugin({_permissions:{_host:new Array(1),_agent:[]}}),code('CONFIG'));
 assert.throws(()=>plugin({_secrets:{fixture:'DO_NOT_EXPOSE'}}),code('CONFIG'));
 const r=registry();assert.throws(()=>r.register({...plugin(),get _tools(){gets++;return [];}}),code('CONFIG'));assert.equal(gets,0);assert.equal(r.getStatus().length,0);
});

test('contract, exact stable peer versions and pre-registered dependency compatibility',()=>{
 assert.throws(()=>plugin({_contract:2}),code('COMPATIBILITY'));
 for(const v of ['^1.0.0','1.0','01.0.0','1.0.0-beta']) assert.throws(()=>plugin({_version:v}),code('CONFIG'));
 const r=registry();assert.throws(()=>r.register(plugin({_peers:{'@xpell/agent':'2.0.9'}})),code('COMPATIBILITY'));
 assert.throws(()=>r.register(plugin({_dependencies:[{_id:'missing',_version:'1.0.0'}]})),code('DEPENDENCY'));
 r.register(plugin({_id:'base'}));assert.throws(()=>r.register(plugin({_dependencies:[{_id:'base',_version:'2.0.0'}]})),code('DEPENDENCY'));
 assert.equal(r.getStatus().length,1);
});

test('metadata is snapshotted and frozen; no host/services/secrets are exposed',async()=>{
 const raw={...plugin(),_permissions:permission(),_tools:[tool()]};const r=registry();r.register(raw);
 raw._tools.length=0;raw._permissions._host[0]='mutated.resource';
 const c=r.getContributions();assert.equal(c._tools.length,1);assert.ok(Object.isFrozen(c._tools[0]._input_schema));
 r.setGrants('fixture',permission());await r.start();assert.ok(r.isAvailable('fixture'));
 assert.deepEqual(Object.keys(r.getStatus()[0]).sort(),['_available','_id','_state','_version']);await r.dispose();
});

test('permission denial is default, excess grants reject, explicit host and agent grants required',async()=>{
 const r=registry();let starts=0;r.register(plugin({_permissions:permission(),start(){starts++;}}));
 assert.throws(()=>r.setGrants('fixture',{_host:['other.resource'],_agent:[]}),code('DENIED'));
 r.setGrants('fixture',{_host:['fixture.resource'],_agent:[]});await r.start();
 assert.equal(starts,0);assert.equal(r.getStatus()[0]._error_code,'E_ADK_PLUGIN_DENIED');await r.dispose();
});

test('failed startup cleans partial plugin, isolates unrelated plugins and blocks dependents',async()=>{
 const r=registry(),events=[];r.register(plugin({_id:'bad',start(){throw Error('PRIVATE_RAW_SECRET');},stop(){events.push('stop-bad');throw Error('raw');},dispose(){events.push('dispose-bad');}}));
 r.register(plugin({_id:'dependent',_dependencies:[{_id:'bad',_version:'1.0.0'}],start(){assert.fail('dependency ran');}}));r.register(plugin({_id:'good',start(){events.push('start-good');}}));
 await r.start();assert.ok(r.isAvailable('good'));assert.equal(r.getStatus()[1]._error_code,'E_ADK_PLUGIN_DEPENDENCY');assert.ok(!JSON.stringify(r.getStatus()).includes('PRIVATE'));
 await r.dispose();assert.deepEqual(events,['stop-bad','dispose-bad','start-good']);
});

test('stop during startup fences late readiness, serial cleanup, no duplicate lifecycle callbacks',async()=>{
 const r=registry(),gate=deferred(),entered=deferred(),events=[];r.register(plugin({async start(c){events.push('start');entered.resolve(c);await gate.promise;},stop(){events.push('stop');},dispose(){events.push('dispose');}}));
 const start=r.start(),c=await entered.promise;const stop=r.stop();assert.ok(c._signal.aborted);assert.equal(r.isAvailable('fixture'),false);gate.resolve();await Promise.all([start,stop]);await r.dispose();assert.deepEqual(events,['start','stop','dispose']);
});

test('Read contribution preserves T1 validation/limits, deny by default and reauthorizes replay',async()=>{
 const r=registry();let calls=0;r.register(plugin({_permissions:permission(),_tools:[tool('fixture.echo',({_arguments})=>{calls++;return {text:_arguments.text};})]}));r.setGrants('fixture',permission());
 const reads=createToolRegistry({_tools:r.getContributions()._tools,_policy:r.readPolicy(allow),_limits:limits});const ctx=reads.bindContext(context);
 assert.deepEqual(await reads.project(ctx),[]);await r.start();await reads.project(ctx);
 await assert.rejects(reads.invoke({_id:'bad',_name:'fixture.echo',_arguments:{text:'a',extra:'x'}},ctx),{_code:'E_ADK_TOOL_ARGUMENTS'});
 const call={_id:'one',_name:'fixture.echo',_arguments:{text:'hello'}};assert.deepEqual(await reads.invoke(call,ctx),{text:'hello'});assert.deepEqual(await reads.invoke(call,ctx),{text:'hello'});assert.equal(calls,1);
 r.setGrants('fixture',no());await assert.rejects(reads.invoke(call,ctx),{_code:'E_ADK_TOOL_DENIED'});assert.deepEqual(await reads.project(ctx),[]);
 r.setGrants('fixture',permission());await reads.project(ctx);assert.deepEqual(await reads.invoke(call,ctx),{text:'hello'});assert.equal(calls,1);
 await r.stop();await assert.rejects(reads.invoke(call,ctx),{_code:'E_ADK_TOOL_DENIED'});reads.close();await r.dispose();
});

test('policy default deny and unknown contribution denial do not invoke application policy',async()=>{
 const r=registry();r.register(plugin({_tools:[tool()]}));await r.start();let policyCalls=0;
 const i={_phase:'expose',_tool_id:'unknown',_context:context,_signal:new AbortController().signal};
 assert.deepEqual(await r.readPolicy()(i),{_allow:false});assert.deepEqual(await r.readPolicy(()=>{policyCalls++;return allow(i);})(i),{_allow:false});
 assert.equal(await r.actionPolicy()({_phase:'inspect',_capability_id:'unknown'}),false);assert.equal(policyCalls,0);await r.dispose();
});

test('grant revoke then restore during policy await is fenced and cleanup drains owned policy',async()=>{
 const r=registry(),gate=deferred(),entered=deferred();let stopped=false;r.register(plugin({_permissions:permission(),_tools:[tool()],stop(){stopped=true;}}));r.setGrants('fixture',permission());await r.start();
 const policy=r.readPolicy(async i=>{entered.resolve();await gate.promise;return allow(i);});const pending=policy({_phase:'expose',_tool_id:'fixture.echo',_context:context,_signal:new AbortController().signal});await entered.promise;
 r.setGrants('fixture',no());r.setGrants('fixture',permission());const rejected=assert.rejects(pending,{_code:'E_ADK_TOOL_DENIED'});const stopping=r.stop();await Promise.resolve();assert.equal(stopped,false);gate.resolve();await rejected;await stopping;assert.equal(stopped,true);await r.dispose();
});

test('stop fences and drains an active handler before reverse cleanup',async()=>{
 const r=registry(),entered=deferred(),gate=deferred(),events=[];
 r.register(plugin({_tools:[tool('fixture.echo',async()=>{entered.resolve();await gate.promise;events.push('handler');return {text:'late'};})],stop(){events.push('stop');}}));await r.start();
 const pending=r.getContributions()._tools[0]._handler({_arguments:{text:'hello'},_context:context,_signal:new AbortController().signal});const rejects=assert.rejects(pending,code('DENIED'));await entered.promise;const stopping=r.stop();assert.deepEqual(events,[]);gate.resolve();await rejects;await stopping;assert.deepEqual(events,['handler','stop']);await r.dispose();
});

test('dependency revocation fences dependent contributions and replay',async()=>{
 const r=registry();r.register(plugin({_id:'base',_permissions:permission()}));r.register(plugin({_id:'dependent',_dependencies:[{_id:'base',_version:'1.0.0'}],_tools:[tool()]}));r.setGrants('base',permission());await r.start();assert.ok(r.isAvailable('dependent'));
 r.setGrants('base',no());assert.equal(r.isAvailable('dependent'),false);const p=r.readPolicy(allow);assert.deepEqual(await p({_tool_id:'fixture.echo'}),{_allow:false});await r.dispose();
});

test('fresh plugin factory/registry restarts without lifecycle or receipt state adoption',async()=>{
 let starts=0;for(let i=0;i<2;i++){const r=registry();r.register(plugin({start(){starts++;}}));await r.start();assert.ok(r.isAvailable('fixture'));await r.dispose();}assert.equal(starts,2);
});

test('reconciliation scan policy is explicitly granted, drained and revoked before disclosure',async()=>{
 const r=registry(),gate=deferred(),entered=deferred();r.register(plugin({_permissions:permission()}));r.setGrants('fixture',permission());await r.start();
 const input={_phase:'reconcile',_capability_id:'actions.reconcile'};
 assert.equal(await r.actionPolicy()(input),false);
 const pending=r.actionPolicy(async()=>{entered.resolve();await gate.promise;return true;})(input);const checked=assert.rejects(pending,{_code:'E_ADK_ACTION_DENIED'});await entered.promise;
 r.setGrants('fixture',no());gate.resolve();await checked;assert.equal(await r.actionPolicy(()=>true)(input),false);await r.dispose();
});

test('cleanup errors are safe, continue unrelated cleanup and never retry uncertain hooks',async()=>{
 const r=registry(),events=[];
 for(const id of ['one','two'])r.register(plugin({_id:id,start(){},stop(){events.push('stop-'+id);throw Error('RAW_PRIVATE');},dispose(){events.push('dispose-'+id);throw Error('RAW_PRIVATE');}}));
 await r.start();await r.stop();await r.dispose();await r.dispose();await r.stop();
 assert.deepEqual(events,['stop-two','stop-one','dispose-two','dispose-one']);assert.ok(r.getStatus().every(s=>s._error_code==='E_ADK_PLUGIN_CLEANUP'));assert.ok(!JSON.stringify(r.getStatus()).includes('RAW_PRIVATE'));
});

test('registration rejects reserved reconciliation identity and malformed grants atomically',()=>{
 const r=registry();assert.throws(()=>r.register(plugin({_tools:[tool('actions.reconcile')]})),code('DUPLICATE'));assert.equal(r.getStatus().length,0);
 r.register(plugin({_permissions:permission()}));let getters=0;
 assert.throws(()=>r.setGrants('fixture',{get _host(){getters++;return [];},_agent:[]}),code('CONFIG'));assert.equal(getters,0);assert.equal(r.getStatus()[0]._available,false);
});

test('nested contribution proxies reject without traps',()=>{
 let traps=0;const proxy=new Proxy({}, {ownKeys(){traps++;throw Error('raw');},getPrototypeOf(){traps++;throw Error('raw');}});
 assert.throws(()=>plugin({_tools:[{...tool(),_input_schema:proxy}]}),code('CONFIG'));assert.equal(traps,0);
});

test('T1 deadline retains callback ownership; plugin stop waits without a duplicate invocation',async()=>{
 const r=registry(),gate=deferred(),entered=deferred();let handlers=0,stopped=false;
 r.register(plugin({_tools:[tool('fixture.echo',async()=>{handlers++;entered.resolve();await gate.promise;return {text:'late'};})],stop(){stopped=true;}}));await r.start();
 const reads=createToolRegistry({_tools:r.getContributions()._tools,_policy:r.readPolicy(allow),_limits:{...limits,_timeout_ms:30}}),ctx=reads.bindContext(context);await reads.project(ctx);
 const call={_id:'one',_name:'fixture.echo',_arguments:{text:'hello'}};const timed=assert.rejects(reads.invoke(call,ctx),{_code:'E_ADK_TOOL_TIMEOUT'});await entered.promise;await timed;
 await assert.rejects(reads.invoke(call,ctx),{_code:'E_ADK_TOOL_BUSY'});const stopping=r.stop();await Promise.resolve();assert.equal(stopped,false);assert.equal(handlers,1);gate.resolve();await stopping;assert.equal(stopped,true);reads.close();await r.dispose();
});

test('reentrant start coalesces and grant change during startup prevents late readiness',async()=>{
 const r=registry(),entered=deferred(),gate=deferred();let calls=0,nested;
 r.register(plugin({_permissions:permission(),async start(){calls++;nested=r.start();entered.resolve();await gate.promise;}}));r.setGrants('fixture',permission());const first=r.start();await entered.promise;assert.strictEqual(first,nested);r.setGrants('fixture',no());r.setGrants('fixture',permission());gate.resolve();await first;assert.equal(calls,1);assert.equal(r.isAvailable('fixture'),false);assert.equal(r.getStatus()[0]._state,'disposed');await r.dispose();
});
