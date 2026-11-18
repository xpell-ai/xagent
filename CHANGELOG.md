# Changelog

## Unreleased — durable Actions T2

- Restrict prepare/replay to proposal metadata, reject argument accessors/proxies before callbacks and preserve validated snapshot identity.
- Preserve prepared-resource policy DENIED classification; add adversarial replay, validation and denial regressions.
- Add opt-in `adk/actions` with typed fixed definitions, trusted actor/application/conversation context and deny-by-default policy.
- Reuse reviewed generic Starter proposal binding, 15-minute expiry, confirmation/cancellation and conditional SQLite execution claims in a separate five-entity Action profile.
- Reauthorize confirmation and execution, require exact proposal hash and distinct confirmation delivery, and retain uncertain claims without automatic retry.
- Add bounded actor/conversation reconciliation through registered committed-evidence readers, WAL/FULL verification, neutral synthetic receipts and offline crash/restart/concurrency tests.
- Preserve existing interfaces and four-entity profile assets/marker. No model tool loop, IAM, plugins, product imports, migration, version bump or publication.

## Unreleased — typed read-tool registry

- Add opt-in `adk/tools` with immutable closed-string schemas, typed fixed read handlers and registry-bound caller contexts.
- Default-deny exposure/invocation policy, scoped reauthorization, cooperative deadlines, JSON byte bounds and safe error codes.
- Add bounded process-local invocation receipts/replay, neutral sample.echo and offline contract/type tests.
- Preserve existing factories, Router tool rejection and persistence assets; no model loop, durable Actions, IAM, plugins, version bump or publication.

## Unreleased — bounded Router chat integration

- Add explicit Router model configuration and local `createRouterAgent.chat` using XNode XAI/AimeProvider, existing persistence lifecycle and bounded context.
- Add an optional XAI Providers 2.0.8 peer, dynamically loaded only for Router mode; preserve required XNode peer and existing mock APIs.
- Add offline HTTP contract fixtures, CLI/runbook, replay/error/timeout tests and safe credential/provider teardown.
- No live calls, automatic retry, Actions/Tools, IAM, schema migration, global runtime change, version bump or publication.

## Unreleased — ADK durable conversations Phase 2A

- Add opt-in `createDurableAgent`, bounded history/context and a retained-store example.
- Reuse generic Starter persistence, lifecycle, deterministic keys, recovery and four unchanged protected schemas through EntityManager SQLite.
- Require explicit instance/application scope and a matching profile marker for restart; dispose owned providers without deleting data.
- Preserve Phase 1/root APIs, legacy Starter and existing stores. No schema migration, Actions/Tools, IAM, version bump, publication or host-global changes.

## Unreleased — ADK Foundation Phase 1

- Add the opt-in `@xpell/agent/adk` composition facade and a packaged mock Hello Agent example.
- Require explicit loopback HTTP configuration and a new work folder; compose existing XNode shutdown and Agent-owned Channel teardown.
- Preserve root exports, `new XAgent`, provider ingress/egress and existing application storage contracts.
- This local candidate does not implement IAM, durable Agent conversation storage, external models, plugin installation or a listener-free XNode host. No version bump or publication is included.

## [2.0.8] — 2026-11-13 (unreleased candidate)

- Coordinate the existing provider-neutral XAgent lifecycle and Channel contracts with XNode 2.0.8.
- Align XAgent skill metadata with package version 2.0.8.
- Persistence remains application-owned; the Gate 1 application persistence failures were resolved by the native dependency setup.

Compatibility: internal workspace specifications are retained. No public API redesign, PostgreSQL backend, persistence migration or automatic SQLite activation is introduced by this preparation.

Validation: package builds and available tests are recorded in the coordinated Gate 2 report. Gate 3 must verify the exact packed artifacts and clean-consumer compatibility before publication. These entries describe verified checked-out capabilities and release-preparation deltas; they do not claim that every capability is new relative to the last npm artifact.

