import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { _x, type XModule } from "@xpell/node";
import { composeFoundation, mockTextModel, mockChannel, type AgentFoundationOptions, type FoundationAdapter } from "./foundation.js";
import { defineTool, type ToolArguments, type ToolInputSchema, type ToolJsonObject } from "./tools.js";
import { createExternalActorContext } from "./starter/actor/ActorContext.js";
import type { PersistedInboundConversationTurn } from "./starter/conversation/ConversationService.js";
import { ConversationRepository, STARTER_APP_ID, STARTER_APP_ENV } from "./starter/persistence/ConversationRepository.js";
import { applicationScopeKey, createAgentApplicationScope, type AgentApplicationScope } from "./starter/persistence/AgentApplicationScope.js";
import { deterministicId } from "./starter/persistence/keys.js";
import { ActionRepository } from "./starter/actions/ActionRepository.js";
import { ActionService, actionBindingHash, StarterActionError, STARTER_ACTION_ERROR_CODES } from "./starter/actions/ActionService.js";
import type { AgentActionRecord, AgentActionState } from "./starter/actions/types.js";
import { validateCapabilityArguments, type AgentCapability, type AgentSideEffectOutcome } from "./starter/capabilities/AgentCapability.js";
import { DurableActionError, fail, data, text, integer, hash, frozen, jsonObject, safeFailure } from "./actions/validation.js";
import { registerActionHost } from "./actions/host.js";
export { DurableActionError } from "./actions/validation.js";

export type ActionContextInput = Readonly<{ _actor_id: string; _conversation_id: string; _delivery_id: string }>;
declare const actionContextBrand: unique symbol;
export type TrustedActionContext = ActionContextInput & Readonly<{
  _instance_id: string; _application_scope: AgentApplicationScope; [actionContextBrand]: true;
}>;
export type ActionOutcome = Readonly<{ _status: "succeeded"; _result: ToolJsonObject }> |
  Readonly<{ _status: "failed"; _failure_code: string; _result?: ToolJsonObject }>;
export type ActionExecution = Readonly<{ _action_id: string; _binding_hash: string; _idempotency_key: string;
  _arguments: ToolJsonObject; _authorized_scope: ToolJsonObject }>;
export type ActionEvidence = Readonly<{ _action_id: string; _binding_hash: string; _idempotency_key: string; _outcome: ActionOutcome }>;
export type DurableActionDefinition<S extends ToolInputSchema, Id extends string = string> = Readonly<{
  _id: Id; _description: string; _revision: string; _input_schema: S;
  _prepare_action(input: Readonly<{ _arguments: ToolArguments<S>; _context: TrustedActionContext; _signal: AbortSignal }>):
    Readonly<{ _arguments: ToolArguments<S>; _authorized_scope: ToolJsonObject; _confirmation_summary: string }> |
    Promise<Readonly<{ _arguments: ToolArguments<S>; _authorized_scope: ToolJsonObject; _confirmation_summary: string }>>;
  _handler(input: Omit<ActionExecution, "_arguments"> & Readonly<{ _arguments: ToolArguments<S>; _context: TrustedActionContext; _signal: AbortSignal }>): ActionOutcome | Promise<ActionOutcome>;
  /** Read committed evidence only; never retry/execute an effect. */
  _read_committed_outcome?(input: Omit<ActionExecution, "_arguments"> & Readonly<{ _arguments: ToolArguments<S>; _context: TrustedActionContext; _signal: AbortSignal }>): ActionEvidence | null | Promise<ActionEvidence | null>;
}>;
type AnyAction = Readonly<{ _id: string; _description: string; _revision: string; _input_schema: ToolInputSchema;
  _prepare_action: (...args: never[]) => unknown; _handler: (...args: never[]) => unknown;
  _read_committed_outcome?: (...args: never[]) => unknown }>;
export type ActionProposal = Readonly<{ _action_id: string; _capability_id: string; _revision: string;
  _binding_hash: string; _confirmation_summary: string; _expires_at: string }>;
export type ActionView = ActionProposal & Readonly<{ _state: AgentActionState; _uncertain: boolean;
  _result?: ToolJsonObject; _failure_code?: string }>;
export type ActionPolicy = (input: Readonly<{ _phase: "prepare" | "confirm" | "execute" | "cancel" | "inspect" | "reconcile";
  _capability_id: string; _context: TrustedActionContext; _arguments: ToolJsonObject; _authorized_scope?: ToolJsonObject; _signal: AbortSignal }>) => boolean | Promise<boolean>;
export type DurableActionsOptions<T extends readonly AnyAction[]> = Readonly<{
  _name: string; _instance_id: string; _application_scope: AgentApplicationScope;
  _host: AgentFoundationOptions["_host"]; _actions: T; _policy?: ActionPolicy;
  _limits: Readonly<{ _timeout_ms: number; _max_json_bytes: number }>;
  /** Trusted clock seam for deterministic fixture expiry; never caller-authored. */
  _now?: () => Date;
}>;
export type DurableActions<T extends readonly AnyAction[]> = Readonly<{
  start(): Promise<void>; close(): Promise<void>;
  bindContext(input: ActionContextInput): TrustedActionContext;
  prepare<N extends T[number]["_id"]>(input: Readonly<{ _capability_id: N;
    _arguments: ToolArguments<Extract<T[number], { _id: N }>["_input_schema"]> }>, context: TrustedActionContext): Promise<ActionProposal>;
  confirm(input: Readonly<{ _action_id: string; _binding_hash: string }>, context: TrustedActionContext): Promise<ActionView>;
  cancel(input: Readonly<{ _action_id: string; _binding_hash: string }>, context: TrustedActionContext): Promise<ActionView>;
  get(actionId: string, context: TrustedActionContext): Promise<ActionView>;
  reconcile(input: Readonly<{ _limit: number; _after_id?: string }>, context: TrustedActionContext): Promise<Readonly<{
    _completed: number; _uncertain: number; _confirmed: number; _scan_truncated: boolean; _next_after_id?: string }>>;
}>;
const ROOT = fileURLToPath(new URL("../../adk-action-system-xapps/", import.meta.url));
const ENTITIES = ["conversation_participant", "channel_identity", "conversation", "message", "agent_action"] as const;
const ASSETS = ["app.json", ...ENTITIES.map(id => `entities/${id}.json`)];
const MARKER = ".adk-actions.json";
type Operation = { controller: AbortController; deadline: number };

export function defineAction<const S extends ToolInputSchema, const Id extends string>(d: DurableActionDefinition<S, Id>): DurableActionDefinition<S, Id> {
  const v = data(d, ["_id", "_description", "_revision", "_input_schema", "_prepare_action", "_handler", "_read_committed_outcome"]);
  let read;
  try { read = defineTool({ _id: text(v._id, 100), _description: text(v._description, 1000), _input_schema: v._input_schema as S,
    _effect: "read", _confirmation: "none", _handler: () => ({}) }); } catch { return fail("E_ADK_ACTION_CONFIG"); }
  const revision = text(v._revision, 64);
  if (!/^[A-Za-z0-9._-]+$/.test(revision) || typeof v._prepare_action !== "function" || typeof v._handler !== "function" ||
    v._read_committed_outcome !== undefined && typeof v._read_committed_outcome !== "function") return fail("E_ADK_ACTION_CONFIG");
  return Object.freeze({ _id: read._id, _description: read._description, _input_schema: read._input_schema, _revision: revision,
    _prepare_action: v._prepare_action, _handler: v._handler,
    ...(v._read_committed_outcome ? { _read_committed_outcome: v._read_committed_outcome } : {}) }) as DurableActionDefinition<S, Id>;
}

function composeDurableActions<const T extends readonly AnyAction[]>(options: DurableActionsOptions<T>): DurableActions<T> {
  const v = data(options, ["_name", "_instance_id", "_application_scope", "_host", "_actions", "_policy", "_limits", "_now"]);
  const name = text(v._name), instance = text(v._instance_id), scope = createAgentApplicationScope(data(v._application_scope, ["_env", "_app_id"]) as AgentApplicationScope);
  const scopeKey = applicationScopeKey(scope);
  const limits = data(v._limits, ["_timeout_ms", "_max_json_bytes"]), timeout = integer(limits._timeout_ms, 5000), bytes = integer(limits._max_json_bytes, 8192);
  if (!Array.isArray(v._actions) || v._actions.length > 32 || v._policy !== undefined && typeof v._policy !== "function" || v._now !== undefined && typeof v._now !== "function") return fail("E_ADK_ACTION_CONFIG");
  const definitions = new Map<string, AnyAction>();
  for (const raw of v._actions) { const d = defineAction(raw); if (definitions.has(d._id)) return fail("E_ADK_ACTION_CONFIG"); definitions.set(d._id, d); }
  const policy = v._policy as ActionPolicy | undefined, clock = (v._now ?? (() => new Date())) as () => Date;
  const now = () => { const d = clock(); if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return fail("E_ADK_ACTION_CONFIG"); return new Date(d.getTime()); };
  const repository = new ActionRepository({ _application_scope: scope }), conversationRepository = new ConversationRepository({ _application_scope: scope });
  const service = new ActionService({ _repository: repository, _application_scope: scope, _now: now });
  let closing = false, confirms = 0, reconciling = false;
  const contexts = new WeakSet<object>(), operations = new Set<Operation>(), pending = new Set<Promise<unknown>>(), callbacks = new Set<Promise<unknown>>();
  // Only owned immutable snapshots are memoized, never a caller's mutable input.
  const argumentSnapshots = new WeakMap<object, AgentCapability["_input_schema"]>();
  function snapshotArguments(cap: Pick<AgentCapability, "_input_schema">, value: unknown): ToolJsonObject {
    if (value && typeof value === "object" && argumentSnapshots.get(value) === cap._input_schema) return value as ToolJsonObject;
    const snapshot = jsonObject(value, bytes, "E_ADK_ACTION_CONFIG");
    validateCapabilityArguments(cap as AgentCapability, snapshot);
    argumentSnapshots.set(snapshot, cap._input_schema); return snapshot;
  }
  function check(op?: Operation): void {
    if (closing) return fail("E_ADK_ACTION_CLOSED");
    if (op && (op.controller.signal.aborted || performance.now() >= op.deadline)) { op.controller.abort(); return fail("E_ADK_ACTION_TIMEOUT"); }
  }
  function context(ctx: TrustedActionContext): void { check(); if (!ctx || !contexts.has(ctx)) fail("E_ADK_ACTION_DENIED"); }
  async function callback<R>(op: Operation, fn: () => R | Promise<R>): Promise<R> {
    check(op); let timer: ReturnType<typeof setTimeout> | undefined, stop!: () => void;
    const aborted = new Promise<never>((_, no) => { stop = () => no(new DurableActionError(closing ? "E_ADK_ACTION_CLOSED" : "E_ADK_ACTION_TIMEOUT")); });
    op.controller.signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(() => op.controller.abort(), Math.max(1, op.deadline - performance.now()));
    const actual = Promise.resolve().then(fn); callbacks.add(actual);
    const clear = () => callbacks.delete(actual); void actual.then(clear, clear);
    try { const result = await Promise.race([actual, aborted]); check(op); return result; }
    finally { clearTimeout(timer); op.controller.signal.removeEventListener("abort", stop); }
  }
  async function authorize(phase: Parameters<ActionPolicy>[0]["_phase"], d: AnyAction, ctx: TrustedActionContext, op: Operation, args: unknown, authorized?: unknown): Promise<void> {
    check(op); if (!policy) return fail("E_ADK_ACTION_DENIED");
    let allowed = false;
    try { allowed = await callback(op, () => policy(Object.freeze({ _phase: phase, _capability_id: d._id, _context: ctx,
      _arguments: d._input_schema ? snapshotArguments(d, args) : jsonObject(args, bytes),
      ...(authorized === undefined ? {} : { _authorized_scope: jsonObject(authorized, bytes) }), _signal: op.controller.signal }))) === true; }
    catch (e) { if (e instanceof DurableActionError) throw e; return fail("E_ADK_ACTION_DENIED"); }
    if (!allowed) return fail("E_ADK_ACTION_DENIED");
  }
  const tuple = (ctx: TrustedActionContext) => JSON.stringify([instance, scopeKey, ctx._actor_id, ctx._conversation_id]);
  const actorId = (ctx: TrustedActionContext) => deterministicId("adk-action-actor", JSON.stringify([instance, scopeKey, ctx._actor_id]));
  const turn = (ctx: TrustedActionContext): PersistedInboundConversationTurn => frozen({ _application_scope_key: scopeKey,
    _participant_id: actorId(ctx), _conversation_id: deterministicId("adk-action-conversation", tuple(ctx)),
    _source_type: "channel" as const, _source_id: "actions-internal", _source_conversation_id: ctx._conversation_id,
    _inbound_message_id: deterministicId("adk-action-request", JSON.stringify([tuple(ctx), ctx._delivery_id])) });
  const actor = (ctx: TrustedActionContext) => createExternalActorContext({ _participant_id: actorId(ctx), _channel_identity_id: "adk-trusted-caller" });
  function verified(row: AgentActionRecord, ctx: TrustedActionContext): void {
    const t = turn(ctx);
    if (row._requester_participant_id !== t._participant_id || row._conversation_id !== t._conversation_id || row._application_scope_key !== scopeKey) return fail("E_ADK_ACTION_DENIED");
    const expected = actionBindingHash({ _id: row._id, _capability_id: row._capability_id, _capability_revision: row._capability_revision,
      _arguments: row._arguments, _authorized_scope: row._authorized_scope, _confirmation_summary: row._confirmation_summary,
      _requester_participant_id: row._requester_participant_id, _conversation_id: row._conversation_id, _request_message_id: row._request_message_id,
      _expires_at: new Date(row._expires_at).toISOString(), _application_scope_key: row._application_scope_key });
    if (expected !== row._binding_hash) return fail("E_ADK_ACTION_BINDING");
    if (["executing", "succeeded", "failed"].includes(row._state) && (row._confirmed_by_participant_id !== row._requester_participant_id ||
      !row._confirmation_message_id || !row._confirmed_at || !row._execution_started_at)) return fail("E_ADK_ACTION_BINDING");
  }
  async function row(id: string, ctx: TrustedActionContext): Promise<AgentActionRecord> {
    const r = await repository.get(text(id, 200)); if (!r) return fail("E_ADK_ACTION_NOT_FOUND"); verified(r, ctx); return r;
  }
  function outcome(value: unknown): AgentSideEffectOutcome {
    const out = data(value, ["_status", "_result", "_failure_code"], "E_ADK_ACTION_RESULT");
    if (out._status !== "succeeded" && out._status !== "failed") return fail("E_ADK_ACTION_RESULT");
    const result = jsonObject(out._result ?? {}, bytes);
    if (out._status === "succeeded") { if (out._failure_code !== undefined) return fail("E_ADK_ACTION_RESULT"); return { _status: "succeeded", _result: result }; }
    const code = text(out._failure_code, 80, "E_ADK_ACTION_RESULT"); if (!/^E_[A-Z0-9_]+$/.test(code)) return fail("E_ADK_ACTION_RESULT");
    return { _status: "failed", _failure_code: code, _result: result };
  }
  const execution = (r: AgentActionRecord): ActionExecution => frozen({ _action_id: r._id, _binding_hash: r._binding_hash,
    _idempotency_key: `agent-action:${r._id}`, _arguments: jsonObject(r._arguments, bytes), _authorized_scope: jsonObject(r._authorized_scope, bytes) });
  function capability(d: AnyAction, ctx: TrustedActionContext, op: Operation, phase: "prepare" | "confirm" = "confirm"): AgentCapability {
    return { _id: d._id, _description: d._description, _revision: d._revision, _input_schema: d._input_schema, _effect: "side_effect", _confirmation: "required",
      _prepare_action: async input => {
        check(op);
        const raw = data(await callback(op, () => (d._prepare_action as (x: unknown) => unknown)(Object.freeze({
          _arguments: snapshotArguments(d, input._arguments), _context: ctx, _signal: op.controller.signal }))),
          ["_arguments", "_authorized_scope", "_confirmation_summary"], "E_ADK_ACTION_RESULT");
        const prepared = { _arguments: snapshotArguments(d, raw._arguments), _authorized_scope: jsonObject({
          _caller_binding: hash(tuple(ctx)), _resource: jsonObject(raw._authorized_scope, bytes) }, bytes),
          _confirmation_summary: text(raw._confirmation_summary, 2000, "E_ADK_ACTION_RESULT") };
        try { await authorize(phase, d, ctx, op, prepared._arguments, prepared._authorized_scope); }
        catch (e) {
          // The generic service preserves XError authorization failures. Bridge
          // only this known denial; raw callback errors still stay private.
          if (e instanceof DurableActionError && e._code === "E_ADK_ACTION_DENIED")
            throw new StarterActionError(STARTER_ACTION_ERROR_CODES.NOT_ALLOWED, "Agent Action is not allowed in this context");
          throw e;
        }
        return frozen(prepared);
      },
      _handler: async input => {
        const stored = await row(input._action!._id, ctx); check(op);
        const raw = await callback(op, () => (d._handler as (x: unknown) => unknown)(Object.freeze({ ...execution(stored), _context: ctx, _signal: op.controller.signal })));
        return outcome(raw);
      },
    };
  }
  const proposal = (r: AgentActionRecord): ActionProposal => frozen({ _action_id: r._id, _capability_id: r._capability_id,
    _revision: r._capability_revision, _binding_hash: r._binding_hash, _confirmation_summary: r._confirmation_summary,
    _expires_at: new Date(r._expires_at).toISOString() });
  const view = (r: AgentActionRecord): ActionView => frozen({ _action_id: r._id, _capability_id: r._capability_id, _revision: r._capability_revision,
    _state: r._state, _binding_hash: r._binding_hash, _confirmation_summary: r._confirmation_summary, _expires_at: new Date(r._expires_at).toISOString(),
    _uncertain: r._state === "executing", ...(r._result ? { _result: jsonObject(r._result, bytes) } : {}),
    ...(r._failure_code ? { _failure_code: /^E_[A-Z0-9_]{1,80}$/.test(r._failure_code) ? r._failure_code : "E_ADK_ACTION_UNCERTAIN" } : {}) });
  async function request<R>(ctx: TrustedActionContext, fn: (op: Operation) => Promise<R>): Promise<R> {
    context(ctx); if (base.getStatus()._state !== "ready") return fail("E_ADK_ACTION_NOT_READY");
    if (operations.size >= 16 || callbacks.size >= 16) return fail("E_ADK_ACTION_BUSY");
    const op = { controller: new AbortController(), deadline: performance.now() + timeout }; operations.add(op);
    const work = (async () => { try { return await fn(op); } catch (e) { throw safeFailure(e); } finally { operations.delete(op); } })();
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  }
  const adapter: FoundationAdapter = {
    _entity_sqlite: { _require_full_durability: true }, _system_xapps_path: ROOT, _lifecycle: {},
    async prepareFolder(folder) {
      let digest = ""; for (const p of ASSETS) digest += hash(await readFile(join(ROOT, STARTER_APP_ID, p), "utf8"));
      const expected = JSON.stringify({ _profile: "adk-actions-sqlite/1", _instance_id: instance, _application_scope: scope,
        _agent_name: name, _schema_sha256: hash(digest), _durability: "wal-full" });
      try { await mkdir(folder, { mode: 0o700 }); await writeFile(join(folder, MARKER), expected + "\n", { flag: "wx", mode: 0o600 }); return; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      try {
        const dir = await lstat(folder), m = await lstat(join(folder, MARKER));
        if (!dir.isDirectory() || dir.isSymbolicLink() || !m.isFile() || m.isSymbolicLink() || m.size > 65536 ||
          JSON.stringify(JSON.parse(await readFile(join(folder, MARKER), "utf8"))) !== expected) throw Error();
      } catch { return fail("E_ADK_ACTION_PROFILE"); }
    },
    async afterStart() {
      const ids: readonly string[] = await conversationRepository.listEntityIds();
      if (ids.length !== ENTITIES.length || ENTITIES.some(id => !ids.includes(id))) return fail("E_ADK_ACTION_STORAGE");
      for (const id of ENTITIES) if (await (id === "agent_action" ? repository.storageProvider() : conversationRepository.storageProvider(id)) !== "sqlite") return fail("E_ADK_ACTION_STORAGE");
      const diagnostic = await repository.storageDiagnostic(), pragmas = diagnostic._sqlite_pragmas;
      if (pragmas?._journal_mode !== "wal" || pragmas?._synchronous !== 2 || pragmas?._foreign_keys !== 1) return fail("E_ADK_ACTION_STORAGE");
    },
    async beforeModel() { return fail("E_ADK_ACTION_DENIED"); }, async replay() { return fail("E_ADK_ACTION_DENIED"); }, async turn() { return fail("E_ADK_ACTION_DENIED"); },
    async close(ownsGraph) {
      closing = true; for (const op of operations) op.controller.abort();
      await Promise.allSettled([...pending]); await Promise.allSettled([...callbacks]);
      if (!ownsGraph) return;
      let manager: XModule | undefined; try { manager = _x.getModule("entity-manager"); } catch { return; }
      if (!manager) return;
      const failures = [];
      for (const id of ENTITIES) {
        try {
          const cmd = { _module: "entity-manager", _op: "unregister", _params: { _app_id: STARTER_APP_ID, _env: STARTER_APP_ENV, _entity_id: id } };
          const r = await (_x.isRunning() ? _x.execute(cmd) : manager.execute(cmd)); if (!r?._ok) failures.push(id);
        } catch { failures.push(id); }
      }
      if (failures.length) return fail("E_ADK_ACTION_STORAGE");
    },
  };
  const base = composeFoundation({ _name: name, _model: mockTextModel({ _text: "Action-only profile" }),
    _channel: mockChannel({ _id: "actions-internal" }), _host: options._host }, adapter);
  const getDefinition = (id: string): AnyAction => { const d = definitions.get(id); if (!d) return fail("E_ADK_ACTION_UNAVAILABLE"); return d; };
  async function control(raw: unknown, ctx: TrustedActionContext, kind: "confirm" | "cancel", op: Operation): Promise<ActionView> {
    const input = data(raw, ["_action_id", "_binding_hash"]), stored = await row(text(input._action_id), ctx), d = getDefinition(stored._capability_id);
    if (input._binding_hash !== stored._binding_hash || turn(ctx)._inbound_message_id === stored._request_message_id) return fail("E_ADK_ACTION_BINDING");
    await authorize(kind, d, ctx, op, stored._arguments, stored._authorized_scope);
    if (kind === "cancel") await service.cancel({ _action_id: stored._id, _actor: actor(ctx), _conversation: turn(ctx) });
    else {
      if (reconciling) return fail("E_ADK_ACTION_BUSY");
      confirms++;
      try { await service.confirmAndExecute({ _action_id: stored._id, _actor: actor(ctx), _conversation: turn(ctx), _capabilities: [capability(d, ctx, op)],
        _reauthorize: async (_, phase) => {
          const current = await row(stored._id, ctx);
          await authorize(phase, d, ctx, op, current._arguments, current._authorized_scope);
          if (phase === "execute" && new Date(current._expires_at).getTime() <= now().getTime()) return fail("E_ADK_ACTION_EXPIRED");
          return [capability(d, ctx, op)];
        } }); }
      finally { confirms--; }
    }
    return view(await row(stored._id, ctx));
  }
  const api = {
    async start() { try { await base.start(); } catch (e) { throw safeFailure(e); } },
    async close() { try { await base.close(); } catch (e) { throw safeFailure(e); } },
    bindContext(input: ActionContextInput): TrustedActionContext {
      check(); if (base.getStatus()._state !== "ready") return fail("E_ADK_ACTION_NOT_READY");
      const x = data(input, ["_actor_id", "_conversation_id", "_delivery_id"]);
      const ctx = frozen({ _actor_id: text(x._actor_id), _conversation_id: text(x._conversation_id), _delivery_id: text(x._delivery_id), _instance_id: instance, _application_scope: scope }) as TrustedActionContext;
      contexts.add(ctx); return ctx;
    },
    prepare(input: { _capability_id: string; _arguments: unknown }, ctx: TrustedActionContext) {
      return request(ctx, async op => {
        const x = data(input, ["_capability_id", "_arguments"]), d = getDefinition(text(x._capability_id));
        const cap = capability(d, ctx, op, "prepare"), args = snapshotArguments(d, x._arguments);
        await authorize("prepare", d, ctx, op, args);
        const result = await service.createPendingAction({ _capability: cap, _arguments: args, _actor: actor(ctx), _conversation: turn(ctx) });
        verified(result, ctx); return proposal(result);
      });
    },
    confirm(input: { _action_id: string; _binding_hash: string }, ctx: TrustedActionContext) { return request(ctx, op => control(input, ctx, "confirm", op)); },
    cancel(input: { _action_id: string; _binding_hash: string }, ctx: TrustedActionContext) { return request(ctx, op => control(input, ctx, "cancel", op)); },
    get(id: string, ctx: TrustedActionContext) { return request(ctx, async op => { const r = await row(id, ctx); await authorize("inspect", getDefinition(r._capability_id), ctx, op, r._arguments, r._authorized_scope); return view(r); }); },
    reconcile(input: { _limit: number; _after_id?: string }, ctx: TrustedActionContext) {
      return request(ctx, async op => {
        const x = data(input, ["_limit", "_after_id"]), limit = integer(x._limit, 100), after = x._after_id === undefined ? undefined : text(x._after_id);
        if (reconciling || confirms || callbacks.size) return fail("E_ADK_ACTION_BUSY");
        // No scan is permitted without an explicit actor-scoped policy grant.
        await authorize("reconcile", { _id: "actions.reconcile" } as AnyAction, ctx, op, {});
        if (reconciling || confirms || callbacks.size) return fail("E_ADK_ACTION_BUSY"); reconciling = true;
        try { return await service.reconcileUnfinished({ _requester_participant_id: actorId(ctx), _conversation_id: turn(ctx)._conversation_id, _limit: limit, _after_id: after,
          _read_committed_outcome: async r => {
            verified(r, ctx); const d = getDefinition(r._capability_id);
            if (d._revision !== r._capability_revision) return fail("E_ADK_ACTION_UNAVAILABLE");
            await authorize("reconcile", d, ctx, op, r._arguments, r._authorized_scope);
            if (!d._read_committed_outcome) return null;
            const e = await callback(op, () => (d._read_committed_outcome as (x: unknown) => unknown)(Object.freeze({ ...execution(r), _context: ctx, _signal: op.controller.signal })));
            if (e === null) return null;
            const v = data(e, ["_action_id", "_binding_hash", "_idempotency_key", "_outcome"], "E_ADK_ACTION_EVIDENCE");
            if (v._action_id !== r._id || v._binding_hash !== r._binding_hash || v._idempotency_key !== `agent-action:${r._id}`) return fail("E_ADK_ACTION_EVIDENCE");
            return outcome(v._outcome);
          } }); }
        finally { reconciling = false; }
      });
    },
  };
  registerActionHost(api, Object.freeze({ _name: name, _instance_id: instance, _application_scope: scope,
    _definitions: Object.freeze([...definitions.values()].map(d => Object.freeze({ _id: d._id, _description: d._description, _revision: d._revision, _input_schema: d._input_schema }))),
    check() { check(); if (base.getStatus()._state !== "ready") return fail("E_ADK_ACTION_NOT_READY"); } }));
  return Object.freeze(api) as DurableActions<T>;
}

export function createDurableActions<const T extends readonly AnyAction[]>(options: DurableActionsOptions<T>): DurableActions<T> {
  try { return composeDurableActions(options); } catch (e) { throw safeFailure(e); }
}
