import { defineTool, createToolRegistry } from "@xpell/agent/adk/tools";

// Explicit synthetic read-only fixture. No host, storage, credentials or model.
const echo = defineTool({
  _id: "sample.echo", _description: "Echo a bounded synthetic value",
  _effect: "read", _confirmation: "none",
  _input_schema: { type: "object", additionalProperties: false,
    properties: { text: { type: "string", minLength: 1, maxLength: 64 } }, required: ["text"] },
  _handler: ({ _arguments }) => ({ text: _arguments.text }),
});
const registry = createToolRegistry({
  _tools: [echo],
  _limits: { _timeout_ms: 1000, _max_input_bytes: 256, _max_output_bytes: 256, _max_invocations: 4, _max_contexts: 1 },
  _policy: i => i._context._actor_id === "synthetic-test-caller" && i._tool_id === "sample.echo"
    ? { _allow: true, _policy_revision: "example-1", _authorized_scope: i._context }
    : { _allow: false },
});
try {
  // Only trusted application composition may bind context. These are fake IDs.
  const context = registry.bindContext({ _instance_id: "example", _application_scope: { _env: "test", _app_id: "neutral" },
    _actor_id: "synthetic-test-caller", _conversation_id: "example", _delivery_id: "delivery-1" });
  await registry.project(context);
  console.log(JSON.stringify(await registry.invoke({ _id: "call-1", _name: "sample.echo", _arguments: { text: "hello" } }, context)));
} finally { registry.close(); }
