# Changelog

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

