import type {
  XAgentInboundMessage,
  XAgentOutboundMessage,
  XChannelSendResult,
} from "./XChannel.js";
import type { XChannelSendFailureCategory } from "./XChannelSendFailure.js";

/** Stable identity for one inbound or explicit outbound Agent execution. */
export type XAgentMessageContext = Readonly<{
  _agent_name: string;
  _origin: "inbound" | "explicit";
}>;

/**
 * Optional observer/controller around Agent message processing and delivery.
 *
 * Message views are immutable. The only control result is the inbound
 * `handled` short-circuit; all routing and provider results remain owned by
 * XAgent.
 */
export interface XAgentMessageLifecycle {
  beforeInbound?(
    context: XAgentMessageContext,
    message: Readonly<XAgentInboundMessage>,
  ):
    | void
    | { readonly _action: "handled" }
    | Promise<void | { readonly _action: "handled" }>;

  afterInbound?(
    context: XAgentMessageContext,
    message: Readonly<XAgentInboundMessage>,
    outcome:
      | Readonly<{ _status: "processed" }>
      | Readonly<{
          _status: "processing_failed";
          _error: Readonly<{
            _code: string;
            _message: string;
          }>;
        }>,
  ): void | Promise<void>;

  beforeSend?(
    context: XAgentMessageContext,
    message: Readonly<XAgentOutboundMessage>,
  ): void | Promise<void>;

  /** Last application-owned gate before the Channel is invoked. */
  beforeChannelSend?(
    context: XAgentMessageContext,
    message: Readonly<XAgentOutboundMessage>,
  ): void | Promise<void>;

  afterSend?(
    context: XAgentMessageContext,
    message: Readonly<XAgentOutboundMessage>,
    outcome:
      | Readonly<{
          _status: "accepted";
          _result: Readonly<XChannelSendResult>;
        }>
      | Readonly<{
          _status: "send_failed";
          _error: Readonly<{
            _code: string;
            _message: string;
            _category?: XChannelSendFailureCategory;
            _retry_after_ms?: number;
            _permanent?: boolean;
          }>;
        }>,
  ): void | Promise<void>;
}
