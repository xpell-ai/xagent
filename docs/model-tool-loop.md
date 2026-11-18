# Bounded model tool loop — T3

Review candidate. Opt-in `@xpell/agent/adk/tool-loop`; source implementation and
executable fixtures are authoritative. No release or live-provider qualification
is implied. Existing `createRouterAgent` stays text-only and rejects tool calls.

## Source-backed design

| Mechanism | Reused authority | T3 delta |
| --- | --- | --- |
| Host, schemas, SQLite | `adk/actions.ts`, five unchanged protected entities, WAL/FULL profile | Require the actual started T2 host through a private WeakMap identity; no second XNode, new profile, schema or migration |
| Read definitions and execution | `adk/tools.ts` (`project`, `invoke`) | Use actual T1 registry; private authorization-only seam checks current invoke policy on receipt replay without calling handlers |
| Action binding and consent | `adk/actions.ts` (`prepare`, `confirm`) | Explicit allowlist + expose policy; model calls only prepare; confirmation remains an application operation |
| Turn claim | `starter/conversation/ConversationService.prepareInbound`, `ConversationRepository.claimInboundMessage` | Synthetic internal source namespace, scoped actor/conversation/delivery, immutable request binding; existing atomic SQLite claim before any dispatch |
| Terminal receipt | `ConversationRepository.addMessage` + `completeInbound` through EntityManager | Internal outbound `message` with state `processed`, followed by inbound completion; not a provider delivery/acceptance claim |
| Model transport | `adk/router.ts` shared internal connection; XNode XAI + optional AimeProvider | Native tools/messages through `_x.execute`; no duplicate HTTP client, fallback or retry |

Inspected `@xpell/node` 2.0.8 `XAI/XAIProvider` and `XAI/XAI` contracts define:

- `_tools: [{_name,_description?,_input_schema}]`, `_tool_choice`, `_messages`.
- Tool call `{_id,_name,_arguments,_continuation_ref?}` and finish reason
  `tool_calls`; a final text answer requires `stop` and no calls.
- Assistant `{_role:"assistant",_content,_tool_calls}` followed by
  `{_role:"tool",_tool_call_id,_content:[{_type:"text",_text}]}`.
- XAI normalizes output; it does not authorize or execute tools.

AimeProvider 2.0.8 maps these to Wormholes v2 `xai-router.generate` and maps
Router `_tool_calls`, `_finish_reason`, `_usage` back through XAI. Preserve call
IDs, assistant text and opaque continuation references in subsequent messages.
Some Router/model profiles enforce narrower native conversation limits and
opaque provider continuations; rejection stops this loop. The fixture proves
this client contract only, not any running Router/model's configuration,
capabilities, accounting or continuation implementation.

## API and composition

```ts
const loop = createRouterToolLoop({
  _model: routerTextModel({
    _endpoint: approvedEndpoint, _model: approvedModel,
    _credential: { _env: "APP_ROUTER_KEY" }, _timeout_ms: 1000,
    _error_policy: "fail-closed", _allow_requests: true,
  }),
  _reads: readRegistry,       // actual T1 registry, fixed trusted handlers
  _actions: actionHost,      // actual T2 facade, including an empty Action list
  _action_ids: ["sample.record"], // subset of the host's typed registered IDs
  _system: "Application instructions",
  _policy: async ({ _phase, _context, _action_id, _signal }) => {
    // Application verifies current authority; false/omission/throw denies.
    return applicationPolicy(_phase, _context, _action_id, _signal);
  },
  _limits: {
    _max_rounds: 3, _max_calls: 4, _max_calls_per_round: 4,
    _max_transcript_bytes: 8192, _max_output_tokens: 64,
    _max_total_tokens: 16384, _timeout_ms: 3000,
  },
});
await actionHost.start();
await loop.start(); // provider setup only; never probes/generates
const ctx = loop.bindContext({
  _actor_id: verifiedActor, _conversation_id: ownedConversation,
  _delivery_id: stableDelivery,
});
const result = await loop.run({ _text: requestText }, ctx, abortSignal);
```

`bindContext` is trusted local composition, **not authentication/IAM**. Never
bind identity from unchecked transport/model JSON. `run` is a local orchestration
utility; it does not expose a Channel ingress or HTTP endpoint. A real provider
Channel must still enter its owned XAgent through the existing bound runtime
and `_x.execute`. This utility does not replace that path or change Agent DTOs.

The loop policy phases are `run`, `replay` and `expose-action`. Both initial and
repeated deliveries require `run`; replay additionally requires `replay`.
Read discovery/invocation/replay require current T1 policy. T2 independently
authorizes Action prepare and all later controls. No policy means denial.
The Action list is explicit; discovery is not an execution grant.

This slice starts each turn with one user message and the configured system
instruction. It retains only the bounded in-turn native transcript in memory.
It does not automatically load conversation history, append model-private
reasoning, or change the existing durable-conversation/context APIs.

## Consent and mixed batches

`completed` returns `_text` and `_trace`. `requires_confirmation` returns only
`_proposals` and `_trace`. A mixed read/Action batch is fully schema-validated
before its first callback, then processed sequentially. Reads pass through T1;
Actions call T2 `prepare`. The loop stops after preparation; there is no further
model round, Action handler invocation or model-visible confirmation result.

The application shows the proposal summary and obtains explicit consent. It
then calls the existing T2 `confirm({_action_id,_binding_hash}, context)` with a
**distinct trusted confirmation delivery** bound to the same actor/conversation.
The loop has no confirm/cancel/execute methods or model tools. A model request
for any such name is rejected before callbacks. Consent, cancel and conservative
reconciliation remain T2/application responsibilities. An uncertain external
outcome is never retried by T3. A later user turn is a new explicit application
operation, not an automatic continuation of the prior loop.

## Limits and deterministic execution

All limits are required positive safe integers. Maximums: 8 model rounds,
16 calls total, 8 calls/round, 32768 transcript bytes, 2048 requested output
tokens/round, 262144 total token reservations, 120000ms elapsed deadline.
At most 64 contexts may be bound per loop; T1's own capacities also apply.

Before each generation, charge UTF-8 bytes of system/messages/tools plus the
requested output token reserve. Stop before dispatch if the transcript or
cumulative reservation exceeds its bound. Reported usage must contain finite,
nonnegative safe-integer input/output/total counts with a consistent total;
check cumulative usage and the per-round output bound before any callbacks or
next round. The greater of reservations and reported cumulative usage is carried
forward. Missing usage retains the reservation charge. **This is conservative
client budgeting, not a verified provider token ceiling or dollar-cost guarantee.**
Provider-side hidden inputs or ignored output limits cannot be enforced here.

Input/output use the existing bounded immutable JSON validator (rejecting
accessors, proxies, cycles and executable values). Tool schemas remain T1's
closed-object/bounded-string subset. A whole response batch is validated before
callbacks: unknown tools, extra arguments, wrong types, duplicate batch IDs or
changed arguments for a reused call ID stop execution. No partial invalid batch
is executed. Read results are bounded by T1 and again before model continuation.

Round idempotency keys hash profile/configuration, trusted turn identity,
request binding and round. Read call IDs and T2 preparation delivery IDs hash
the trusted turn and provider call ID. Repeated same-ID read calls are checked
and replayed by T1 with current policy; different bindings conflict. Repeated
calls still consume the finite call/round budget. No recursion, auto-resume,
provider fallback, retry or background loop is implemented.

## Persistence, replay and crash behavior

Only the existing T2 scoped SQLite profile is used. Original markers/assets are
unchanged; no old Starter store is adopted. An internal synthetic Channel source
`adk-model-tool-loop` separates loop ledger records from application chat.
Actor and conversation together select the internal conversation. The inbound
record stores a configuration/request hash; the terminal internal outbound
record stores a versioned result, safe trace, read authorization inputs and
Action preparation bindings. These are protected application runtime records,
not raw provider responses or provider-delivery receipts. They can contain
application text/arguments; protect the instance folder accordingly.

The atomic inbound reservation precedes model dispatch. Terminal receipt insert
precedes marking inbound processed. These are separate SQLite operations:
crash between them yields **uncertain**, never implicit redispatch. Any incomplete,
failed, timed-out or cancelled reserved turn fails closed on redelivery, including
after restart. The same delivery with changed request/configuration conflicts.
Completed turns return their stored result without another model request/read
handler. Before disclosure, replay checks current loop `run/replay`, T1
expose/invoke authorization for retained reads, and T2 prepare authorization for
retained proposals. Proposal replay never reveals retained Action outcomes.
A cached answer can be stale; application replay policy decides whether disclosure
is currently permitted. Policy revisions are not an IAM implementation.

One process owns the instance folder. Concurrent independent owners/processes
are unsupported; there is no OS lease or distributed recovery protocol. No
hardware power-loss or external exactly-once guarantee is made. Existing T2
uncertainty and committed-evidence reconciliation semantics remain unchanged.

## Cancellation, teardown and safe failures

Cancellation/deadline immediately fence the returned promise and prevent later
rounds/callback dispatch. AimeProvider has its own bounded transport timeout;
T1/T2 callbacks are trusted cooperative JavaScript. T3 cannot kill arbitrary
callbacks or cancel an already dispatched remote request. Ownership remains
busy until the actual operation settles. A pending T2 proposal may finish after
the caller is fenced, but T3 can never execute it. `close()` aborts/fences and
awaits actual work, then clears the owned provider credential. Close can wait
for noncooperative trusted callbacks. No late result resumes the loop.

Close in order: `await loop.close(); reads.close(); await actionHost.close()`.
T3 never closes caller-owned T1/T2 resources implicitly. XAI lacks unregister;
the existing connection leaves an inert, credential-free entry until host exit.

`ModelToolLoopError` exposes only fixed `E_ADK_LOOP_*` codes for config/readiness,
denial/busy/limits, malformed result/conflict, timeout/cancel/uncertainty, storage,
model and tool failures. No raw provider exception/message/response/cause is
returned. Trace entries contain bounded round/event, SHA-256 operation/call
hashes and static registered tool IDs; no prompt, arguments, outputs, actor IDs,
credentials or opaque continuation references. Do not log entire results or
protected runtime records as if they were sanitized trace events.

## Offline runbook

Build the exact source through the existing workspace (`pnpm build`). For an
isolated clean consumer, pack with the normal workspace peer conversion and
install its tarball plus required `@xpell/node` 2.0.8 and optional
`@xpell/xai-providers` 2.0.8. Use one ESM dependency graph; Node22/24 SQLite addons
need their matching ABI. Source version 2.0.8 is not proof this ADK is published.

```sh
node node_modules/@xpell/agent/examples/model-tool-loop.mjs /absolute/disposable/parent
node --test tests/tool-loop.test.mjs
```

The example creates only its own synthetic ephemeral loopback Router fixture
and disposable T2 profile; it has no live mode or provider/account setup. It
prints `MODEL_TOOL_LOOP_OFFLINE_PASS completed 2`. Give each fresh sample run a
fresh parent: changing the fixture endpoint is a configuration-binding change.
Tests exercise the actual XNode XAI → AimeProvider → Wormholes fixture path,
with external traffic/owner ports blocked. Tests are offline author qualification,
not independent CI, production security review, live billing, deployment or
publication approval. Review package/type fixtures and downstream regressions
on both Node versions before any separate release decision.
