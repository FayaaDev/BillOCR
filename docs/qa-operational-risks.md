# Phase 6 QA and operational risks

## Covered with no-network mocks

`test/e2e.test.ts` drives the public WhatsApp ingestion service, SQLite adapter, job worker, extraction handler, validation callback, Drive adapter, and Sheets adapter. It asserts original persistence and SHA-256 provenance, schema-validated extraction, deterministic approval/review, transitions, restart/replay, and one Drive identity/Sheet hidden-ID row. Focused Telegram tests cover the multi-chat allowlist, one-time backlog discard, serial cursor advancement, outage replay after transient download failure, duplicate durable identity, bounded responses/downloads, cancellation, anonymous senders, photos/documents, and token/body-safe logging. Existing focused tests also cover duplicate WhatsApp staging recovery, representative English/Arabic/handwritten/angled/PDF fixtures, Sheets concurrent append reconciliation, review correction, and rejection cleanup.

## Telegram rollout verification — 2026-09-01

- Passed the focused migration, durable-ingestion, Telegram, server, review, operations/projection, and end-to-end suites: 118 tests across 9 files. The Telegram tests cover serial cursor advancement, allowed-chat filtering, ignored edits, duplicate/replayed updates after transient download failure, permanent poison files, bounded responses, cancellation, and secret-safe logging. Durable-ingestion tests prove source-qualified identities include chat ID, so the same message ID in different groups cannot collide.
- Passed `bun run typecheck && bun test && bun run verify-build`: 324 tests across 27 files; passed `docker compose config --quiet`.
- The documented live Telegram smoke was not run: it requires explicitly authorized access to a dedicated bot token and configured group, and would make live Telegram/Drive/Sheets/provider calls. No credentials were read or logged and no live calls were made. Before release, perform the checklist in `README.md` with that authorization, including the duplicate-event replay and one review correction/rejection.

## Unresolved release risks

- No live Mistral, Google, or WhatsApp provider verification was performed. Mock contracts may differ from production APIs, OAuth policy, quota, or permissions.
- Mistral idempotency is required for the unavoidable crash-after-provider-effect window; the API's real retention/scope must be confirmed before production replay.
- Baileys is an RC dependency and WhatsApp can revoke/log out the dedicated account or change protocol behavior.
- Telegram Bot API update retention is provider-bounded. The durable cursor supports replay after ordinary outages only after its first initialization; the intentionally discarded pre-enablement snapshot and updates older than Telegram's retention window cannot be recovered by this service.
- A Telegram bot removed from a configured group, left in privacy mode, blocked from ordinary media, or configured with the wrong signed chat ID silently yields no eligible bills. Monitor both configured groups with periodic supported-media probes. Rotating a bot token requires an environment update and service restart.
- Telegram albums have no batch atomicity here: each member is an independent message/bill and can arrive or retry separately. Edited-message updates are ignored; operators must use the authenticated review workflow for corrections. Permanent unsupported/oversized/gone media is acknowledged and skipped so one poison update cannot block later updates.
- Telegram polling has no dedicated persistent volume. Losing the SQLite volume loses its cursor; the replacement database performs first-run backlog discard, so restore SQLite and originals together rather than attempting to reconstruct state from Telegram.
- Google Drive/Sheets have no shared transaction. Reserved Drive IDs and hidden Sheet bill IDs compensate for lost responses and concurrent workers, but external/manual Sheet edits and provider consistency lag still require reconciliation.
- SQLite plus originals is single-host storage. The backup command creates a consistent DB snapshot then copies originals, but it is not a distributed point-in-time backup; use one host, durable volume snapshots, and restore drills.
- Review Basic auth is only acceptable behind TLS and an authenticated reverse proxy. The application does not terminate TLS or implement user lifecycle/audit identity federation.
