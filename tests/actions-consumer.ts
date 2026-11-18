import { defineAction, createDurableActions, type TrustedActionContext, type ActionView } from "@xpell/agent/adk/actions";
const record = defineAction({ _id: "sample.record", _description: "Local synthetic action", _revision: "1",
  _input_schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", minLength: 1, maxLength: 64 } }, required: ["text"] },
  _prepare_action: ({ _arguments }) => { const s: string = _arguments.text; return { _arguments, _authorized_scope: { target: "fixture" }, _confirmation_summary: s }; },
  _handler: async ({ _arguments, _idempotency_key, _signal }) => {
    const s: string = _arguments.text; void s; void _idempotency_key; void _signal;
    // @ts-expect-error Validated handler arguments are immutable.
    _arguments.text = "changed";
    return { _status: "succeeded", _result: {} };
  },
  _read_committed_outcome: () => null });
const actions = createDurableActions({ _name: "fixture", _instance_id: "fixture", _application_scope: { _app_id: "fixture", _env: "test" },
  _host: { _work_folder: "/synthetic-only", _listen: { _host: "127.0.0.1", _port: 0 } }, _actions: [record],
  _limits: { _timeout_ms: 1000, _max_json_bytes: 1024 }, _policy: i => i._context._actor_id === "fixture" });
declare const context: TrustedActionContext;
const proposal: Promise<ActionView> = actions.prepare({ _capability_id: "sample.record", _arguments: { text: "hello" } }, context);
void proposal;
// @ts-expect-error Only registered names are accepted.
actions.prepare({ _capability_id: "missing", _arguments: { text: "hello" } }, context);
// @ts-expect-error Required schema fields are inferred.
actions.prepare({ _capability_id: "sample.record", _arguments: {} }, context);
// @ts-expect-error Wrong argument type.
actions.prepare({ _capability_id: "sample.record", _arguments: { text: 1 } }, context);
// @ts-expect-error Context references must be bound by this profile at runtime too.
actions.get("id", { _actor_id: "fixture", _conversation_id: "fixture", _delivery_id: "fixture" });
// @ts-expect-error Consent binds an exact proposal hash.
actions.confirm({ _action_id: "id" }, context);
// @ts-expect-error Existing factories gain no Action methods.
import("@xpell/agent/adk").then(({ createAgent }) => createAgent.actions);
