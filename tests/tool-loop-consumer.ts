import { createRouterToolLoop, type ToolLoopResult } from "@xpell/agent/adk/tool-loop";
import { defineTool, createToolRegistry } from "@xpell/agent/adk/tools";
import { defineAction, createDurableActions } from "@xpell/agent/adk/actions";
import { routerTextModel } from "@xpell/agent/adk";
const schema = { type: "object", additionalProperties: false, properties: { text: { type: "string", minLength: 1, maxLength: 64 } }, required: ["text"] } as const;
const reads = createToolRegistry({ _tools: [defineTool({ _id: "sample.echo", _description: "Echo", _input_schema: schema,
  _effect: "read", _confirmation: "none", _handler: ({ _arguments }) => ({ text: _arguments.text }) })] as const,
  _limits: { _timeout_ms: 500, _max_input_bytes: 4096, _max_output_bytes: 8192, _max_invocations: 16, _max_contexts: 16 } });
const host = createDurableActions({ _name: "typed", _instance_id: "typed", _application_scope: { _env: "test", _app_id: "typed" },
  _host: { _work_folder: "/disposable/typed", _listen: { _host: "127.0.0.1", _port: 0 } },
  _actions: [defineAction({ _id: "sample.record", _description: "Record", _revision: "1", _input_schema: schema,
    _prepare_action: ({ _arguments }) => ({ _arguments, _authorized_scope: {}, _confirmation_summary: "Confirm" }),
    _handler: () => ({ _status: "succeeded", _result: {} }) })] as const, _limits: { _timeout_ms: 1000, _max_json_bytes: 4096 } });
const options = { _actions: host, _reads: reads, _action_ids: ["sample.record"] as const, _system: "Policy",
  _model: routerTextModel({ _endpoint: "http://127.0.0.1:1", _model: "fixture", _credential: { _env: "SYNTHETIC" }, _timeout_ms: 1000, _error_policy: "fail-closed", _allow_requests: true }),
  _limits: { _max_rounds: 3, _max_calls: 4, _max_calls_per_round: 4, _max_transcript_bytes: 8192, _max_output_tokens: 64, _max_total_tokens: 16384, _timeout_ms: 3000 } };
const loop = createRouterToolLoop(options);
const context = loop.bindContext({ _actor_id: "actor", _conversation_id: "conversation", _delivery_id: "delivery" });
const result: Promise<ToolLoopResult> = loop.run({ _text: "hello" }, context);
// @ts-expect-error unregistered Action ID
createRouterToolLoop({ ...options, _action_ids: ["unknown"] });
// @ts-expect-error only loop-minted trusted contexts
loop.run({ _text: "hello" }, { _actor_id: "actor", _conversation_id: "conversation", _delivery_id: "delivery" });
// @ts-expect-error model cannot confirm Actions
loop.confirm({ _action_id: "x" });
void result;
