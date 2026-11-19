# Experimental trusted Host turn delegate (Gate D.1)

This opt-in source-built review candidate extends `@xpell/agent/adk/host` only.
It runs trusted application text orchestration inside the existing owned
Channel -> `_x.execute(receive-message)` -> XAgent -> selected Channel reply
path. It does not add an Agent engine, tool executor, Router/model provider,
Principal/IAM, durable profile, plugin loader or public HTTP ingress.

The API remains experimental. P2.2 profile nesting and the bounded XVM source
descriptor remain provisional. Existing root, Foundation, T1-T4 and P1 consumers
remain unchanged when the option is omitted. No npm availability is implied by
the source manifest version. Use an exact reviewed artifact, not an assumed
published Agent 2.0.8 ADK.

## Supported slice and application ownership

The neutral example uses one synchronous pure T1 Read handler and synchronous
T1 policy, plus a deterministic in-memory model. Model/tool orchestration and
the registry remain application-owned. The model first emits
`business.get-business-info`, the application invokes the authorized T1 registry,
and the model derives text from the resulting tool message. The empty native
XVM View is not the business-data source.

`bindContext` does not authenticate. Trusted application composition must first
establish actor, instance, native app scope, conversation and delivery ownership.
The example deliberately binds an explicitly synthetic fixture identity; no
model/user/Channel field becomes an authenticated Principal. Its one stable
fixture delivery demonstrates T1 replay, not a production ingress/replay scheme.

## API

```ts
import type { HostTurnDelegate } from "@xpell/agent/adk/host";

const turn: HostTurnDelegate = {
  _authorize: async request => {
    // Required trusted run/reply policy; exactly true allows.
    // At reply, also reauthorize retained completed tool reads.
    return applicationPolicy(request);
  },
  _run: async ({ _text, _signal, _turn_id, _source }) => {
    // Application-owned bounded orchestration; no hidden/detached work.
    // _turn_id is correlation and _source is "synthetic-local", not authority.
    return applicationTextTurn(_text, _signal, _turn_id, _source);
  },
  _limits: {
    _timeout_ms: 1000,
    _max_input_bytes: 512,
    _max_output_bytes: 1024,
  },
};
// Existing createAgentHost options plus optional top-level _turn: turn.
await host.start();
const answer = await host.testTurn({ _text: question }, abortController.signal);
await host.close();
// Then close application-owned loop/registry resources explicitly.
```

The two application functions above are illustrative ports, not SDK exports.
For a runnable composition use `examples/host-turn-agent.mjs`. It creates no
credentials, loads no `.env`, uses no production/product source, starts one
owned ephemeral loopback Host and removes only its own disposable instance.

`_turn` accepts only `_run`, required `_authorize`, and `_limits`.
`HostTurnRequest` contains `_turn_id`, `_source`, `_text`, `_signal`. Policy adds
`_phase: "run" | "reply"`. Caller input remains exactly `{_text}`; actor/app/grant
fields are rejected. Construction snapshots callback references and bounded
scalars without executing them. Unknown/proxy/accessor configuration is rejected.
No delegate/policy/model callback runs at import, construction or Host start.

There is one admitted delegated turn and no queue. Limits are positive safe
integers: at most 5000ms, 4096 input UTF-8 bytes and 8192 output UTF-8 bytes.
Input/output must be nonempty text. One deadline includes run policy, application
delegate and final reply policy. The caller's optional AbortSignal is local
control, not an authority grant. An already-aborted signal dispatches no work.
Without `_turn`, retain the original one-argument mock turn; an explicitly
supplied cancellation argument in that mode is rejected as configuration.

With `_turn` present it explicitly replaces the fixed mock text strategy; the
profile's required mock descriptor is a provisional compatibility placeholder.
Denial/failure never falls back to that mock text. The delegate returns only
text; XAgent retains original conversation/reply routing and Channel ownership.
Raw XNode, inner Agent, arbitrary commands and tool dispatch are not exposed.

## Authorization, error and replay boundaries

The Host requires run authorization before orchestration and reply authorization
at the last owned lifecycle gate before Channel send. False, malformed or
throwing policy denies. The synchronous mock Channel acceptance has an additional
deadline/cancellation/admission fence. Missing, duplicate or unadmitted direct
Agent commands cannot enter the delegate.

T1 independently checks exposure, arguments, current scope/invoke policy and
receipt binding. Application reply policy must reauthorize every retained read
needed for disclosure. The example uses public same-ID T1 invocation only for a
known successful receipt, without another handler dispatch. Never invoke a new
call just to test authority. Host correlation is not a stable delivery ID; any
durable request identity, changed-request conflict or final-answer cache is an
application/T2/T3 concern. This Host adds no result cache, retry or fallback.

The reply decision is the authorization linearization point. A later grant
change can race with send acceptance; this is not an atomic global grant/send
transaction or retroactive unsend guarantee. Data previously authorized and
observed in process cannot be retroactively unseen.

Turn failures use fixed `E_ADK_HOST_TURN_` codes: `DENIED`, `BUSY`, `CANCELLED`,
`TIMEOUT`, `LIMIT`, `FAILED`. Recognized T1 denial remains DENIED. Unknown errors,
raw messages/causes and fabricated arbitrary Host error codes are not disclosed.
Private per-admission failure state preserves classification through existing
XAgent generic error normalization, without adding fields to Agent/Channel DTOs.
Existing Host readiness/closed/start/cleanup errors retain their meanings.

## Cancellation and actual work

Timeout, caller abort or Host close fences the caller and later sends, requests
cooperative abort and stops further dispatch. Admission remains busy until the
actual owned delegate/policy/native turn settles, even after caller timeout.
Close fences immediately and awaits actual work before stopping the owned
Channel/XNode/resources. It is coalesced and terminal and never closes a foreign
graph or caller-owned registry.

This is not arbitrary-JavaScript isolation. Synchronous CPU work can block timers;
ignoring abort can keep close pending. Do not recursively call/await Host.close
from an owned callback or detach work. The Host owns the delegate promise, not
unreported ambient work.

**T1 timeout is not handler completion.** `invoke` has no parent AbortSignal;
its deadline may reject while actual handler/policy work remains, and `close()`
returns void. Gate D.1's synchronous Read/policy fixture avoids such nested work.
Broader async/resource-bearing handlers require separately approved actual-work
tracking/drain proof; do not claim that awaiting a raced T1 result drains them.
Do not close a shared registry to cancel one turn. No T1 or durable contract is
widened here.

## Reproduction and review gates

Use Node22.23.1 or qualified24.22.3 with matching isolated native dependencies
and exact reviewed Agent/Node/Core artifact graph. No owner services or stores.

```sh
node node_modules/typescript/bin/tsc -p .
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node --test tests/host-turn.test.mjs
node --test tests/host.test.mjs
node --test tests/*.test.mjs
node examples/host-turn-agent.mjs
```

The focused suite runs fresh child processes, blocks outbound connections and
permits only their owned ephemeral loopback Host. It verifies real Host entry,
model-call/registry/handler/result/model/Channel acceptance order, changed-data
grounding, unchanged native read-only empty View, denial/revocation/replay,
forged input/context, malformed batch/arguments, unsafe errors, operation bounds,
timeout/cancel/actual drain/no late send and competing/foreign host preservation.
Observations wrap public `_x.execute` and XNode start/stop without replacing the
runtime; no private consumer imports or manual handler call produces the answer.

Run clean installed-artifact Host, P1 and approved held synthetic downstream
regressions separately on both qualified Node versions at original scheduler and
timeouts. Preserve failures and known skips. Existing SDK T3 regression fixtures
are offline tests, not activation of Router/T3 in this Host profile. No claim of
production security, live identity/provider quality, arbitrary async drain or
independent CI follows from local fixture passes.

Architecture approval: AimeVerse/aime-operations#65 comment7010140142.
Implementation scope: #67, separate from P2.3. Draft review only; no merge,
publication, runtime pin change, deployment, live calls or Pulse migration.
