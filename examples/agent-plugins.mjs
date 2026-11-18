import assert from 'node:assert/strict';
import { defineAgentPlugin, createAgentPluginRegistry } from '@xpell/agent/adk/plugins';
import { defineTool, createToolRegistry } from '@xpell/agent/adk/tools';

// Trusted application imports optional packages itself; registry never installs/loads code.
const registry = createAgentPluginRegistry({_peers:{'@xpell/agent':'2.0.8'}});
const echo = defineTool({
  _id:'sample.echo', _description:'Return neutral local text', _effect:'read', _confirmation:'none',
  _input_schema:{type:'object',additionalProperties:false,properties:{text:{type:'string',minLength:1,maxLength:80}},required:['text']},
  _handler:({_arguments})=>({text:_arguments.text}),
});
registry.register(defineAgentPlugin({
  _id:'sample-echo',_version:'1.0.0',_contract:1,_peers:{'@xpell/agent':'2.0.8'},_dependencies:[],
  _permissions:{_host:[],_agent:['sample.read']},_tools:[echo],
}));
registry.register(defineAgentPlugin({
  _id:'sample-consumer',_version:'1.0.0',_contract:1,_peers:{},
  _dependencies:[{_id:'sample-echo',_version:'1.0.0'}],_permissions:{_host:[],_agent:[]},
}));
registry.setGrants('sample-echo',{_host:[],_agent:['sample.read']});
const reads = createToolRegistry({
  _tools:registry.getContributions()._tools,
  _policy:registry.readPolicy(input=>({_allow:true,_policy_revision:'sample-1',_authorized_scope:input._context})),
  _limits:{_timeout_ms:200,_max_input_bytes:256,_max_output_bytes:256,_max_invocations:4,_max_contexts:1},
});
try {
  await registry.start();
  const ctx=reads.bindContext({_instance_id:'sample',_application_scope:{_env:'test',_app_id:'sample'},_actor_id:'sample',_conversation_id:'sample',_delivery_id:'sample'});
  assert.ok(registry.isAvailable('sample-consumer'));
  await reads.project(ctx);
  const call={_id:'sample-call',_name:'sample.echo',_arguments:{text:'Hello plugins'}};
  assert.deepEqual(await reads.invoke(call,ctx),{text:'Hello plugins'});
  registry.setGrants('sample-echo',{_host:[],_agent:[]});
  await assert.rejects(reads.invoke(call,ctx),{_code:'E_ADK_TOOL_DENIED'});
  console.log('AGENT_PLUGINS_OFFLINE_OK: two neutral plugins; replay denied after grant revocation');
} finally {
  reads.close();
  await registry.dispose();
}
