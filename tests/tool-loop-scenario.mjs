import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import net from "node:net";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import dgram from "node:dgram";
const [scenario, parent, stage] = process.argv.slice(2);
let allowed = new Set(), denied = 0;
const deny = () => { denied++; throw Error("offline guard blocked network"); };
const connect = net.Socket.prototype.connect, fetch = globalThis.fetch;
net.Socket.prototype.connect = function (...a) { const opts = Array.isArray(a[0]) ? a[0][0] : a[0]; const p = Number(opts?.port ?? opts); const h = opts?.host ?? a[1];
  if (!allowed.has(p) || [3001,3100].includes(p) || !["127.0.0.1","::1",undefined].includes(h)) return deny(); return connect.apply(this,a); };
globalThis.fetch = (u,...a) => { const url = new URL(u); if (url.hostname !== "127.0.0.1" || !allowed.has(Number(url.port))) return deny(); return fetch(u,...a); };
dns.lookup = (h,...a) => { if (h !== "127.0.0.1") return deny(); const cb = a.at(-1); cb(null,"127.0.0.1",4); };
http.request = http.get = https.request = https.get = tls.connect = dgram.createSocket = deny;
syncBuiltinESMExports();
const require = createRequire(import.meta.url), root = dirname(require.resolve("@xpell/agent/package.json"));
const { startToolLoopFixture, echoSchema, TOOL_LOOP_FIXTURE_KEY } = await import(pathToFileURL(join(root,"examples/model-tool-loop.mjs")));
const { createRouterToolLoop } = await import("@xpell/agent/adk/tool-loop");
const { defineTool, createToolRegistry } = await import("@xpell/agent/adk/tools");
const { defineAction, createDurableActions } = await import("@xpell/agent/adk/actions");
const { routerTextModel } = await import("@xpell/agent/adk");
const { _x, _xai } = await import("@xpell/node");
const calls = (items, text = "") => ({ _ok:true,_text:text,_finish_reason:"tool_calls",_tool_calls:items });
const call = (name="sample.echo",args={text:"hello"},id="call-1") => ({_id:id,_name:name,_arguments:args,_continuation_ref:"opaque-ref"});
const done = {_ok:true,_text:"fixture complete",_finish_reason:"stop",_usage:{_input_tokens:3,_output_tokens:2,_total_tokens:5}};
let script = [calls([call()]),done];
if (["mixed","action","action-denied","action-hidden","uncertain-action","restart-action","crash-proposal"].includes(scenario)) script=[calls(scenario==="mixed"?[call(),call("sample.record",{text:"saved"},"a-1")]:[call("sample.record")])];
if (scenario==="unknown") script=[calls([call("unknown")])];
if (scenario==="schema") script=[calls([call("sample.echo",{text:"x",_context:{_actor_id:"admin"}})])];
if (scenario==="malformed") script=[calls([{_id:"c",_name:"sample.echo",_arguments:{text:3}}])];
if (scenario==="batch-validation") script=[calls([call(),call("unknown",{},"c-2")])];
if (scenario==="self-confirm") script=[calls([call("sample.record"),call("actions.confirm",{text:"yes"},"evil")])];
if (scenario==="duplicate-batch") script=[calls([call(),call()])];
if (scenario==="repeated-call") script=[calls([call()]),calls([call()]),done];
if (scenario==="changed-call") script=[calls([call()]),calls([call("sample.echo",{text:"changed"})]),done];
if (scenario==="usage-reservation") script=[{...calls([call()]),_usage:{_input_tokens:1900,_output_tokens:2,_total_tokens:1902}},done];
if (scenario==="max-batch") script=[calls(Array.from({length:5},(_,i)=>call("sample.echo",{text:"x"},"c"+i)))];
if (scenario==="round-limit") script=[calls([call()])];
if (scenario==="call-limit") script=[calls([call(),call("sample.echo",{text:"x"},"c-2")])];
if (scenario==="finish") script=[{...done,_finish_reason:"length"}];
if (scenario==="planning") script=[{...done,_text:"<think>private synthetic planning"}];
if (scenario==="provider-error") script=[{_ok:false,_error:{_code:"E_XAI_PROVIDER_GENERATE_FAILED",_message:"UNSAFE_SYNTHETIC_PROVIDER_DATA"}}];
if (scenario==="usage") script=[{...done,_usage:{_input_tokens:1,_output_tokens:5000,_total_tokens:5001}}];
if (scenario==="bad-usage") script=[{...done,_usage:{_input_tokens:-1,_output_tokens:2,_total_tokens:1}}];
if (["timeout","cancel","close","concurrency"].includes(scenario)) script=[{...calls([call()]),_delay_ms:200},done];
if (scenario==="receipt-size") script=[{...done,_text:"x".repeat(20000)}];
let fixture, endpoint;
if (stage==="read") endpoint=await readFile(join(parent,"endpoint"),"utf8");
else {fixture=await startToolLoopFixture(script);endpoint=fixture.endpoint;allowed.add(Number(new URL(endpoint).port));await writeFile(join(parent,"endpoint"),endpoint);}
process.env.XAGENT_LOOP_TEST=TOOL_LOOP_FIXTURE_KEY;
let effects=0,readsCount=0,prepareCount=0,denyReplay=false,denyRead=false;
const action = defineAction({_id:"sample.record",_description:"Synthetic side effect",_revision:"1",_input_schema:echoSchema,
 _prepare_action:({_arguments})=>{prepareCount++;return {_arguments,_authorized_scope:{target:"fixture"},_confirmation_summary:"Record synthetic text"};},
 _handler:()=>{effects++;if(scenario==="uncertain-action")throw Error("UNSAFE_SYNTHETIC_PROVIDER_DATA");return {_status:"succeeded",_result:{ok:true}};}});
const host=createDurableActions({_name:"loop-test",_instance_id:"loop-test",_application_scope:{_env:"test",_app_id:"loop-test"},
 _host:{_work_folder:join(parent,"runtime"),_listen:{_host:"127.0.0.1",_port:0}},_actions:[action],_policy:()=>scenario!=="action-denied",
 _limits:{_timeout_ms:1000,_max_json_bytes:4096}});
const registry=createToolRegistry({_tools:[defineTool({_id:"sample.echo",_description:"Synthetic echo",_input_schema:echoSchema,_effect:"read",_confirmation:"none",
 _handler:async({_arguments,_context})=>{readsCount++;assert.ok(["actor","other-actor"].includes(_context._actor_id));if(scenario==="read-error")throw Error("UNSAFE_SYNTHETIC_PROVIDER_DATA");if(scenario==="read-timeout")await new Promise(r=>setTimeout(r,100));assert.equal(Object.isFrozen(_arguments),true);if(scenario==="crash-read")process.kill(process.pid,"SIGKILL");return {text:_arguments.text};}})],
 _policy:({_context,_phase})=>scenario==="deny-expose"||denyRead&&_phase==="invoke"?{_allow:false}:{_allow:true,_policy_revision:"1",_authorized_scope:_context},
 _limits:{_timeout_ms:scenario==="read-timeout"?30:1000,_max_input_bytes:4096,_max_output_bytes:8192,_max_invocations:32,_max_contexts:64}});
const options={_actions:host,_reads:registry,_action_ids:["sample.record"],_system:"Offline synthetic loop.",
 _policy:({_phase})=>!(denyReplay&&_phase==="replay"||scenario==="deny-run"||scenario==="action-hidden"&&_phase==="expose-action"),
 _model:routerTextModel({_endpoint:endpoint,_model:"fixture",_credential:{_env:"XAGENT_LOOP_TEST"},_timeout_ms:1000,_error_policy:"fail-closed",_allow_requests:true}),
 _limits:{_max_rounds:3,_max_calls:4,_max_calls_per_round:4,_max_transcript_bytes:8192,_max_output_tokens:64,_max_total_tokens:30000,_timeout_ms:scenario==="timeout"?100:3000}};
if(scenario==="round-limit")options._limits._max_rounds=2;
if(scenario==="call-limit")options._limits._max_calls=1;
if(scenario==="usage-reservation")options._limits._max_total_tokens=2200;
if(scenario==="token-limit")options._limits._max_total_tokens=1;
if(scenario==="deny-default")delete options._policy;
const loop=createRouterToolLoop(options);
const ctxData={_actor_id:"actor",_conversation_id:"conversation",_delivery_id:"delivery"};
try {
 await host.start();await loop.start();assert.equal(fixture?.requests.length??0,0);
 const ctx=loop.bindContext(ctxData);const input={_text:"Synthetic request"};
 if(stage!=="read"&&["crash-before-model","crash-after-model","crash-receipt","crash-proposal"].includes(scenario)) {
  const execute=_x.execute;_x.execute=async function(cmd) {
   if(scenario==="crash-before-model"&&cmd._module==="xai")process.kill(process.pid,"SIGKILL");
   const r=await execute.call(this,cmd);
   if(scenario==="crash-after-model"&&cmd._module==="xai"||scenario==="crash-receipt"&&cmd._module==="entity-manager"&&cmd._op==="add"&&cmd._params?._data?._dedupe_key?.startsWith("adk-tool-loop-result:"))process.kill(process.pid,"SIGKILL");
   if(scenario==="crash-proposal"&&cmd._module==="entity-manager"&&cmd._op==="add"&&cmd._params?._entity==="agent_action")process.kill(process.pid,"SIGKILL");
   return r;};
 }
 if(stage==="read") {
  if(scenario==="restart-action") {const r=await loop.run(input,ctx);assert.equal(r._status,"requires_confirmation");assert.equal(r._proposals.length,1);assert.equal(prepareCount,1);}
  else if(scenario==="restart") {const r=await loop.run(input,ctx);assert.equal(r._status,"completed");}
  else await assert.rejects(loop.run(input,ctx),{_code:"E_ADK_LOOP_UNCERTAIN"});
  assert.equal(readsCount,0);assert.equal(effects,0);assert.equal(denied,0);
 } else if(scenario==="config") {
  for(const k of Object.keys(options._limits))for(const n of [0,NaN,Infinity,2**32])assert.throws(()=>createRouterToolLoop({...options,_limits:{...options._limits,[k]:n}}));
  for(const change of [{_actions:{...host}},{_reads:{...registry}},{_action_ids:["unknown"]},{_action_ids:["sample.record","sample.record"]},{_policy:"model policy"}])assert.throws(()=>createRouterToolLoop({...options,...change}));
  assert.equal(fixture.requests.length,0);
 } else if(scenario==="cancel-pre") {const c=new AbortController();c.abort();await assert.rejects(loop.run(input,ctx,c.signal),{_code:"E_ADK_LOOP_CANCELLED"});assert.equal(fixture.requests.length,0);}
 else if(scenario==="forged") {assert.throws(()=>loop.run(input,{...ctx}),{_code:"E_ADK_LOOP_DENIED"});assert.equal(fixture.requests.length,0);}
 else if(scenario==="accessor") {let gets=0;const q={get _text(){gets++;return "x";}};assert.throws(()=>loop.run(q,ctx));assert.equal(gets,0);assert.equal(fixture.requests.length,0);}
 else if(["deny-run","deny-default"].includes(scenario)) {await assert.rejects(loop.run(input,ctx),{_code:"E_ADK_LOOP_DENIED"});assert.equal(fixture.requests.length,0);}
 else if(["timeout","cancel","close","concurrency"].includes(scenario)) {
  const controller=new AbortController();const p=loop.run(input,ctx,controller.signal);
  while(!fixture.requests.length)await new Promise(r=>setTimeout(r,5));
  if(scenario==="concurrency") {assert.throws(()=>loop.run(input,ctx),{_code:"E_ADK_LOOP_BUSY"});assert.equal((await p)._status,"completed");}
  else {let closing;if(scenario==="cancel")controller.abort();if(scenario==="close")closing=loop.close();await assert.rejects(p,{_code:{timeout:"E_ADK_LOOP_TIMEOUT",cancel:"E_ADK_LOOP_CANCELLED",close:"E_ADK_LOOP_CLOSED"}[scenario]});
   if(closing)await closing;else await new Promise(r=>setTimeout(r,240));assert.equal(readsCount,0);assert.equal(fixture.requests.length,1);if(scenario!=="close")await assert.rejects(loop.run(input,ctx),{_code:"E_ADK_LOOP_UNCERTAIN"});}
 } else {
  if(scenario==="deny-invoke")denyRead=true;
  const codes={unknown:"E_ADK_LOOP_RESULT",schema:"E_ADK_LOOP_RESULT",malformed:"E_ADK_LOOP_RESULT","batch-validation":"E_ADK_LOOP_RESULT","self-confirm":"E_ADK_LOOP_RESULT","duplicate-batch":"E_ADK_LOOP_RESULT","changed-call":"E_ADK_LOOP_CONFLICT","round-limit":"E_ADK_LOOP_LIMIT","call-limit":"E_ADK_LOOP_LIMIT","token-limit":"E_ADK_LOOP_LIMIT","usage-reservation":"E_ADK_LOOP_LIMIT","max-batch":"E_ADK_LOOP_RESULT","read-error":"E_ADK_LOOP_TOOL","read-timeout":"E_ADK_LOOP_TOOL",finish:"E_ADK_LOOP_RESULT",planning:"E_ADK_LOOP_RESULT","provider-error":"E_ADK_LOOP_MODEL",usage:"E_ADK_LOOP_LIMIT","bad-usage":"E_ADK_LOOP_RESULT","receipt-size":"E_ADK_LOOP_RESULT","deny-expose":"E_ADK_LOOP_RESULT","deny-invoke":"E_ADK_LOOP_DENIED","action-denied":"E_ADK_LOOP_DENIED","action-hidden":"E_ADK_LOOP_RESULT"};
  if(codes[scenario]) {await assert.rejects(loop.run(input,ctx),{_code:codes[scenario]});const n=fixture.requests.length;await assert.rejects(loop.run(input,ctx),{_code:"E_ADK_LOOP_UNCERTAIN"});assert.equal(fixture.requests.length,n);if(!["changed-call","round-limit","usage-reservation","read-error","read-timeout"].includes(scenario))assert.equal(readsCount,0);assert.equal(effects,0);}
  else {
   const r=await loop.run(input,ctx);const n=fixture.requests.length;
   assert.deepEqual(await loop.run(input,ctx),r);assert.equal(fixture.requests.length,n);assert.equal(effects,0);
   if(["mixed","action","uncertain-action","restart-action","crash-proposal"].includes(scenario)) {
    assert.equal(r._status,"requires_confirmation");assert.equal(n,1);assert.equal(r._proposals.length,1);assert.equal(readsCount,scenario==="mixed"?1:0);
    const proposal=r._proposals[0];assert.deepEqual(Object.keys(proposal).sort(),["_action_id","_capability_id","_revision","_binding_hash","_confirmation_summary","_expires_at"].sort());
    const control={_action_id:proposal._action_id,_binding_hash:proposal._binding_hash};

    if(scenario!=="restart-action") {
     if(scenario==="uncertain-action") {await assert.rejects(host.confirm(control,host.bindContext({...ctxData,_delivery_id:"trusted-confirmation"})));assert.equal((await host.get(proposal._action_id,host.bindContext(ctxData)))._uncertain,true);}
     else assert.equal((await host.confirm(control,host.bindContext({...ctxData,_delivery_id:"trusted-confirmation"})))._state,"succeeded");assert.equal(effects,1);
    }
    assert.deepEqual(await loop.run(input,ctx),r);assert.equal(effects,scenario==="restart-action"?0:1);assert.equal(fixture.requests.length,1);
   } else {assert.equal(r._status,"completed");assert.equal(readsCount,1);assert.equal(n,scenario==="repeated-call"?3:2);
    const p=fixture.requests[1]._payload._params;assert.equal(p._messages[1]._tool_calls[0]._continuation_ref,"opaque-ref");assert.equal(p._messages[2]._tool_call_id,"call-1");assert.equal(p._messages[2]._content[0]._text,JSON.stringify({text:"hello"}));}
   assert.equal(JSON.stringify(r._trace).includes("hello"),false);assert.equal(JSON.stringify(r._trace).includes("actor"),false);assert.equal(JSON.stringify(r._trace).includes(TOOL_LOOP_FIXTURE_KEY),false);
   if(scenario==="replay-read-policy") {denyRead=true;await assert.rejects(loop.run(input,ctx),{_code:"E_ADK_LOOP_DENIED"});assert.equal(fixture.requests.length,n);assert.equal(readsCount,1);}
   if(scenario==="replay-policy") {denyReplay=true;await assert.rejects(loop.run(input,ctx),{_code:"E_ADK_LOOP_DENIED"});assert.equal(fixture.requests.length,n);}
   if(scenario==="conflict") {await assert.rejects(loop.run({_text:"changed"},ctx),{_code:"E_ADK_LOOP_CONFLICT"});assert.equal(fixture.requests.length,n);}
  }
 }
 if(stage!=="read")for(const q of fixture.requests){const p=q._payload._params;assert.equal(p._max_tokens,64);assert.equal(p._tools.some(x=>x._name.includes("confirm")),false);assert.match(p._idempotency_key,/^[a-f0-9]{64}$/);assert.equal(p._actor_id,undefined);assert.equal(p._context,undefined);}
 assert.equal(denied,0);console.log("TOOL_LOOP_PASS",scenario,stage??"");
} finally {await loop.close();registry.close();await host.close();await fixture?.close();delete process.env.XAGENT_LOOP_TEST;}
