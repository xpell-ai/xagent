import type { AgentScopedRecord, RuntimeDate } from "../persistence/types.js";
export type { RuntimeDate } from "../persistence/types.js";
export const ENTITY_IDS = { ACTION: "agent_action" } as const;

export type AgentActionState =
  | "pending"
  | "confirmed"
  | "executing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type AgentActionRecord = AgentScopedRecord & {
  _id: string;
  _capability_id: string;
  _capability_revision: string;
  _state: AgentActionState;
  _arguments: Record<string, unknown>;
  _authorized_scope: Record<string, unknown>;
  _confirmation_summary: string;
  _binding_hash: string;
  _requester_participant_id: string;
  _conversation_id: string;
  _request_message_id: string;
  _expires_at: RuntimeDate;
  _confirmed_by_participant_id?: string;
  _confirmation_message_id?: string;
  _confirmed_at?: RuntimeDate;
  _execution_started_at?: RuntimeDate;
  _completed_at?: RuntimeDate;
  _result?: Record<string, unknown>;
  _failure_code?: string;
  _cancelled_by_participant_id?: string;
  _created_at?: RuntimeDate;
  _updated_at?: RuntimeDate;
};
