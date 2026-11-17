import { randomUUID } from "node:crypto";
import { displayedAssistantReply } from "./UserVisibleReply.js";

import type {
  XAgentInboundMessage,
  XAgentOutboundMessage,
  XChannelSendResult,
  XChannelSendFailureCategory,
} from "@xpell/agent";

import {
  type ActorContext,
  createAuthenticatedActorContext,
  createExternalActorContext,
  type AuthenticatedActorContext,
  type ExternalActorContext,
  type TrustedXAuthPrincipal,
} from "../actor/ActorContext.js";
import {
  ConversationRepository,
  type RecentMessageHistoryPageInput,
} from "../persistence/ConversationRepository.js";
import { canonicalKey, deterministicId } from "../persistence/keys.js";
import { assertApplicationScopeKey } from "../persistence/AgentApplicationScope.js";
import type {
  ConversationRecord,
  MessageRecord,
  RuntimeDate,
} from "../persistence/types.js";
import { recoveryPolicy, safeFailureCode, type OutboundRecoveryPolicy } from "../recovery/OutboundRetryPolicy.js";

export const AGENT_CONSOLE_SOURCE_ID = "agent-console";
export const AGENT_CONSOLE_HISTORY_LIMIT = 200;

export type InboundCompletionOutcome =
  | Readonly<{ _status: "processed" }>
  | Readonly<{
      _status: "processing_failed";
      _error: Readonly<{ _code: string; _message: string }>;
    }>;

export type OutboundCompletionOutcome =
  | Readonly<{
      _status: "accepted";
      _result: Readonly<XChannelSendResult>;
    }>
  | Readonly<{
      _status: "send_failed";
      _error: Readonly<{ _code: string; _message: string; _category?: XChannelSendFailureCategory;
        _retry_after_ms?: number; _permanent?: boolean }>;
    }>;

export type ConversationTurnState = Readonly<{
  _application_scope_key?: string;
  _participant_id?: string;
  _channel_identity_id?: string;
  _conversation_id: string;
  _source_type: "channel" | "xpell";
  _source_id: string;
  _source_conversation_id: string;
  _inbound_message_id?: string;
  _outbound_message_id?: string;
}>;

export type PersistedInboundConversationTurn = ConversationTurnState &
  Readonly<{
    _participant_id: string;
    _inbound_message_id: string;
  }>;

export type InboundConversationTurn = PersistedInboundConversationTurn &
  Readonly<{
    _source_type: "channel";
    _channel_identity_id: string;
  }>;

export type NativeConversationTurn = PersistedInboundConversationTurn &
  Readonly<{
    _source_type: "xpell";
    _source_id: typeof AGENT_CONSOLE_SOURCE_ID;
  }>;

export type PreparedInboundTurn = Readonly<{
  _handled: boolean;
  _turn: InboundConversationTurn;
}>;

export type NativeTranscriptMessage = Readonly<{
  _id: string;
  _role: "user" | "assistant";
  _text: string;
  _created_at: string;
}>;

export type PreparedNativeTurn = Readonly<{
  _turn: NativeConversationTurn;
  _actor: AuthenticatedActorContext;
  _user_message: NativeTranscriptMessage;
}>;

export type ConversationServiceOptions = {
  _repository: ConversationRepository;
  _now?: () => Date;
  _local_id?: () => string;
  _recovery_policy?: OutboundRecoveryPolicy;
};

export class StarterConversationError extends Error {
  readonly _code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StarterConversationError";
    this._code = code;
  }
}

function messageDate(timestamp: number | undefined, now: () => Date): Date {
  return timestamp === undefined ? now() : new Date(timestamp);
}

function freezeTurn<T extends ConversationTurnState>(turn: T): T {
  return Object.freeze(turn);
}

function iso(value: RuntimeDate): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString();
}

function transcriptMessage(record: MessageRecord): NativeTranscriptMessage | null {
  if (record._direction === "inbound" && record._delivery_state === "processed") {
    return Object.freeze({
      _id: record._id,
      _role: "user",
      _text: record._text,
      _created_at: iso(record._occurred_at),
    });
  }
  if (record._direction === "outbound" && record._delivery_state === "accepted") {
    return Object.freeze({
      _id: record._id,
      _role: "assistant",
      _text: displayedAssistantReply(record._text),
      _created_at: iso(record._occurred_at),
    });
  }
  return null;
}

/** Conversation operations shared by provider Channels and native Xpell ingress. */
export class ConversationService {
  readonly #repository: ConversationRepository;
  readonly #now: () => Date;
  readonly #localId: () => string;
  readonly #recoveryPolicy: OutboundRecoveryPolicy;

  constructor(options: ConversationServiceOptions) {
    this.#repository = options._repository;
    this.#now = options._now ?? (() => new Date());
    this.#localId = options._local_id ?? randomUUID;
    this.#recoveryPolicy = recoveryPolicy(options._recovery_policy);
  }

  assertConversationScope(turn: ConversationTurnState): void {
    assertApplicationScopeKey(
      this.#repository.applicationScopeKey,
      turn._application_scope_key,
    );
  }

  async prepareInbound(
    message: Readonly<XAgentInboundMessage>,
  ): Promise<PreparedInboundTurn> {
    const occurredAt = messageDate(message._timestamp, this.#now);
    const resolved = await this.#repository.resolveIdentity({
      _channel_id: message._channel_id,
      _external_user_id: message._external_user_id,
      _seen_at: occurredAt,
    });
    const conversation = await this.#repository.resolveConversation({
      _source_type: "channel",
      _source_id: message._channel_id,
      _source_conversation_id: message._external_conversation_id,
      _participant_id: resolved._participant._id,
      _activity_at: occurredAt,
    });
    const dedupeKey = this.#repository.inboundDedupeKey(
      message._channel_id,
      message._external_conversation_id,
      message._external_message_id,
    );
    const existing = await this.#repository.findMessageByDedupeKey(dedupeKey);

    const reply = message._reply_to_external_message_id
      ? await this.#repository.findMessageByExternalId(
          conversation._id,
          message._reply_to_external_message_id,
        )
      : null;
    const inbound = existing ?? await this.#repository.addMessage({
      _id: deterministicId("inbound-message", dedupeKey),
      _conversation_id: conversation._id,
      _sender_participant_id: resolved._participant._id,
      _direction: "inbound",
      _text: message._text,
      _occurred_at: occurredAt,
      _dedupe_key: dedupeKey,
      _delivery_state: "received",
      _attempt_count: 0,
      _failure_code: "E_STARTER_INBOUND_UNCLAIMED",
      _external_message_id: message._external_message_id,
      ...(reply ? { _reply_to_message_id: reply._id } : {}),
      ...(message._reply_to_external_message_id
        ? { _reply_to_external_message_id: message._reply_to_external_message_id }
        : {}),
    });

    // Never use a redelivered payload to change the stored work or its authority.
    if (inbound._direction !== "inbound" || inbound._conversation_id !== conversation._id ||
        inbound._sender_participant_id !== resolved._participant._id || inbound._text !== message._text ||
        inbound._reply_to_external_message_id !== message._reply_to_external_message_id) {
      throw new StarterConversationError("E_STARTER_INBOUND_BINDING", "Inbound receipt binding differs");
    }
    const claimed = inbound._delivery_state === "received" && inbound._failure_code === "E_STARTER_INBOUND_UNCLAIMED"
      ? await this.#repository.claimInboundMessage(inbound, this.#now()) : false;

    return Object.freeze({
      _handled: !claimed,
      _turn: freezeTurn({
        ...(this.#repository.applicationScopeKey
          ? { _application_scope_key: this.#repository.applicationScopeKey }
          : {}),
        _participant_id: resolved._participant._id,
        _channel_identity_id: resolved._identity._id,
        _conversation_id: conversation._id,
        _source_type: "channel",
        _source_id: message._channel_id,
        _source_conversation_id: message._external_conversation_id,
        _inbound_message_id: inbound._id,
      }),
    });
  }

  async prepareNativeChat(input: {
    _principal: TrustedXAuthPrincipal;
    _text: string;
    _conversation_id?: string;
  }): Promise<PreparedNativeTurn> {
    const participant = await this.#repository.resolveAuthenticatedParticipant({
      _user_id: input._principal._user_id,
      _account_id: input._principal._account_id,
    });
    const occurredAt = this.#now();
    const threadId = input._conversation_id ?? this.#localId();

    if (input._conversation_id) {
      const existing = await this.#repository.findConversation({
        _source_type: "xpell",
        _source_id: AGENT_CONSOLE_SOURCE_ID,
        _source_conversation_id: threadId,
      });
      this.requireOwnedNativeConversation(existing, participant._id);
    }

    const conversation = await this.#repository.resolveConversation({
      _source_type: "xpell",
      _source_id: AGENT_CONSOLE_SOURCE_ID,
      _source_conversation_id: threadId,
      _participant_id: participant._id,
      _activity_at: occurredAt,
    });

    const localMessageId = this.#localId();
    const dedupeKey = canonicalKey([
      "native-inbound",
      conversation._id,
      localMessageId,
    ]);
    const inbound = await this.#repository.addMessage({
      _id: deterministicId("native-inbound-message", dedupeKey),
      _conversation_id: conversation._id,
      _sender_participant_id: participant._id,
      _direction: "inbound",
      _text: input._text,
      _occurred_at: occurredAt,
      _dedupe_key: dedupeKey,
      _delivery_state: "received",
      _attempt_count: 1,
      _last_attempt_at: this.#now(),
    });
    const turn: NativeConversationTurn = freezeTurn({
      ...(this.#repository.applicationScopeKey
        ? { _application_scope_key: this.#repository.applicationScopeKey }
        : {}),
      _participant_id: participant._id,
      _conversation_id: conversation._id,
      _source_type: "xpell" as const,
      _source_id: AGENT_CONSOLE_SOURCE_ID as typeof AGENT_CONSOLE_SOURCE_ID,
      _source_conversation_id: threadId,
      _inbound_message_id: inbound._id,
    });

    return Object.freeze({
      _turn: turn,
      _actor: createAuthenticatedActorContext({
        _participant_id: participant._id,
        _principal: input._principal,
      }),
      _user_message: Object.freeze({
        _id: inbound._id,
        _role: "user" as const,
        _text: inbound._text,
        _created_at: iso(inbound._occurred_at),
      }),
    });
  }

  async nativeConversationForPrincipal(input: {
    _principal: TrustedXAuthPrincipal;
    _conversation_id: string;
  }): Promise<Readonly<{ _conversation_id: string; _participant_id: string }>> {
    const participant = await this.#repository.resolveAuthenticatedParticipant({
      _user_id: input._principal._user_id,
      _account_id: input._principal._account_id,
    });
    const conversation = await this.#repository.findConversation({
      _source_type: "xpell",
      _source_id: AGENT_CONSOLE_SOURCE_ID,
      _source_conversation_id: input._conversation_id,
    });
    const owned = this.requireOwnedNativeConversation(conversation, participant._id);
    return Object.freeze({ _conversation_id: owned._id, _participant_id: participant._id });
  }

  async createNativeConversation(input: {
    _principal: TrustedXAuthPrincipal;
    _request_id: string;
    _previous_conversation_id?: string;
  }): Promise<string> {
    const participant = await this.#repository.resolveAuthenticatedParticipant({
      _user_id: input._principal._user_id,
      _account_id: input._principal._account_id,
    });
    if (input._previous_conversation_id) {
      await this.nativeConversationForPrincipal({
        _principal: input._principal,
        _conversation_id: input._previous_conversation_id,
      });
    }
    const sourceConversationId = deterministicId(
      "native-new-conversation",
      canonicalKey([participant._id, input._request_id]),
    );
    const existing = await this.#repository.findConversation({
      _source_type: "xpell",
      _source_id: AGENT_CONSOLE_SOURCE_ID,
      _source_conversation_id: sourceConversationId,
    });
    if (existing) {
      this.requireOwnedNativeConversation(existing, participant._id);
      return sourceConversationId;
    }
    const created = await this.#repository.resolveConversation({
      _source_type: "xpell",
      _source_id: AGENT_CONSOLE_SOURCE_ID,
      _source_conversation_id: sourceConversationId,
      _participant_id: participant._id,
      _activity_at: this.#now(),
    });
    this.requireOwnedNativeConversation(created, participant._id);
    return sourceConversationId;
  }

  async completeInbound(
    turn: PersistedInboundConversationTurn,
    outcome: InboundCompletionOutcome,
  ): Promise<void> {
    assertApplicationScopeKey(
      this.#repository.applicationScopeKey,
      turn._application_scope_key,
    );
    await this.#repository.updateMessage(turn._inbound_message_id, {
      _delivery_state:
        outcome._status === "processed" ? "processed" : "processing_failed",
      _failure_code: outcome._status === "processing_failed" ? outcome._error._code : "",
    });
  }

  async completeNativeChat(
    turn: NativeConversationTurn,
    text: string,
  ): Promise<NativeTranscriptMessage> {
    await this.completeInbound(turn, { _status: "processed" });
    const occurredAt = this.#now();
    const localMessageId = this.#localId();
    const dedupeKey = canonicalKey([
      "native-outbound",
      turn._conversation_id,
      localMessageId,
    ]);
    const outbound = await this.#repository.addMessage({
      _id: deterministicId("native-outbound-message", dedupeKey),
      _conversation_id: turn._conversation_id,
      _direction: "outbound",
      _text: text,
      _occurred_at: occurredAt,
      _dedupe_key: dedupeKey,
      _delivery_state: "pending",
    });
    const acceptedAt = this.#now();
    await this.#repository.updateMessage(outbound._id, {
      _delivery_state: "accepted",
      _accepted_at: acceptedAt,
    });
    return Object.freeze({
      _id: outbound._id,
      _role: "assistant",
      _text: outbound._text,
      _created_at: iso(outbound._occurred_at),
    });
  }

  async failNativeChat(
    turn: NativeConversationTurn,
    code: string,
  ): Promise<void> {
    await this.completeInbound(turn, {
      _status: "processing_failed",
      _error: { _code: code, _message: "Native chat processing failed" },
    });
  }

  async listNativeTranscript(input: {
    _principal: TrustedXAuthPrincipal;
    _conversation_id: string;
  }): Promise<NativeTranscriptMessage[]> {
    const participant = await this.#repository.resolveAuthenticatedParticipant({
      _user_id: input._principal._user_id,
      _account_id: input._principal._account_id,
    });
    const conversation = await this.#repository.findConversation({
      _source_type: "xpell",
      _source_id: AGENT_CONSOLE_SOURCE_ID,
      _source_conversation_id: input._conversation_id,
    });
    const owned = this.requireOwnedNativeConversation(
      conversation,
      participant._id,
    );
    const records = await this.#repository.listMessageHistory({
      _conversation_id: owned._id,
      _limit: AGENT_CONSOLE_HISTORY_LIMIT,
    });
    return records
      .map(transcriptMessage)
      .filter((message): message is NativeTranscriptMessage => message !== null);
  }

  async prepareOutbound(
    current: ConversationTurnState | undefined,
    message: Readonly<XAgentOutboundMessage>,
  ): Promise<ConversationTurnState> {
    if (current) {
      assertApplicationScopeKey(
        this.#repository.applicationScopeKey,
        current._application_scope_key,
      );
      if (current._source_type !== "channel" ||
          current._source_id !== message._channel_id ||
          current._source_conversation_id !== message._external_conversation_id) {
        throw new StarterConversationError(
          "E_STARTER_OUTBOUND_RECIPIENT_SCOPE",
          "Outbound reply must use its originating Channel and conversation",
        );
      }
    }
    const now = this.#now();
    const conversation =
      current &&
      current._source_type === "channel" &&
      current._source_id === message._channel_id &&
      current._source_conversation_id === message._external_conversation_id
        ? { _id: current._conversation_id }
        : await this.#repository.resolveConversation({
            _source_type: "channel",
            _source_id: message._channel_id,
            _source_conversation_id: message._external_conversation_id,
            _activity_at: now,
          });
    const localId = current?._inbound_message_id ?? this.#localId();
    const dedupeKey = this.#repository.outboundDedupeKey(
      message._channel_id,
      message._external_conversation_id,
      localId,
    );
    const reply = message._reply_to_external_message_id
      ? await this.#repository.findMessageByExternalId(
          conversation._id,
          message._reply_to_external_message_id,
        )
      : null;
    const outbound = await this.#repository.addMessage({
      _id: deterministicId("outbound-message", dedupeKey),
      _conversation_id: conversation._id,
      _direction: "outbound",
      _text: message._text,
      _occurred_at: now,
      _dedupe_key: dedupeKey,
      _delivery_state: "pending",
      _channel_id: message._channel_id,
      _recipient_external_conversation_id: message._external_conversation_id,
      _attempt_count: 0,
      ...(current?._inbound_message_id
        ? { _origin_inbound_message_id: current._inbound_message_id }
        : {}),
      ...(current?._channel_identity_id
        ? { _recipient_channel_identity_id: current._channel_identity_id }
        : {}),
      ...(reply ? { _reply_to_message_id: reply._id } : {}),
      ...(message._reply_to_external_message_id
        ? { _reply_to_external_message_id: message._reply_to_external_message_id }
        : {}),
    });

    return freezeTurn({
      ...current,
      ...(this.#repository.applicationScopeKey
        ? { _application_scope_key: this.#repository.applicationScopeKey }
        : {}),
      _conversation_id: conversation._id,
      _source_type: "channel",
      _source_id: message._channel_id,
      _source_conversation_id: message._external_conversation_id,
      _outbound_message_id: outbound._id,
    });
  }

  async claimOutbound(turn: ConversationTurnState): Promise<void> {
    assertApplicationScopeKey(
      this.#repository.applicationScopeKey,
      turn._application_scope_key,
    );
    if (!turn._outbound_message_id || turn._source_type !== "channel") {
      throw new StarterConversationError(
        "E_STARTER_OUTBOUND_STATE",
        "Outbound conversation state is incomplete",
      );
    }
    await this.#repository.transitionOutboundMessage({
      _id: turn._outbound_message_id,
      _conversation_id: turn._conversation_id,
      _channel_id: turn._source_id,
      _recipient_external_conversation_id: turn._source_conversation_id,
      _expected_state: "pending",
      _updates: {
        _delivery_state: "sending",
        _attempt_count: 1,
        _last_attempt_at: this.#now(),
      },
    });
  }

  async completeOutbound(
    turn: ConversationTurnState,
    outcome: OutboundCompletionOutcome,
  ): Promise<void> {
    assertApplicationScopeKey(
      this.#repository.applicationScopeKey,
      turn._application_scope_key,
    );
    if (!turn._outbound_message_id) {
      throw new Error("Outbound conversation state is incomplete");
    }
    if (turn._source_type !== "channel") {
      throw new StarterConversationError(
        "E_STARTER_OUTBOUND_STATE",
        "Outbound conversation state is incomplete",
      );
    }
    const updates: Partial<MessageRecord> = outcome._status === "accepted"
      ? {
          _delivery_state: "accepted",
          _external_message_id: outcome._result._external_message_id,
          _accepted_at: new Date(outcome._result._accepted_at),
        }
      : {
          _delivery_state: outcome._error._category === "rejected" ||
            outcome._error._category === "rate_limited" ? "failed" : "uncertain",
          _failure_code: outcome._error._category === "rejected" ||
            outcome._error._category === "rate_limited"
            ? safeFailureCode({
                _category: outcome._error._category,
                _permanent: outcome._error._permanent,
                _retry_after_ms: outcome._error._retry_after_ms,
                _attempt_count: 1,
              }, this.#recoveryPolicy)
            : outcome._error._code,
          _last_error_at: this.#now(),
          _last_error_category: outcome._error._category ?? "unknown",
        };
    await this.#repository.transitionOutboundMessage({
      _id: turn._outbound_message_id,
      _conversation_id: turn._conversation_id,
      _channel_id: turn._source_id,
      _recipient_external_conversation_id: turn._source_conversation_id,
      _expected_state: "sending",
      _updates: updates,
    });
  }

  async listRecentMessageHistory(
    input: RecentMessageHistoryPageInput,
  ): Promise<MessageRecord[]> {
    return await this.#repository.listRecentMessageHistory(input);
  }

  async getConversationStats(input: {
    _actor: ActorContext;
    _conversation: PersistedInboundConversationTurn;
  }): Promise<Readonly<{ conversations: number; messages: number }>> {
    assertApplicationScopeKey(
      this.#repository.applicationScopeKey,
      input._conversation._application_scope_key,
    );
    if (
      input._actor._actor_type !== "authenticated" ||
      input._conversation._source_type !== "xpell" ||
      input._conversation._source_id !== AGENT_CONSOLE_SOURCE_ID ||
      input._conversation._participant_id !== input._actor._participant_id
    ) {
      throw new StarterConversationError(
        "E_STARTER_CAPABILITY_SCOPE_INVALID",
        "Conversation statistics are not available in this context",
      );
    }

    return await this.#repository.getConversationStats({
      _participant_id: input._actor._participant_id,
      _source_type: "xpell",
      _source_id: AGENT_CONSOLE_SOURCE_ID,
    });
  }

  resolveExternalActor(turn: InboundConversationTurn): ExternalActorContext {
    return createExternalActorContext({
      _participant_id: turn._participant_id,
      _channel_identity_id: turn._channel_identity_id,
    });
  }

  xaiIdempotencyKey(
    turn: PersistedInboundConversationTurn,
    phase: "initial" | "capability-result" | "capability-clarification" | "classification" | "action-verbalization" | "side-effect-routing" | "authoritative-read-routing" | "preparation-request" = "initial",
  ): string {
    return phase === "initial"
      ? canonicalKey(["xai-generation", turn._inbound_message_id])
      : canonicalKey([
          "xai-generation",
          turn._inbound_message_id,
          phase,
        ]);
  }

  private requireOwnedNativeConversation(
    conversation: ConversationRecord | null,
    participantId: string,
  ): ConversationRecord {
    if (!conversation) {
      throw new StarterConversationError(
        "E_STARTER_CONVERSATION_NOT_FOUND",
        "Conversation not found",
      );
    }
    if (!conversation._participant_ids.includes(participantId)) {
      throw new StarterConversationError(
        "E_STARTER_CONVERSATION_FORBIDDEN",
        "Conversation is not available to this caller",
      );
    }
    return conversation;
  }
}
