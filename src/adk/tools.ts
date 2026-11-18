import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { XAIToolDefinition } from "@xpell/node";

export type ToolJson = null | boolean | number | string | readonly ToolJson[] | ToolJsonObject;
export type ToolJsonObject = { readonly [key: string]: ToolJson };
export type ToolInputSchema = Readonly<{
  type: "object";
  additionalProperties: false;
  properties: Readonly<Record<string, Readonly<{
    type: "string"; minLength: number; maxLength: number; description?: string;
  }>>>;
  required: readonly string[];
}>;
export type ToolArguments<S extends ToolInputSchema> = Readonly<
  { [K in Extract<S["required"][number], keyof S["properties"]>]: string } &
  { [K in Exclude<keyof S["properties"], S["required"][number]>]?: string }
>;
export type ToolContextData = Readonly<{
  _instance_id: string;
  _application_scope: Readonly<{ _env: string; _app_id: string }>;
  _actor_id: string;
  _conversation_id: string;
  _delivery_id: string;
}>;
declare const contextBrand: unique symbol;
/** Minted by this registry's trusted application caller; not authentication. */
export type TrustedToolContext = ToolContextData & { readonly [contextBrand]: true };
export type ToolPolicyDecision = Readonly<{ _allow: false }> | Readonly<{
  _allow: true; _policy_revision: string; _authorized_scope: ToolContextData;
}>;
export type ToolPolicy = (input: Readonly<{
  _phase: "expose" | "invoke";
  _tool_id: string;
  _context: TrustedToolContext;
  _arguments?: Readonly<Record<string, string>>;
  _signal: AbortSignal;
}>) => ToolPolicyDecision | Promise<ToolPolicyDecision>;
export type ReadToolDefinition<S extends ToolInputSchema, R extends ToolJsonObject, Id extends string = string> = Readonly<{
  _id: Id; _description: string; _input_schema: S;
  _effect: "read"; _confirmation: "none";
  _handler: (input: Readonly<{
    _arguments: ToolArguments<S>; _context: TrustedToolContext; _signal: AbortSignal;
  }>) => R | Promise<R>;
}>;
type AnyTool = Readonly<{
  _id: string; _description: string; _input_schema: ToolInputSchema;
  _effect: "read"; _confirmation: "none";
  _handler: (...args: never[]) => ToolJsonObject | Promise<ToolJsonObject>;
}>;
type Names<T extends readonly AnyTool[]> = T[number]["_id"];
type Selected<T extends readonly AnyTool[], N extends Names<T>> = Extract<T[number], { _id: N }>;
type Frozen<T> = T extends readonly (infer V)[] ? readonly Frozen<V>[] : T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
export type ToolLimits = Readonly<{
  _timeout_ms: number; _max_input_bytes: number; _max_output_bytes: number;
  _max_invocations: number; _max_contexts: number;
}>;
export type ToolErrorCode = "E_ADK_TOOL_CONFIG" | "E_ADK_TOOL_UNKNOWN" | "E_ADK_TOOL_DENIED" |
  "E_ADK_TOOL_ARGUMENTS" | "E_ADK_TOOL_RESULT" | "E_ADK_TOOL_HANDLER" | "E_ADK_TOOL_TIMEOUT" |
  "E_ADK_TOOL_LIMIT" | "E_ADK_TOOL_BUSY" | "E_ADK_TOOL_CONFLICT" | "E_ADK_TOOL_CAPACITY" | "E_ADK_TOOL_CLOSED";
export class ReadToolError extends Error {
  constructor(readonly _code: ToolErrorCode) {
    super("Read tool operation failed; inspect the safe error code");
    this.name = "ReadToolError";
  }
}
export type ToolAuditReceipt = Readonly<{
  _sequence: number; _operation_hash: string; _tool_id: string;
  _status: "pending" | "succeeded" | "failed";
  _policy_revision?: string; _result_sha256?: string; _error_code?: ToolErrorCode;
}>;
export type ToolRegistry<T extends readonly AnyTool[]> = Readonly<{
  bindContext(input: ToolContextData): TrustedToolContext;
  project(context: TrustedToolContext): Promise<readonly XAIToolDefinition[]>;
  invoke<N extends Names<T>>(call: Readonly<{
    _id: string; _name: N; _arguments: ToolArguments<Selected<T, N>["_input_schema"]>;
  }>, context: TrustedToolContext): Promise<Frozen<Awaited<ReturnType<Selected<T, N>["_handler"]>>>>;
  getAudit(): readonly ToolAuditReceipt[];
  /** Fences/aborts cooperatively; never claims to terminate arbitrary JS. */
  close(): void;
}>;
const fail = (code: ToolErrorCode): never => { throw new ReadToolError(code); };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function object(value: unknown, code: ToolErrorCode): Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(k => typeof k !== "string" || !descriptors[k]?.enumerable || !("value" in descriptors[k]))) return fail(code);
    return Object.fromEntries(Object.entries(descriptors).map(([k, d]) => [k, d.value]));
  } catch { return fail(code); }
}
function exact(value: unknown, keys: readonly string[], code: ToolErrorCode): Record<string, unknown> {
  const v = object(value, code);
  if (Object.keys(v).some(k => !keys.includes(k))) return fail(code);
  return v;
}
function array(value: unknown, max: number, code: ToolErrorCode): unknown[] {
  try {
    if (!Array.isArray(value)) return fail(code);
    const ds = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>, length = ds.length.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > max || Reflect.ownKeys(value).length !== length + 1) return fail(code);
    return Array.from({ length }, (_, i) => {
      if (!ds[i] || !("value" in ds[i]) || !ds[i].enumerable) return fail(code);
      return ds[i].value;
    });
  } catch { return fail(code); }
}
function text(v: unknown, max: number, code: ToolErrorCode): string {
  if (typeof v !== "string" || !v.trim() || v !== v.trim() || v.length > max) return fail(code);
  return v;
}
function integer(v: unknown, low: number, high: number): number {
  if (!Number.isSafeInteger(v) || Number(v) < low || Number(v) > high) return fail("E_ADK_TOOL_CONFIG");
  return v as number;
}
function freezeJson<T>(v: T): T {
  if (v && typeof v === "object") { Object.values(v).forEach(freezeJson); Object.freeze(v); }
  return v;
}
/** Bounded, canonical JSON; rejects accessors, cycles, holes and non-JSON values. */
function json(value: unknown, max: number, code: ToolErrorCode): string {
  let bytes = 0, nodes = 0;
  const seen = new Set<object>();
  const add = (s: string) => { bytes += Buffer.byteLength(s); if (bytes > max) fail(code); return s; };
  const string = (s: string) => { if (Buffer.byteLength(s) > max) fail(code); return add(JSON.stringify(s)); };
  const walk = (v: unknown, depth: number): string => {
    if (++nodes > 1024 || depth > 8) return fail(code);
    if (v === null || typeof v === "boolean") return add(JSON.stringify(v));
    if (typeof v === "string") return string(v);
    if (typeof v === "number" && Number.isFinite(v)) return add(JSON.stringify(v));
    if (!v || typeof v !== "object" || seen.has(v)) return fail(code);
    seen.add(v);
    let out: string;
    if (Array.isArray(v)) {
      if (v.length > 1024 || Reflect.ownKeys(v).length !== v.length + 1) return fail(code);
      const ds = Object.getOwnPropertyDescriptors(v);
      out = add("[") + Array.from({ length: v.length }, (_, i) => {
        if (!ds[i] || !("value" in ds[i])) return fail(code);
        return (i ? add(",") : "") + walk(ds[i].value, depth + 1);
      }).join("") + add("]");
    } else {
      const data = object(v, code), keys = Object.keys(data).sort();
      out = add("{") + keys.map((k, i) => (i ? add(",") : "") + string(k) + add(":") + walk(data[k], depth + 1)).join("") + add("}");
    }
    seen.delete(v); return out;
  };
  try { return walk(value, 0); } catch { return fail(code); }
}
function schema(value: unknown): ToolInputSchema {
  const c: ToolErrorCode = "E_ADK_TOOL_CONFIG", s = exact(value, ["type", "properties", "required", "additionalProperties"], c);
  const properties = object(s.properties, c);
  if (s.type !== "object" || s.additionalProperties !== false || Object.keys(properties).length > 16) return fail(c);
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(properties)) {
    if (!/^_?[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) return fail(c);
    const p = exact(raw, ["type", "minLength", "maxLength", "description"], c);
    if (p.type !== "string") return fail(c);
    const min = integer(p.minLength, 0, 1024), max = integer(p.maxLength, 1, 1024);
    if (min > max) return fail(c);
    result[key] = { type: "string", minLength: min, maxLength: max,
      ...(p.description === undefined ? {} : { description: text(p.description, 500, c) }) };
  }
  const required = array(s.required, 16, c);
  if (required.length > 16 || new Set(required).size !== required.length || required.some(k => typeof k !== "string" || !Object.hasOwn(properties, k))) return fail(c);
  return freezeJson({ type: "object", additionalProperties: false, properties: result, required: [...required] }) as ToolInputSchema;
}
/** New adapter using the Starter's closed-object/string validation pattern. */
export function defineTool<const S extends ToolInputSchema, R extends ToolJsonObject, const Id extends string>(
  definition: ReadToolDefinition<S, R, Id>,
): ReadToolDefinition<S, R, Id> {
  const c: ToolErrorCode = "E_ADK_TOOL_CONFIG";
  const v = exact(definition, ["_id", "_description", "_input_schema", "_effect", "_confirmation", "_handler"], c);
  const id = text(v._id, 100, c);
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(id) || v._effect !== "read" || v._confirmation !== "none" || typeof v._handler !== "function") return fail(c);
  return Object.freeze({ _id: id, _description: text(v._description, 1000, c), _input_schema: schema(v._input_schema),
    _effect: "read", _confirmation: "none", _handler: v._handler }) as ReadToolDefinition<S, R, Id>;
}
function contextData(value: unknown): ToolContextData {
  const c: ToolErrorCode = "E_ADK_TOOL_DENIED", v = exact(value, ["_instance_id", "_application_scope", "_actor_id", "_conversation_id", "_delivery_id"], c);
  const s = exact(v._application_scope, ["_env", "_app_id"], c);
  return freezeJson({ _instance_id: text(v._instance_id, 200, c), _application_scope: { _env: text(s._env, 200, c), _app_id: text(s._app_id, 200, c) },
    _actor_id: text(v._actor_id, 200, c), _conversation_id: text(v._conversation_id, 200, c), _delivery_id: text(v._delivery_id, 200, c) });
}
type Operation = { controller: AbortController; check(): void; stop(code: ToolErrorCode): void };
type Entry = { binding: string; audit: ToolAuditReceipt; result?: ToolJsonObject; error?: ToolErrorCode };
export function createToolRegistry<const T extends readonly AnyTool[]>(options: Readonly<{
  _tools: T; _policy?: ToolPolicy; _limits: ToolLimits;
}>): ToolRegistry<T> {
  const c: ToolErrorCode = "E_ADK_TOOL_CONFIG", v = exact(options, ["_tools", "_policy", "_limits"], c);
  const definitions = array(v._tools, 32, c);
  if (v._policy !== undefined && typeof v._policy !== "function") return fail(c);
  const limits = exact(v._limits, ["_timeout_ms", "_max_input_bytes", "_max_output_bytes", "_max_invocations", "_max_contexts"], c);
  const timeout = integer(limits._timeout_ms, 1, 5000), inputBytes = integer(limits._max_input_bytes, 2, 4096), outputBytes = integer(limits._max_output_bytes, 2, 8192);
  const capacity = integer(limits._max_invocations, 1, 256), contextCapacity = integer(limits._max_contexts, 1, 64);
  const tools = new Map<string, AnyTool>();
  for (const raw of definitions) {
    const tool = defineTool(raw as ReadToolDefinition<ToolInputSchema, ToolJsonObject>);
    if (tools.has(tool._id)) return fail(c);
    tools.set(tool._id, tool);
  }
  const policy = v._policy as ToolPolicy | undefined;
  let closed = false, busy: Operation | undefined;
  let references = new WeakMap<object, { key: string; exposed: Set<string> }>();
  const contexts = new Map<string, TrustedToolContext>(), entries = new Map<string, Entry>();
  const ready = () => { if (closed) fail("E_ADK_TOOL_CLOSED"); };
  const trusted = (ctx: TrustedToolContext) => {
    ready();
    const ref = ctx && typeof ctx === "object" ? references.get(ctx) : undefined;
    if (!ref) return fail("E_ADK_TOOL_DENIED");
    return ref;
  };
  function bounded<R>(work: (op: Operation) => Promise<R>): Promise<R> {
    ready(); if (busy) return fail("E_ADK_TOOL_BUSY");
    const controller = new AbortController(), deadline = performance.now() + timeout;
    let code: ToolErrorCode | undefined, reject!: (error: ReadToolError) => void;
    const stopped = new Promise<never>((_, no) => { reject = no; });
    const op: Operation = { controller,
      stop(reason) { if (!code) { code = reason; controller.abort(); reject(new ReadToolError(reason)); } },
      check() { if (closed) op.stop("E_ADK_TOOL_CLOSED"); if (performance.now() >= deadline) op.stop("E_ADK_TOOL_TIMEOUT"); if (code) fail(code); } };
    busy = op;
    const timer = setTimeout(() => op.stop("E_ADK_TOOL_TIMEOUT"), timeout);
    const actual = (async () => { op.check(); const value = await work(op); op.check(); return value; })();
    const release = () => { if (busy === op) busy = undefined; };
    void actual.then(release, release);
    // The deadline fences the caller, but ownership lasts until actual settles.
    return Promise.race([actual, stopped]).finally(() => clearTimeout(timer));
  }
  async function authorize(phase: "expose" | "invoke", tool: AnyTool, ctx: TrustedToolContext, op: Operation, args?: Readonly<Record<string, string>>): Promise<string | undefined> {
    if (!policy) return undefined;
    let raw: unknown;
    try { raw = await policy(Object.freeze({ _phase: phase, _tool_id: tool._id, _context: ctx, _signal: op.controller.signal,
      ...(args === undefined ? {} : { _arguments: args }) })); } catch { op.check(); return fail("E_ADK_TOOL_DENIED"); }
    op.check();
    const d = object(raw, "E_ADK_TOOL_DENIED");
    if (d._allow === false && Object.keys(d).length === 1) return undefined;
    if (d._allow !== true || Object.keys(d).sort().join() !== "_allow,_authorized_scope,_policy_revision" ||
      json(contextData(d._authorized_scope), 4096, "E_ADK_TOOL_DENIED") !== json(ctx, 4096, "E_ADK_TOOL_DENIED")) return fail("E_ADK_TOOL_DENIED");
    const revision = text(d._policy_revision, 64, "E_ADK_TOOL_DENIED");
    if (!/^[A-Za-z0-9._-]+$/.test(revision)) return fail("E_ADK_TOOL_DENIED");
    return revision;
  }
  const api = {
    bindContext(input: ToolContextData): TrustedToolContext {
      ready(); const data = contextData(input), key = hash(json(data, 4096, "E_ADK_TOOL_DENIED"));
      const prior = contexts.get(key); if (prior) return prior;
      if (contexts.size >= contextCapacity) return fail("E_ADK_TOOL_CAPACITY");
      const ctx = data as TrustedToolContext;
      contexts.set(key, ctx); references.set(ctx, { key, exposed: new Set() }); return ctx;
    },
    async project(ctx: TrustedToolContext): Promise<readonly XAIToolDefinition[]> {
      const ref = trusted(ctx);
      return bounded(async op => {
        ref.exposed.clear(); const allowed: XAIToolDefinition[] = [];
        for (const tool of tools.values()) {
          if (await authorize("expose", tool, ctx, op)) allowed.push(freezeJson({ _name: tool._id, _description: tool._description, _input_schema: tool._input_schema }));
        }
        op.check(); ref.exposed = new Set(allowed.map(t => t._name)); return Object.freeze(allowed);
      });
    },
    async invoke(call: unknown, ctx: TrustedToolContext): Promise<ToolJsonObject> {
      const ref = trusted(ctx), q = exact(call, ["_id", "_name", "_arguments"], "E_ADK_TOOL_ARGUMENTS");
      const id = text(q._id, 200, "E_ADK_TOOL_ARGUMENTS"), name = text(q._name, 100, "E_ADK_TOOL_UNKNOWN"), tool = tools.get(name);
      if (!tool) return fail("E_ADK_TOOL_UNKNOWN");
      if (!ref.exposed.has(name)) return fail("E_ADK_TOOL_DENIED");
      const args = object(q._arguments, "E_ADK_TOOL_ARGUMENTS"), s = tool._input_schema;
      if (Object.keys(args).some(k => !Object.hasOwn(s.properties, k)) || s.required.some(k => !Object.hasOwn(args, k))) return fail("E_ADK_TOOL_ARGUMENTS");
      for (const [k, value] of Object.entries(args)) {
        const p = s.properties[k];
        if (typeof value !== "string" || value.length < p.minLength || value.length > p.maxLength) return fail("E_ADK_TOOL_ARGUMENTS");
      }
      const serialized = json(args, inputBytes, "E_ADK_TOOL_LIMIT"), argumentsValue = Object.freeze(JSON.parse(serialized)) as Readonly<Record<string, string>>;
      const key = hash(JSON.stringify([ref.key, id])), binding = hash(JSON.stringify([name, serialized]));
      const old = entries.get(key);
      if (old && old.binding !== binding) return fail("E_ADK_TOOL_CONFLICT");
      if (busy || old?.audit._status === "pending") return fail("E_ADK_TOOL_BUSY");
      if (!old && entries.size >= capacity) return fail("E_ADK_TOOL_CAPACITY");
      const entry = old ?? { binding, audit: { _sequence: entries.size + 1, _operation_hash: key, _tool_id: name, _status: "pending" as const } };
      if (!old) entries.set(key, entry);
      try {
        const result = await bounded(async op => {
          const revision = await authorize("invoke", tool, ctx, op, argumentsValue);
          if (!revision) return fail("E_ADK_TOOL_DENIED");
          if (old) { if (old.error) return fail(old.error); return old.result!; }
          entry.audit = { ...entry.audit, _policy_revision: revision };
          op.check(); let raw: unknown;
          try { raw = await (tool._handler as (input: unknown) => unknown)(Object.freeze({ _arguments: argumentsValue, _context: ctx, _signal: op.controller.signal })); }
          catch { op.check(); return fail("E_ADK_TOOL_HANDLER"); }
          op.check(); object(raw, "E_ADK_TOOL_RESULT");
          return freezeJson(JSON.parse(json(raw, outputBytes, "E_ADK_TOOL_RESULT"))) as ToolJsonObject;
        });
        ready();
        if (!old) { entry.result = result; entry.audit = { ...entry.audit, _status: "succeeded", _result_sha256: hash(json(result, outputBytes, "E_ADK_TOOL_RESULT")) }; }
        return result;
      } catch (error) {
        const code = error instanceof ReadToolError ? error._code : "E_ADK_TOOL_HANDLER";
        if (!old) { entry.error = code; entry.audit = { ...entry.audit, _status: "failed", _error_code: code }; }
        return fail(code);
      }
    },
    getAudit(): readonly ToolAuditReceipt[] { return Object.freeze([...entries.values()].map(e => Object.freeze({ ...e.audit }))); },
    close(): void {
      if (closed) return; closed = true; busy?.stop("E_ADK_TOOL_CLOSED");
      contexts.clear(); references = new WeakMap(); for (const e of entries.values()) e.result = undefined;
    },
  };
  return Object.freeze(api) as ToolRegistry<T>;
}
