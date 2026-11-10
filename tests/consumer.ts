import {
  XAgent,
  type XAgentInboundMessage,
  type XAgentMessageLifecycle,
  type XChannel,
  type XChannelOutboundMessage,
  type XChannelRuntime,
  type XChannelSendResult,
  type XChannelStatusData,
  type XAgentPresentationProfile,
  type XAgentUserPreferences,
} from "@xpell/agent";
import { XNode } from "@xpell/node";

class ConsumerChannel implements XChannel {
  readonly _id = "consumer-channel";
  readonly _provider = "consumer";

  start(_runtime: XChannelRuntime): void {}
  stop(): void {}
  getStatus(): XChannelStatusData {
    return {
      _id: this._id,
      _provider: this._provider,
      _status: "ready",
      _ready: true,
    };
  }
  async send(_message: XChannelOutboundMessage): Promise<XChannelSendResult> {
    return {
      _accepted: true,
      _external_message_id: "consumer-message",
      _accepted_at: 1,
    };
  }
}

class ConsumerAgent extends XAgent {
  protected override async onMessage(
    message: XAgentInboundMessage,
  ): Promise<XChannelOutboundMessage> {
    return {
      _external_conversation_id: message._external_conversation_id,
      _text: "received",
    };
  }
}

const lifecycle: XAgentMessageLifecycle = {
  beforeInbound(context, message) {
    // @ts-expect-error lifecycle context is read-only
    context._origin = "explicit";
    // @ts-expect-error lifecycle message views are read-only
    message._text = "changed";
  },
  beforeSend(_context, message) {
    // @ts-expect-error lifecycle outbound views are read-only
    message._channel_id = "other-channel";
  },
};

const agent = new ConsumerAgent({
  _name: "consumer-agent",
  _channels: [new ConsumerChannel()],
  _message_lifecycle: lifecycle,
});
const node = new XNode();

void agent;
void node;

const presentation: XAgentPresentationProfile = { display_name: "Business helper" };
const preferences: XAgentUserPreferences = { grammatical_address: "neutral" };
// @ts-expect-error profile presentation is immutable data
presentation.display_name = "changed";
// @ts-expect-error preferences cannot express authorization roles
preferences.roles = ["owner"];
// @ts-expect-error grammatical address is a bounded, domain-neutral value
const invalidPreferences: XAgentUserPreferences = { grammatical_address: "administrator" };
void invalidPreferences;
