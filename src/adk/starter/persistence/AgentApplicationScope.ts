import { XError } from "@xpell/node";
import { canonicalKey } from "./keys.js";

/** Trusted XVM application identity supplied by server-side composition. */
export type AgentApplicationScope = Readonly<{
  _env: string;
  _app_id: string;
}>;

export const AGENT_APPLICATION_SCOPE_ERROR_CODES = {
  REQUIRED: "E_STARTER_APPLICATION_SCOPE_REQUIRED",
  INVALID: "E_STARTER_APPLICATION_SCOPE_INVALID",
  MISMATCH: "E_STARTER_APPLICATION_SCOPE_MISMATCH",
} as const;

export class AgentApplicationScopeError extends XError {
  constructor(code: string) {
    super(code, "Agent application scope is invalid or mismatched", {
      _level: "warn",
    });
    this.name = "AgentApplicationScopeError";
  }
}

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u;

export function createAgentApplicationScope(
  input: AgentApplicationScope,
): AgentApplicationScope {
  if (!input || typeof input._env !== "string" ||
      typeof input._app_id !== "string" ||
      !SAFE_SEGMENT.test(input._env) ||
      !SAFE_SEGMENT.test(input._app_id)) {
    throw new AgentApplicationScopeError(AGENT_APPLICATION_SCOPE_ERROR_CODES.INVALID);
  }
  return Object.freeze({ _env: input._env, _app_id: input._app_id });
}

/** Internal indexed encoding of the native XVM pair, not another app identity. */
export function applicationScopeKey(
  scope: AgentApplicationScope | undefined,
): string | undefined {
  return scope ? canonicalKey([scope._env, scope._app_id]) : undefined;
}

export function assertApplicationScopeKey(
  expected: string | undefined,
  actual: string | undefined | null,
): void {
  const checkedActual = actual ?? undefined;
  if (expected !== undefined && checkedActual === undefined) {
    throw new AgentApplicationScopeError(AGENT_APPLICATION_SCOPE_ERROR_CODES.REQUIRED);
  }
  if (expected !== checkedActual) {
    throw new AgentApplicationScopeError(AGENT_APPLICATION_SCOPE_ERROR_CODES.MISMATCH);
  }
}
