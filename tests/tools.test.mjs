import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { defineTool, createToolRegistry, ReadToolError } from "@xpell/agent/adk/tools";

const limits = { _timeout_ms: 1000, _max_input_bytes: 4096, _max_output_bytes: 8192, _max_invocations: 16, _max_contexts: 8 };
const data = { _instance_id: "synthetic-instance", _application_scope: { _env: "test", _app_id: "neutral" },
  _actor_id: "private-test-actor", _conversation_id: "fixture-conversation", _delivery_id: "fixture-delivery" };
const allow = input => ({ _allow: true, _policy_revision: "fixture-1", _authorized_scope: input._context });
const schema = () => ({ type: "object", additionalProperties: false,
  properties: { text: { type: "string", minLength: 1, maxLength: 64 }, note: { type: "string", minLength: 0, maxLength: 64 } }, required: ["text"] });
const definition = (handler = ({ _arguments }) => ({ text: _arguments.text })) => ({
  _id: "sample.echo", _description: "Echo synthetic input", _effect: "read", _confirmation: "none", _input_schema: schema(), _handler: handler });
const call = (id = "call-1", args = { text: "hello" }, name = "sample.echo") => ({ _id: id, _name: name, _arguments: args });
const code = name => error => error instanceof ReadToolError && error._code === "E_ADK_TOOL_" + name &&
  error.message === "Read tool operation failed; inspect the safe error code" && !error.cause;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(handler, options = {}) {
  const r = createToolRegistry({ _tools: [definition(handler)], _policy: allow, _limits: limits, ...options });
  const context = r.bindContext(data); await r.project(context); return { r, context };
}

test("read tools: definition snapshot, authorized projection and fixed echo dispatch", async () => {
  const raw = definition(); const r = createToolRegistry({ _tools: [raw], _policy: allow, _limits: limits });
  raw._id = "sample.changed"; raw._handler = () => ({ text: "wrong" }); raw._input_schema.properties.text.maxLength = 1;
  const ctx = r.bindContext(data), projection = await r.project(ctx);
  assert.deepEqual(Object.keys(projection[0]).sort(), ["_description", "_input_schema", "_name"]);
  assert.equal(projection[0]._name, "sample.echo");
  assert.ok(Object.isFrozen(projection)); assert.ok(Object.isFrozen(projection[0]._input_schema.properties.text));
  assert.deepEqual(await r.invoke(call(), ctx), { text: "hello" }); r.close();
});

test("read tools: absent policy is default deny, including an empty registry", async () => {
  const r = createToolRegistry({ _tools: [definition(() => assert.fail("denied handler"))], _limits: limits });
  const ctx = r.bindContext(data); assert.deepEqual(await r.project(ctx), []);
  await assert.rejects(r.invoke(call(), ctx), code("DENIED")); r.close();
  const empty = createToolRegistry({ _tools: [], _limits: limits });
  assert.deepEqual(await empty.project(empty.bindContext(data)), []); empty.close();
});

test("read tools: definitions reject writes, duplicate IDs and unsupported schemas eagerly", () => {
  for (const mutate of [
    d => { d._effect = "side_effect"; }, d => { d._confirmation = "required"; }, d => { d._id = "bad id"; },
    d => { d._input_schema.additionalProperties = true; }, d => { d._input_schema.required = ["missing"]; },
    d => { d._input_schema.required = ["text", "text"]; }, d => { d._input_schema.properties.text.type = "number"; },
    d => { delete d._input_schema.properties.text.maxLength; }, d => { d._input_schema.properties.text.enum = ["a"]; },
    d => { d._input_schema.properties.text.minLength = 65; }, d => { d._input_schema.properties.text.maxLength = 1025; },
    d => { d._input_schema.extra = true; }, d => { d._prepare_action = () => ({}); },
  ]) { const d = definition(); mutate(d); assert.throws(() => defineTool(d), code("CONFIG")); }
  assert.throws(() => createToolRegistry({ _tools: [definition(), definition()], _limits: limits }), code("CONFIG"));
});

test("read tools: bounded explicit configuration and no sparse definition arrays", () => {
  for (const [key, values] of Object.entries({ _timeout_ms: [0, 5001, NaN], _max_input_bytes: [1, 4097],
    _max_output_bytes: [1, 8193], _max_invocations: [0, 257], _max_contexts: [0, 65] })) {
    for (const value of values) assert.throws(() => createToolRegistry({ _tools: [], _limits: { ...limits, [key]: value } }), code("CONFIG"));
  }
  assert.throws(() => createToolRegistry({ _tools: Array(1), _limits: limits }), code("CONFIG"));
  assert.throws(() => createToolRegistry({ _tools: [], _limits: { ...limits, arbitrary: 1 } }), code("CONFIG"));
});

test("read tools: forged, cloned and foreign contexts have no authority", async () => {
  const { r, context } = await fixture();
  for (const bad of [data, structuredClone(context), { ...context }, undefined]) {
    await assert.rejects(r.project(bad), code("DENIED")); await assert.rejects(r.invoke(call(), bad), code("DENIED"));
  }
  const other = await fixture(); await assert.rejects(other.r.invoke(call(), context), code("DENIED"));
  assert.equal(r.bindContext(structuredClone(data)), context); assert.ok(Object.isFrozen(context._application_scope));
  other.r.close(); r.close();
});

test("read tools: malformed, throwing and wrong-scope policies fail closed", async () => {
  for (const policy of [() => true, () => ({}), () => { throw Error("PRIVATE_POLICY"); },
    i => ({ ...allow(i), _authorized_scope: { ...i._context, _actor_id: "other" } }),
    i => ({ ...allow(i), _authorized_scope: { ...i._context, _application_scope: { _env: "test", _app_id: "other" } } }),
    i => ({ ...allow(i), extra: true })]) {
    let invoked = 0; const r = createToolRegistry({ _tools: [definition(() => { invoked++; return {}; })], _policy: policy, _limits: limits });
    await assert.rejects(r.project(r.bindContext(data)), code("DENIED")); assert.equal(invoked, 0); r.close();
  }
});

test("read tools: invocation requires exposure and fresh authorization", async () => {
  let allowed = true, effects = 0; const phases = [];
  const r = createToolRegistry({ _tools: [definition(() => { effects++; return {}; })], _limits: limits,
    _policy: i => { phases.push(i._phase); return allowed ? allow(i) : { _allow: false }; } });
  const ctx = r.bindContext(data); await assert.rejects(r.invoke(call(), ctx), code("DENIED"));
  await r.project(ctx); allowed = false; await assert.rejects(r.invoke(call(), ctx), code("DENIED"));
  assert.equal(effects, 0); assert.deepEqual(phases, ["expose", "invoke"]); r.close();
});

test("read tools: hidden and unknown tool names cannot dispatch", async () => {
  let effects = 0; const hidden = { ...definition(() => { effects++; return {}; }), _id: "sample.hidden" };
  const { r, context } = await fixture(undefined, { _tools: [definition(), hidden], _policy: i => i._tool_id === "sample.hidden" ? { _allow: false } : allow(i) });
  await assert.rejects(r.invoke(call("x", {}, "sample.hidden"), context), code("DENIED"));
  await assert.rejects(r.invoke(call("x", {}, "sample.unknown"), context), code("UNKNOWN")); assert.equal(effects, 0); r.close();
});

test("read tools: arguments reject missing, mistyped, extra and accessor fields without execution", async () => {
  let invoked = 0, getters = 0; const { r, context } = await fixture(() => { invoked++; return {}; });
  const accessor = {}; Object.defineProperty(accessor, "text", { enumerable: true, get() { getters++; return "x"; } });
  for (const args of [{}, { text: 2 }, { text: "" }, { text: "a".repeat(65) }, { text: "x", _module: "other" }, [], accessor]) {
    await assert.rejects(r.invoke(call("x", args), context), code("ARGUMENTS"));
  }
  const malformed = {}; Object.defineProperty(malformed, "_id", { enumerable: true, get() { getters++; return "x"; } });
  await assert.rejects(r.invoke(malformed, context), code("ARGUMENTS"));
  assert.equal(invoked, 0); assert.equal(getters, 0); r.close();
});

test("read tools: UTF-8 input cap is enforced before handler", async () => {
  const { r, context } = await fixture(() => assert.fail("over-budget handler"), { _limits: { ...limits, _max_input_bytes: 16 } });
  await assert.rejects(r.invoke(call("large", { text: "🍋🍋🍋" }), context), code("LIMIT")); r.close();
});

test("read tools: process-local replay is canonical, scoped and conflict-safe", async () => {
  let count = 0; const { r, context } = await fixture(({ _arguments }) => { count++; return { text: _arguments.text, nested: { ok: true } }; });
  const first = await r.invoke(call("one", { text: "hello", note: "x" }), context);
  assert.equal(await r.invoke(call("one", { note: "x", text: "hello" }), context), first);
  assert.ok(Object.isFrozen(first.nested));
  await assert.rejects(r.invoke(call("one", { text: "changed" }), context), code("CONFLICT"));
  const c2 = r.bindContext({ ...data, _delivery_id: "another" }); await r.project(c2); await r.invoke(call("one"), c2);
  assert.equal(count, 2); assert.equal(r.getAudit().length, 2);
  assert.equal(JSON.stringify(r.getAudit()).includes("private-test-actor"), false);
  assert.equal(JSON.stringify(r.getAudit()).includes("hello"), false); r.close();
});

test("read tools: replay is reauthorized without altering its original receipt", async () => {
  let allowed = true, count = 0; const { r, context } = await fixture(() => { count++; return { private: "kept-local" }; },
    { _policy: i => allowed ? allow(i) : { _allow: false } });
  await r.invoke(call(), context); const before = r.getAudit(); allowed = false;
  await assert.rejects(r.invoke(call(), context), code("DENIED")); assert.deepEqual(r.getAudit(), before); assert.equal(count, 1); r.close();
});

test("read tools: deterministic receipts across equivalent registries", async () => {
  const a = await fixture(), b = await fixture(); await a.r.invoke(call(), a.context); await b.r.invoke(call(), b.context);
  assert.deepEqual(a.r.getAudit(), b.r.getAudit()); assert.ok(Object.isFrozen(a.r.getAudit()[0])); a.r.close(); b.r.close();
});

test("read tools: concurrent duplicates and new IDs never start a second handler", async () => {
  const start = deferred(), end = deferred(); let count = 0;
  const { r, context } = await fixture(async () => { count++; start.resolve(); await end.promise; return {}; });
  const first = r.invoke(call(), context); await start.promise;
  await assert.rejects(r.invoke(call(), context), code("BUSY")); await assert.rejects(r.invoke(call("second"), context), code("BUSY"));
  end.resolve(); await first; await r.invoke(call(), context); assert.equal(count, 1); assert.equal(r.getAudit().length, 1); r.close();
});

test("read tools: deadline fences late results and preserves ownership until settlement", async () => {
  const start = deferred(), end = deferred(); let signal, count = 0;
  const { r, context } = await fixture(async i => { count++; signal = i._signal; start.resolve(); await end.promise; return { late: true }; },
    { _limits: { ...limits, _timeout_ms: 25 } });
  const pending = r.invoke(call(), context); await start.promise; await assert.rejects(pending, code("TIMEOUT")); assert.equal(signal.aborted, true);
  await assert.rejects(r.invoke(call("second"), context), code("BUSY")); end.resolve(); await tick();
  await assert.rejects(r.invoke(call(), context), code("TIMEOUT")); assert.equal(count, 1);
  assert.equal(r.getAudit()[0]._result_sha256, undefined); assert.equal(r.getAudit()[0]._error_code, "E_ADK_TOOL_TIMEOUT"); r.close();
});

test("read tools: policy deadline never releases a later handler", async () => {
  const end = deferred(); let handlers = 0;
  const { r, context } = await fixture(() => { handlers++; return {}; }, {
    _limits: { ...limits, _timeout_ms: 25 }, _policy: i => i._phase === "expose" ? allow(i) : end.promise.then(() => allow(i)) });
  await assert.rejects(r.invoke(call(), context), code("TIMEOUT")); end.resolve(); await tick();
  assert.equal(handlers, 0); r.close();
});

test("read tools: elapsed synchronous work is rejected, not represented as cancellable", async () => {
  const { r, context } = await fixture(() => { const until = performance.now() + 30; while (performance.now() < until) {} return {}; },
    { _limits: { ...limits, _timeout_ms: 5 } });
  await assert.rejects(r.invoke(call(), context), code("TIMEOUT")); r.close();
});

test("read tools: close fences pending work and clears replay data", async () => {
  const start = deferred(), end = deferred(); let signal;
  const { r, context } = await fixture(async i => { signal = i._signal; start.resolve(); await end.promise; return { late: true }; });
  const p = r.invoke(call(), context); await start.promise; r.close(); r.close();
  await assert.rejects(p, code("CLOSED")); assert.equal(signal.aborted, true); end.resolve(); await tick();
  await assert.rejects(r.invoke(call(), context), code("CLOSED")); await assert.rejects(r.project(context), code("CLOSED"));
  assert.throws(() => r.bindContext(data), code("CLOSED")); assert.equal(r.getAudit()[0]._status, "failed");
});

test("read tools: handler exceptions and invalid results have safe cached outcomes", async () => {
  const cyclic = {}; cyclic.self = cyclic; const getter = {}; let reads = 0;
  Object.defineProperty(getter, "value", { enumerable: true, get() { reads++; return "private"; } });
  for (const value of [undefined, 1, [], { value: BigInt(1) }, { value: Infinity }, { value: () => 1 }, { value: new Date() }, { value: Array(1) }, cyclic, getter, { text: "x".repeat(9000) }]) {
    const { r, context } = await fixture(() => value); await assert.rejects(r.invoke(call(), context), code("RESULT")); r.close();
  }
  const { r, context } = await fixture(() => { throw Error("PRIVATE_HANDLER"); });
  await assert.rejects(r.invoke(call(), context), code("HANDLER")); await assert.rejects(r.invoke(call(), context), code("HANDLER"));
  assert.equal(JSON.stringify(r.getAudit()).includes("PRIVATE_HANDLER"), false); assert.equal(reads, 0); r.close();
});

test("read tools: capacity fails closed without evicting idempotency receipts", async () => {
  const { r, context } = await fixture(undefined, { _limits: { ...limits, _max_invocations: 1, _max_contexts: 1 } });
  await r.invoke(call(), context); await assert.rejects(r.invoke(call("second"), context), code("CAPACITY"));
  assert.deepEqual(await r.invoke(call(), context), { text: "hello" });
  assert.throws(() => r.bindContext({ ...data, _actor_id: "another" }), code("CAPACITY")); r.close();
});
