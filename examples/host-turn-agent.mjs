import { createHash } from "node:crypto";
import { defineTool, createToolRegistry, ReadToolError } from "@xpell/agent/adk/tools";
import { normalizeXAIToolCalls } from "@xpell/node";

const TOOL = "business.get-business-info";
/** Deterministic fixture model. It has no registry, handler or business-record reference. */
function modelRound(input, mode, record) {
  record("model.generate", { roles: input.messages.map(m => m._role) });
  const last = input.messages.at(-1);
  if (last._role === "tool") {
    const assistant = input.messages.at(-2);
    if (assistant?._tool_calls?.[0]?._id !== last._tool_call_id) throw Error("fixture result binding");
    const info = JSON.parse(last._content[0]._text).business_info;
    if (!info || typeof info.name !== "string" || typeof info.opening_hours !== "string" || info.synthetic !== true)
      throw Error("fixture result shape");
    const text = `${info.name} is open ${info.opening_hours} (${info.timezone}).`;
    record("model.grounded-answer", { text });
    return { text, finish_reason: "stop" };
  }
  const business = last._content[0]._text.match(/synthetic-business-[0-9]{3}/)?.[0];
  if (!business || !input.tools.some(t => t._name === TOOL)) throw new ReadToolError("E_ADK_TOOL_DENIED");
  const call = { _id: "fixture-model-call", _name: mode === "unknown" ? "business.unknown" : TOOL,
    _arguments: { business_id: business, ...(mode === "arguments" ? { admin: "true" } : {}) } };
  record("model.tool-call", { id: call._id, name: call._name });
  return { text: "", finish_reason: "tool_calls", tool_calls: mode === "batch" ? [call, { ...call, _id: "extra-call" }] : [call] };
}

/** Application-owned synthetic fixture, not a generic SDK model loop or identity service. */
export function syntheticBusinessTurn({ hours = "09:00-17:00 Monday-Friday", actor = "fixture-reader",
  control = { reads: true, run: true, reply: true }, mode = "normal", record = () => {} } = {}) {
  const business = Object.freeze({ business_id: "synthetic-business-001", name: "Synthetic Corner Shop",
    opening_hours: hours, timezone: "UTC", synthetic: true });
  let handlers = 0, rounds = 0;
  const modelInputs = [], retained = new WeakMap();
  // Both the handler and policy are synchronous pure reads; no detached/nested resource work.
  const reads = createToolRegistry({
    _tools: [defineTool({ _id: TOOL, _description: "Read synthetic opening hours", _effect: "read", _confirmation: "none",
      _input_schema: { type: "object", additionalProperties: false,
        properties: { business_id: { type: "string", minLength: 3, maxLength: 64 } }, required: ["business_id"] },
      _handler: ({ _arguments, _signal }) => {
        if (_signal.aborted || _arguments.business_id !== business.business_id) throw Error("fixture binding");
        handlers++; record("T1.handler"); return { business_info: business };
      } })],
    _policy: input => {
      const ok = control.reads && input._context._actor_id === "fixture-reader" &&
        input._context._instance_id === "host-turn-fixture" && input._context._application_scope._env === "test" &&
        input._context._application_scope._app_id === "synthetic-business" &&
        (input._phase === "expose" || input._arguments.business_id === business.business_id);
      record("T1.policy", { phase: input._phase, allowed: ok });
      return ok ? { _allow: true, _policy_revision: "fixture-1", _authorized_scope: input._context } : { _allow: false };
    },
    _limits: { _timeout_ms: 1000, _max_input_bytes: 256, _max_output_bytes: 1024, _max_invocations: 8, _max_contexts: 2 },
  });
  const trusted = reads.bindContext({ _instance_id: "host-turn-fixture", _application_scope: { _env: "test", _app_id: "synthetic-business" },
    _actor_id: actor, _conversation_id: "synthetic-conversation", _delivery_id: "explicit-fixture-delivery" });
  const context = mode === "forged" ? structuredClone(trusted) : trusted;
  const delegate = Object.freeze({
    _limits: Object.freeze({ _timeout_ms: 1000, _max_input_bytes: 512, _max_output_bytes: 1024 }),
    async _authorize(request) {
      record(`host.authorize.${request._phase}`);
      if (actor !== "fixture-reader" || request._signal.aborted || !control.run) return false;
      if (request._phase === "run") return true;
      if (!control.reply) return false;
      const call = retained.get(request._signal);
      if (!call) return false;
      // Reauthorize a known completed T1 receipt; never dispatch a fresh call to check access.
      await reads.invoke(call, context);
      return control.reply && control.run && !request._signal.aborted;
    },
    async _run(request) {
      const check = () => { if (request._signal.aborted) throw Error("fixture cancelled"); };
      check(); const tools = await reads.project(context); check();
      if (!tools.some(tool => tool._name === TOOL)) throw new ReadToolError("E_ADK_TOOL_DENIED");
      const messages = [{ _role: "user", _content: [{ _type: "text", _text: request._text }] }];
      const firstInput = { messages: structuredClone(messages), tools: structuredClone(tools) };
      modelInputs.push(firstInput); rounds++;
      const first = modelRound(firstInput, mode, record); check();
      if (first.finish_reason !== "tool_calls" || first.tool_calls.length !== 1) throw Error("fixture bounded batch");
      const calls = normalizeXAIToolCalls(first.tool_calls), call = calls[0];
      if (call._name !== TOOL) throw Error("fixture unknown tool");
      const read = Object.freeze({ _id: createHash("sha256").update(JSON.stringify([trusted, call._id])).digest("hex"),
        _name: call._name, _arguments: call._arguments });
      record("application.registry-invoke"); const result = await reads.invoke(read, context); check();
      retained.set(request._signal, read);
      messages.push({ _role: "assistant", _content: [], _tool_calls: calls });
      messages.push({ _role: "tool", _tool_call_id: call._id, _content: [{ _type: "text", _text: JSON.stringify(result) }] });
      record("application.tool-result");
      const secondInput = { messages: structuredClone(messages), tools: structuredClone(tools) };
      modelInputs.push(secondInput); rounds++;
      const answer = modelRound(secondInput, mode, record); check();
      if (answer.finish_reason !== "stop" || !answer.text) throw Error("fixture missing answer");
      return answer.text;
    },
  });
  return Object.freeze({ delegate, reads, close: () => reads.close(),
    getEvidence: () => ({ handlers, rounds, model_inputs: structuredClone(modelInputs), audit: reads.getAudit() }) });
}

// Optional standalone neutral consumer. Importing this file never starts a Host.
if (process.argv[1] && (await import("node:url")).fileURLToPath(import.meta.url) === process.argv[1]) {
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { join } = await import("node:path"), { tmpdir } = await import("node:os");
  const { createAgentHost } = await import("@xpell/agent/adk/host");
  const { mockChannel, mockTextModel } = await import("@xpell/agent/adk");
  const parent = await realpath(await mkdtemp(join(tmpdir(), "host-turn-example-")));
  const sample = syntheticBusinessTurn();
  const host = createAgentHost({ _profile: { _type: "foundation", _options: {
    _name: "synthetic-host", _model: mockTextModel({ _text: "unused delegated placeholder" }),
    _channel: mockChannel({ _id: "local" }), _plugins: [],
    _host: { _work_folder: join(parent, "instance"), _listen: { _host: "127.0.0.1", _port: 0 } },
  } }, _turn: sample.delegate });
  try {
    await host.start();
    console.log(await host.testTurn({ _text: "What are the opening hours for synthetic-business-001?" }));
  } finally { await host.close(); sample.close(); await rm(parent, { recursive: true, force: true }); }
}
