/**
 * @xpell/agent
 *
 * Agent runtime infrastructure for Xpell.
 *
 * Minimal agent runtime primitives for XNode applications.
 */

export {
  XAgent,
  XAGENT_OPS,
  XAGENT_SKILL,
  type XAgentData,
  type XAgentRuntimeStatus,
  type XAgentStatusData,
} from "./XAgent.js";

export {
  XAGENT_CHANNEL_ERROR_CODES,
  XAgentChannelError,
  type XAgentChannelErrorCode,
} from "./XAgentChannelError.js";

export {
  XChannelSendFailure,
  type XChannelSendFailureCategory,
} from "./XChannelSendFailure.js";

export type {
  XAgentMessageContext,
  XAgentMessageLifecycle,
} from "./XAgentMessageLifecycle.js";

export type {
  XAgentPresentationProfile,
  XAgentUserPreferences,
  XAgentGrammaticalAddress,
} from "./XAgentProfiles.js";

export type {
  XAgentInboundMessage,
  XAgentOutboundMessage,
  XChannel,
  XChannelInboundMessage,
  XChannelLifecycleStatus,
  XChannelOutboundMessage,
  XChannelRuntime,
  XChannelSendResult,
  XChannelStatusData,
} from "./XChannel.js";
