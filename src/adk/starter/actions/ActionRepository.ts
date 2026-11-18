import { _x, type XCommandData } from "@xpell/node";
import {
  applicationScopeKey,
  assertApplicationScopeKey,
  createAgentApplicationScope,
  type AgentApplicationScope,
} from "../persistence/AgentApplicationScope.js";

import {
  STARTER_APP_ENV,
  STARTER_APP_ID,
} from "../persistence/ConversationRepository.js";
import {
  ENTITY_IDS,
  type AgentActionRecord,
  type AgentActionState,
} from "./types.js";

type Execute = (command: XCommandData) => Promise<any>;

export type ActionRepositoryOptions = Readonly<{
  _app_id?: string;
  _env?: string;
  _execute?: Execute;
  _application_scope?: AgentApplicationScope;
}>;

export class ActionRepositoryError extends Error {
  readonly _code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ActionRepositoryError";
    this._code = code;
  }
}

function responseCode(response: any): string {
  const code = response?._error?._code ?? response?._result?._code;
  return typeof code === "string" ? code : "E_STARTER_ACTION_STORAGE";
}

/** EntityManager-only storage boundary for durable Agent Actions. */
export class ActionRepository {
  readonly #appId: string;
  readonly #env: string;
  readonly #execute: Execute;
  readonly #applicationScope?: AgentApplicationScope;
  readonly #scopeKey?: string;

  constructor(options: ActionRepositoryOptions = {}) {
    this.#appId = options._app_id ?? STARTER_APP_ID;
    this.#env = options._env ?? STARTER_APP_ENV;
    this.#execute = options._execute ?? ((command) => _x.execute(command));
    this.#applicationScope = options._application_scope
      ? createAgentApplicationScope(options._application_scope)
      : undefined;
    this.#scopeKey = applicationScopeKey(this.#applicationScope);
  }

  get applicationScope(): AgentApplicationScope | undefined {
    return this.#applicationScope;
  }

  get applicationScopeKey(): string | undefined {
    return this.#scopeKey;
  }

  async get(id: string): Promise<AgentActionRecord | null> {
    const response = await this.#execute({
      _module: "entity-manager",
      _op: "get",
      _params: { ...this.#params(), _id: id },
    });
    this.#assertOK(response, "get Action");
    const record = (response?._result?._record as AgentActionRecord | null) ?? null;
    return record && (record._application_scope_key ?? undefined) === this.#scopeKey
      ? record
      : null;
  }

  async add(record: AgentActionRecord): Promise<AgentActionRecord> {
    if (record._application_scope_key !== undefined) {
      assertApplicationScopeKey(this.#scopeKey, record._application_scope_key);
    }
    const response = await this.#execute({
      _module: "entity-manager",
      _op: "add",
      _params: {
        ...this.#params(),
        _data: {
          ...record,
          ...(this.#scopeKey ? { _application_scope_key: this.#scopeKey } : {}),
        },
      },
    });
    this.#assertOK(response, "add Action");
    const stored = response._result._record as AgentActionRecord;
    assertApplicationScopeKey(this.#scopeKey, stored._application_scope_key);
    return stored;
  }

  async findPendingForContext(input: {
    _participant_id: string;
    _conversation_id: string;
  }): Promise<AgentActionRecord[]> {
    return await this.find({
      _requester_participant_id: input._participant_id,
      _conversation_id: input._conversation_id,
      _state: "pending",
    });
  }

  async list(): Promise<AgentActionRecord[]> {
    return await this.find({});
  }

  async listUnfinished(limit: number, afterId: string | undefined, participantId: string, conversationId: string): Promise<AgentActionRecord[]> {
    return this.find({ _requester_participant_id: participantId, _conversation_id: conversationId, _state: { _in: ["confirmed", "executing"] },
      ...(afterId ? { _id: { _gt: afterId } } : {}) }, limit, "_id");
  }

  /**
   * One provider-atomic compare-and-set. Callers must inspect the returned
   * count; zero means another execution changed the state first.
   */
  async compareAndSet(input: {
    _id: string;
    _binding_hash: string;
    _from: AgentActionState;
    _to: AgentActionState;
    _updates?: Partial<AgentActionRecord>;
  }): Promise<number> {
    if (input._updates?._application_scope_key !== undefined) {
      assertApplicationScopeKey(this.#scopeKey, input._updates._application_scope_key);
    }
    const updates = Object.fromEntries(
      Object.entries({
        ...(input._updates ?? {}),
        _state: input._to,
      }).filter(([key, value]) =>
        key !== "_application_scope_key" && value !== undefined),
    );
    const response = await this.#execute({
      _module: "entity-manager",
      _op: "update",
      _params: {
        ...this.#params(),
        _filter: {
          _id: input._id,
          _binding_hash: input._binding_hash,
          _state: input._from,
          _application_scope_key: this.#scopeKey ?? null,
        },
        _updates: updates,
      },
    });
    this.#assertOK(response, `transition Action ${input._from} to ${input._to}`);
    const updated = response?._result?._updated;
    if (!Number.isSafeInteger(updated) || updated < 0 || updated > 1) {
      throw new ActionRepositoryError(
        "E_STARTER_ACTION_UPDATE_INVALID",
        "EntityManager returned an invalid Action update count",
      );
    }
    return updated;
  }

  async storageProvider(): Promise<string> {
    return String((await this.storageDiagnostic())._provider ?? "");
  }

  async storageDiagnostic(): Promise<Record<string, any>> {
    const response = await this.#execute({
      _module: "entity-manager",
      _op: "storage-diagnostics",
      _params: this.#params(),
    });
    this.#assertOK(response, "inspect Action storage");
    return response?._result?._diagnostic ?? {};
  }

  private async find(
    filter: Record<string, unknown>,
    limit = 100,
    sortBy = "_created_at",
  ): Promise<AgentActionRecord[]> {
    const response = await this.#execute({
      _module: "entity-manager",
      _op: "find",
      _params: {
        ...this.#params(),
        _filter: { ...filter, _application_scope_key: this.#scopeKey ?? null },
        _skip: 0,
        _limit: limit,
        _sort: { _sort_by: sortBy, _sort_order: "asc" },
      },
    });
    this.#assertOK(response, "find Actions");
    const rows = response?._result?._records?._data;
    return Array.isArray(rows)
      ? (rows as AgentActionRecord[]).filter(
          (record) => (record._application_scope_key ?? undefined) === this.#scopeKey,
        )
      : [];
  }

  #params(): Record<string, string> {
    return {
      _app_id: this.#appId,
      _env: this.#env,
      _entity: ENTITY_IDS.ACTION,
    };
  }

  #assertOK(response: any, operation: string): void {
    if (response?._ok !== true) {
      throw new ActionRepositoryError(
        responseCode(response),
        `EntityManager failed to ${operation}`,
      );
    }
  }
}
