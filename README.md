# @xpell/agent

## Neutral reference consumer (source artifact only)

`examples/reference-agent/` is a six-authored-file ESM/TypeScript consumer of
the existing public ADK APIs. Its definition selects a mock model and an owned
mock Channel; the installed package supplies the runtime. The entrypoint makes
one synthetic turn using a fresh disposable directory and an ephemeral loopback
listener, closes the Agent, and removes only that directory. It loads no `.env`
and needs no credential. Node 22 and 24 are the qualification targets.

This is a review sample, not a published-npm quickstart. Published
`@xpell/agent@2.0.8` lacks ADK exports. The sample intentionally depends on
`file:artifacts/xpell-agent-2.0.8.tgz`; that **unpublished source-built artifact is
not committed or downloaded automatically**. Obtain the reviewed artifact through
an approved channel. Its SHA-256 must be
`0b2d54d2184caaff717c58d900981f4e5ab084d7aab74dc6bddb72aad6cf8011`.
It was built from `c9d398f755e2aeee7eb7dff0a05ca311cfef6d40`, whose tree
`85efdf58d06fd162210f47165368feecd75bef24` matches merged commit
`f6437b4a29ef9f74c000606960b5c4456a33fa38`. The manifest records this pin;
the lock pins the local archive integrity and all registry dependencies.

Place that exact archive at
`examples/reference-agent/artifacts/xpell-agent-2.0.8.tgz`. Verify its checksum
before installation, then from `examples/reference-agent/`:

```sh
shasum -a 256 artifacts/xpell-agent-2.0.8.tgz
npm ci --no-audit --no-fund
npm run build
npm run typecheck
npm test
npm start
```

Clean offline reproduction uses `npm ci --offline` with a separately prepared
dependency cache and matching native SQLite build prerequisites/Node headers.
Initial registry/cache preparation requires network access. It is not a model
call. Native dependencies must be installed separately for each Node ABI; do not
reuse or rebuild an active application's `node_modules`. The npm 11 script
allowlist permits only the locked `better-sqlite3@12.11.1` native install.

The dependency direction is this sample → `@xpell/agent` → required
`@xpell/node@2.0.8` peer → Core/host/storage dependencies. TypeScript and Node types
are development dependencies. Router providers, Channels and browser UI are not
installed by this sample. Tests check public T1–T4 export availability, the mock
lifecycle, denied optional Read/plugin composition, and entrypoint exit; they do
not qualify live Router/provider behavior or durable Action execution. A trusted
context is not authentication, and plugin registration is not a permission grant.
The default Foundation still accepts only `_plugins: []`; the optional registry
fixture is composed independently. No Host Facade, duplicated host/storage/tool
engine, product logic, migration or deployment is included. Artifact/lock updates
require review; this dependency must not be replaced with registry 2.0.8 until a
separately approved release actually contains the required exports.

## Optional Agent Plugins review candidate

The additive `@xpell/agent/adk/plugins` subpath provides explicit typed plugin
registration, exact compatibility declarations, host/agent grants, lifecycle
cleanup and policy-decorated T1/T2 contributions. It installs/loads no code and
starts no host/model. Trusted in-process plugins are not a sandbox or IAM.
See [the API and offline runbook](docs/agent-plugins.md) and the neutral
`examples/agent-plugins.mjs` two-plugin example. Existing APIs and Action consent
remain unchanged. OAuth is design-only; no release or live integration is included.

## Durable Actions review candidate

The separate opt-in `@xpell/agent/adk/actions` subpath adds an explicit trusted
prepare/confirm/cancel lifecycle, SQLite conditional execution claims and
receipt-only reconciliation. It uses a fresh Action profile, WAL/FULL and a
distinct marker. Existing Foundation, Conversations, Router and read-tool
interfaces remain unchanged. See [the API and offline runbook](docs/durable-actions.md)
and `examples/durable-actions.mjs`. No model loop, IAM service, migration or
release is included. This subpath is unpublished.

Prepare/replay returns proposal metadata only; status and retained outcomes need
authorized inspection. Arguments are snapshotted and validated before callbacks,
and prepared-resource policy refusal retains the safe denial code.

## Read-tool registry review candidate

The separate opt-in `@xpell/agent/adk/tools` subpath adds typed read definitions,
registry-bound trusted contexts, deny-by-default policy, bounded cooperative
execution and process-local replay receipts. It starts no host/model/storage.
See [read tools](docs/read-tools.md) and the neutral
`examples/read-tools.mjs` example. Existing Foundation, durable and text Router
interfaces remain unchanged; no model tool loop, durable Actions, IAM, plugin
loading or release is included. This subpath is an unpublished review candidate.

## Router chat review candidate

The opt-in `createRouterAgent` / `routerTextModel` facade sends bounded durable
conversation context through existing XNode XAI and AimeProvider. It adds a local
programmatic `chat` API and CLI, with no new chat HTTP route. Explicit endpoint,
model, credential environment reference, timeout, request consent and fail-closed
policy are required. Install optional peer `@xpell/xai-providers@2.0.8` only for
Router mode; the existing mock APIs remain unchanged. No published package
contains this candidate.

See the [Yehudit local chat runbook](docs/router-chat-runbook.md) for a reproducible
offline fixture, fresh-process restart, safe error codes, ownership limits and
the separately gated live procedure. No live/paid call is authorized by the
runbook. No tools/Actions, IAM service, retry worker or package release is added.

## Opt-in ADK Foundation Phase 1 (unpublished local candidate)

`@xpell/agent/adk` adds a headless, zero-plugin composition facade. The root
exports and `new XAgent(data)` remain unchanged. This subpath is new local
work and is **not available from the already published 2.0.8 package**.

```js
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, mockChannel, mockTextModel } from "@xpell/agent/adk";

const parent = await mkdtemp(join(tmpdir(), "xagent-hello-"));
const app = createAgent({
  _name: "hello-agent",
  _model: mockTextModel({ _text: "Hello from the mock" }),
  _channel: mockChannel({ _id: "local" }),
  _host: {
    _work_folder: join(parent, "runtime"),
    _listen: { _host: "127.0.0.1", _port: 0 },
  },
  _plugins: [],
});
try {
  await app.start();
  console.log(await app.testTurn({ _text: "hello" }));
} finally {
  try { await app.close(); }
  finally { await rm(parent, { recursive: true, force: true }); }
}
```

After building the checked-out package with `pnpm run build`, run
`node examples/hello-agent.mjs`. Expected output includes
`Hello from the mock` alongside XNode startup messages. A reviewed local
tarball can be exercised in a separate empty directory:

```sh
npm install /absolute/path/to/reviewed-xpell-agent.tgz
npm ls @xpell/agent @xpell/node @xpell/core --all
node node_modules/@xpell/agent/examples/hello-agent.mjs
```

That is candidate-tarball qualification, not a published ADK installation.
Development manifests use workspace peers; packaging must resolve that peer
to the coordinated runtime version, as existing release tooling does.
`@xpell/node` remains the required peer (2.0.8 in this qualification); modern
npm normally installs peers, while other package managers/settings may require
an explicit peer install. No dependency or peer range is changed by Phase 1.
The published baseline can be checked separately with a clean
`npm install @xpell/agent`: 2.0.8 resolves the required XNode 2.0.8 peer, but
does not contain this unpublished ADK subpath. Clean candidate-tarball and
registry-baseline installs are separate qualification cases.

Use one compatible ESM XNode/Core dependency graph. `--force`,
`--legacy-peer-deps`, mismatched peers, duplicate runtime copies and mixing
Core's CommonJS and ESM entry points are outside this profile. Core's current
import/require entries can create separate engine objects even at the same
version. A successful install alone does not verify runtime identity:
`tests/peer.test.mjs` checks the required peer, Agent/consumer XNode identity,
the peer's ESM Core identity and the Agent's ESM-only entry boundary. No
process-global duplicate-runtime guard or CommonJS bridge is introduced.
XNode still brings its existing core, node-core, Vibe, MCP, file-service,
Express, WebSocket, Mongo and native `better-sqlite3` dependencies. Optional
plugin usage does not remove these current host dependencies.

### Foundation ownership and limits

- Construction validates and snapshots configuration without starting Core,
  creating files, registering providers or opening listeners.
- `start()` creates the supplied absolute work folder exclusively; its parent
  must already exist. Existing folders, files and symlinks are refused. XNode
  writes its normal host setup files only inside that fresh folder. No Agent
  conversation store, schema migration, memory-backend promise or old store
  adoption is introduced.
- XNode currently opens HTTP even for a headless application. `_listen` is
  therefore required, with an explicit `127.0.0.1` or `::1` address and port
  (`0` requests an ephemeral port). Wormholes and TLS are disabled for this
  fixture profile. Headless means no Console/UI; it does not mean listener-free.
  A listener-free host requires a separately approved XNode change.
- Exactly one XAgent owns the configured mock Channel. `testTurn` generates
  synthetic fixture identities, calls its bound Channel runtime and enters
  `_x.execute(receive-message)`. The Agent generates the configured fixed mock
  text; outbound delivery calls the owned Channel directly. This is a local
  fixture, not an XAI provider or a production model abstraction. No external
  provider imports, provider registration or paid calls occur.
- Start is idempotent while live. Close immediately fences new turns, drains
  already accepted mock turns, stops Channels and closes XNode. Repeated close
  is idempotent; partial startup is cleaned up. Closing during startup also
  fences XNode. Arbitrary third-party hooks are not supported.
- A rejected competing facade does not close another host. XNode retains its
  existing global Core ownership and terminal-shutdown rules: one host per
  fresh process, including when creating another facade after close. A failed
  start is terminal for that facade. Work files are retained after close;
  only the example explicitly removes its own temporary parent.
- `_plugins` may be omitted or `[]`; nonempty plugins and unknown configuration
  fields are rejected. There is no new IAM, Principal/Group/Admin service,
  authentication, tools/Actions host, secret vault, plugin installer/grants,
  Router setup, external Channel, XNet integration or durable Agent history.
  Existing Starter/product orchestration remains application-owned.

Node 22+ is required by the existing package. Node 22 and 24 qualification
must use separate fresh dependency trees and native binaries for each ABI;
never rebuild a running application's native addon. Local lifecycle tests
are `node --test tests/adk.test.mjs` after build; public type checks include
`tests/adk-consumer.ts`. Test workers block outbound network and isolate each
terminal XNode graph in its own process. Platform/native-build support and
any clean-install results must be reported for the actual tested environment;
this documentation does not imply every OS/architecture was qualified.

## Opt-in durable conversations (Phase 2A review candidate)

`createDurableAgent` adds SQLite persistence to the local mock profile. Existing
`createAgent` stays mock-only and refuses existing work folders. Root XAgent and
Channel APIs are unchanged. No published npm version includes this candidate.

```js
import { createDurableAgent, mockChannel, mockTextModel } from "@xpell/agent/adk";
const app = createDurableAgent({
  _name: "durable-agent",
  _model: mockTextModel({ _text: "Saved local reply" }),
  _channel: mockChannel({ _id: "local" }),
  _host: {
    _work_folder: "/absolute/operator-owned-parent/new-instance",
    _listen: { _host: "127.0.0.1", _port: 0 },
  },
  _conversations: {
    _provider: "sqlite",
    _instance_id: "local-instance",
    _application_scope: { _env: "development", _app_id: "example" },
    _history_limit: 100,
    _context: {
      _max_context_tokens: 2048,
      _reserved_output_tokens: 256,
      _safety_margin_tokens: 128,
      _system_instructions: "Respond to local synthetic fixtures.",
    },
  },
});
try {
  await app.start();
  console.log(await app.testTurn({
    _text: "Remember this synthetic message",
    _external_conversation_id: "conversation-1",
    _external_user_id: "participant-1",
    _external_message_id: "delivery-1",
  }));
  console.log(await app.getHistory({ _external_conversation_id: "conversation-1",
    _external_user_id: "participant-1" }));
  console.log(await app.getContext({ _external_conversation_id: "conversation-1",
    _external_user_id: "participant-1", _current_text: "Read-only context preview" }));
} finally { await app.close(); }
```

Restart in a **fresh process** with the same configuration and work folder.
`node examples/durable-agent.mjs /absolute/operator-owned-parent/new-instance`
provides a runnable local example; run it twice to recover history. It retains
its synthetic store. The parent directory must already exist and be private to
the operator. Do not point this profile at a Starter, product or existing store.

The first start exclusively creates the directory and a profile marker binding
the instance, logical application scope, Agent, Channel and exact packaged
schema hash. Reopening requires that marker to match; unknown directories,
symlinks and different profiles are rejected before XNode starts. The marker is
an accidental-adoption guard, not an authentication or tamper-proof mechanism.
One process/writer per work folder is required; no cross-process lease is added.
The instance is isolated by its folder; the explicit logical application pair
also scopes deterministic record keys/queries. Changing either is a new profile,
not a migration. There is no implicit adoption, data move or schema upgrade.

The private adapter reuses Starter ConversationRepository, ConversationService,
AgentPersistenceLifecycle and ConversationContextManager with four unchanged
protected entity artifacts under `xpell-agent-starter/default`. The logical
application scope does not rename that storage namespace. Persistence state
remains private to the lifecycle WeakMap. All normal I/O goes through the existing
app-scoped EntityManager command surface; no second persistence engine or direct
SQLite API is introduced. Close unregisters the four application entity runtimes
to dispose their SQLite handles, then stops XNode, preserving tables and files.
On partial startup after Core fencing, only the same owned EntityManager's
command dispatcher is used for disposal. No global host behavior changes.

`testTurn` accepts only text and optional external conversation/user/message IDs.
The defaults are `mock-conversation` and `mock-participant`; omitted message IDs
use UUIDs. Turns within a conversation are serialized. A redelivery with the
same immutable payload and explicit message ID returns its persisted accepted
reply without generating or sending again. Conflicting payload/sender bindings
fail. Received, failed or uncertain work is not automatically repeated. Startup
only changes interrupted `sending` records to `uncertain` using the existing
conservative recovery rule. Provider acceptance is not delivery confirmation.

`getHistory` returns at most the configured newest 1–200 records projected as
processed user messages and accepted assistant messages, in the existing
canonical `(occurred_at, message ID)` order. Filtering can return fewer records;
equal timestamps use ID order, not insertion order. Planning-enveloped replies
are withheld in history and excluded from model context. `getContext` does not
persist its preview text. Both reads require a linked scoped mock identity;
this is synthetic routing, not authentication, authorization or IAM.

Context is built before each mock response and available as a read-only preview.
The fixed mock deliberately does not interpret it. Existing context selection
keeps the newest eligible history suffix within the input budget after system,
safe actor projection, current text, output reserve and safety margin. The
fallback estimate is UTF-8 bytes/3 rounded up plus framing overhead, not a
provider tokenizer guarantee. Oversized fixed input fails before generation;
its inbound audit remains failed. History is paged in 64-record chunks; no
retention/deletion or total database-size bound is promised.

The same required XNode 2.0.8 peer, single ESM Core graph, Node >=22, explicit
loopback listener and native `better-sqlite3` setup apply. Qualification covers
macOS arm64 Node 22/24, separate native ABIs; other platforms need validation.
No real providers, Actions/Tools, IAM service, grants, background retries or
Phase 2B are included. See [extraction provenance](docs/durable-conversations-extraction.md)
for the reviewed generic source and schema hashes.

## 2.0.8 baseline

The registry baseline is 2.0.8. The ADK Foundation changes above remain unpublished.
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

The root Agent runtime does not provide:

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

Root runtime tests use a test-only `FakeChannel`. ADK tests additionally start
real loopback XNode hosts and synthetic temporary SQLite stores in isolated
processes. Outbound network/provider calls are blocked. No real data is used.

## License

MIT

## Opt-in bounded model tool loop

`@xpell/agent/adk/tool-loop` composes a real T1 read registry and one existing T2
host with native XAI tool messages. Action calls prepare proposals and stop for
application-mediated confirmation. Existing text-only Router chat stays unchanged.
See [API, boundaries and offline runbook](docs/model-tool-loop.md) and the
[neutral fixture sample](examples/model-tool-loop.mjs). No live calls or automatic
retry/resume are enabled by installation.
