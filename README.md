# @xpell/agent

## 2.0.8 release candidate

Target publication date: **13 November 2026**; this candidate has not been published.
Use the coordinated 2.0.8 runtime dependencies. See [CHANGELOG](./CHANGELOG.md)
for package changes and qualification limits; [LICENSE](./LICENSE) contains the MIT terms.

Agent runtime infrastructure for Xpell.

`@xpell/agent` provides `XAgent`, an XNode-hosted `XModule` that owns zero or
more provider Channel adapters. A Channel is a plain adapter owned by one
Agent; it is not an `XModule` and is not registered globally.

## Runtime model

```text
provider adapter
  -> bound XChannelRuntime.receive()
  -> _x.execute({ _module: agent_name, _op: "receive-message" })
  -> XAgent.onMessage()
  -> selected owned channel.send()
  -> provider
```

Inbound provider data enters the Agent through normal Xpell execution. Once the
Agent has selected an owned Channel, outbound delivery is a direct `send()` call
and does not re-enter `_x.execute`.

## Agent and Channel identity

An Agent's `_name` is both its stable identity and its Xpell module name.

Each Channel has:

- `_id`: the unique Channel instance ID within its owning Agent;
- `_provider`: the adapter/provider implementation type.

Multiple Channels on one Agent may use the same provider. For example,
`telegram-customers` and `telegram-owner` may both use `_provider: "telegram"`.
Duplicate Channel IDs are rejected. One Channel instance cannot be attached to
multiple Agents.

Channels may be supplied through `_channels` during Agent construction or with
`registerChannel()` before loading begins. Registration is rejected once the
Agent starts loading.

## Messages

The optional, type-only `XAgentPresentationProfile` and `XAgentUserPreferences`
contracts describe presentation and communication preferences. They do not
contain credentials, permission roles or a mandatory authentication identity.
Applications retain identity resolution, authorization, validation, persistence
and context composition. There is no automatic profile resolver, storage,
profile-management tool or dependency on XAuth/XDB/EntityManager in these types.
Existing Agent constructors, Channels and consumers work without using them.

A normalized inbound Channel message contains:

- `_external_user_id`;
- `_external_conversation_id`;
- `_external_message_id`;
- `_text`;
- optional `_timestamp`;
- optional `_reply_to_external_message_id`.

The bound Channel runtime injects `_channel_id`; provider input cannot select or
override it. The runtime then calls the owning Agent's `receive-message`
operation through `_x.execute`.

Override `onMessage()` to add Agent behavior. Returning `undefined` sends
nothing. Returning an `XChannelOutboundMessage` sends it through the same
Channel that delivered the inbound message.

```ts
import {
  XAgent,
  type XAgentInboundMessage,
  type XChannelOutboundMessage
} from "@xpell/agent";

class GreetingAgent extends XAgent {
  protected override async onMessage(
    message: XAgentInboundMessage
  ): Promise<XChannelOutboundMessage | void> {
    if (message._text !== "hello") return;

    return {
      _external_conversation_id: message._external_conversation_id,
      _text: "hi",
      _reply_to_external_message_id: message._external_message_id
    };
  }
}
```

For explicit outbound delivery, invoke `send-message` with `_channel_id`,
`_external_conversation_id`, `_text`, and an optional reply reference. A
successful result confirms provider acceptance and includes
`_external_message_id` and `_accepted_at`; it does not claim human delivery.

```ts
const response = await _x.execute({
  _module: "centrum",
  _op: "send-message",
  _params: {
    _channel_id: "web-chat",
    _external_conversation_id: "conversation-1",
    _text: "Hello"
  }
});
```

## Optional message lifecycle

An Agent may receive one construction-time `XAgentMessageLifecycle`. It lets an
external layer participate deterministically around behavior and provider
acceptance without adding persistence to `@xpell/agent`:

```text
beforeInbound
  -> onMessage
  -> afterInbound(processed | processing_failed)
  -> beforeSend
  -> Channel.send
  -> afterSend(accepted | send_failed)
```

The lifecycle is optional, observe-only, and cannot replace messages, alter
routing, choose a Channel, or manufacture a send result. `beforeInbound` may
return `{ _action: "handled" }` to stop already-handled input. In that case the
Agent returns its normal successful `null` result without calling `onMessage`,
`afterInbound`, or the outbound path.

```ts
import {
  XAgent,
  type XAgentMessageLifecycle
} from "@xpell/agent";

const lifecycle: XAgentMessageLifecycle = {
  async beforeInbound(_context, message) {
    // A real external layer would perform its own durable deduplication here.
    if (message._external_message_id === "known-duplicate") {
      return { _action: "handled" };
    }
  },
  async afterSend(_context, _message, outcome) {
    if (outcome._status === "accepted") {
      // Provider acceptance is available in outcome._result.
    }
  }
};

const agent = new XAgent({
  _name: "centrum",
  _message_lifecycle: lifecycle
});
```

Each inbound execution receives one immutable `XAgentMessageContext`; the same
object reference reaches all phases of its automatic response. Explicit
`send-message` calls receive independent contexts. `_origin` is `"inbound"` for
the former and `"explicit"` for the latter. An external lifecycle can associate
private per-execution state through a `WeakMap` without adding persistence IDs
or metadata to runtime message DTOs.

`afterSend({ _status: "accepted" })` means the provider accepted the message.
It does not mean the message was delivered, read, or seen. If the post-acceptance
lifecycle callback fails, the operation returns a safe lifecycle error that
explicitly records that provider acceptance already occurred.

## Lifecycle and discovery

Channel lifecycle is separate from Agent/XModule readiness:

```text
registered -> starting -> ready
                    \-> not_ready
ready -> stopped
```

Channel startup failures are isolated. A failed Channel does not prevent other
Channels from starting or the Agent module from becoming ready, and no automatic
retry is performed. `start()` and `stop()` implementations must be idempotent.
`stopChannels()` is an explicit teardown helper; it does not introduce or imply
a generic XNode module shutdown lifecycle.

An `XAgent` subclass that overrides `onLoad()` must call
`await super.onLoad()` so owned Channels remain part of the normal module load
lifecycle.

The Agent operations are:

- `status`: Agent module identity and readiness;
- `list-channels`: safe Agent-scoped Channel lifecycle information;
- `receive-message`: normalized inbound delivery;
- `send-message`: explicit outbound delivery through one owned Channel.

`list-channels` exposes only Channel ID, provider ID, lifecycle state, readiness,
and a safe error summary when applicable. It does not expose adapter config,
tokens, provider payloads, or raw provider errors.

## Current scope

The Agent runtime does not provide:

- Telegram, WhatsApp, or other production provider adapters;
- persistent conversations or messages;
- users or identity mapping;
- memory;
- XAI behavior;
- tools or actions;
- jobs;
- campaigns;
- application capability installation.

Runtime message DTOs are transient boundary data, not application entities.
The optional message lifecycle is a generic sequencing boundary, not a
persistence implementation.

## Development

```bash
pnpm build
pnpm test
```

The acceptance suite uses a test-only `FakeChannel`. It performs no network,
persistence, XDB, XAI, timer, or background work.

## License

MIT
