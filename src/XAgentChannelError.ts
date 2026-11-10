import { XError } from "@xpell/node";

export const XAGENT_CHANNEL_ERROR_CODES = {
  INVALID: "E_AGENT_CHANNEL_INVALID",
  DUPLICATE: "E_AGENT_CHANNEL_DUPLICATE",
  NOT_FOUND: "E_AGENT_CHANNEL_NOT_FOUND",
  NOT_READY: "E_AGENT_CHANNEL_NOT_READY",
  BAD_MESSAGE: "E_AGENT_CHANNEL_BAD_MESSAGE",
  SEND_FAILED: "E_AGENT_CHANNEL_SEND_FAILED",
  RECOVERY_NOT_AUTHORIZED: "E_AGENT_CHANNEL_RECOVERY_NOT_AUTHORIZED",
  MESSAGE_HANDLER_FAILED: "E_AGENT_MESSAGE_HANDLER_FAILED",
  MESSAGE_LIFECYCLE_FAILED: "E_AGENT_MESSAGE_LIFECYCLE_FAILED",
} as const;

export type XAgentChannelErrorCode =
  (typeof XAGENT_CHANNEL_ERROR_CODES)[keyof typeof XAGENT_CHANNEL_ERROR_CODES];

export class XAgentChannelError extends XError {
  constructor(
    code: XAgentChannelErrorCode,
    message: string,
    meta: Record<string, unknown> = {},
  ) {
    super(code, message, {
      _level: "warn",
      _meta: meta,
    });
  }
}
