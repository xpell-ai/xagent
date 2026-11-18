import { createHash } from "node:crypto";
import { types } from "node:util";
import type { ToolJsonObject } from "../tools.js";

export type ActionErrorCode = "E_ADK_ACTION_CONFIG" | "E_ADK_ACTION_NOT_READY" | "E_ADK_ACTION_CLOSED" |
  "E_ADK_ACTION_DENIED" | "E_ADK_ACTION_BINDING" | "E_ADK_ACTION_NOT_FOUND" | "E_ADK_ACTION_CONFLICT" |
  "E_ADK_ACTION_EXPIRED" | "E_ADK_ACTION_STATE" | "E_ADK_ACTION_UNAVAILABLE" | "E_ADK_ACTION_UNCERTAIN" |
  "E_ADK_ACTION_RESULT" | "E_ADK_ACTION_TIMEOUT" | "E_ADK_ACTION_BUSY" | "E_ADK_ACTION_STORAGE" |
  "E_ADK_ACTION_PROFILE" | "E_ADK_ACTION_EVIDENCE";
export class DurableActionError extends Error {
  readonly _code: ActionErrorCode;
  constructor(code: ActionErrorCode) {
    super("Durable Action failed; inspect the safe error code"); this.name = "DurableActionError";
    this._code = ["CONFIG", "NOT_READY", "CLOSED", "DENIED", "BINDING", "NOT_FOUND", "CONFLICT", "EXPIRED", "STATE", "UNAVAILABLE",
      "UNCERTAIN", "RESULT", "TIMEOUT", "BUSY", "STORAGE", "PROFILE", "EVIDENCE"].some(x => code === `E_ADK_ACTION_${x}`) ? code : "E_ADK_ACTION_STORAGE";
    Object.freeze(this);
  }
}
export const fail = (code: ActionErrorCode): never => { throw new DurableActionError(code); };
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function data(value: unknown, keys?: readonly string[], code: ActionErrorCode = "E_ADK_ACTION_CONFIG"): Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(code);
    const ds = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(k => typeof k !== "string" || !ds[k]?.enumerable || !("value" in ds[k]) || keys && !keys.includes(k))) return fail(code);
    return Object.fromEntries(Object.entries(ds).map(([k, v]) => [k, v.value]));
  } catch { return fail(code); }
}
export function text(v: unknown, max = 200, code: ActionErrorCode = "E_ADK_ACTION_CONFIG"): string {
  if (typeof v !== "string" || !v.trim() || v !== v.trim() || v.length > max) return fail(code); return v;
}
export function integer(v: unknown, max: number): number {
  if (!Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > max) return fail("E_ADK_ACTION_CONFIG"); return v as number;
}
export function frozen<T>(v: T): T { if (v && typeof v === "object") { Object.values(v).forEach(frozen); Object.freeze(v); } return v; }
/** Bounded data snapshot; no toJSON/getters/functions or non-finite values. */
export function jsonObject(v: unknown, max: number, code: ActionErrorCode = "E_ADK_ACTION_RESULT"): ToolJsonObject {
  let nodes = 0, bytes = 0; const seen = new Set<object>();
  const add = (n: number) => { bytes += n; if (bytes > max) fail(code); };
  const string = (s: string) => { if (Buffer.byteLength(s) > max) fail(code); add(Buffer.byteLength(JSON.stringify(s))); return s; };
  const walk = (x: unknown, depth: number): unknown => {
    if (++nodes > 1024 || depth > 8) return fail(code);
    if (x === null || typeof x === "boolean" || typeof x === "number" && Number.isFinite(x)) { add(Buffer.byteLength(JSON.stringify(x))); return x; }
    if (typeof x === "string") return string(x);
    if (!x || typeof x !== "object" || types.isProxy(x) || seen.has(x)) return fail(code);
    seen.add(x); let out: unknown;
    if (Array.isArray(x)) {
      const ds = Object.getOwnPropertyDescriptors(x);
      if (x.length > 1024 || Reflect.ownKeys(x).length !== x.length + 1) return fail(code);
      add(2 + x.length); out = Array.from({ length: x.length }, (_, i) => { if (!ds[i] || !("value" in ds[i])) return fail(code); return walk(ds[i].value, depth + 1); });
    } else {
      const obj = data(x, undefined, code); add(2 + Object.keys(obj).length * 2);
      out = Object.fromEntries(Object.keys(obj).sort().map(k => [string(k), walk(obj[k], depth + 1)]));
    }
    seen.delete(x); return out;
  };
  try { data(v, undefined, code); return frozen(walk(v, 0)) as ToolJsonObject; } catch { return fail(code); }
}
export function safeFailure(error: unknown): DurableActionError {
  if (error instanceof DurableActionError) return error;
  let code: unknown;
  try { code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "_code")?.value : undefined; } catch { /* Untrusted exception. */ }
  const map: Record<string, ActionErrorCode> = {
    E_ADK_CONFIG: "E_ADK_ACTION_CONFIG", E_ADK_CLOSED: "E_ADK_ACTION_CLOSED", E_ADK_NOT_READY: "E_ADK_ACTION_NOT_READY", E_ADK_HOST_IN_USE: "E_ADK_ACTION_BUSY",
    E_STARTER_ACTION_CONFLICT: "E_ADK_ACTION_CONFLICT", E_STARTER_ACTION_INTEGRITY: "E_ADK_ACTION_BINDING",
    E_STARTER_ACTION_NOT_FOUND: "E_ADK_ACTION_NOT_FOUND", E_STARTER_ACTION_NOT_ALLOWED: "E_ADK_ACTION_DENIED",
    E_STARTER_ACTION_EXPIRED: "E_ADK_ACTION_EXPIRED", E_STARTER_ACTION_NOT_PENDING: "E_ADK_ACTION_STATE",
    E_STARTER_ACTION_CAPABILITY_UNAVAILABLE: "E_ADK_ACTION_UNAVAILABLE", E_STARTER_ACTION_CLAIM_FAILED: "E_ADK_ACTION_STATE",
    E_STARTER_ACTION_EXECUTION_AMBIGUOUS: "E_ADK_ACTION_UNCERTAIN", E_STARTER_ACTION_OUTCOME_INVALID: "E_ADK_ACTION_UNCERTAIN",
    E_STARTER_CAPABILITY_ARGUMENTS_INVALID: "E_ADK_ACTION_CONFIG", E_ADK_PROFILE_MISMATCH: "E_ADK_ACTION_PROFILE",
    E_STARTER_ACTION_INVALID_PREPARATION: "E_ADK_ACTION_RESULT", E_STARTER_APPLICATION_SCOPE_INVALID: "E_ADK_ACTION_CONFIG",
  };
  return new DurableActionError(typeof code === "string" && Object.hasOwn(map, code) ? map[code] : "E_ADK_ACTION_STORAGE");
}
