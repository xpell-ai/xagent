# Read-tool registry — unpublished review candidate

The opt-in `@xpell/agent/adk/tools` subpath supplies `defineTool`,
`createToolRegistry`, `ReadToolError` and their types. It does not start XNode,
read credentials, open files/listeners, call a model or register a global module.
Existing root, Foundation, durable conversation and Router APIs are unchanged.
The text Router adapter still rejects model-emitted tool calls.

Install the tarball built from the reviewed commit in a fresh ESM consumer,
then run `node node_modules/@xpell/agent/examples/read-tools.mjs`. Expected output:
`{"text":"hello"}`. The example is entirely synthetic and uses no model/host.
This candidate is not a claim that the subpath is available in published 2.0.8.

```js
import { defineTool, createToolRegistry } from "@xpell/agent/adk/tools";
const echo = defineTool({
  _id: "sample.echo", _description: "Echo synthetic input",
  _effect: "read", _confirmation: "none",
  _input_schema: { type: "object", additionalProperties: false,
    properties: { text: { type: "string", minLength: 1, maxLength: 64 } },
    required: ["text"] },
  _handler: ({ _arguments }) => ({ text: _arguments.text })
});
const registry = createToolRegistry({
  _tools: [echo],
  _limits: { _timeout_ms: 1000, _max_input_bytes: 256,
    _max_output_bytes: 256, _max_invocations: 4, _max_contexts: 1 },
  // This allowlist is only for the explicitly synthetic example context.
  _policy: i => i._context._actor_id === "fixture" && i._tool_id === "sample.echo"
    ? { _allow: true, _policy_revision: "example-1", _authorized_scope: i._context }
    : { _allow: false }
});
try {
  const context = registry.bindContext({ _instance_id: "example",
    _application_scope: { _env: "test", _app_id: "example" }, _actor_id: "fixture",
    _conversation_id: "example", _delivery_id: "delivery-1" });
  await registry.project(context);
  const reply = await registry.invoke({ _id: "call-1", _name: "sample.echo",
    _arguments: { text: "hello" } }, context);
  console.log(reply);
} finally { registry.close(); }
```

## Definition and input contract

Definitions are snapshotted/frozen at registration. IDs are stable lowercase
kebab segments optionally separated by dots, at most 100 characters. Only
`read`/`none` is supported; side-effect/preparation fields are rejected. Handlers
are fixed reviewed application functions, never caller-selected module/operation
commands. TypeScript infers required/optional string arguments from the literal
schema and the returned JSON result type; runtime validation is still required.

This new narrow adapter follows the generic Starter's capability projection,
closed-object/string validation and immediate reauthorization patterns. It is
not byte-identical extraction. It has no Starter/product imports. Schemas are a
deliberate subset: `type:object`, `additionalProperties:false`, explicit
`properties` and `required`. Up to 16 properties, each a string with integer
`minLength`/`maxLength` in 0–1024 / 1–1024, min <= max. Optional descriptions are
bounded. Unknown keywords, extra arguments, accessors and unsupported value
types fail closed. No general JSON Schema validator is implied.

## Trusted composition and policy

The registry object belongs only to trusted server/application composition.
`bindContext` freezes explicit instance, native app pair, actor, conversation
and delivery references and records private runtime membership. Clones,
plain objects and contexts from another registry are rejected. Equal values
bound by the same registry return the same reference. This does not verify
identity: the application must establish those facts before binding them.
Never expose context minting or the registry directly through untrusted HTTP,
Channel/model input. A brand/reference is not authentication or an IAM grant.

No policy means `project` returns an empty list and invocation is denied.
`project` evaluates `expose` and returns only allowed XAI definition projections.
`invoke` requires a registered, exposed ID and re-evaluates `invoke` with the
validated arguments, including on cached-result replay. A positive decision
must have a nonempty safe policy revision and match the exact entire context
as `_authorized_scope`. False, malformed, wrong-scope, throwing or expired
decisions do not execute a handler. Policy receives an AbortSignal. It must
check resource rights from trusted state; these are in-process hooks, not a
Principal/Group/Admin or grant-management service.

## Bounds, replay and audit

All limits are explicit positive integers. Hard maxima: 32 tools, 64 bound
contexts, 256 invocation receipts, 5000 ms per operation, 4096 input bytes and
8192 output bytes. Input/output byte limits count canonical JSON UTF-8, including
keys/escaping. Results must be JSON objects; finite numbers, arrays and nested
objects are allowed within depth 8 / 1024-node limits. Results are immutable
snapshots. No raw handler/policy errors or arbitrary causes cross the API.

One project/invocation operation owns the registry at a time. The deadline
covers its policy and handler together (all policies for a projection share
one deadline). Handlers receive an AbortSignal. Timed-out/closed operations
cannot release late results or start a replacement while the original work
is unresolved; concurrent calls receive `E_ADK_TOOL_BUSY`. Arbitrary JavaScript
cannot be forcibly cancelled: synchronous CPU work can block the event loop,
and ignoring abort can keep ownership alive. This is not a hostile-code sandbox.
Only reviewed read-only handlers are supported; no network/write tool or I/O
authority is supplied. The contract cannot stop trusted JavaScript from making
its own ambient I/O calls. Stronger isolation is separate work.

The invocation key hashes context plus call ID; its binding hashes tool ID and
canonical arguments. An admitted ID is never evicted/reused within this registry.
Equal completed requests replay the same result after fresh policy checks;
changed payload/tool returns conflict. Pending duplicates return busy. Failures,
including timeout/denial, retain a safe failed receipt and never execute again
under that ID. No automatic retry occurs. Capacity exhaustion fails closed.
This is **process-local**, not durable idempotency or exactly-once execution.
New registries/processes do not inherit results/receipts.

`getAudit()` returns immutable receipt snapshots in admission order: sequence,
operation hash, tool ID, status, safe revision/error and result hash. It contains
no argument/result content or raw context identifiers. It is a bounded diagnostic
receipt, not an append-only or tamper-resistant durable audit log. It records
admitted IDs, not every rejected probe or replay attempt. Replays do not mutate
the original receipt; revoked replay still returns denial. `close()` is
idempotent, fences new work, requests abort and clears cached results/context
references; safe receipts remain inspectable. It does not await hung JavaScript.

Safe codes use `E_ADK_TOOL_`: `CONFIG`, `UNKNOWN`, `DENIED`, `ARGUMENTS`,
`RESULT`, `HANDLER`, `TIMEOUT`, `LIMIT`, `BUSY`, `CONFLICT`, `CAPACITY`, `CLOSED`.
No model loop, durable Actions, schema/marker migration, plugin loading or IAM
is added. Qualification commands are `pnpm build`, `pnpm test` and the packaged
example in isolated Node 22/24 consumers. Other platforms need qualification.
