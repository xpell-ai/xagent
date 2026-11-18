import { performance } from "node:perf_hooks";
import type { XAIMessage, XAIToolCall, XAIToolDefinition } from "@xpell/node";
import { RouterModel, routerTextModel, type RouterTextModel } from "./router.js";
import { readRegistryHost } from "./tools/host.js";
import { actionHost } from "./actions/host.js";
import { createDurableActions, type DurableActions, type ActionContextInput, type ActionProposal } from "./actions.js";
import { createToolRegistry, type ToolRegistry, type TrustedToolContext, type ToolInputSchema } from "./tools.js";
import { data, jsonObject, frozen, hash } from "./actions/validation.js";
import { ConversationRepository } from "./starter/persistence/ConversationRepository.js";
import { ConversationService, type InboundConversationTurn } from "./starter/conversation/ConversationService.js";
import { deterministicId } from "./starter/persistence/keys.js";
import { hasPlanningEnvelope } from "./starter/conversation/UserVisibleReply.js";

type Reads = Parameters<typeof createToolRegistry>[0]["_tools"];
type Actions = Parameters<typeof createDurableActions>[0]["_actions"];
export type ToolLoopLimits = Readonly<{
  _max_rounds: number; _max_calls: number; _max_calls_per_round: number;
  _max_transcript_bytes: number; _max_output_tokens: number; _max_total_tokens: number;
  _timeout_ms: number;
}>;
declare const contextBrand: unique symbol;
export type TrustedToolLoopContext = ActionContextInput & Readonly<{ [contextBrand]: true }>;
export type ToolLoopPolicy = (input: Readonly<{
  _phase: "run" | "replay" | "expose-action"; _context: TrustedToolLoopContext;
  _action_id?: string; _signal: AbortSignal;
}>) => boolean | Promise<boolean>;
export type ToolLoopTrace = Readonly<{
  _round: number; _event: "dispatch" | "read" | "proposal" | "complete";
  _operation_hash: string; _tool_id?: string; _call_hash?: string;
}>;
export type ToolLoopResult = Readonly<{
  _status: "completed"; _text: string; _trace: readonly ToolLoopTrace[];
}> | Readonly<{
  _status: "requires_confirmation"; _proposals: readonly ActionProposal[]; _trace: readonly ToolLoopTrace[];
}>;
export type RouterToolLoop = Readonly<{
  /** The existing T2 host must be ready; start never generates or probes. */
  start(): Promise<void>;
  bindContext(input: ActionContextInput): TrustedToolLoopContext;
  run(input: Readonly<{ _text: string }>, context: TrustedToolLoopContext, signal?: AbortSignal): Promise<ToolLoopResult>;
  /** Fences immediately; awaits owned work without closing caller-owned host/registry. */
  close(): Promise<void>;
}>;
export type RouterToolLoopOptions<R extends Reads, H extends DurableActions<Actions>> = Readonly<{
  _model: RouterTextModel; _reads: ToolRegistry<R>; _actions: H;
  /** Explicit T2 IDs eligible for policy-filtered, prepare-only advertisement. */
  _action_ids: readonly NoInfer<Parameters<H["prepare"]>[0]["_capability_id"]>[];
  _system: string; _policy?: ToolLoopPolicy; _limits: ToolLoopLimits;
}>;
export type ToolLoopErrorCode = "E_ADK_LOOP_CONFIG" | "E_ADK_LOOP_NOT_READY" | "E_ADK_LOOP_CLOSED" |
  "E_ADK_LOOP_DENIED" | "E_ADK_LOOP_BUSY" | "E_ADK_LOOP_LIMIT" | "E_ADK_LOOP_RESULT" |
  "E_ADK_LOOP_CONFLICT" | "E_ADK_LOOP_TIMEOUT" | "E_ADK_LOOP_CANCELLED" | "E_ADK_LOOP_UNCERTAIN" |
  "E_ADK_LOOP_STORAGE" | "E_ADK_LOOP_MODEL" | "E_ADK_LOOP_TOOL" | "E_ADK_LOOP_ACTION";
export class ModelToolLoopError extends Error {
  constructor(readonly _code: ToolLoopErrorCode) { super("Model tool loop failed; inspect the safe error code"); this.name = "ModelToolLoopError"; Object.freeze(this); }
}
const fail = (c: ToolLoopErrorCode): never => { throw new ModelToolLoopError(c); };
function safe(e: unknown): ModelToolLoopError {
  if (e instanceof ModelToolLoopError) return e;
  let c: unknown;
  try { c = e && typeof e === "object" ? Object.getOwnPropertyDescriptor(e, "_code")?.value : undefined; } catch { /* No untrusted getters. */ }
  if (typeof c === "string" && c.endsWith("_DENIED")) return new ModelToolLoopError("E_ADK_LOOP_DENIED");
  if (c === "E_STARTER_INBOUND_BINDING") return new ModelToolLoopError("E_ADK_LOOP_CONFLICT");
  return new ModelToolLoopError("E_ADK_LOOP_STORAGE");
}
function obj(v: unknown, keys?: readonly string[]): Record<string, unknown> {
  try { return data(v, keys); } catch { return fail("E_ADK_LOOP_CONFIG"); }
}
function snapshot(v: unknown, bytes: number, code: ToolLoopErrorCode = "E_ADK_LOOP_RESULT"): Record<string, any> {
  try { return jsonObject(v, bytes) as Record<string, any>; } catch { return fail(code); }
}
function string(v: unknown, max = 200): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) return fail("E_ADK_LOOP_CONFIG"); return v;
}
function bound(v: unknown, max: number): number {
  if (!Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > max) return fail("E_ADK_LOOP_CONFIG"); return v as number;
}
function argumentsFor(args: Record<string, unknown>, schema: ToolInputSchema): void {
  if (Object.keys(args).some(k => !Object.hasOwn(schema.properties, k)) || schema.required.some(k => !Object.hasOwn(args, k))) fail("E_ADK_LOOP_RESULT");
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties[k];
    if (typeof v !== "string" || v.length < p.minLength || v.length > p.maxLength) fail("E_ADK_LOOP_RESULT");
  }
}
type DispatchEntry = Readonly<{ _kind: "read"; _tool: Readonly<XAIToolDefinition> }> |
  Readonly<{ _kind: "action"; _tool: Readonly<XAIToolDefinition> }>;
type DispatchCatalog = readonly DispatchEntry[];
type CatalogStamp = Readonly<{ _name: string; _kind: DispatchEntry["_kind"] }>;
type PreparedCall = { call: XAIToolCall; entry: DispatchEntry };
function dispatchCatalog(entries: DispatchEntry[]): DispatchCatalog {
  if (entries.length > 32 || new Set(entries.map(e => e._tool._name)).size !== entries.length) return fail("E_ADK_LOOP_CONFIG");
  return frozen(entries);
}
type PendingAction = { _name: string; _arguments: Record<string, string>; _delivery_id: string };
type Receipt = { _format: "adk-tool-loop/1" | "adk-tool-loop/2"; _catalog?: readonly CatalogStamp[]; _binding: string; _result: ToolLoopResult; _actions: PendingAction[]; _reads: { _id: string; _name: string; _arguments: Record<string, unknown> }[] };
const CHANNEL = "adk-model-tool-loop";

/** Opt-in local orchestration, not another Agent/XNode runtime or public ingress. */
export function createRouterToolLoop<const R extends Reads, const H extends DurableActions<Actions>>(options: RouterToolLoopOptions<R, H>): RouterToolLoop {
  const v = obj(options, ["_model", "_reads", "_actions", "_action_ids", "_system", "_policy", "_limits"]);
  const host = actionHost(v._actions as object);
  const readHost = readRegistryHost(v._reads as object);
  if (!host || !readHost || v._policy !== undefined && typeof v._policy !== "function") return fail("E_ADK_LOOP_CONFIG");
  const m = obj(v._model, ["_type", "_endpoint", "_model", "_credential", "_timeout_ms", "_error_policy", "_allow_requests"]);
  if (m._type !== "xai-router") return fail("E_ADK_LOOP_CONFIG");
  const { _type: ignored, ...rawModel } = m;
  const model = routerTextModel(rawModel as Omit<RouterTextModel, "_type">);
  const b = obj(v._limits, ["_max_rounds", "_max_calls", "_max_calls_per_round", "_max_transcript_bytes", "_max_output_tokens", "_max_total_tokens", "_timeout_ms"]);
  const limits: ToolLoopLimits = Object.freeze({ _max_rounds: bound(b._max_rounds, 8), _max_calls: bound(b._max_calls, 16),
    _max_calls_per_round: bound(b._max_calls_per_round, 8), _max_transcript_bytes: bound(b._max_transcript_bytes, 32768),
    _max_output_tokens: bound(b._max_output_tokens, 2048), _max_total_tokens: bound(b._max_total_tokens, 262144), _timeout_ms: bound(b._timeout_ms, 120000) });
  const ids = snapshot({ ids: v._action_ids }, 4096, "E_ADK_LOOP_CONFIG").ids;
  if (!Array.isArray(ids) || ids.length > 16 || new Set(ids).size !== ids.length) return fail("E_ADK_LOOP_CONFIG");
  const definitions = ids.map(id => { const d = host._definitions.find(x => x._id === id); if (!d) return fail("E_ADK_LOOP_CONFIG"); return d; });
  // Namespace ambiguity is a configuration error even if either policy hides it.
  if (definitions.some(d => readHost._tool_ids.includes(d._id))) return fail("E_ADK_LOOP_CONFIG");
  const system = string(v._system, 4096), policy = v._policy as ToolLoopPolicy | undefined;
  const reads = options._reads, actions = options._actions;
  const connection = new RouterModel(model, { _name: host._name, _conversations: host });
  const repo = new ConversationRepository({ _application_scope: host._application_scope });
  const conversations = new ConversationService({ _repository: repo });
  const configHash = hash(JSON.stringify(["adk-tool-loop/1", host._name, host._instance_id, host._application_scope, model, system, limits, definitions]));
  const contexts = new WeakMap<object, { read: TrustedToolContext; key: string }>();
  let contextCount = 0, state: "created" | "starting" | "ready" | "closed" = "created";
  let busy: { controller: AbortController; actual: Promise<ToolLoopResult> } | undefined;
  let startWork: Promise<void> | undefined;
  const ready = () => { if (state === "closed") fail("E_ADK_LOOP_CLOSED"); if (state !== "ready") fail("E_ADK_LOOP_NOT_READY"); host.check(); };
  const api: RouterToolLoop = {
    async start() {
      if (state === "closed") return fail("E_ADK_LOOP_CLOSED");
      if (state === "ready") { host.check(); return; }
      if (startWork) return startWork;
      host.check(); state = "starting";
      startWork = (async () => { try { await connection.prepare(); await connection.start(); if ((state as string) === "closed") fail("E_ADK_LOOP_CLOSED"); state = "ready"; }
        catch (e) { state = "closed"; await connection.close(); throw safe(e); } })();
      return startWork;
    },
    bindContext(input) {
      ready(); if (contextCount >= 64) return fail("E_ADK_LOOP_LIMIT");
      const d = obj(input, ["_actor_id", "_conversation_id", "_delivery_id"]);
      const ctx = frozen({ _actor_id: string(d._actor_id), _conversation_id: string(d._conversation_id), _delivery_id: string(d._delivery_id) }) as TrustedToolLoopContext;
      const read = reads.bindContext({ ...ctx, _instance_id: host._instance_id, _application_scope: host._application_scope });
      contexts.set(ctx, { read, key: hash(JSON.stringify([host._instance_id, host._application_scope, ctx])) }); contextCount++;
      return ctx;
    },
    run(input, ctx, signal) {
      ready(); const ref = ctx && contexts.get(ctx); if (!ref) return fail("E_ADK_LOOP_DENIED");
      if (busy) return fail("E_ADK_LOOP_BUSY");
      if (signal !== undefined && !(signal instanceof AbortSignal)) return fail("E_ADK_LOOP_CONFIG");
      const q = snapshot(input, limits._max_transcript_bytes, "E_ADK_LOOP_CONFIG");
      if (Object.keys(q).join() !== "_text") return fail("E_ADK_LOOP_CONFIG");
      const text = string(q._text, limits._max_transcript_bytes);
      const controller = new AbortController(), deadline = performance.now() + limits._timeout_ms;
      let reason: ToolLoopErrorCode | undefined, reject!: (e: ModelToolLoopError) => void;
      const stopped = new Promise<never>((_, no) => { reject = no; });
      const stop = (code: ToolLoopErrorCode) => { if (!reason) { reason = code; controller.abort(); reject(new ModelToolLoopError(code)); } };
      const check = () => { if (state === "closed") stop("E_ADK_LOOP_CLOSED"); if (performance.now() >= deadline) stop("E_ADK_LOOP_TIMEOUT"); if (reason) fail(reason); host.check(); };
      const cancel = () => stop("E_ADK_LOOP_CANCELLED");
      const timer = setTimeout(() => stop("E_ADK_LOOP_TIMEOUT"), limits._timeout_ms);
      signal?.addEventListener("abort", cancel, { once: true });
      const authorize = async (phase: Parameters<ToolLoopPolicy>[0]["_phase"], id?: string) => {
        check(); let allow = false;
        try { allow = await policy?.(Object.freeze({ _phase: phase, _context: ctx, _signal: controller.signal, ...(id ? { _action_id: id } : {}) })) === true; }
        catch { check(); return fail("E_ADK_LOOP_DENIED"); }
        check(); return allow;
      };
      const projectCatalog = async (provenance?: readonly CatalogStamp[]): Promise<DispatchCatalog> => {
        const projected = await reads.project(ref.read); check();
        const entries: DispatchEntry[] = projected.map(tool => ({ _kind: "read", _tool: tool }));
        for (const d of definitions) {
          // Replay uses recorded authorized exposure, then current T2 prepare policy.
          // Discovery alone remains distinct from application replay authorization.
          const exposed = provenance ? provenance.some(e => e._name === d._id && e._kind === "action") : await authorize("expose-action", d._id);
          if (exposed) entries.push({ _kind: "action", _tool: { _name: d._id,
            _description: `Prepare only; application confirmation required. ${d._description}`, _input_schema: d._input_schema } });
        }
        check(); return dispatchCatalog(entries);
      };
      const actual = Promise.resolve().then(async (): Promise<ToolLoopResult> => {
        let turn: InboundConversationTurn | undefined;
        try {
          if (signal?.aborted) cancel(); check();
          if (!await authorize("run")) return fail("E_ADK_LOOP_DENIED");
          const binding = hash(JSON.stringify([configHash, text]));
          const prepared = await conversations.prepareInbound({ _channel_id: CHANNEL, _external_user_id: ctx._actor_id,
            _external_conversation_id: hash(JSON.stringify([ctx._actor_id, ctx._conversation_id])), _external_message_id: ctx._delivery_id, _text: binding });
          check();
          const receiptKey = `adk-tool-loop-result:${prepared._turn._inbound_message_id}`;
          if (prepared._handled) {
            if (!await authorize("replay")) return fail("E_ADK_LOOP_DENIED");
            const inbound = await repo.getRecoveryMessage(prepared._turn._inbound_message_id);
            const stored = await repo.findMessageByDedupeKey(receiptKey);
            if (inbound?._delivery_state !== "processed" || !stored || stored._delivery_state !== "processed") return fail("E_ADK_LOOP_UNCERTAIN");
            let receipt: Receipt;
            try { receipt = snapshot(JSON.parse(stored._text), 65536) as Receipt; } catch { return fail("E_ADK_LOOP_STORAGE"); }
            if (!["adk-tool-loop/1", "adk-tool-loop/2"].includes(receipt._format) || receipt._binding !== binding) return fail("E_ADK_LOOP_CONFLICT");
            if (!Array.isArray(receipt._reads) || !Array.isArray(receipt._actions) ||
                receipt._reads.length + receipt._actions.length > limits._max_calls) return fail("E_ADK_LOOP_UNCERTAIN");
            // V1 cannot prove Action classification, even if a colliding Read was
            // later removed. Never prepare or disclose such historical receipts.
            if (receipt._format === "adk-tool-loop/1" && receipt._actions.length) return fail("E_ADK_LOOP_UNCERTAIN");
            const stamps = receipt._format === "adk-tool-loop/2" ? receipt._catalog : [];
            if (!Array.isArray(stamps) || stamps.length > 32 || stamps.some(e => !e || typeof e !== "object" ||
                Object.keys(e).sort().join() !== "_kind,_name" || typeof e._name !== "string" || !["read", "action"].includes(e._kind)) ||
                new Set(stamps.map(e => e._name)).size !== stamps.length) return fail("E_ADK_LOOP_UNCERTAIN");
            if (!["completed", "requires_confirmation"].includes(receipt._result?._status) ||
                (receipt._result._status === "requires_confirmation") !== (receipt._actions.length > 0)) return fail("E_ADK_LOOP_UNCERTAIN");
            const catalog = await projectCatalog(stamps);
            const retainedEntry = (call: { _name: string }, kind: DispatchEntry["_kind"]): DispatchEntry => {
              const entry = catalog.find(e => e._tool._name === call?._name);
              if (receipt._format === "adk-tool-loop/2" && !stamps.some(e => e._name === call?._name && e._kind === kind)) return fail("E_ADK_LOOP_UNCERTAIN");
              if (!entry && kind === "read" && readHost._tool_ids.includes(call?._name)) return fail("E_ADK_LOOP_DENIED");
              if (!entry || entry._kind !== kind) return fail("E_ADK_LOOP_UNCERTAIN");
              return entry;
            };
            // Validate all retained kinds before any invocation authorization or preparer.
            const retainedReads = receipt._reads.map(call => ({ call, entry: retainedEntry(call, "read") }));
            const retainedActions = receipt._actions.map(call => ({ call, entry: retainedEntry(call, "action") }));
            for (const { call } of retainedReads) { await readHost.reauthorize(call, ref.read); check(); }
            // Prepare replay reauthorizes and returns proposals only, never retained outcomes.
            const proposals: ActionProposal[] = [];
            for (const { call: a, entry } of retainedActions) { check(); proposals.push(await actions.prepare({ _capability_id: entry._tool._name, _arguments: a._arguments } as never, actions.bindContext({ ...ctx, _delivery_id: a._delivery_id }))); }
            check(); return frozen(receipt._result._status === "requires_confirmation" ? { ...receipt._result, _proposals: proposals } : receipt._result);
          }
          turn = prepared._turn;
          const catalog = await projectCatalog();
          const tools = Object.freeze(catalog.map(entry => entry._tool));
          const messages: XAIMessage[] = [{ _role: "user", _content: [{ _type: "text", _text: text }] }];
          const trace: ToolLoopTrace[] = [], pending: PendingAction[] = [], readCalls: Receipt["_reads"] = [];
          const seen = new Map<string, string>();
          let calls = 0, reserved = 0, used = 0;
          let result: ToolLoopResult | undefined;
          for (let round = 1; round <= limits._max_rounds; round++) {
            check(); const bytes = Buffer.byteLength(JSON.stringify([system, messages, tools]));
            if (bytes > limits._max_transcript_bytes || reserved + bytes + limits._max_output_tokens > limits._max_total_tokens) return fail("E_ADK_LOOP_LIMIT");
            reserved += bytes + limits._max_output_tokens;
            const operation = hash(JSON.stringify([configHash, ref.key, binding, round]));
            trace.push({ _round: round, _event: "dispatch", _operation_hash: operation });
            let response: Record<string, any>;
            try { response = await connection.round({ _messages: messages, _tools: tools, _tool_choice: tools.length ? "auto" : "none",
              system, max_tokens: limits._max_output_tokens, response_format: { type: "text" },
              _app_id: host._application_scope._app_id, _env: host._application_scope._env, _caller_module: host._name,
              _caller_op: "model-tool-loop", _purpose: "agent-tool-loop", _idempotency_key: operation }); }
            catch { check(); return fail("E_ADK_LOOP_MODEL"); }
            check();
            const r = snapshot({ _text: response._text, _finish_reason: response._finish_reason,
              _tool_calls: response._tool_calls ?? [], ...(response._usage === undefined ? {} : { _usage: response._usage }) }, limits._max_transcript_bytes);
            if (r._usage !== undefined) {
              const u = r._usage;
              if (![u.input_tokens, u.output_tokens, u.total_tokens].every(n => Number.isSafeInteger(n) && n >= 0) || u.total_tokens < u.input_tokens + u.output_tokens) return fail("E_ADK_LOOP_RESULT");
              used += u.total_tokens; reserved = Math.max(reserved, used);
              if (used > limits._max_total_tokens || u.output_tokens > limits._max_output_tokens) return fail("E_ADK_LOOP_LIMIT");
            }
            if (!Array.isArray(r._tool_calls) || r._tool_calls.length > limits._max_calls_per_round || typeof r._text !== "string") return fail("E_ADK_LOOP_RESULT");
            if (!r._tool_calls.length) {
              if (r._finish_reason !== "stop" || !r._text.trim() || hasPlanningEnvelope(r._text)) return fail("E_ADK_LOOP_RESULT");
              trace.push({ _round: round, _event: "complete", _operation_hash: operation });
              result = frozen({ _status: "completed", _text: r._text, _trace: trace }); break;
            }
            if (r._finish_reason !== "tool_calls") return fail("E_ADK_LOOP_RESULT");
            calls += r._tool_calls.length;
            if (calls > limits._max_calls) return fail("E_ADK_LOOP_LIMIT");
            // Validate the entire immutable batch before any callback, including mixed batches.
            const batch: PreparedCall[] = [], batchIds = new Set<string>();
            for (const raw of r._tool_calls) {
              const c = obj(raw, ["_id", "_name", "_arguments", "_continuation_ref"]);
              const id = string(c._id, 128), name = string(c._name, 100), entry = catalog.find(e => e._tool._name === name);
              if (!entry || batchIds.has(id)) return fail("E_ADK_LOOP_RESULT"); batchIds.add(id);
              const args = snapshot(c._arguments, 4096); argumentsFor(args, entry._tool._input_schema as ToolInputSchema);
              const binding = hash(JSON.stringify([name, args]));
              if (seen.has(id) && seen.get(id) !== binding) return fail("E_ADK_LOOP_CONFLICT");
              seen.set(id, binding);
              batch.push({ call: { _id: id, _name: name, _arguments: args,
                ...(c._continuation_ref === undefined ? {} : { _continuation_ref: string(c._continuation_ref, 512) }) }, entry });
            }
            messages.push({ _role: "assistant", _content: r._text ? [{ _type: "text", _text: r._text }] : [], _tool_calls: batch.map(x => x.call) });
            const proposals: ActionProposal[] = [];
            for (const { call, entry } of batch) {
              check(); const localId = hash(JSON.stringify([ref.key, call._id]));
              if (entry._kind === "action") {
                const a = { _name: entry._tool._name, _arguments: call._arguments as Record<string, string>, _delivery_id: localId };
                const proposal = await actions.prepare({ _capability_id: a._name, _arguments: a._arguments } as never, actions.bindContext({ ...ctx, _delivery_id: localId }));
                check(); pending.push(a); proposals.push(proposal);
                trace.push({ _round: round, _event: "proposal", _operation_hash: operation, _tool_id: call._name, _call_hash: hash(call._id) });
              } else {
                let output: unknown;
                try { output = await reads.invoke({ _id: localId, _name: entry._tool._name, _arguments: call._arguments } as never, ref.read); }
                catch (e) { check(); const error = safe(e); if (error._code === "E_ADK_LOOP_DENIED") throw error; return fail("E_ADK_LOOP_TOOL"); }
                check(); readCalls.push({ _id: localId, _name: call._name, _arguments: call._arguments });
                const content = JSON.stringify(snapshot(output, 8192));
                messages.push({ _role: "tool", _tool_call_id: call._id, _content: [{ _type: "text", _text: content }] });
                trace.push({ _round: round, _event: "read", _operation_hash: operation, _tool_id: call._name, _call_hash: hash(call._id) });
              }
            }
            if (proposals.length) { result = frozen({ _status: "requires_confirmation", _proposals: proposals, _trace: trace }); break; }
          }
          if (!result) return fail("E_ADK_LOOP_LIMIT");
          check(); const receipt = snapshot({ _format: "adk-tool-loop/2", _catalog: catalog.map(e => ({ _name: e._tool._name, _kind: e._kind })), _binding: binding, _result: result, _actions: pending, _reads: readCalls }, 65536);
          await repo.addMessage({ _id: deterministicId("adk-tool-loop-result", receiptKey), _conversation_id: turn._conversation_id,
            _direction: "outbound", _text: JSON.stringify(receipt), _occurred_at: new Date(), _dedupe_key: receiptKey,
            _origin_inbound_message_id: turn._inbound_message_id, _channel_id: CHANNEL, _delivery_state: "processed" });
          check(); await conversations.completeInbound(turn, { _status: "processed" }); check(); return result;
        } catch (e) {
          if (turn) { try { await conversations.completeInbound(turn, { _status: "processing_failed", _error: { _code: safe(e)._code, _message: "Model tool loop stopped" } }); } catch { /* Reservation still prevents redispatch. */ } }
          throw safe(e);
        }
      });
      busy = { controller, actual };
      const clear = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); if (busy?.actual === actual) busy = undefined; };
      void actual.then(clear, clear);
      controller.signal.addEventListener("abort", () => { if (!reason) stop(state === "closed" ? "E_ADK_LOOP_CLOSED" : "E_ADK_LOOP_CANCELLED"); }, { once: true });
      return Promise.race([actual, stopped]);
    },
    async close() { state = "closed"; busy?.controller.abort(); await Promise.allSettled([...(startWork ? [startWork] : []), ...(busy ? [busy.actual] : [])]); await connection.close(); },
  };
  return Object.freeze(api);
}
