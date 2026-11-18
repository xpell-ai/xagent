# Optional Agent Plugins (contract 1)

Review candidate. The `@xpell/agent/adk/plugins` entry adds trusted application
composition only. Root XAgent, Channels, Foundation, Conversations, Router, Read
Tools, Durable Actions and Model Tool Loop interfaces remain unchanged. Source
version 2.0.8 does not establish publication of this entry. Build the reviewed
source or install its locally packed tarball until a separately approved release.

## Install and compose

Install `@xpell/agent` with its required `@xpell/node` peer in one ESM graph on
Node 22 or 24. The optional Router peer remains `@xpell/xai-providers@2.0.8`.
A plugin's optional external SDKs belong in that plugin's own npm manifest;
Channels remain a separately installed optional package. This registry never
installs packages, resolves semver ranges, scans directories, dynamically imports,
starts XNode, adds routes, discovers Channels or runs a model.

The trusted application explicitly imports a plugin factory and calls
`defineAgentPlugin`, `createAgentPluginRegistry({_peers})`, `register(plugin)`,
`setGrants(id, {_host, _agent})`, then `start()`. See the complete network-free
[two-plugin sample](../examples/agent-plugins.mjs):

```sh
node node_modules/@xpell/agent/examples/agent-plugins.mjs
```

`defineAgentPlugin` validates and snapshots:

| Field | Contract |
| --- | --- |
| `_id` | Lowercase kebab ID, at most 100 characters, unique in one registry |
| `_version` | Exact stable `major.minor.patch`, no ranges/prerelease, at most 40 characters |
| `_contract` | Exactly `1`; another contract is rejected |
| `_peers` | Exact package/version requirements; compared to host's explicit attestation |
| `_dependencies` | Unique plugin ID/exact version pairs; register dependencies first |
| `_permissions` | Required `_host` and `_agent` arrays; unique names such as `sample.read` |
| `_tools`, `_actions` | Optional existing T1 Read/T2 Action definitions |
| `start`, `stop`, `dispose` | Optional trusted async hooks with immutable context |

The peer map is an operator assertion, not verification of installed module
resolution. Check actual manifests, lockfile, `npm ls @xpell/agent @xpell/node
@xpell/core --all` and consumer tests. The package still has the required XNode
peer; a plugin that imports XNode or Channels declares those peers in its own
manifest. Contract version, package peer versions and Action `_revision` are
separate checks. No package version bump is made by this slice.

Registration rejects accessors, proxies, sparse arrays, unknown fields, duplicate
plugin IDs and all duplicate contribution IDs across Reads/Actions, irrespective
of discovery policy. `actions.reconcile` is reserved for T2's application scan.
It validates everything before changing the registry. At most 32 plugins, 32
combined contributions, 32 dependencies/peers and 32 names per permission class.
Dependencies must already exist with exact versions, so cycles/missing/order
errors fail closed without implicit sorting. One plugin object belongs to one
registry for its lifetime; use a fresh factory instance for another registry.

## Host authority, agent authority and secrets

All declared permissions are required. Grants begin empty. The trusted host may
set only subsets of declared names; host resource permissions and agent tool-use
permissions are separate arrays. `setGrants` is application-only, never a model
or remote command. It grants no user identity, authenticated principal, OS
permission or external OAuth scope. A declaration is not a grant. Even with all
grants, application Tool/Action policy must allow the operation.

Plugin code is **trusted in-process JavaScript, not a sandbox**. It can use the
process's filesystem/network/credentials irrespective of these advisory
composition checks. Review imports and dependencies before loading the code.
No secrets or host service locator enter metadata/status/model definitions.
Construct a plugin with approved client/service/credential closures in private
host code. Lifecycle context contains only `_id`, `_version`, permission names
and a registry-owned abort signal, never raw secrets, XNode or model authority.
Plugin factories must not expose private closure state through descriptions,
results or logs. Application IAM and external consent stay separate.

## Tool and Action composition

After registration, `getContributions()` returns frozen `_tools`/`_actions`
arrays. Obtain the final catalog after all registrations and before constructing
T1/T2. Registration seals on first `start()` or shutdown; no hot loading.

```js
const contributions = plugins.getContributions();
const reads = createToolRegistry({
  _tools: contributions._tools,
  _policy: plugins.readPolicy(applicationReadPolicy),
  _limits: readLimits,
});
const actions = createDurableActions({
  ...existingActionOptions,
  _actions: contributions._actions,
  _policy: plugins.actionPolicy(applicationActionPolicy),
});
```

**Use both policy decorators**. They default deny without an application policy,
reject unknown contributions and check plugin/dependency readiness and grants
before/after application policy. Handler wrappers alone cannot protect retained
results: T1/T2 replay can return a stored result without calling a handler.
Do not compose contributions into an undecorated registry/host. Native T1 schema,
limits, branded context, safe errors and replay authorization remain; native T2
prepare/confirm/cancel/inspect/execute/reconcile and uncertainty rules remain.
T2's `actions.reconcile` scan requires an active plugin plus explicit application
policy; every row's registered Action is separately checked. Base non-plugin
contributions should use separate registries/hosts; unknown IDs are denied.

For T3, use those real decorated T1/T2 instances and explicitly gate
`expose-action` using `plugins.isAvailable(pluginId)` plus application discovery
policy. Keep the existing T3 run/replay policy. The model receives only normal
validated Read/Action metadata; never grant/secret/context objects. It prepares
proposals and stops; a separate authorized application delivery confirms T2.
The plugin registry never confirms or retries an Action. T3's typed dispatch and
conservative historical replay gates are unchanged.

Revocation immediately fences new policy/handler work and dependent plugins.
Every grant update invalidates in-flight policy/handler authorization snapshots,
including revoke-then-restore races; this conservatively includes unrelated grant
updates. Restoring a grant may allow a *new* authorized replay, never resurrection
of a previously invalidated callback. Already-dispatched external work cannot be
undone. If an Action result becomes unavailable after an effect, retain T2's
uncertain outcome and use committed evidence under new authority; never resend.

## Lifecycle and failure ownership

Registration order is startup order; cleanup is reverse order. `start()` is
idempotent while active. Before each hook, required grants and dependencies must
be available. Startup failure stops/disposes that partially started plugin,
records only fixed safe codes, blocks dependents and continues unrelated
plugins. Callers must inspect `getStatus()`; successful completion of registry
startup does not claim every plugin ready. A failure does not stop XAgent,
Channels or caller-owned XNode. No raw exception/cause escapes through status.

`stop()` immediately fences new work and aborts plugin signals, waits for startup
and tracked policy/handler callbacks to actually settle, then calls stop hooks in
reverse order. `dispose()` also disposes registered-but-never-started plugins.
Cleanup errors are recorded, unrelated cleanup continues, and uncertain cleanup
is never retried. Both methods are idempotent and terminal. Restart requires new
plugin/registry instances; restarting a stopped XNode requires a fresh process.
There is no persisted plugin lifecycle, store adoption or migration.

Hooks/callbacks are cooperative trusted code. T1/T2 retain their invocation
deadlines; the registry does **not** terminate JavaScript or promise a shutdown
deadline. A nonsettling plugin hook/callback can keep shutdown pending. Drain
ownership prevents overlapping cleanup or a second invocation after caller
timeout. A plugin requiring hard resource isolation needs a separate approved
process/container boundary. No automatic retries, background worker or scheduler.

Explicit host ordering is application-owned: register/grant, compose T1/T2,
start the existing host, start plugins, start the optional T3 loop; accept work
only after checking plugin availability. On shutdown fence/close T3 and T1,
dispose plugins while their host services remain alive, then close T2/XNode.
Do not call lifecycle shutdown recursively from its own hook/handler.

## Google login: design only

A future separately installed plugin could own its OAuth SDK/client dependency,
exact Agent/XNode peers, callback route contribution and secret-store reference.
The host must explicitly compose HTTPS routes before XNode start, validate
redirect/issuer/audience, PKCE/state/CSRF and sessions, request least scopes and
obtain user consent, revoke access and own token storage/refresh/logout. Login
identity belongs to application authentication; it must not turn Channel IDs
into XAuth users or give an LLM access/refresh tokens. A model-facing read tool
would return bounded approved application data under current user policy;
side effects would still require T2 confirmation. No OAuth client registration,
credentials, tokens, route, real login/refresh or live call is implemented here.

## Source basis and validation

This adapts generic Starter composition ideas (immutable explicit definitions,
duplicate plugin/capability rejection), not its application packs/product code.
Package references: [XAgent ownership](../src/XAgent.ts), [Read definitions and
policy](../src/adk/tools.ts), [Durable Action consent](../src/adk/actions.ts),
[typed Model Tool Loop](../src/adk/tool-loop.ts). Channel lifecycle is a reference;
Channels retain Agent ownership and their own start/stop path. XNode remains the
host; no new XModule/runtime/provider dependency or private product import.

Run from reviewed source with Node 22/24 and matching native SQLite ABI:

```sh
pnpm build
pnpm test
node --test tests/plugins.test.mjs tests/plugins-integration.test.mjs
```

The integration fixtures use disposable SQLite profiles and an ephemeral
loopback Router fixture only. They verify mixed Read/Action prepare-only output,
separate confirmation, no extra request on replay, revocation/stop retained-result
denial and fresh-process allowed/denied replay. Existing crash, reservation,
limits and downstream suites remain required. Local tests are not independent
review, live provider/OAuth qualification, publication or deployment approval.
