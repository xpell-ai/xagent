# AGENTS.md — `@xpell/agent`

Apply this file as a strict package contract for every change under
`packages/xagent`.

## Required Codex Skills

Before changing this package, apply:

- `xpell-contract`
- `xagent`

Also apply `xpell-core` or the XNode contract when a task genuinely crosses
those package boundaries. A higher-layer task must not weaken the rules in
this file.

## Authority

Use this order of authority:

1. Current `packages/xagent/src/` implementation.
2. Current `packages/xagent/tests/` behavior.
3. `packages/xagent/package.json` and public exports in `src/index.ts`.
4. This contract and the `xagent` skill.
5. `packages/xagent/README.md`.

If documentation and implementation differ, follow the implementation and
tests, then update the documentation deliberately.

Use this package for runtime architecture. The current `/xpell-agent` is the
application Starter and is authoritative for its orchestration, persistence and
plugin contracts, not package APIs. Do not copy its removed legacy implementation
or move product policy into this package.

## Package Role

`@xpell/agent` is the provider-neutral Agent runtime for XNode.

```text
@xpell/core
      ↓
@xpell/node
      ↓
@xpell/agent
      ↓
@xpell/agent-channels
      ↓
Agent application / product
```

The manifest is authoritative: `@xpell/agent` peer-depends on `@xpell/node`.
XNode must not depend on this package, and this package must not depend on a
provider implementation.

This package owns:

- `XAgent` as an XNode-hosted `XModule`;
- generic Channel contracts and normalized message DTOs;
- Agent-scoped Channel ownership and status;
- inbound and outbound Agent operations;
- the deterministic message lifecycle boundary;
- safe Agent/Channel error normalization.

This package does not own:

- Telegram, WhatsApp, Messenger, Instagram, or other providers;
- HTTP/webhook route registration;
- XDB persistence or repositories;
- users, customers, participants, identity mapping, or XAuth principals;
- conversations, persistent messages, history, or memory;
- XAI behavior, tools, actions, jobs, campaigns, queues, or schedulers;
- capability installation or application artifact packs.

## XAgent Contract

`XAgent` must remain the only XModule in this package. Its `_name` is both the
stable Agent identity and the Xpell module name.

Agent, Channel, and provider identities use lowercase kebab-case.

Construction may accept only the current `XAgentData` surface:

```ts
type XAgentData = XModuleData & {
  _description?: string;
  _version?: string;
  _channels?: readonly XChannel[];
  _message_lifecycle?: XAgentMessageLifecycle;
};
```

Keep these lifecycle rules:

- Agent state is `created → starting → ready` through normal XModule loading.
- An Agent with zero Channels is valid.
- Construction-time Channel registration is supported.
- `registerChannel()` is allowed only before loading begins.
- Duplicate Channel IDs within one Agent fail.
- One Channel adapter instance belongs to exactly one Agent.
- Multiple Channels may share the same `_provider`.
- One Channel startup failure must not prevent other Channels or the Agent
  module from becoming ready.
- Agent readiness must not be redefined by Channel readiness.
- `stopChannels()` is explicit; do not invent an XModule unload lifecycle.

Extend behavior only through the current protected hook:

```ts
protected async onMessage(
  message: XAgentInboundMessage,
  context: XAgentMessageContext,
): Promise<XChannelOutboundMessage | void>
```

Returning `undefined` sends no response. Do not place persistence, identity
resolution, XAI, tools, or product business logic in the default base class.

## XChannel Contract

Channels are plain provider adapters owned by one Agent. They are not XModules
and must never enter a global module or Channel registry.

```ts
interface XChannel {
  readonly _id: string;
  readonly _provider: string;
  start(runtime: XChannelRuntime): Promise<void> | void;
  stop(): Promise<void> | void;
  getStatus(): XChannelStatusData;
  send(message: XChannelOutboundMessage): Promise<XChannelSendResult>;
}
```

`_id` identifies an adapter instance within one Agent. `_provider` identifies
the provider implementation type. They are separate concepts.

The Channel lifecycle is:

```text
registered → starting → ready
                    ↘ not_ready
ready → stopped
```

Channel implementations must make `start()` and `stop()` safe when repeated,
must not retry automatically, and must expose only safe status errors. Never
include tokens, secrets, raw provider payloads, response bodies, or raw errors
in public status.

## Inbound Routing

The required path is:

```text
provider
→ provider Channel
→ normalize to XChannelInboundMessage
→ bound XChannelRuntime.receive()
→ inject bound _channel_id
→ _x.execute({ _module: agent_name, _op: "receive-message" })
→ XAgent
→ onMessage()
```

Provider input must not choose `_channel_id`. The runtime created for one
owned Channel injects its bound identity and copies only normalized fields.
This is a trust boundary.

Provider ingress must not call an Agent instance directly. External ingress
uses `_x.execute` so normal Xpell module discovery, operation dispatch, and
response/error behavior remain authoritative.

The normalized inbound DTO contains only:

- `_external_user_id`;
- `_external_conversation_id`;
- `_external_message_id`;
- `_text`;
- optional `_timestamp`;
- optional `_reply_to_external_message_id`.

`XAgentInboundMessage` adds `_channel_id` at the trusted Agent boundary. Do
not add raw payloads, arbitrary metadata bags, profiles, attachments, customer
IDs, user entity IDs, or conversation entity IDs without an explicit contract
change.

## Outbound Routing

Automatic responses use the originating Channel:

```text
onMessage()
→ XAgent canonical send path
→ originating owned Channel.send()
→ provider
```

Explicit sends use the selected Channel:

```text
_x.execute({ _module: agent_name, _op: "send-message" })
→ XAgent canonical send path
→ selected owned Channel.send()
→ provider
```

Both paths must share the same canonical Agent send behavior. After ownership
and readiness validation, outbound delivery calls the adapter directly. Do
not route Agent-to-Channel delivery through `_x.execute` or XEM.

The provider-facing outbound DTO contains only:

- `_external_conversation_id`;
- `_text`;
- optional `_reply_to_external_message_id`.

`XAgentOutboundMessage` adds Agent-only `_channel_id`. Remove that routing
field before `channel.send()`.

A successful result is provider acceptance:

```ts
type XChannelSendResult = {
  _accepted: true;
  _external_message_id: string;
  _accepted_at: number;
};
```

Provider acceptance is not human delivery, reading, or engagement.

## Runtime Operations

Keep the current operation surface:

- `status`;
- `list-channels`;
- `receive-message`;
- `send-message`.

Operations must use normal XModule dispatch and return structured Xpell
responses through `XResponseOK` or `XResponseError`. Never silently return
`false` for failures.

`list-channels` is Agent-scoped and may expose only safe ID, provider,
lifecycle, readiness, and sanitized error information.

## Message Lifecycle V0.2

An Agent may receive one optional construction-time
`XAgentMessageLifecycle`. Do not add callback registries or dynamic lifecycle
installation without a deliberate API revision.

The callbacks are:

- `beforeInbound`;
- `afterInbound`;
- `beforeSend`;
- `afterSend`.

Required ordering for inbound work with a response:

```text
beforeInbound
→ onMessage
→ afterInbound(processed)
→ beforeSend
→ Channel.send
→ afterSend(accepted | send_failed)
```

No-response inbound work ends after `afterInbound`. Explicit outbound work
runs `beforeSend → Channel.send → afterSend`.

`beforeInbound` may return only `{ _action: "handled" }` as control. That
short-circuits the handler, `afterInbound`, and send while returning successful
null processing.

One frozen `XAgentMessageContext` exists per inbound execution. Automatic
outbound callbacks reuse the exact same context reference. Explicit sends get
a separate context.

```ts
type XAgentMessageContext = Readonly<{
  _agent_name: string;
  _origin: "inbound" | "explicit";
}>;
```

Do not add persistence/domain IDs to this context. An application lifecycle
implementation may associate its own state through
`WeakMap<XAgentMessageContext, AppSpecificState>`.

The lifecycle is an awaited deterministic integration seam. It is not
persistence. Do not use XEM for authoritative message processing.

## Error Contract

Preserve the current safe error vocabulary:

- `E_AGENT_CHANNEL_INVALID`;
- `E_AGENT_CHANNEL_DUPLICATE`;
- `E_AGENT_CHANNEL_NOT_FOUND`;
- `E_AGENT_CHANNEL_NOT_READY`;
- `E_AGENT_CHANNEL_BAD_MESSAGE`;
- `E_AGENT_CHANNEL_SEND_FAILED`;
- `E_AGENT_MESSAGE_HANDLER_FAILED`;
- `E_AGENT_MESSAGE_LIFECYCLE_FAILED`.

Preserve precedence:

- handler failure remains authoritative even if failure observation fails;
- provider send failure remains authoritative even if its failure observer
  fails;
- `beforeSend` failure means the provider is not called;
- successful provider acceptance followed by `afterSend` failure is a
  lifecycle failure, not a provider send failure;
- safe acceptance metadata remains available when the provider already
  accepted the message.

Never expose provider credentials, raw payloads, raw response bodies, or
unsafe causes through public Xpell errors.

## XNode Boundary

XAgent is loaded like any application XModule:

```ts
await node.start({
  _modules: [agent],
});
```

Provider webhook routes belong to provider/application composition through
generic XNode `_routes` and `XWebRouteContributor`. Do not add HTTP routes,
webhook dispatch, or provider knowledge to this package. Do not modify XNode
to know about XAgent.

## Persistence, Auth, and Memory Boundaries

Persistent conversational artifacts belong to the application Starter, not
this package. The current Starter owns `conversation_participant`,
`channel_identity`, `conversation`, `message`, and protected `agent_action` audit
records; product entities such as `customer` belong to application plugins.
These are not `@xpell/agent` APIs.

Keep these distinctions explicit:

- XAuth principals are authentication/authorization state.
- External messaging customers are not automatically XAuth users.
- Channel identities are not authentication identities.
- Conversation history is not derived customer memory/preferences.
- Neither is Agent runtime/working memory.

Installing `@xpell/agent` creates none of these systems.

## Test Contract

Use `tests/fake-channel.mjs` only as a test helper. Do not export it from the
production package.

Tests must preserve at least:

- zero-Channel loading;
- construction-time and pre-load registration;
- duplicate ID and cross-Agent ownership rejection;
- same-provider multiple Channels;
- lifecycle isolation and status discovery;
- bound runtime `_channel_id` injection and `_x.execute` ingress;
- normalized ID preservation;
- automatic reply through the originating Channel;
- explicit Channel selection;
- no-response behavior;
- safe unknown/not-ready/send/handler/lifecycle failures;
- exact lifecycle ordering, context identity, and error precedence;
- XNode module registration.

Use injected dependencies in provider-package tests. Do not require network,
persistence, timers, or background jobs for Agent runtime tests.

## Verification

Run the narrowest relevant commands from `packages/xagent`:

```bash
pnpm build
pnpm test
```

For public API changes, also verify:

- `src/index.ts` exports;
- `tests/consumer.ts` type consumption;
- `README.md` implemented behavior;
- package metadata when the surface or compatibility changes.

Do not publish or change package versions unless the task explicitly requests
it.

## Forbidden Architecture

Do not introduce:

- a second Agent runtime around XNode;
- `ChannelsModule`, Channel XModules, or a global Channel registry;
- XEM-based authoritative message routing;
- provider-specific code in `@xpell/agent`;
- implicit persistence, users, conversations, identity mapping, or memory;
- automatic XAuth user creation for external customers;
- hidden polling, timers, workers, retries, queues, or schedulers;
- legacy `AgentRuntime`, `UsersModule`, `TelegramConnectorModule`, AIME, or
  obsolete custom flow/auth/settings architecture;
- assumptions copied from the removed legacy Starter implementation.

## Change Discipline

- Inspect current source and tests before changing API-sensitive behavior.
- Preserve `_snake_case` runtime fields and Xpell command conventions.
- Prefer the smallest auditable change at the owning layer.
- Add tests for behavioral changes before expanding documentation claims.
- Keep README and this contract aligned with implemented behavior.
- Mark future directions as planned; never describe them as existing APIs.
