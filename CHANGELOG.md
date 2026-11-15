# Changelog

## [2.0.8] — 2026-11-13 (unreleased candidate)

- Coordinate the existing provider-neutral XAgent lifecycle and Channel contracts with XNode 2.0.8.
- Align XAgent skill metadata with package version 2.0.8.
- Persistence remains application-owned; the Gate 1 application persistence failures were resolved by the native dependency setup.

Compatibility: internal workspace specifications are retained. No public API redesign, PostgreSQL backend, persistence migration or automatic SQLite activation is introduced by this preparation.

Validation: package builds and available tests are recorded in the coordinated Gate 2 report. Gate 3 must verify the exact packed artifacts and clean-consumer compatibility before publication. These entries describe verified checked-out capabilities and release-preparation deltas; they do not claim that every capability is new relative to the last npm artifact.

