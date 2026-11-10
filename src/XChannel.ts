import type { XResponseData } from "@xpell/node";

export type XChannelLifecycleStatus =
  | "registered"
  | "starting"
  | "ready"
  | "not_ready"
  | "stopped";

export type XChannelStatusData = {
  _id: string;
  _provider: string;
  _status: XChannelLifecycleStatus;
  _ready: boolean;
  _error?: {
    _code: string;
    _message: string;
  };
};

export type XChannelInboundMessage = {
  _external_user_id: string;
  _external_conversation_id: string;
  _external_message_id: string;
  _text: string;
  _timestamp?: number;
  _reply_to_external_message_id?: string;
};

export type XAgentInboundMessage = XChannelInboundMessage & {
  _channel_id: string;
};

export type XChannelOutboundMessage = {
  _external_conversation_id: string;
  _text: string;
  _reply_to_external_message_id?: string;
};

export type XAgentOutboundMessage = XChannelOutboundMessage & {
  _channel_id: string;
};

export type XChannelSendResult = {
  _accepted: true;
  _external_message_id: string;
  _accepted_at: number;
};

export type XChannelRuntime = {
  receive(message: XChannelInboundMessage): Promise<XResponseData>;
};

/**
 * Provider adapter owned by exactly one XAgent.
 *
 * Implementations must make start() and stop() safe to call repeatedly and
 * must expose lifecycle state without provider secrets or raw errors.
 */
export interface XChannel {
  readonly _id: string;
  readonly _provider: string;

  start(runtime: XChannelRuntime): Promise<void> | void;
  stop(): Promise<void> | void;
  getStatus(): XChannelStatusData;
  send(message: XChannelOutboundMessage): Promise<XChannelSendResult>;
  /** Optional read-only policy gate for an already persisted reply. */
  authorizeRecovery?(message: Readonly<XChannelOutboundMessage>): boolean | Promise<boolean>;
}
