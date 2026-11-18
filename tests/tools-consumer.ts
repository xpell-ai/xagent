import { defineTool, createToolRegistry, type ToolPolicy, type ToolContextData } from "@xpell/agent/adk/tools";
const echo = defineTool({ _id: "sample.echo", _description: "Neutral echo", _effect: "read", _confirmation: "none",
  _input_schema: { type: "object", additionalProperties: false,
    properties: { text: { type: "string", minLength: 1, maxLength: 64 }, note: { type: "string", minLength: 0, maxLength: 64 } }, required: ["text"] },
  _handler: ({ _arguments, _signal }) => { const text: string = _arguments.text; const note: string | undefined = _arguments.note;
    void note; void _signal; return { text }; } });
const policy: ToolPolicy = i => ({ _allow: true, _policy_revision: "fixture", _authorized_scope: i._context });
const r = createToolRegistry({ _tools: [echo], _policy: policy,
  _limits: { _timeout_ms: 100, _max_input_bytes: 256, _max_output_bytes: 256, _max_invocations: 8, _max_contexts: 4 } });
declare const data: ToolContextData;
const ctx = r.bindContext(data);
const result = r.invoke({ _id: "one", _name: "sample.echo", _arguments: { text: "hi" } }, ctx);
const checked: Promise<{ readonly text: string }> = result;
void checked;
result.then(value => {
  // @ts-expect-error Results are immutable snapshots.
  value.text = "changed";
});
// @ts-expect-error Unknown tool IDs do not dispatch through the typed registry.
r.invoke({ _id: "x", _name: "sample.other", _arguments: { text: "x" } }, ctx);
// @ts-expect-error Required text is inferred from the closed schema.
r.invoke({ _id: "x", _name: "sample.echo", _arguments: {} }, ctx);
// @ts-expect-error Wrong argument types are rejected statically too.
r.invoke({ _id: "x", _name: "sample.echo", _arguments: { text: 1 } }, ctx);
// @ts-expect-error Plain caller data is not a registry-bound context reference.
r.invoke({ _id: "x", _name: "sample.echo", _arguments: { text: "x" } }, data);
const number = defineTool({ _id: "sample.number", _description: "Neutral numeric projection", _effect: "read", _confirmation: "none",
  _input_schema: { type: "object", additionalProperties: false,
    properties: { value: { type: "string", minLength: 1, maxLength: 8 } }, required: ["value"] },
  _handler: async ({ _arguments }) => ({ value: Number(_arguments.value) }) });
const mixed = createToolRegistry({ _tools: [echo, number], _limits: {
  _timeout_ms: 100, _max_input_bytes: 256, _max_output_bytes: 256, _max_invocations: 8, _max_contexts: 4 } });
const numeric: Promise<{ readonly value: number }> = mixed.invoke({ _id: "x", _name: "sample.number", _arguments: { value: "12" } }, ctx);
void numeric;
// @ts-expect-error Another registered tool's schema does not widen this name's arguments.
mixed.invoke({ _id: "x", _name: "sample.echo", _arguments: { value: "12" } }, ctx);
