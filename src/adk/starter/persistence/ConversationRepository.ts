import { _x, type XCommandData } from "@xpell/node";

import { canonicalKey, deterministicId, messageHistoryKey } from "./keys.js";
import {
  applicationScopeKey,
  assertApplicationScopeKey,
  createAgentApplicationScope,
  type AgentApplicationScope,
} from "./AgentApplicationScope.js";
import {
  ENTITY_IDS,
  type ChannelIdentityRecord,
  type ConversationParticipantRecord,
  type ConversationRecord,
  type ConversationSource,
  type ConversationSourceType,
  type EntityId,
  type EntityRecordMap,
  type MessageRecord,
  type NewMessageRecord,
} from "./types.js";

export const STARTER_APP_ID = "xpell-agent-starter";
export const STARTER_APP_ENV = "default";

type Execute = (command: XCommandData) => Promise<any>;

export type ConversationRepositoryOptions = {
  _app_id?: string;
  _env?: string;
  _application_scope?: AgentApplicationScope;
  _execute?: Execute;
};

export type ResolvedIdentity = {
  _participant: ConversationParticipantRecord;
  _identity: ChannelIdentityRecord;
};

export type AuthenticatedParticipantIdentity = {
  _user_id: string;
  _account_id: string;
};

export type MessageHistoryPageInput = {
  _conversation_id: string;
  _after_history_key?: string;
  _limit: number;
};

export type RecentMessageHistoryPageInput = {
  _conversation_id: string;
  _before_history_key?: string;
  _limit: number;
};

export type ConversationStats = Readonly<{
  conversations: number;
  messages: number;
}>;

const CONVERSATION_STATS_PAGE_SIZE = 100;

type FindOptions = {
  _skip?: number;
  _limit?: number;
  _sort?: {
    _sort_by: string;
    _sort_order?: "asc" | "desc";
  };
};

export class StarterPersistenceError extends Error {
  readonly _code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StarterPersistenceError";
    this._code = code;
  }
}

function responseMessage(response: any): string {
  const code = response?._error?._code ?? response?._result?._code;
  return typeof code === "string" ? code : "E_STARTER_ENTITY_OPERATION";
}

export class ConversationRepository {
  readonly #appId: string;
  readonly #env: string;
  readonly #execute: Execute;
  readonly #applicationScope?: AgentApplicationScope;
  readonly #scopeKey?: string;

  constructor(options: ConversationRepositoryOptions = {}) {
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

  private scopedKey(parts: readonly string[]): string {
    return canonicalKey(this.#scopeKey
      ? ["agent-app", this.#scopeKey, ...parts]
      : parts);
  }

  identityKey(channelId: string, externalUserId: string): string {
    return this.scopedKey([channelId, externalUserId]);
  }

  authPrincipalKey(accountId: string, userId: string): string {
    return this.scopedKey(["xauth", accountId, userId]);
  }

  conversationKey(
    sourceType: ConversationSourceType,
    sourceId: string,
    sourceConversationId: string,
  ): string;
  /** V1-compatible Channel shorthand; returned keys always use the V2 source triple. */
  conversationKey(channelId: string, externalConversationId: string): string;
  conversationKey(
    sourceTypeOrChannelId: ConversationSourceType | string,
    sourceIdOrExternalConversationId: string,
    sourceConversationId?: string,
  ): string {
    return sourceConversationId === undefined
      ? this.scopedKey([
          "channel",
          sourceTypeOrChannelId,
          sourceIdOrExternalConversationId,
        ])
      : this.scopedKey([
          sourceTypeOrChannelId,
          sourceIdOrExternalConversationId,
          sourceConversationId,
        ]);
  }

  inboundDedupeKey(
    channelId: string,
    externalConversationId: string,
    externalMessageId: string,
  ): string {
    return this.scopedKey([
      "inbound",
      channelId,
      externalConversationId,
      externalMessageId,
    ]);
  }

  outboundDedupeKey(
    channelId: string,
    externalConversationId: string,
    localId: string,
  ): string {
    return this.scopedKey([
      "outbound",
      channelId,
      externalConversationId,
      localId,
    ]);
  }

  /** Read the scoped provider identity without onboarding or updating last-seen time. */
  async findChannelIdentity(channelId: string, externalUserId: string): Promise<ChannelIdentityRecord | null> {
    return this.findOne(ENTITY_IDS.CHANNEL_IDENTITY,
      { _identity_key: this.identityKey(channelId, externalUserId) });
  }

  async resolveIdentity(input: {
    _channel_id: string;
    _external_user_id: string;
    _seen_at: Date;
  }): Promise<ResolvedIdentity> {
    const identityKey = this.identityKey(
      input._channel_id,
      input._external_user_id,
    );
    let identity = await this.findOne(
      ENTITY_IDS.CHANNEL_IDENTITY,
      { _identity_key: identityKey },
    );

    if (identity) {
      const participant =
        (await this.get(ENTITY_IDS.PARTICIPANT, identity._participant_id)) ??
        (await this.addIfMissing(ENTITY_IDS.PARTICIPANT, {
          _id: identity._participant_id,
        }));
      await this.update(ENTITY_IDS.CHANNEL_IDENTITY, { _id: identity._id }, {
        _last_seen_at: input._seen_at,
      });
      identity = { ...identity, _last_seen_at: input._seen_at };
      return { _participant: participant, _identity: identity };
    }

    const participantId = deterministicId("participant", identityKey);
    const participant = await this.addIfMissing(ENTITY_IDS.PARTICIPANT, {
      _id: participantId,
    });
    const candidate: ChannelIdentityRecord = {
      _id: deterministicId("channel-identity", identityKey),
      _identity_key: identityKey,
      _channel_id: input._channel_id,
      _external_user_id: input._external_user_id,
      _participant_id: participant._id,
      _last_seen_at: input._seen_at,
    };

    try {
      identity = await this.add(ENTITY_IDS.CHANNEL_IDENTITY, candidate);
    } catch {
      identity = await this.findOne(
        ENTITY_IDS.CHANNEL_IDENTITY,
        { _identity_key: identityKey },
      );
      if (!identity) {
        throw new StarterPersistenceError(
          "E_STARTER_IDENTITY_CREATE",
          "Channel identity could not be created",
        );
      }
    }

    const resolvedParticipant =
      identity._participant_id === participant._id
        ? participant
        : (await this.get(ENTITY_IDS.PARTICIPANT, identity._participant_id)) ??
          (await this.addIfMissing(ENTITY_IDS.PARTICIPANT, {
            _id: identity._participant_id,
          }));
    return { _participant: resolvedParticipant, _identity: identity };
  }

  async resolveAuthenticatedParticipant(
    input: AuthenticatedParticipantIdentity,
  ): Promise<ConversationParticipantRecord> {
    const principalKey = this.authPrincipalKey(
      input._account_id,
      input._user_id,
    );
    const existing = await this.findOne(ENTITY_IDS.PARTICIPANT, {
      _auth_principal_key: principalKey,
    });
    if (existing) return existing;

    const candidate: ConversationParticipantRecord = {
      _id: deterministicId("authenticated-participant", principalKey),
      _auth_principal_key: principalKey,
      _auth_user_id: input._user_id,
      _auth_account_id: input._account_id,
    };
    try {
      return await this.add(ENTITY_IDS.PARTICIPANT, candidate);
    } catch {
      const reconciled = await this.findOne(ENTITY_IDS.PARTICIPANT, {
        _auth_principal_key: principalKey,
      });
      if (reconciled) return reconciled;
      throw new StarterPersistenceError(
        "E_STARTER_AUTH_PARTICIPANT_CREATE",
        "Authenticated Participant could not be created",
      );
    }
  }

  async findConversation(
    source: ConversationSource,
  ): Promise<ConversationRecord | null> {
    return await this.findOne(ENTITY_IDS.CONVERSATION, {
      _conversation_key: this.conversationKey(
        source._source_type,
        source._source_id,
        source._source_conversation_id,
      ),
    });
  }

  async resolveConversation(input: ConversationSource & {
    _activity_at: Date;
    _participant_id?: string;
  }): Promise<ConversationRecord> {
    const conversationKey = this.conversationKey(
      input._source_type,
      input._source_id,
      input._source_conversation_id,
    );
    let conversation = await this.findOne(
      ENTITY_IDS.CONVERSATION,
      { _conversation_key: conversationKey },
    );

    if (!conversation) {
      const participantIds = input._participant_id
        ? [input._participant_id]
        : [];
      const candidate: ConversationRecord = {
        _id: deterministicId("conversation", conversationKey),
        _conversation_key: conversationKey,
        _source_type: input._source_type,
        _source_id: input._source_id,
        _source_conversation_id: input._source_conversation_id,
        _participant_ids: participantIds,
        _started_at: input._activity_at,
        _last_activity_at: input._activity_at,
      };
      try {
        conversation = await this.add(ENTITY_IDS.CONVERSATION, candidate);
      } catch {
        conversation = await this.findOne(
          ENTITY_IDS.CONVERSATION,
          { _conversation_key: conversationKey },
        );
        if (!conversation) {
          throw new StarterPersistenceError(
            "E_STARTER_CONVERSATION_CREATE",
            "Conversation could not be created",
          );
        }
      }
    }

    const participantIds = conversation._participant_ids ?? [];
    const nextParticipantIds =
      input._participant_id && !participantIds.includes(input._participant_id)
        ? [...participantIds, input._participant_id]
        : participantIds;
    await this.update(ENTITY_IDS.CONVERSATION, { _id: conversation._id }, {
      _participant_ids: nextParticipantIds,
      _last_activity_at: input._activity_at,
    });
    return {
      ...conversation,
      _participant_ids: nextParticipantIds,
      _last_activity_at: input._activity_at,
    };
  }

  async findMessageByDedupeKey(dedupeKey: string): Promise<MessageRecord | null> {
    return await this.findOne(ENTITY_IDS.MESSAGE, { _dedupe_key: dedupeKey });
  }

  async findMessageByExternalId(
    conversationId: string,
    externalMessageId: string,
  ): Promise<MessageRecord | null> {
    return await this.findOne(ENTITY_IDS.MESSAGE, {
      _conversation_id: conversationId,
      _external_message_id: externalMessageId,
    });
  }

  async addMessage(record: NewMessageRecord): Promise<MessageRecord> {
    const data = {
      ...record,
      _history_key:
        record._history_key ??
        messageHistoryKey(record._occurred_at, record._id),
    };
    // Concurrent deliveries can race after the initial lookup. The winner's
    // immutable payload is checked by ConversationService before any claim.
    return record._direction === "inbound" && record._attempt_count === 0
      ? await this.addIfMissing(ENTITY_IDS.MESSAGE, data)
      : await this.add(ENTITY_IDS.MESSAGE, data);
  }

  async updateMessage(
    id: string,
    updates: Partial<MessageRecord>,
  ): Promise<void> {
    await this.update(ENTITY_IDS.MESSAGE, { _id: id }, updates);
  }

  /** The indexed diagnostic marker is the durable receipt; attempt count is
   * informational. Reusing V4 fields avoids an automatic historical index migration.
   */
  async claimInboundMessage(record: MessageRecord, at: Date): Promise<boolean> {
    const response = await this.#execute({
      _module: "entity-manager", _op: "update",
      _params: { ...this.params(ENTITY_IDS.MESSAGE),
        _filter: { _id: record._id, _application_scope_key: this.#scopeKey ?? null,
          _direction: "inbound", _conversation_id: record._conversation_id,
          _delivery_state: "received", _failure_code: "E_STARTER_INBOUND_UNCLAIMED" },
        _updates: { _attempt_count: 1, _last_attempt_at: at, _failure_code: "E_STARTER_INBOUND_IN_PROGRESS" },
      },
    });
    this.assertOK(response, "claim inbound message");
    const count = response?._result?._updated;
    if (count !== 0 && count !== 1) throw new StarterPersistenceError(
      "E_STARTER_INBOUND_CLAIM", "Invalid inbound processing claim count");
    return count === 1;
  }

  async inboundRecoveryDiagnostics(): Promise<Readonly<{
    _unclaimed: number; _interrupted_or_legacy: number; _processing_failed: number;
  }>> {
    const [received, unclaimed, failed] = await Promise.all([
      this.count(ENTITY_IDS.MESSAGE, { _direction: "inbound", _delivery_state: "received" }),
      this.count(ENTITY_IDS.MESSAGE, { _direction: "inbound", _delivery_state: "received", _failure_code: "E_STARTER_INBOUND_UNCLAIMED" }),
      this.count(ENTITY_IDS.MESSAGE, { _direction: "inbound", _delivery_state: "processing_failed" }),
    ]);
    return Object.freeze({ _unclaimed: unclaimed, _interrupted_or_legacy: received - unclaimed,
      _processing_failed: failed });
  }

  /** Compare-and-set through the app-scoped EntityManager SQLite transaction. */
  async transitionOutboundMessage(input: {
    _id: string;
    _conversation_id: string;
    _channel_id: string;
    _recipient_external_conversation_id: string;
    _expected_state: "pending" | "sending" | "failed";
    _expected_failure_code?: string;
    _updates: Partial<MessageRecord>;
  }): Promise<void> {
    const record = await this.get(ENTITY_IDS.MESSAGE, input._id);
    if (record?._direction !== "outbound" ||
        record._conversation_id !== input._conversation_id ||
        record._channel_id !== input._channel_id ||
        record._recipient_external_conversation_id !== input._recipient_external_conversation_id) {
      throw new StarterPersistenceError(
        "E_STARTER_OUTBOUND_BINDING",
        "Outbound message binding does not match the trusted conversation",
      );
    }
    const response = await this.#execute({
      _module: "entity-manager",
      _op: "update",
      _params: {
        ...this.params(ENTITY_IDS.MESSAGE),
        _filter: {
          _id: input._id,
          _application_scope_key: this.#scopeKey ?? null,
          _conversation_id: input._conversation_id,
          _direction: "outbound",
          _delivery_state: input._expected_state,
          ...(input._expected_failure_code !== undefined
            ? { _failure_code: input._expected_failure_code } : {}),
        },
        _updates: input._updates,
      },
    });
    this.assertOK(response, "transition message");
    if (response?._result?._updated !== 1) {
      throw new StarterPersistenceError(
        "E_STARTER_OUTBOUND_CLAIM_CONFLICT",
        "Exactly one outbound message transition is required",
      );
    }
  }

  async getRecoveryMessage(id: string): Promise<MessageRecord | null> {
    return await this.get(ENTITY_IDS.MESSAGE, id);
  }

  async getRecoveryConversation(id: string): Promise<ConversationRecord | null> {
    return await this.get(ENTITY_IDS.CONVERSATION, id);
  }

  async getRecoveryChannelIdentity(id: string): Promise<ChannelIdentityRecord | null> {
    return await this.get(ENTITY_IDS.CHANNEL_IDENTITY, id);
  }

  async listRecoveryMessages(state: "pending" | "failed", limit: number): Promise<MessageRecord[]> {
    return await this.find(ENTITY_IDS.MESSAGE, {
      _direction: "outbound", _delivery_state: state,
    }, { _limit: limit, _sort: { _sort_by: "_occurred_at", _sort_order: "asc" } });
  }

  async countRecoveryMessages(state: "pending" | "failed" | "uncertain"): Promise<number> {
    return await this.count(ENTITY_IDS.MESSAGE, {
      _direction: "outbound", _delivery_state: state,
    });
  }

  async reconcileInterruptedOutbound(at: Date): Promise<number> {
    const sending = await this.find(ENTITY_IDS.MESSAGE, {
      _direction: "outbound",
      _delivery_state: "sending",
    });
    let reconciled = 0;
    for (const record of sending) {
      if (!record._channel_id || !record._recipient_external_conversation_id) {
        throw new StarterPersistenceError(
          "E_STARTER_OUTBOUND_BINDING",
          "Interrupted outbound message has no trusted recipient binding",
        );
      }
      try {
        await this.transitionOutboundMessage({
          _id: record._id,
          _conversation_id: record._conversation_id,
          _channel_id: record._channel_id,
          _recipient_external_conversation_id: record._recipient_external_conversation_id,
          _expected_state: "sending",
          _updates: {
            _delivery_state: "uncertain",
            _last_error_at: at,
            _last_error_category: "interrupted",
          },
        });
        reconciled += 1;
      } catch (error) {
        if (!(error instanceof StarterPersistenceError) ||
            error._code !== "E_STARTER_OUTBOUND_CLAIM_CONFLICT") throw error;
      }
    }
    return reconciled;
  }

  async list<K extends EntityId>(entity: K): Promise<EntityRecordMap[K][]> {
    return await this.find(entity, {});
  }

  async getConversationStats(input: {
    _participant_id: string;
    _source_type: ConversationSourceType;
    _source_id: string;
  }): Promise<ConversationStats> {
    let conversations = 0;
    let messages = 0;
    let skip = 0;

    while (true) {
      const candidates = await this.find(
        ENTITY_IDS.CONVERSATION,
        {
          _source_type: input._source_type,
          _source_id: input._source_id,
        },
        {
          _skip: skip,
          _limit: CONVERSATION_STATS_PAGE_SIZE,
        },
      );

      for (const conversation of candidates) {
        if (!conversation._participant_ids.includes(input._participant_id)) {
          continue;
        }

        const processedInbound = await this.count(ENTITY_IDS.MESSAGE, {
          _conversation_id: conversation._id,
          _direction: "inbound",
          _delivery_state: "processed",
        });
        const acceptedOutbound = await this.count(ENTITY_IDS.MESSAGE, {
          _conversation_id: conversation._id,
          _direction: "outbound",
          _delivery_state: "accepted",
        });
        const successfulMessages = processedInbound + acceptedOutbound;

        if (successfulMessages > 0) {
          conversations += 1;
          messages += successfulMessages;
        }
      }

      if (candidates.length < CONVERSATION_STATS_PAGE_SIZE) {
        break;
      }
      skip += candidates.length;
    }

    return Object.freeze({
      conversations,
      messages,
    });
  }

  async listMessageHistory(
    input: MessageHistoryPageInput,
  ): Promise<MessageRecord[]> {
    if (!Number.isInteger(input._limit) || input._limit < 1) {
      throw new StarterPersistenceError(
        "E_STARTER_HISTORY_PAGE_INVALID",
        "Message history page limit must be a positive integer",
      );
    }
    return await this.find(
      ENTITY_IDS.MESSAGE,
      {
        _conversation_id: input._conversation_id,
        ...(input._after_history_key
          ? { _history_key: { _gt: input._after_history_key } }
          : {}),
      },
      {
        _limit: input._limit,
        _sort: {
          _sort_by: "_history_key",
          _sort_order: "asc",
        },
      },
    );
  }

  async listRecentMessageHistory(
    input: RecentMessageHistoryPageInput,
  ): Promise<MessageRecord[]> {
    if (!Number.isInteger(input._limit) || input._limit < 1) {
      throw new StarterPersistenceError(
        "E_STARTER_HISTORY_PAGE_INVALID",
        "Message history page limit must be a positive integer",
      );
    }
    return await this.find(
      ENTITY_IDS.MESSAGE,
      {
        _conversation_id: input._conversation_id,
        ...(input._before_history_key
          ? { _history_key: { _lt: input._before_history_key } }
          : {}),
      },
      {
        _limit: input._limit,
        _sort: {
          _sort_by: "_history_key",
          _sort_order: "desc",
        },
      },
    );
  }

  async storageProvider(entity: EntityId): Promise<string> {
    const response = await this.#execute({
      _module: "entity-manager",
      _op: "storage-diagnostics",
      _params: this.params(entity),
    });
    this.assertOK(response, `inspect ${entity} storage`);
    return String(response?._result?._diagnostic?._provider ?? "");
  }

  async listEntityIds(): Promise<string[]> {
    const response = await this.#execute({
      _module: "entity-manager",
      _op: "list",
      _params: {
        _app_id: this.#appId,
        _env: this.#env,
      },
    });
    this.assertOK(response, "list entities");
    const entities = response?._result?.entities;
    return Array.isArray(entities) ? entities.map(String).sort() : [];
  }

  private params(entity: EntityId): Record<string, string> {
    return {
      _app_id: this.#appId,
      _env: this.#env,
      _entity: entity,
    };
  }

  private assertOK(response: any, operation: string): void {
    if (response?._ok !== true) {
      throw new StarterPersistenceError(
        responseMessage(response),
        `EntityManager failed to ${operation}`,
      );
    }
  }

  private async get<K extends EntityId>(
    entity: K,
    id: string,
  ): Promise<EntityRecordMap[K] | null> {
    const response = await this.#execute({
      _module: "entity-manager",
      _op: "get",
      _params: { ...this.params(entity), _id: id },
    });
    this.assertOK(response, `get ${entity}`);
    const record = (response?._result?._record as EntityRecordMap[K] | null) ?? null;
    if (!record) return null;
    return (record._application_scope_key ?? undefined) === this.#scopeKey
      ? record
      : null;
  }

  private async find<K extends EntityId>(
    entity: K,
    filter: Record<string, unknown>,
    options: FindOptions = {},
  ): Promise<EntityRecordMap[K][]> {
    const response = await this.#execute({
      _module: "entity-manager",
      _op: "find",
      _params: {
        ...this.params(entity),
        _filter: { ...filter, _application_scope_key: this.#scopeKey ?? null },
        _skip: options._skip ?? 0,
        _limit: options._limit ?? 100000,
        ...(options._sort ? { _sort: options._sort } : {}),
      },
    });
    this.assertOK(response, `find ${entity}`);
    const records = response?._result?._records?._data;
    if (!Array.isArray(records)) return [];
    return (records as EntityRecordMap[K][]).filter(
      (record) => (record._application_scope_key ?? undefined) === this.#scopeKey,
    );
  }

  private async findOne<K extends EntityId>(
    entity: K,
    filter: Record<string, unknown>,
  ): Promise<EntityRecordMap[K] | null> {
    const rows = await this.find(entity, filter, { _limit: 1 });
    return rows[0] ?? null;
  }

  private async count<K extends EntityId>(
    entity: K,
    filter: Record<string, unknown>,
  ): Promise<number> {
    const response = await this.#execute({
      _module: "entity-manager",
      _op: "find",
      _params: {
        ...this.params(entity),
        _filter: { ...filter, _application_scope_key: this.#scopeKey ?? null },
        _skip: 0,
        _limit: 0,
      },
    });
    this.assertOK(response, `count ${entity}`);
    const total = Number(
      response?._result?._records?._meta?._total_records,
    );
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new StarterPersistenceError(
        "E_STARTER_ENTITY_COUNT_INVALID",
        `EntityManager returned an invalid ${entity} count`,
      );
    }
    return total;
  }

  private async add<K extends EntityId>(
    entity: K,
    data: EntityRecordMap[K],
  ): Promise<EntityRecordMap[K]> {
    if (data._application_scope_key !== undefined) {
      assertApplicationScopeKey(this.#scopeKey, data._application_scope_key);
    }
    const response = await this.#execute({
      _module: "entity-manager",
      _op: "add",
      _params: {
        ...this.params(entity),
        _data: {
          ...data,
          ...(this.#scopeKey ? { _application_scope_key: this.#scopeKey } : {}),
        },
      },
    });
    this.assertOK(response, `add ${entity}`);
    const stored = response._result._record as EntityRecordMap[K];
    assertApplicationScopeKey(this.#scopeKey, stored._application_scope_key);
    return stored;
  }

  private async addIfMissing<K extends EntityId>(
    entity: K,
    data: EntityRecordMap[K],
  ): Promise<EntityRecordMap[K]> {
    const existing = await this.get(entity, data._id);
    if (existing) return existing;
    try {
      return await this.add(entity, data);
    } catch {
      const reconciled = await this.get(entity, data._id);
      if (reconciled) return reconciled;
      throw new StarterPersistenceError(
        "E_STARTER_ENTITY_CREATE",
        `${entity} could not be created`,
      );
    }
  }

  private async update<K extends EntityId>(
    entity: K,
    filter: Record<string, unknown>,
    updates: Partial<EntityRecordMap[K]>,
  ): Promise<void> {
    if (updates._application_scope_key !== undefined) {
      assertApplicationScopeKey(this.#scopeKey, updates._application_scope_key);
    }
    const definedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([key, value]) =>
        key !== "_application_scope_key" && value !== undefined),
    );
    if (Object.keys(definedUpdates).length === 0) return;
    const response = await this.#execute({
      _module: "entity-manager",
      _op: "update",
      _params: {
        ...this.params(entity),
        _filter: { ...filter, _application_scope_key: this.#scopeKey ?? null },
        _updates: definedUpdates,
      },
    });
    this.assertOK(response, `update ${entity}`);
  }
}
