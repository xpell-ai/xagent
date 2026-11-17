export const ENTITY_IDS = {
  PARTICIPANT: "conversation_participant",
  CHANNEL_IDENTITY: "channel_identity",
  CONVERSATION: "conversation",
  MESSAGE: "message",
} as const;

export type EntityId = (typeof ENTITY_IDS)[keyof typeof ENTITY_IDS];
export type RuntimeDate = Date | string;

/** Internal EntityManager discriminator; absent for legacy unscoped records. */
export type AgentScopedRecord = {
  _application_scope_key?: string;
};

export type ConversationParticipantRecord = AgentScopedRecord & {
  _id: string;
  _created_at?: RuntimeDate;
  _updated_at?: RuntimeDate;
  _auth_principal_key?: string;
  _auth_user_id?: string;
  _auth_account_id?: string;
};

export type ChannelIdentityRecord = AgentScopedRecord & {
  _id: string;
  _identity_key: string;
  _channel_id: string;
  _external_user_id: string;
  _participant_id: string;
  _last_seen_at: RuntimeDate;
  _created_at?: RuntimeDate;
  _updated_at?: RuntimeDate;
};

export type ConversationSourceType = "channel" | "xpell";

export type ConversationSource = {
  _source_type: ConversationSourceType;
  _source_id: string;
  _source_conversation_id: string;
};

export type ConversationRecord = AgentScopedRecord & {
  _id: string;
  _conversation_key: string;
  _source_type: ConversationSourceType;
  _source_id: string;
  _source_conversation_id: string;
  _participant_ids: string[];
  _started_at: RuntimeDate;
  _last_activity_at: RuntimeDate;
  _created_at?: RuntimeDate;
  _updated_at?: RuntimeDate;
};

export type MessageDirection = "inbound" | "outbound";
export type MessageDeliveryState =
  | "received"
  | "processed"
  | "processing_failed"
  | "pending"
  | "sending"
  | "accepted"
  | "failed"
  | "uncertain"
  /** Legacy state; its provider outcome is not provably definitive. */
  | "send_failed";

export type MessageRecord = AgentScopedRecord & {
  _id: string;
  _conversation_id: string;
  _sender_participant_id?: string;
  _direction: MessageDirection;
  _text: string;
  _occurred_at: RuntimeDate;
  _history_key: string;
  _dedupe_key: string;
  _delivery_state: MessageDeliveryState;
  _origin_inbound_message_id?: string;
  _channel_id?: string;
  _recipient_external_conversation_id?: string;
  _recipient_channel_identity_id?: string;
  _attempt_count?: number;
  _last_attempt_at?: RuntimeDate;
  _last_error_at?: RuntimeDate;
  _last_error_category?: "rejected" | "rate_limited" | "unknown" | "interrupted";
  _external_message_id?: string;
  _reply_to_message_id?: string;
  _reply_to_external_message_id?: string;
  _accepted_at?: RuntimeDate;
  _failure_code?: string;
  _created_at?: RuntimeDate;
  _updated_at?: RuntimeDate;
};

export type NewMessageRecord = Omit<MessageRecord, "_history_key"> & {
  _history_key?: string;
};

export type EntityRecordMap = {
  conversation_participant: ConversationParticipantRecord;
  channel_identity: ChannelIdentityRecord;
  conversation: ConversationRecord;
  message: MessageRecord;
};
