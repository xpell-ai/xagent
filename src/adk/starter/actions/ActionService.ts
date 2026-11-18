import { createHash } from "node:crypto";

import { XError, _xu } from "@xpell/node";

import type { ActorContext } from "../actor/ActorContext.js";
import {
  validateCapabilityArguments,
  type AgentCapability,
  type AgentSideEffectOutcome,
  type EffectiveAgentCapability,
  type PreparedAgentAction,
} from "../capabilities/AgentCapability.js";
import type { PersistedInboundConversationTurn } from "../conversation/ConversationService.js";
import { canonicalKey, deterministicId } from "../persistence/keys.js";
import {
  applicationScopeKey,
  assertApplicationScopeKey,
  createAgentApplicationScope,
  type AgentApplicationScope,
} from "../persistence/AgentApplicationScope.js";
import type {
  AgentActionRecord,
  RuntimeDate,
} from "./types.js";
import { ActionRepository } from "./ActionRepository.js";

export const AGENT_ACTION_CONFIRM_CAPABILITY_ID = "agent.action.confirm";
export const AGENT_ACTION_CANCEL_CAPABILITY_ID = "agent.action.cancel";
export const AGENT_ACTION_TTL_MS = 15 * 60 * 1000;

export const STARTER_ACTION_ERROR_CODES = {
  INVALID_PREPARATION: "E_STARTER_ACTION_INVALID_PREPARATION",
  CONFLICT: "E_STARTER_ACTION_CONFLICT",
  INTEGRITY: "E_STARTER_ACTION_INTEGRITY",
  NOT_FOUND: "E_STARTER_ACTION_NOT_FOUND",
  NOT_ALLOWED: "E_STARTER_ACTION_NOT_ALLOWED",
  EXPIRED: "E_STARTER_ACTION_EXPIRED",
  NOT_PENDING: "E_STARTER_ACTION_NOT_PENDING",
  CAPABILITY_UNAVAILABLE: "E_STARTER_ACTION_CAPABILITY_UNAVAILABLE",
  CLAIM_FAILED: "E_STARTER_ACTION_CLAIM_FAILED",
  OUTCOME_INVALID: "E_STARTER_ACTION_OUTCOME_INVALID",
  EXECUTION_AMBIGUOUS: "E_STARTER_ACTION_EXECUTION_AMBIGUOUS",
} as const;

export type StarterActionErrorCode =
  (typeof STARTER_ACTION_ERROR_CODES)[keyof typeof STARTER_ACTION_ERROR_CODES];

export class StarterActionError extends XError {
  constructor(code: StarterActionErrorCode, message: string) {
    super(code, message, { _level: "warn" });
    this.name = "StarterActionError";
  }
}

export type PendingActionProjection = Readonly<{
  _capability_id: string;
  _summary: string;
  _state: "pending";
  _expires_at: string;
}>;

export type ActionAuthorization = (
  capability: AgentCapability,
  phase: "confirm" | "execute",
) =>
  | readonly AgentCapability[]
  | Promise<readonly AgentCapability[]>;

export type ActionServiceOptions = Readonly<{
  _repository: ActionRepository;
  _now?: () => Date;
  _application_scope?: AgentApplicationScope;
}>;

type ImmutableActionEnvelope = Readonly<{
  _id: string;
  _capability_id: string;
  _capability_revision: string;
  _arguments: Record<string, unknown>;
  _authorized_scope: Record<string, unknown>;
  _confirmation_summary: string;
  _requester_participant_id: string;
  _conversation_id: string;
  _request_message_id: string;
  _expires_at: string;
  _application_scope_key?: string;
}>;

function dateISOString(value: RuntimeDate): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new StarterActionError(
      STARTER_ACTION_ERROR_CODES.INTEGRITY,
      "Stored Agent Action integrity check failed",
    );
  }
  return date.toISOString();
}

function canonicalJSON(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("cyclic value");
    seen.add(value);
    const serialized = `[${value.map((item) => canonicalJSON(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  if (_xu.is_plain_object(value)) {
    if (seen.has(value)) throw new Error("cyclic value");
    seen.add(value);
    const keys = Object.keys(value).sort();
    const serialized = `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key], seen)}`)
      .join(",")}}`;
    seen.delete(value);
    return serialized;
  }
  throw new Error("non-JSON value");
}

function cloneRecord(
  value: unknown,
  code: StarterActionErrorCode = STARTER_ACTION_ERROR_CODES.INVALID_PREPARATION,
): Record<string, unknown> {
  if (!_xu.is_plain_object(value)) {
    throw new StarterActionError(code, "Agent Action data is invalid");
  }
  try {
    return JSON.parse(canonicalJSON(value)) as Record<string, unknown>;
  } catch {
    throw new StarterActionError(code, "Agent Action data is invalid");
  }
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonicalJSON(left) === canonicalJSON(right);
  } catch {
    return false;
  }
}

function immutableEnvelope(record: AgentActionRecord): ImmutableActionEnvelope {
  return {
    _id: record._id,
    _capability_id: record._capability_id,
    _capability_revision: record._capability_revision,
    _arguments: record._arguments,
    _authorized_scope: record._authorized_scope,
    _confirmation_summary: record._confirmation_summary,
    _requester_participant_id: record._requester_participant_id,
    _conversation_id: record._conversation_id,
    _request_message_id: record._request_message_id,
    _expires_at: dateISOString(record._expires_at),
    ...(record._application_scope_key
      ? { _application_scope_key: record._application_scope_key }
      : {}),
  };
}

export function actionBindingHash(
  envelope: ImmutableActionEnvelope,
): string {
  return createHash("sha256").update(canonicalJSON(envelope)).digest("hex");
}

export function deterministicActionId(
  requestMessageId: string,
  capabilityId: string,
): string {
  return deterministicId(
    "agent-action",
    canonicalKey([requestMessageId, capabilityId]),
  );
}

function effectiveCapabilities(
  capabilities: readonly AgentCapability[],
): readonly EffectiveAgentCapability[] {
  return Object.freeze(
    capabilities.map((capability) =>
      Object.freeze({
        _id: capability._id,
        _description: capability._description,
      }),
    ),
  );
}

function publicActionResult(action: AgentActionRecord): Record<string, unknown> {
  const base: Record<string, unknown> = {
    _status: action._state,
    _capability_id: action._capability_id,
  };
  if (action._result !== undefined) base._result = action._result;
  if (action._failure_code !== undefined) {
    base._failure_code = action._failure_code;
  }
  return base;
}

export class ActionService {
  readonly #repository: ActionRepository;
  readonly #now: () => Date;
  readonly #scopeKey?: string;

  constructor(options: ActionServiceOptions) {
    this.#repository = options._repository;
    this.#now = options._now ?? (() => new Date());
    this.#scopeKey = options._application_scope
      ? applicationScopeKey(createAgentApplicationScope(options._application_scope))
      : options._repository.applicationScopeKey;
    assertApplicationScopeKey(this.#scopeKey, options._repository.applicationScopeKey);
  }

  async createPendingAction(input: {
    _capability: AgentCapability;
    _arguments: Readonly<Record<string, unknown>>;
    _actor: ActorContext;
    _conversation: PersistedInboundConversationTurn;
  }): Promise<AgentActionRecord> {
    assertApplicationScopeKey(
      this.#scopeKey,
      input._conversation._application_scope_key,
    );
    const capability = input._capability;
    if (
      capability._effect !== "side_effect" ||
      capability._confirmation !== "required" ||
      !_xu.is_non_empty_string(capability._revision) ||
      typeof capability._prepare_action !== "function"
    ) {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.INVALID_PREPARATION,
        "Agent Action capability is invalid",
      );
    }

    const prepared = await this.#prepare(
      capability,
      input._arguments,
      input._actor,
      input._conversation,
    );
    const id = deterministicActionId(
      input._conversation._inbound_message_id,
      capability._id,
    );
    const existing = await this.#repository.get(id);
    if (existing) {
      this.#assertEquivalent(existing, {
        _capability_id: capability._id,
        _capability_revision: capability._revision,
        ...prepared,
        _requester_participant_id: input._conversation._participant_id,
        _conversation_id: input._conversation._conversation_id,
        _request_message_id: input._conversation._inbound_message_id,
      });
      return existing;
    }

    const expiresAt = new Date(this.#now().getTime() + AGENT_ACTION_TTL_MS);
    const envelope: ImmutableActionEnvelope = {
      _id: id,
      _capability_id: capability._id,
      _capability_revision: capability._revision,
      ...prepared,
      _requester_participant_id: input._conversation._participant_id,
      _conversation_id: input._conversation._conversation_id,
      _request_message_id: input._conversation._inbound_message_id,
      _expires_at: expiresAt.toISOString(),
      ...(this.#scopeKey ? { _application_scope_key: this.#scopeKey } : {}),
    };
    const candidate: AgentActionRecord = {
      ...envelope,
      _expires_at: expiresAt,
      _state: "pending",
      _binding_hash: actionBindingHash(envelope),
    };

    try {
      return await this.#repository.add(candidate);
    } catch {
      const reconciled = await this.#repository.get(id);
      if (!reconciled) {
        throw new StarterActionError(
          STARTER_ACTION_ERROR_CODES.CONFLICT,
          "Agent Action could not be created",
        );
      }
      this.#assertEquivalent(reconciled, {
        _capability_id: capability._id,
        _capability_revision: capability._revision,
        ...prepared,
        _requester_participant_id: input._conversation._participant_id,
        _conversation_id: input._conversation._conversation_id,
        _request_message_id: input._conversation._inbound_message_id,
      });
      return reconciled;
    }
  }

  async listPendingForContext(input: {
    _participant_id: string;
    _conversation_id: string;
  }): Promise<readonly AgentActionRecord[]> {
    const candidates = await this.#repository.findPendingForContext(input);
    const now = this.#now();
    const pending: AgentActionRecord[] = [];
    for (const action of candidates) {
      this.#verifyBinding(action);
      if (new Date(action._expires_at).getTime() <= now.getTime()) {
        await this.#repository.compareAndSet({
          _id: action._id,
          _binding_hash: action._binding_hash,
          _from: "pending",
          _to: "expired",
          _updates: { _completed_at: now },
        });
        continue;
      }
      pending.push(action);
    }
    return Object.freeze(pending);
  }

  async modelContext(input: {
    _participant_id: string;
    _conversation_id: string;
  }): Promise<Readonly<{ _pending_actions: readonly PendingActionProjection[] }> | undefined> {
    const pending = await this.listPendingForContext(input);
    if (pending.length === 0) return undefined;
    return Object.freeze({
      _pending_actions: Object.freeze(
        pending.map((action) =>
          Object.freeze({
            _capability_id: action._capability_id,
            _summary: action._confirmation_summary,
            _state: "pending" as const,
            _expires_at: dateISOString(action._expires_at),
          }),
        ),
      ),
    });
  }

  async confirmAndExecute(input: {
    _action_id: string;
    _actor: ActorContext;
    _conversation: PersistedInboundConversationTurn;
    _capabilities: readonly AgentCapability[];
    _reauthorize: ActionAuthorization;
  }): Promise<Record<string, unknown>> {
    let action = await this.#requireAction(input._action_id);
    this.#assertSameAuthority(action, input._actor, input._conversation);
    this.#verifyBinding(action);

    if (["succeeded", "failed", "executing"].includes(action._state)) {
      return publicActionResult(action);
    }
    if (action._state === "expired") {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.EXPIRED,
        "Agent Action has expired",
      );
    }
    if (action._state !== "pending" && action._state !== "confirmed") {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.NOT_PENDING,
        "Agent Action is not confirmable",
      );
    }

    const now = this.#now();
    if (
      action._state === "pending" &&
      new Date(action._expires_at).getTime() <= now.getTime()
    ) {
      await this.#repository.compareAndSet({
        _id: action._id,
        _binding_hash: action._binding_hash,
        _from: "pending",
        _to: "expired",
        _updates: { _completed_at: now },
      });
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.EXPIRED,
        "Agent Action has expired",
      );
    }

    const capability = input._capabilities.find(
      (candidate) =>
        candidate._id === action._capability_id &&
        candidate._revision === action._capability_revision,
    );
    if (!capability || typeof capability._prepare_action !== "function") {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.CAPABILITY_UNAVAILABLE,
        "Agent Action capability revision is unavailable",
      );
    }

    const allowed = await input._reauthorize(capability, "confirm");
    if (
      !allowed.some(
        (candidate) =>
          candidate._id === capability._id &&
          candidate._revision === capability._revision,
      )
    ) {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.NOT_ALLOWED,
        "Agent Action is not allowed in this context",
      );
    }

    const storedArguments = validateCapabilityArguments(
      capability,
      action._arguments,
    );
    const prepared = await this.#prepare(
      capability,
      storedArguments,
      input._actor,
      input._conversation,
    );
    if (
      !sameCanonical(prepared._arguments, action._arguments) ||
      !sameCanonical(prepared._authorized_scope, action._authorized_scope) ||
      prepared._confirmation_summary !== action._confirmation_summary
    ) {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.NOT_ALLOWED,
        "Agent Action scope is no longer valid",
      );
    }

    const transitionNow = this.#now();
    if (new Date(action._expires_at).getTime() <= transitionNow.getTime()) {
      if (action._state === "pending") {
        await this.#repository.compareAndSet({
          _id: action._id,
          _binding_hash: action._binding_hash,
          _from: "pending",
          _to: "expired",
          _updates: { _completed_at: transitionNow },
        });
      }
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.EXPIRED,
        "Agent Action has expired",
      );
    }

    if (action._state === "pending") {
      const confirmed = await this.#repository.compareAndSet({
        _id: action._id,
        _binding_hash: action._binding_hash,
        _from: "pending",
        _to: "confirmed",
        _updates: {
          _confirmed_by_participant_id: input._actor._participant_id,
          _confirmation_message_id: input._conversation._inbound_message_id,
          _confirmed_at: transitionNow,
        },
      });
      if (confirmed === 0) {
        action = await this.#requireAction(action._id);
        if (["succeeded", "failed", "executing"].includes(action._state)) {
          return publicActionResult(action);
        }
        if (action._state !== "confirmed") {
          throw new StarterActionError(
            STARTER_ACTION_ERROR_CODES.CLAIM_FAILED,
            "Agent Action confirmation was not claimed",
          );
        }
      } else {
        action = { ...action, _state: "confirmed" };
      }
    }

    const claimedAt = this.#now();
    const claimed = await this.#repository.compareAndSet({
      _id: action._id,
      _binding_hash: action._binding_hash,
      _from: "confirmed",
      _to: "executing",
      _updates: { _execution_started_at: claimedAt },
    });
    if (claimed === 0) {
      const current = await this.#requireAction(action._id);
      if (["succeeded", "failed", "executing"].includes(current._state)) {
        return publicActionResult(current);
      }
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.CLAIM_FAILED,
        "Agent Action execution was not claimed",
      );
    }

    // The claim is durable. Recheck current authority at the effect boundary,
    // after asynchronous re-preparation and conditional state transitions.
    let executionAllowed = false;
    try {
      executionAllowed = (await input._reauthorize(capability, "execute")).some(
        candidate => candidate._id === capability._id && candidate._revision === capability._revision,
      );
    } catch { /* No handler ran: this is a known authorization failure. */ }
    if (!executionAllowed) {
      const count = await this.#repository.compareAndSet({ _id: action._id, _binding_hash: action._binding_hash,
        _from: "executing", _to: "failed", _updates: { _completed_at: this.#now(),
          _failure_code: STARTER_ACTION_ERROR_CODES.NOT_ALLOWED, _result: {} } });
      if (count !== 1) throw new StarterActionError(STARTER_ACTION_ERROR_CODES.EXECUTION_AMBIGUOUS,
        "Agent Action authorization outcome could not be recorded");
      return { _status: "failed", _capability_id: action._capability_id,
        _failure_code: STARTER_ACTION_ERROR_CODES.NOT_ALLOWED, _result: {} };
    }

    let outcome: AgentSideEffectOutcome;
    try {
      outcome = (await capability._handler({
        _arguments: action._arguments,
        _actor: input._actor,
        _conversation: input._conversation,
        _effective_capabilities: effectiveCapabilities(allowed),
        _action: Object.freeze({
          _id: action._id,
          _idempotency_key: `agent-action:${action._id}`,
          _authorized_scope: Object.freeze({ ...action._authorized_scope }),
          _request_message_id: action._request_message_id,
        }),
      })) as AgentSideEffectOutcome;
    } catch {
      // The effect may have committed before throwing or losing its response.
      // Keep the execution claim; a diagnostic marker never authorizes replay.
      try {
        await this.#repository.compareAndSet({ _id: action._id, _binding_hash: action._binding_hash,
          _from: "executing", _to: "executing",
          _updates: { _failure_code: STARTER_ACTION_ERROR_CODES.EXECUTION_AMBIGUOUS } });
      } catch { /* The existing executing row still requires reconciliation. */ }
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.EXECUTION_AMBIGUOUS,
        "Agent Action execution outcome is uncertain",
      );
    }

    const completedAt = this.#now();
    if (
      !_xu.is_plain_object(outcome) ||
      (outcome._status !== "succeeded" && outcome._status !== "failed")
    ) {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.OUTCOME_INVALID,
        "Agent Action execution outcome is invalid",
      );
    }

    const result = cloneRecord(
      outcome._result ?? {},
      STARTER_ACTION_ERROR_CODES.OUTCOME_INVALID,
    );
    const failureCode =
      outcome._status === "failed" ? outcome._failure_code : undefined;
    if (
      outcome._status === "failed" &&
      (!_xu.is_non_empty_string(failureCode) || failureCode.length > 200)
    ) {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.OUTCOME_INVALID,
        "Agent Action execution outcome is invalid",
      );
    }

    const terminal = outcome._status === "succeeded" ? "succeeded" : "failed";
    let updated: number;
    try { updated = await this.#repository.compareAndSet({
      _id: action._id,
      _binding_hash: action._binding_hash,
      _from: "executing",
      _to: terminal,
      _updates: {
        _completed_at: completedAt,
        _result: result,
        ...(failureCode ? { _failure_code: failureCode } : {}),
      },
    }); } catch {
      throw new StarterActionError(STARTER_ACTION_ERROR_CODES.EXECUTION_AMBIGUOUS,
        "Agent Action completion could not be recorded");
    }
    if (updated !== 1) {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.EXECUTION_AMBIGUOUS,
        "Agent Action completion could not be recorded",
      );
    }
    return {
      _status: terminal,
      _capability_id: action._capability_id,
      _result: result,
      ...(failureCode ? { _failure_code: failureCode } : {}),
    };
  }

  /** Startup/operator-only audit repair. The callback reads committed evidence;
   * it must never execute an effect. No stored actor is an authorization to replay.
   */
  async reconcileUnfinished(input: {
    _requester_participant_id: string;
    _conversation_id: string;
    _read_committed_outcome: (action: Readonly<AgentActionRecord>) => Promise<AgentSideEffectOutcome | null>;
    _limit?: number;
    _after_id?: string;
  }): Promise<Readonly<{ _completed: number; _uncertain: number; _confirmed: number;
    _scan_truncated: boolean; _next_after_id?: string }>> {
    const limit = input._limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("E_STARTER_ACTION_SCAN_LIMIT");
    const rows = await this.#repository.listUnfinished(limit + 1, input._after_id, input._requester_participant_id, input._conversation_id);
    let completed = 0, uncertain = 0, confirmed = 0;
    for (const action of rows.slice(0, limit)) {
      this.#verifyBinding(action);
      if (action._state === "confirmed") { confirmed++; continue; }
      if (action._confirmed_by_participant_id !== action._requester_participant_id ||
          !action._confirmed_at || !action._confirmation_message_id || !action._execution_started_at) {
        throw new StarterActionError(STARTER_ACTION_ERROR_CODES.INTEGRITY, "Action confirmation receipt is missing");
      }
      // Clone to keep product readers from mutating the audit envelope.
      const outcome = await input._read_committed_outcome(structuredClone(action));
      if (!outcome) {
        await this.#repository.compareAndSet({ _id: action._id, _binding_hash: action._binding_hash,
          _from: "executing", _to: "executing",
          _updates: { _failure_code: STARTER_ACTION_ERROR_CODES.EXECUTION_AMBIGUOUS } });
        uncertain++;
        continue;
      }
      if ((outcome._status !== "succeeded" && outcome._status !== "failed") ||
          (outcome._status === "failed" && !_xu.is_non_empty_string(outcome._failure_code))) {
        throw new StarterActionError(STARTER_ACTION_ERROR_CODES.OUTCOME_INVALID, "Invalid reconciliation evidence");
      }
      completed += await this.#repository.compareAndSet({ _id: action._id, _binding_hash: action._binding_hash,
        _from: "executing", _to: outcome._status,
        _updates: { _completed_at: this.#now(),
          _result: cloneRecord(outcome._result ?? {}, STARTER_ACTION_ERROR_CODES.OUTCOME_INVALID),
          // An empty code clears an earlier uncertain marker without changing the schema.
          _failure_code: outcome._status === "failed" ? outcome._failure_code : "" } });
    }
    return Object.freeze({ _completed: completed, _uncertain: uncertain, _confirmed: confirmed,
      _scan_truncated: rows.length > limit,
      ...(rows.length > limit ? { _next_after_id: rows[limit - 1]._id } : {}) });
  }

  async cancel(input: {
    _action_id: string;
    _actor: ActorContext;
    _conversation: PersistedInboundConversationTurn;
  }): Promise<Record<string, unknown>> {
    const action = await this.#requireAction(input._action_id);
    this.#assertSameAuthority(action, input._actor, input._conversation);
    this.#verifyBinding(action);
    if (action._state === "cancelled") return publicActionResult(action);
    if (action._state !== "pending") {
      throw new StarterActionError(
        action._state === "expired"
          ? STARTER_ACTION_ERROR_CODES.EXPIRED
          : STARTER_ACTION_ERROR_CODES.NOT_PENDING,
        "Agent Action is not cancellable",
      );
    }

    const now = this.#now();
    if (new Date(action._expires_at).getTime() <= now.getTime()) {
      await this.#repository.compareAndSet({
        _id: action._id,
        _binding_hash: action._binding_hash,
        _from: "pending",
        _to: "expired",
        _updates: { _completed_at: now },
      });
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.EXPIRED,
        "Agent Action has expired",
      );
    }

    const updated = await this.#repository.compareAndSet({
      _id: action._id,
      _binding_hash: action._binding_hash,
      _from: "pending",
      _to: "cancelled",
      _updates: {
        _cancelled_by_participant_id: input._actor._participant_id,
        _completed_at: now,
      },
    });
    if (updated === 0) {
      const current = await this.#requireAction(action._id);
      if (current._state === "cancelled") return publicActionResult(current);
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.NOT_PENDING,
        "Agent Action is not cancellable",
      );
    }
    return {
      _status: "cancelled",
      _capability_id: action._capability_id,
    };
  }

  async #prepare(
    capability: AgentCapability,
    argumentsValue: Readonly<Record<string, unknown>>,
    actor: ActorContext,
    conversation: PersistedInboundConversationTurn,
  ): Promise<PreparedAgentAction & {
    _arguments: Record<string, unknown>;
    _authorized_scope: Record<string, unknown>;
  }> {
    let raw: PreparedAgentAction;
    try {
      raw = await capability._prepare_action!({
        _arguments: argumentsValue,
        _actor: actor,
        _conversation: conversation,
      });
    } catch (error) {
      if (error instanceof XError) throw error;
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.INVALID_PREPARATION,
        "Agent Action could not be prepared",
      );
    }
    if (
      !_xu.is_plain_object(raw) ||
      !_xu.is_non_empty_string(raw._confirmation_summary) ||
      raw._confirmation_summary.length > 2000
    ) {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.INVALID_PREPARATION,
        "Agent Action preparation is invalid",
      );
    }
    const preparedArguments = validateCapabilityArguments(
      capability,
      raw._arguments,
    );
    return Object.freeze({
      _arguments: cloneRecord(preparedArguments),
      _authorized_scope: cloneRecord(raw._authorized_scope),
      _confirmation_summary: raw._confirmation_summary.trim(),
    });
  }

  #assertEquivalent(
    existing: AgentActionRecord,
    expected: Omit<
      ImmutableActionEnvelope,
      "_id" | "_expires_at"
    >,
  ): void {
    this.#verifyBinding(existing);
    const same =
      (existing._application_scope_key ?? undefined) === this.#scopeKey &&
      existing._capability_id === expected._capability_id &&
      existing._capability_revision === expected._capability_revision &&
      sameCanonical(existing._arguments, expected._arguments) &&
      sameCanonical(existing._authorized_scope, expected._authorized_scope) &&
      existing._confirmation_summary === expected._confirmation_summary &&
      existing._requester_participant_id === expected._requester_participant_id &&
      existing._conversation_id === expected._conversation_id &&
      existing._request_message_id === expected._request_message_id;
    if (!same) {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.CONFLICT,
        "Agent Action retry conflicts with the stored proposal",
      );
    }
  }

  #verifyBinding(action: AgentActionRecord): void {
    assertApplicationScopeKey(this.#scopeKey, action._application_scope_key);
    let expected: string;
    try {
      expected = actionBindingHash(immutableEnvelope(action));
    } catch {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.INTEGRITY,
        "Stored Agent Action integrity check failed",
      );
    }
    if (expected !== action._binding_hash) {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.INTEGRITY,
        "Stored Agent Action integrity check failed",
      );
    }
  }

  #assertSameAuthority(
    action: AgentActionRecord,
    actor: ActorContext,
    conversation: PersistedInboundConversationTurn,
  ): void {
    assertApplicationScopeKey(this.#scopeKey, conversation._application_scope_key);
    assertApplicationScopeKey(this.#scopeKey, action._application_scope_key);
    if (
      actor._participant_id !== action._requester_participant_id ||
      conversation._participant_id !== action._requester_participant_id ||
      conversation._conversation_id !== action._conversation_id
    ) {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.NOT_ALLOWED,
        "Agent Action is not allowed in this context",
      );
    }
  }

  async #requireAction(id: string): Promise<AgentActionRecord> {
    const action = await this.#repository.get(id);
    if (!action) {
      throw new StarterActionError(
        STARTER_ACTION_ERROR_CODES.NOT_FOUND,
        "Agent Action was not found",
      );
    }
    return action;
  }
}
