import { defineAgentPlugin, createAgentPluginRegistry, type PluginPermissions, type AgentPluginContext } from '@xpell/agent/adk/plugins';
import { defineTool, createToolRegistry } from '@xpell/agent/adk/tools';
import { defineAction, createDurableActions } from '@xpell/agent/adk/actions';
const schema = {type:'object',additionalProperties:false,properties:{text:{type:'string',minLength:1,maxLength:32}},required:['text']} as const;
const read = defineTool({_id:'sample.echo',_description:'Neutral',_effect:'read',_confirmation:'none',_input_schema:schema,_handler:({_arguments})=>({text:_arguments.text})});
const action = defineAction({_id:'sample.record',_description:'Neutral',_revision:'1',_input_schema:schema,
 _prepare_action:({_arguments})=>({_arguments,_authorized_scope:{fixture:true},_confirmation_summary:'Record fixture'}),
 _handler:()=>({_status:'succeeded',_result:{fixture:true}})});
const p = defineAgentPlugin({_id:'sample',_version:'1.0.0',_contract:1,_peers:{'@xpell/agent':'2.0.8'},_dependencies:[],_permissions:{_host:[],_agent:['sample.read']},_tools:[read],_actions:[action],start(ctx:AgentPluginContext){
 // @ts-expect-error lifecycle context has no XNode or secret authority
 ctx._node;
 // @ts-expect-error context is immutable
 ctx._id='changed';
}});
const registry=createAgentPluginRegistry({_peers:{'@xpell/agent':'2.0.8'}});registry.register(p);
const grants:PluginPermissions={_host:[],_agent:['sample.read']};registry.setGrants('sample',grants);
// @ts-expect-error grants are immutable
 grants._agent.push('sample.write');
// @ts-expect-error only contract1 is supported
 defineAgentPlugin({...p,_contract:2});
const reads=createToolRegistry({_tools:registry.getContributions()._tools,_policy:registry.readPolicy(),_limits:{_timeout_ms:100,_max_input_bytes:128,_max_output_bytes:128,_max_contexts:1,_max_invocations:1}});
const actions=createDurableActions({_name:'sample',_instance_id:'sample',_application_scope:{_env:'test',_app_id:'sample'},_host:{_work_folder:'/tmp/compile-only-not-run',_listen:{_host:'127.0.0.1',_port:0}},_actions:registry.getContributions()._actions,_policy:registry.actionPolicy(),_limits:{_timeout_ms:100,_max_json_bytes:128}});
void reads;void actions;
