import { registerPluginActionPolicy } from "./plugins/host.js";
import { StarterActionError, STARTER_ACTION_ERROR_CODES } from "./starter/actions/ActionService.js";
import { types } from "node:util";
import { defineTool, ReadToolError, type ToolPolicy, type createToolRegistry } from "./tools.js";
import { defineAction, type ActionPolicy, type createDurableActions } from "./actions.js";
import { DurableActionError } from "./actions/validation.js";

type Read = Parameters<typeof createToolRegistry>[0]["_tools"][number];
type Action = Parameters<typeof createDurableActions>[0]["_actions"][number];
export type PluginPermissions = Readonly<{ _host: readonly string[]; _agent: readonly string[] }>;
export type AgentPluginContext = Readonly<{
  _id: string; _version: string; _permissions: PluginPermissions; _signal: AbortSignal;
}>;
export type AgentPlugin = Readonly<{
  _id: string; _version: string; _contract: 1;
  /** Exact stable versions, explicitly attested by the composing host. */
  _peers: Readonly<Record<string, string>>;
  /** Register dependencies first. No implicit installation or dependency sorting. */
  _dependencies: readonly Readonly<{ _id: string; _version: string }>[];
  _permissions: PluginPermissions;
  _tools?: readonly Read[]; _actions?: readonly Action[];
  start?(context: AgentPluginContext): void | Promise<void>;
  stop?(context: AgentPluginContext): void | Promise<void>;
  dispose?(context: AgentPluginContext): void | Promise<void>;
}>;
export type AgentPluginState = "registered" | "starting" | "ready" | "not_ready" | "stopping" | "stopped" | "disposed";
export type AgentPluginErrorCode = "E_ADK_PLUGIN_CONFIG" | "E_ADK_PLUGIN_DUPLICATE" | "E_ADK_PLUGIN_COMPATIBILITY" |
  "E_ADK_PLUGIN_DEPENDENCY" | "E_ADK_PLUGIN_DENIED" | "E_ADK_PLUGIN_STATE" | "E_ADK_PLUGIN_START" | "E_ADK_PLUGIN_CLEANUP";
export class AgentPluginError extends Error {
  constructor(readonly _code: AgentPluginErrorCode) {
    super("Agent plugin operation failed; inspect the safe error code"); this.name = "AgentPluginError"; Object.freeze(this);
  }
}
export type AgentPluginStatus = Readonly<{
  _id: string; _version: string; _state: AgentPluginState; _available: boolean; _error_code?: AgentPluginErrorCode;
}>;
export type AgentPluginContributions = Readonly<{ _tools: readonly Read[]; _actions: readonly Action[] }>;
export type AgentPluginRegistry = Readonly<{
  register(plugin: AgentPlugin): void;
  /** Trusted application grants only; never expose this method to a model or transport. */
  setGrants(id: string, grants: PluginPermissions): void;
  getContributions(): AgentPluginContributions;
  getStatus(): readonly AgentPluginStatus[];
  isAvailable(id: string): boolean;
  /** Required policy decorators preserve permission checks on T1/T2 replay. */
  readPolicy(policy?: ToolPolicy): ToolPolicy;
  actionPolicy(policy?: ActionPolicy): ActionPolicy;
  start(): Promise<void>; stop(): Promise<void>; dispose(): Promise<void>;
}>;
const registryDenials = new WeakSet<object>();
const fail = (code: AgentPluginErrorCode): never => {
  const error = new AgentPluginError(code);
  if (code === "E_ADK_PLUGIN_DENIED") registryDenials.add(error);
  throw error;
};
const registryDenied = (error: unknown): boolean => !!error && typeof error === "object" && registryDenials.has(error);
const owners = new WeakSet<object>();
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function data(v: unknown, keys?: readonly string[]): Record<string, unknown> {
  try {
    if (!v || typeof v !== "object" || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail("E_ADK_PLUGIN_CONFIG");
    const ds = Object.getOwnPropertyDescriptors(v);
    if (Reflect.ownKeys(ds).some(k => typeof k !== "string" || !ds[k].enumerable || !("value" in ds[k]) || keys && !keys.includes(k))) return fail("E_ADK_PLUGIN_CONFIG");
    return Object.fromEntries(Object.entries(ds).map(([k, d]) => [k, d.value]));
  } catch { return fail("E_ADK_PLUGIN_CONFIG"); }
}
function array(v: unknown, max = 32): unknown[] {
  if (!v || typeof v !== "object" || types.isProxy(v) || !Array.isArray(v)) return fail("E_ADK_PLUGIN_CONFIG");
  const ds = Object.getOwnPropertyDescriptors(v) as Record<string, PropertyDescriptor>, n = ds.length.value;
  if (!Number.isSafeInteger(n) || n < 0 || n > max || Reflect.ownKeys(ds).length !== n + 1) return fail("E_ADK_PLUGIN_CONFIG");
  return Array.from({ length: n }, (_, i) => { if (!ds[i]?.enumerable || !("value" in ds[i])) return fail("E_ADK_PLUGIN_CONFIG"); return ds[i].value; });
}
function string(v: unknown, pattern: RegExp, max = 100): string {
  if (typeof v !== "string" || v !== v.trim() || v.length > max || !pattern.test(v)) return fail("E_ADK_PLUGIN_CONFIG"); return v;
}
function permissions(v: unknown): PluginPermissions {
  const p = data(v, ["_host", "_agent"]);
  const list = (v: unknown) => {
    const a = array(v).map(x => string(x, /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/));
    if (new Set(a).size !== a.length) return fail("E_ADK_PLUGIN_CONFIG"); return Object.freeze(a);
  };
  return Object.freeze({ _host: list(p._host), _agent: list(p._agent) });
}
function peers(v: unknown): Readonly<Record<string, string>> {
  const p = data(v);
  if (Object.keys(p).length > 32) return fail("E_ADK_PLUGIN_CONFIG");
  return Object.freeze(Object.fromEntries(Object.entries(p).map(([k, v]) => [string(k, /^(?:@[a-z0-9-]+\/)?[a-z][a-z0-9.-]*$/), string(v, versionPattern, 40)])));
}
// Snapshot contribution metadata without executing accessors/proxy traps. Functions
// remain fixed trusted callbacks; T1/T2 validate their own schemas and contracts.
function contribution(value: unknown): unknown {
  let nodes = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (++nodes > 1024 || depth > 8) return fail("E_ADK_PLUGIN_CONFIG");
    if (v === null || ["string", "number", "boolean", "undefined", "function"].includes(typeof v)) return v;
    if (!v || typeof v !== "object" || types.isProxy(v)) return fail("E_ADK_PLUGIN_CONFIG");
    if (Array.isArray(v)) return array(v).map(x => walk(x, depth + 1));
    return Object.fromEntries(Object.entries(data(v)).map(([k, x]) => [k, walk(x, depth + 1)]));
  };
  return walk(value, 0);
}
/** Explicit static definition; no loading, installation, host or model activation. */
export function defineAgentPlugin<const P extends AgentPlugin>(input: P): Readonly<P> {
  const p = data(input, ["_id", "_version", "_contract", "_peers", "_dependencies", "_permissions", "_tools", "_actions", "start", "stop", "dispose"]);
  const id = string(p._id, idPattern), version = string(p._version, versionPattern, 40);
  if (p._contract !== 1) return fail("E_ADK_PLUGIN_COMPATIBILITY");
  const dependencies = array(p._dependencies).map(v => { const d = data(v, ["_id", "_version"]); return Object.freeze({ _id: string(d._id, idPattern), _version: string(d._version, versionPattern, 40) }); });
  if (dependencies.some(d => d._id === id) || new Set(dependencies.map(d => d._id)).size !== dependencies.length) return fail("E_ADK_PLUGIN_DEPENDENCY");
  const hooks: Record<string, unknown> = {};
  for (const key of ["start", "stop", "dispose"] as const) {
    if (p[key] !== undefined && typeof p[key] !== "function") return fail("E_ADK_PLUGIN_CONFIG");
    if (p[key] !== undefined) hooks[key] = p[key];
  }
  let reads: Read[], actions: Action[];
  try {
    reads = array(p._tools ?? []).map(v => defineTool(contribution(v) as Parameters<typeof defineTool>[0]));
    actions = array(p._actions ?? []).map(v => defineAction(contribution(v) as Parameters<typeof defineAction>[0]));
  } catch { return fail("E_ADK_PLUGIN_CONFIG"); }
  if (new Set([...reads, ...actions].map(d => d._id)).size !== reads.length + actions.length) return fail("E_ADK_PLUGIN_DUPLICATE");
  return Object.freeze({ _id: id, _version: version, _contract: 1, _peers: peers(p._peers), _dependencies: Object.freeze(dependencies),
    _permissions: permissions(p._permissions), _tools: Object.freeze(reads), _actions: Object.freeze(actions), ...hooks }) as unknown as Readonly<P>;
}
type Entry = {
  plugin: AgentPlugin; state: AgentPluginState; grants: PluginPermissions; controller: AbortController;
  error?: AgentPluginErrorCode; touched: boolean; disposed: boolean; pending: Set<Promise<unknown>>;
};
const empty = Object.freeze({ _host: Object.freeze([]), _agent: Object.freeze([]) });

/** Trusted in-process composition, NOT an isolation boundary or IAM implementation. */
export function createAgentPluginRegistry(options: Readonly<{ _peers: Readonly<Record<string, string>> }>): AgentPluginRegistry {
  const opts = data(options, ["_peers"]), hostPeers = peers(opts._peers);
  const entries = new Map<string, Entry>(), toolOwners = new Map<string, Entry>(), actionOwners = new Map<string, Entry>();
  let catalog: AgentPluginContributions = Object.freeze({ _tools: Object.freeze([]), _actions: Object.freeze([]) });
  let sealed = false, stopping = false, disposed = false, startupComplete = false, epoch = 0;
  const scanPolicies = new Set<Promise<unknown>>();
  let startup: Promise<void> | undefined, shutdown: Promise<void> | undefined, disposal: Promise<void> | undefined;
  const granted = (e: Entry) => (["_host", "_agent"] as const).every(k => e.plugin._permissions[k].every(p => e.grants[k].includes(p)));
  const available = (e: Entry): boolean => !stopping && !disposed && e.state === "ready" && granted(e) &&
    e.plugin._dependencies.every(d => { const dependency = entries.get(d._id); return !!dependency && available(dependency); });
  const ctx = (e: Entry): AgentPluginContext => Object.freeze({ _id: e.plugin._id, _version: e.plugin._version, _permissions: e.plugin._permissions, _signal: e.controller.signal });
  const requireReady = (e: Entry) => { if (!available(e)) fail("E_ADK_PLUGIN_DENIED"); };
  async function owned<T>(e: Entry, callback: () => T | Promise<T>): Promise<T> {
    requireReady(e); const authorizationEpoch = epoch;
    const check = () => { requireReady(e); if (epoch !== authorizationEpoch) fail("E_ADK_PLUGIN_DENIED"); };
    const work = Promise.resolve().then(() => { check(); return callback(); });
    e.pending.add(work);
    try { const result = await work; check(); return result; }
    finally { e.pending.delete(work); }
  }
  const scanAvailable = () => startupComplete && !stopping && !disposed && [...entries.values()].some(available);
  function beginReconciliation(): () => void {
    const authorizationEpoch = epoch;
    const check = () => {
      if (!scanAvailable() || epoch !== authorizationEpoch) throw new DurableActionError("E_ADK_ACTION_DENIED");
    };
    check(); return check;
  }
  async function scanPolicy(input: Parameters<ActionPolicy>[0], policy: ActionPolicy): Promise<boolean> {
    const check = beginReconciliation();
    const work = Promise.resolve().then(() => { check(); return policy(input); });
    scanPolicies.add(work);
    try { const result = await work; check(); return result; }
    finally { scanPolicies.delete(work); }
  }
  async function cleanup(e: Entry, terminal: boolean): Promise<void> {
    if (e.disposed) return;
    e.controller.abort();
    await Promise.allSettled([...e.pending]);
    if (e.touched) {
      // Never retry cleanup after an uncertain hook failure.
      e.touched = false;
      try { await e.plugin.stop?.(ctx(e)); } catch { e.error = "E_ADK_PLUGIN_CLEANUP"; }
    }
    if (terminal) {
      e.disposed = true;
      try { await e.plugin.dispose?.(ctx(e)); } catch { e.error = "E_ADK_PLUGIN_CLEANUP"; }
      e.state = "disposed";
    } else e.state = "stopped";
  }
  const api: AgentPluginRegistry = {
    register(input) {
      if (sealed || disposed) return fail("E_ADK_PLUGIN_STATE");
      if (entries.size >= 32) return fail("E_ADK_PLUGIN_CONFIG");
      const p = defineAgentPlugin(input);
      if (entries.has(p._id) || owners.has(input)) return fail("E_ADK_PLUGIN_DUPLICATE");
      if (Object.entries(p._peers).some(([k, v]) => hostPeers[k] !== v)) return fail("E_ADK_PLUGIN_COMPATIBILITY");
      for (const d of p._dependencies) if (entries.get(d._id)?.plugin._version !== d._version) return fail("E_ADK_PLUGIN_DEPENDENCY");
      const definitions = [...p._tools ?? [], ...p._actions ?? []];
      if (definitions.some(d => d._id === "actions.reconcile") || definitions.some(d => toolOwners.has(d._id) || actionOwners.has(d._id)) || catalog._tools.length + catalog._actions.length + definitions.length > 32) return fail("E_ADK_PLUGIN_DUPLICATE");
      const e: Entry = { plugin: p, state: "registered", grants: empty, controller: new AbortController(), touched: false, disposed: false, pending: new Set() };
      const reads = (p._tools ?? []).map(d => Object.freeze({ ...d, _handler: (...args: never[]) => owned(e, () => d._handler(...args)) }));
      const actions = (p._actions ?? []).map(d => Object.freeze({ ...d,
        _prepare_action: async (...args: never[]) => {
          try { return await owned(e, () => d._prepare_action(...args)); }
          catch (error) {
            // The generic preparer preserves its native XError denial path.
            if (registryDenied(error)) throw new StarterActionError(STARTER_ACTION_ERROR_CODES.NOT_ALLOWED, "Agent Action is not allowed in this context");
            throw error;
          }
        },
        _handler: (...args: never[]) => owned(e, () => d._handler(...args)),
        ...(d._read_committed_outcome ? { _read_committed_outcome: async (...args: never[]) => {
          try { return await owned(e, () => d._read_committed_outcome!(...args)); }
          catch (error) { if (registryDenied(error)) throw new DurableActionError("E_ADK_ACTION_DENIED"); throw error; }
        } } : {}),
      }));
      entries.set(p._id, e); owners.add(input);
      reads.forEach(d => toolOwners.set(d._id, e)); actions.forEach(d => actionOwners.set(d._id, e));
      catalog = Object.freeze({ _tools: Object.freeze([...catalog._tools, ...reads]), _actions: Object.freeze([...catalog._actions, ...actions]) });
    },
    setGrants(id, input) {
      const e = entries.get(id); if (!e || stopping || disposed) return fail("E_ADK_PLUGIN_STATE");
      const p = permissions(input);
      if ((["_host", "_agent"] as const).some(k => p[k].some(x => !e.plugin._permissions[k].includes(x)))) return fail("E_ADK_PLUGIN_DENIED");
      e.grants = p; epoch++;
    },
    getContributions() { return catalog; },
    getStatus() { return Object.freeze([...entries.values()].map(e => Object.freeze({ _id: e.plugin._id, _version: e.plugin._version, _state: e.state, _available: available(e), ...(e.error ? { _error_code: e.error } : {}) }))); },
    isAvailable(id) { const e = entries.get(id); return !!e && available(e); },
    readPolicy(policy) {
      if (policy !== undefined && typeof policy !== "function") return fail("E_ADK_PLUGIN_CONFIG");
      return async input => {
        const e = toolOwners.get(input._tool_id);
        if (!e || !available(e) || !policy) return Object.freeze({ _allow: false });
        try { return await owned(e, () => policy(input)); } catch { throw new ReadToolError("E_ADK_TOOL_DENIED"); }
      };
    },
    actionPolicy(policy) {
      if (policy !== undefined && typeof policy !== "function") return fail("E_ADK_PLUGIN_CONFIG");
      const decorated: ActionPolicy = async input => {
        // A scan is application-authorized. No plugin stands in for another row.
        if (input._phase === "reconcile" && input._capability_id === "actions.reconcile") {
          if (!policy || !scanAvailable()) return false;
          try { return await scanPolicy(input, policy); } catch { throw new DurableActionError("E_ADK_ACTION_DENIED"); }
        }
        const e = actionOwners.get(input._capability_id);
        if (!e || !available(e) || !policy) return false;
        try { return await owned(e, () => policy(input)); } catch { throw new DurableActionError("E_ADK_ACTION_DENIED"); }
      };
      registerPluginActionPolicy(decorated, Object.freeze({ beginReconciliation }));
      return decorated;
    },
    start() {
      if (stopping || disposed) return Promise.reject(new AgentPluginError("E_ADK_PLUGIN_STATE"));
      if (startup) return startup;
      sealed = true;
      startup = Promise.resolve().then(async () => {
        for (const e of entries.values()) {
          if (stopping) break;
          if (!granted(e) || !e.plugin._dependencies.every(d => api.isAvailable(d._id))) {
            e.state = "not_ready"; e.error = !granted(e) ? "E_ADK_PLUGIN_DENIED" : "E_ADK_PLUGIN_DEPENDENCY"; continue;
          }
          e.state = "starting"; e.touched = true; const authorizationEpoch = epoch;
          try {
            await e.plugin.start?.(ctx(e));
            if (!stopping && epoch === authorizationEpoch && granted(e) && e.plugin._dependencies.every(d => api.isAvailable(d._id))) e.state = "ready";
            else { e.state = "not_ready"; e.error = "E_ADK_PLUGIN_DENIED"; await cleanup(e, true); }
          } catch { e.state = "not_ready"; e.error = "E_ADK_PLUGIN_START"; await cleanup(e, true); }
        }
        startupComplete = !stopping;
      });
      return startup;
    },
    stop() {
      if (shutdown) return shutdown;
      stopping = true; sealed = true; epoch++;
      for (const e of entries.values()) e.controller.abort();
      shutdown = (async () => {
        await startup;
        await Promise.allSettled([...scanPolicies]);
        for (const e of [...entries.values()].reverse()) { if (!e.disposed) e.state = "stopping"; await cleanup(e, false); }
      })();
      return shutdown;
    },
    dispose() {
      if (disposal) return disposal;
      disposal = (async () => { await api.stop(); disposed = true; for (const e of [...entries.values()].reverse()) await cleanup(e, true); })();
      return disposal;
    },
  };
  return Object.freeze(api);
}
