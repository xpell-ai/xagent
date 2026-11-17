# Local Router chat runbook — review candidate

For Yehudit: this unpublished ADK candidate adds Router-backed local chat. The
commands below use synthetic data and a deterministic HTTP fixture. No live or
paid smoke call is authorized by this runbook. Root `new XAgent`, `createAgent`
and mock `createDurableAgent` retain their existing APIs.

## Install the reviewed candidate

Use Node 22 or 24, one compatible ESM Core/XNode graph and the platform's correct
`better-sqlite3` binary. Qualification covers macOS arm64: Node 22.23.1/ABI127
and 24.19.0/ABI137. Published Agent 2.0.8 does not contain these ADK additions.
Use the tarball built from the exact reviewed commit; do not publish it.

```sh
mkdir local-agent-review
cd local-agent-review
npm init -y
npm install /absolute/path/to/reviewed-xpell-agent.tgz
npm install @xpell/xai-providers@2.0.8
npm ls @xpell/agent @xpell/node @xpell/core @xpell/xai-providers --all
```

XNode remains a required peer. XAI Providers 2.0.8 is an optional peer: install
it explicitly for Router mode. Mock modes do not need it and Router startup
fails safely if it is missing. AimeProvider is dynamically imported from its
`/aime` subpath, never copied or replaced. With npm versions that block native
scripts, review the pending script and approve only `better-sqlite3` in this
new temporary project. Do not force peer resolution or reuse an active native
build. Verify one XNode/Core installation and use ESM throughout.

## One offline turn and restart

Run from the new consumer directory. The parent is private and disposable;
the `instance` child must not exist on the first run.

```sh
TASK_AGENT_PARENT="$(mktemp -d)"
node node_modules/@xpell/agent/examples/router-chat.mjs \
  --offline "$TASK_AGENT_PARENT/instance" delivery-1 "Hello Router"
node node_modules/@xpell/agent/examples/router-chat.mjs \
  --offline "$TASK_AGENT_PARENT/instance" delivery-1 "Hello Router"
node node_modules/@xpell/agent/examples/router-chat.mjs \
  --offline "$TASK_AGENT_PARENT/instance" delivery-2 "What did I say?"
```

Each invocation starts its own explicit ephemeral loopback fixture, calls the
real XNode XAI → AimeProvider → HTTP path, closes the Agent and fixture, and
retains the synthetic SQLite profile. Expect `Offline Router: Hello Router`
and a JSON history containing the user and assistant text. The second command
returns the persisted reply without a Router request. The third sends bounded
previous user/assistant history; the fixture deterministically echoes the current
text, so it does not demonstrate actual model comprehension. Equal timestamps
retain canonical timestamp/ID order. The only ambient credential created by the
offline demo is its temporary synthetic fixture key, removed on exit.

For a separately running local fixture, in another terminal:

```sh
node node_modules/@xpell/agent/examples/offline-router.mjs 18451
```

Expect `OFFLINE_ROUTER_READY http://127.0.0.1:18451`. The fixture accepts only
Wormholes v2 `xai-router.generate` at `/wh/v2/call`, with synthetic operation
key `offline-fixture-key` and model `fixture-chat`. Ctrl-C stops it. If the port
is occupied, it fails; do not attach to an unknown existing service. This is a
wire-contract fixture, not the Router billing engine, full Router harness or
proof of live account/model readiness.

## Programmatic API and configuration

```js
import { createRouterAgent, routerTextModel, mockChannel } from "@xpell/agent/adk";
const app = createRouterAgent({
  _name: "local-chat",
  _model: routerTextModel({
    _endpoint: "http://127.0.0.1:18451",
    _model: "fixture-chat",
    _credential: { _env: "MY_DISPOSABLE_ROUTER_KEY" },
    _timeout_ms: 5000,
    _error_policy: "fail-closed",
    _allow_requests: true,
  }),
  _channel: mockChannel({ _id: "local" }),
  _host: { _work_folder: "/absolute/private-parent/new-instance",
    _listen: { _host: "127.0.0.1", _port: 0 } },
  _conversations: { _provider: "sqlite", _instance_id: "local-chat-instance",
    _application_scope: { _env: "development", _app_id: "local-chat" },
    _history_limit: 100, _context: { _max_context_tokens: 2048,
      _reserved_output_tokens: 256, _safety_margin_tokens: 128,
      _system_instructions: "Respond to this local conversation." } },
});
try {
  await app.start(); // resolves the environment reference; no network probe
  console.log(await app.chat({ _text: "Hello", _external_message_id: "delivery-1",
    _external_user_id: "local-person", _external_conversation_id: "local-chat" }));
  console.log(await app.getHistory({ _external_user_id: "local-person",
    _external_conversation_id: "local-chat" }));
} finally { await app.close(); }
```

Set the named environment variable through your authorized local secret tooling.
For the offline fixture only, its value is the synthetic key shown above. Never
put an actual key in JSON, command arguments, settings, transcripts, Git or logs.
The library snapshots configuration at construction and reads only that named
environment variable at start. The credential goes to AimeProvider's existing
`_api_key` operation param, not an invented Authorization header. It is excluded
from model context and persisted Agent records. Endpoints must be an origin:
loopback IP HTTP or HTTPS, without userinfo/path/query/fragment. The endpoint and
its redirects must be operator-trusted; existing AimeProvider owns HTTP behavior.
There is no implicit endpoint, model, credential, timeout, retry or fallback.

The local Channel is a synthetic return adapter, not a production messaging
provider or authenticated identity. `chat` uses its bound ingress and ordinary
Agent lifecycle; it does not call the Agent handler directly. There is no new
chat HTTP route. XNode still opens its explicitly configured loopback host.

## Failure isolation and replay

| Symptom / safe code | Boundary / next check |
| --- | --- |
| `E_ADK_ROUTER_CONFIG` / configuration validation | Check explicit endpoint origin, model, environment reference, 1–120000ms timeout, `fail-closed` and `_allow_requests:true`. Construction performs no I/O. |
| `E_ADK_ROUTER_CREDENTIAL` | Named variable is absent/blank. Startup fails before folder creation; supply it through authorized tooling. |
| `E_ADK_ROUTER_DEPENDENCY` | Install the optional XAI Providers 2.0.8 peer and verify the single ESM graph. |
| `E_ADK_PROFILE_MISMATCH` | Wrong/unknown instance or changed marker/schema. Stop; choose a fresh folder. Do not edit markers or migrate existing data. |
| `E_XAI_API_KEY_INVALID` / `E_XAI_API_KEY_REQUIRED` | Router key authentication, separate from local synthetic identity. Check the intended disposable Router/account with its operator; do not print the key. |
| `E_XAI_REQUESTED_MODEL_NOT_ALLOWED` / `E_XAI_MODEL_PROFILE_REQUIRED` | Router catalog/key policy; explicit model is a request, not a bypass of Router routing. |
| `E_XAI_INSUFFICIENT_CREDITS` / rate or daily-limit codes | Router-owned accounting/policy; no Agent credit grant or fallback. |
| `E_XAI_METERING_INCOMPLETE` | Router requires reconciliation. Stop; do not retry with a new ID to bypass the hold. |
| `E_ADK_ROUTER_TIMEOUT` | AimeProvider aborted HTTP at the configured timeout. Router execution/charging may already have occurred. No automatic resend or recovery call. |
| `E_ADK_ROUTER_TRANSPORT` / `E_ADK_ROUTER_GENERATE` | Transport/non-JSON/malformed or unrecognized Router failure. Check the disposable Router's sanitized diagnostics; raw responses/causes are intentionally withheld. |
| `E_ADK_ROUTER_RESULT` | Empty, tool-bearing, planning-enveloped, truncated or filtered reply. No tools are executed and no assistant reply is persisted. |
| `E_ADK_REPLAY_UNCERTAIN` | This persisted delivery has no proven accepted reply. Reconcile the Router and Agent records with the owner; do not automatically mint another delivery ID. |
| `E_ADK_MOCK_TURN` | Existing local Channel failure boundary (input/context/persistence or immutable binding). Check the same scoped `getContext` preview for budget errors; do not bypass persistence or retry automatically. |
| `E_ADK_NOT_READY` / `E_ADK_CLOSED` | Start/close lifecycle; restart requires a fresh process and the same matching profile. |

Accepted replay with the same explicit ID and immutable payload returns the
stored reply without generation; conflicting text/sender fails. Concurrent turns
in one conversation serialize. Context selection and its output reserve use the
existing conservative estimate, not a real model tokenizer guarantee. Excessive
fixed input fails before a Router request. The Router operation idempotency key
is a SHA-256 binding of instance ID and the existing scoped inbound-generation
identity; a new Wormholes envelope is not a new business operation. Keep instance
IDs unique for independent instances sharing the same Router account. No automatic
retry, fallback, `test-key`, usage query or `recover_generation` is issued. Router
usage/charges remain Router-owned; the adapter does not fabricate or persist billing
receipts. Offline success proves forwarding/failure handling, not real metering.

Close fences new chat, drains accepted turns (each dispatch has its configured HTTP timeout; queued
turns drain sequentially),
closes SQLite registrations and then XNode, retaining files. The owned XAI registry
entry becomes inert and its AimeProvider credential reference is cleared. XAI has
no public unregister API; the inert entry remains in the terminal process. Foreign
providers/defaults are not replaced. Do not start another host in that process.
One writer per profile; no cross-process lease or schema migration is supplied.

## Full Router / live smoke — separate owner gate, not executed here

A live local Router can charge a provider even on loopback. Do not use an active
product's endpoint, grant, credentials or stores. The offline fixture is the
reproducible default above. For a full Router, first obtain its owner's selected
reviewed release/profile, disposable account/key/model, private config/store,
loopback port and explicit budget/one-turn approval. Its own reviewed launcher
and matching release manifest are authoritative. Do not run a legacy/default
`dev` entry against an existing work folder.

The inspected Router supports this explicit synthetic-release launcher shape
from an independently reviewed extracted release, using its matching Node/runtime:

```sh
# REVIEW TEMPLATE ONLY: owner must supply verified release/config/store inputs.
node app/scripts/start-rc1.mjs initialize \
  --profile synthetic-staging-rc1-v1 --release-id VERIFIED_RELEASE_ID \
  --config /absolute/private-parent/config.json --store /absolute/private-parent/store
node app/scripts/start-rc1.mjs start \
  --profile synthetic-staging-rc1-v1 --release-id VERIFIED_RELEASE_ID \
  --config /absolute/private-parent/config.json --port 0
```

Those placeholders intentionally do not identify or modify any existing release.
This adapter task does not build, initialize, seed or qualify that full Router.
A live profile has its own additional approval/credential gate and may restrict
the generic model/chat contract; if incompatible, stop for the owner instead of
relaxing it or borrowing another consumer's grant.

After **separate** owner approval only, save the Agent configuration above as
private JSON with `_model._type:"xai-router"`, the owner-selected origin/model
and an environment reference (no secret). The opt-in CLI requires both
`--approved-router` and `XAGENT_OWNER_APPROVED_ROUTER_CALLS=yes`; that is an
operator assertion, not an approval service or budget enforcement system:

```sh
# NOT AUTHORIZED by this task; only after separate approval and Router readiness.
XAGENT_OWNER_APPROVED_ROUTER_CALLS=yes node node_modules/@xpell/agent/examples/router-chat.mjs \
  --approved-router /absolute/private-parent/agent.json APPROVED_ONE_TURN_ID "Approved synthetic smoke text"
```

Record safe output, the Router's authoritative reconciliation evidence and the
exact approval/budget externally. On timeout/uncertainty stop and reconcile;
no second call is implied. The CLI closes the Agent; Ctrl-C the disposable
fixture/Router in its own terminal according to that Router's lifecycle. Keep
synthetic evidence until review; remove only directories you explicitly own
when the reviewer no longer needs them. No merge, package publication or
production service operation is included.
