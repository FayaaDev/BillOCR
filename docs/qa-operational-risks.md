# Phase 6 QA and operational risks

## Covered with no-network mocks

`test/e2e.test.ts` drives the public WhatsApp ingestion service, SQLite adapter, job worker, extraction handler, validation callback, Drive adapter, and Sheets adapter. It asserts original persistence and SHA-256 provenance, schema-validated extraction, deterministic approval/review, transitions, restart/replay, and one Drive identity/Sheet hidden-ID row. Existing focused tests cover duplicate WhatsApp staging recovery, representative English/Arabic/handwritten/angled/PDF fixtures, Sheets concurrent append reconciliation, review correction, and rejection cleanup.

## Unresolved release risks

- No live Azure, Google, or WhatsApp provider verification was performed. Mock contracts may differ from production APIs, OAuth policy, quota, or permissions.
- Azure submission and polling state are persisted for the unavoidable crash-after-provider-effect window; Azure operation retention and replay behavior must be confirmed before production replay.
- Baileys is an RC dependency and WhatsApp can revoke/log out the dedicated account or change protocol behavior.
- Google Drive/Sheets have no shared transaction. Reserved Drive IDs and hidden Sheet bill IDs compensate for lost responses and concurrent workers, but external/manual Sheet edits and provider consistency lag still require reconciliation.
- SQLite plus originals is single-host storage. The backup command creates a consistent DB snapshot then copies originals, but it is not a distributed point-in-time backup; use one host, durable volume snapshots, and restore drills.
- Review Basic auth is only acceptable behind TLS and an authenticated reverse proxy. The application does not terminate TLS or implement user lifecycle/audit identity federation.
