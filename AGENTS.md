# Repository Instructions

## Commands

- Use Bun; Docker pins Bun 1.2. Install with `bun install --frozen-lockfile`.
- Verify in this order: `bun run typecheck && bun test && bun run verify-build`. There is no lint or formatter command.
- Run one test file with `bun test test/<name>.test.ts`; focus a case with `bun test test/<name>.test.ts -t '<test name>'`.
- Apply migrations with `bun run migrate`; start with `bun run start` or watch with `bun run dev`; health is `GET http://127.0.0.1:3000/health`.
- Operations are `bun run ops inspect <id>`, `failed-jobs`, `retry [--include-permanent] <job-id>`, and `backup <directory>`. Production uses `bun dist/ops.js ...`. These commands call `loadConfig`, so even SQLite-only operations require the mandatory WhatsApp, Mistral, and review settings.
- WhatsApp pairing requires the service to remain running while `bun run whatsapp:qr` reads the mode-`0600` token under `WHATSAPP_AUTH_PATH`; never log or commit that token or auth state.
- Personal Gmail OAuth runs locally, not in Docker: set `GOOGLE_OAUTH_CLIENT_JSON` and a nonexistent `GOOGLE_OAUTH_CREDENTIAL_JSON`, then run `bun run google:oauth`. It refuses to overwrite credentials and writes mode `0600`.
- `APPROVED_EXAMPLE_EVALUATION_AUTHORIZED=true bun run evaluate:approved-examples` makes live Mistral calls; run it only with explicit authorization.

## Architecture

- `src/server.ts` is the composition root for HTTP, WhatsApp ingestion, the durable worker, extraction, validation, review, and Google projections. Tests should inject transports/providers through `startService` rather than contact networks.
- SQLite is authoritative. WhatsApp is input; Drive and Sheets are retryable projections. Never reconstruct canonical state from provider state.
- Never hold a SQLite transaction across an external call. Job handlers must use `JobHandlerContext` lease/revision guards immediately before side effects and preserve provider idempotency, claim-token fencing, transition history, and bounded retries.
- After successful extraction, `src/validation.ts` alone decides automatic approval. Vendor name, invoice date, and total must each meet `CONFIDENCE_THRESHOLD`; other factual checks still apply, and terminal extraction failures also route to review. Manual review is sticky and extraction replay must not override reviewer-superseded data.
- Sheet jobs are revision-specific, but hidden `bill.id` is the immutable logical row identity. Corrections reconcile that row rather than append another. Sheet writes wait for a persisted Drive URL.
- Drive IDs are reserved durably before mutation; do not discard confirmed reservations or replace provider-specific replay handling.
- Originals are immutable, flat direct children of `WHATSAPP_ORIGINALS_DIR`. DB SHA-256 must match disk bytes. Provider, archive, and backup paths must use `readVerifiedOriginal`, not pathname `readFile`/`stat`; its descriptor-relative hardening supports Darwin and Linux only.
- Image preprocessing is in-memory, fail-open, and never replaces an original; PDFs bypass it. Enabled/version policy is embedded in each extraction job key, but timeout configuration is read at execution. The Mistral idempotency key includes the SHA-256 of the bytes actually submitted.
- Provider output is untrusted: retain strict Mistral schema/runtime parsing, separate raw and normalized data, and size/time bounds. OCR prose is evidence, not accounting data. Never log raw Baileys/Mistral/Google errors, bodies, credentials, QR data, or auth state; Baileys keeps its silent logger.

## Schema And Tests

- Add schema changes as new entries in `src/migrations.ts`; never edit an applied migration. Update exact migration-count/schema tests and downstream contracts.
- Tests stay offline and use injected Mistral, Drive, Sheets, and Baileys adapters plus `test/fixtures/`. When Google is enabled in a `startService` test, inject both Drive and Sheets adapters or the real pair may be constructed.
- Provider-facing changes need replay and failure assertions, not only happy-path coverage.
- `dist/` is generated and ignored; never edit or commit it. `bun run verify-build` must produce server, ops, both preprocessing bundles, and both review client assets.

## Configuration And Operations

- Bun auto-loads `.env`. `loadConfig` requires WhatsApp group/auth, Mistral, and review credentials even when provider integrations are disabled; Google resource IDs and the selected credential path are additionally required when `GOOGLE_ENABLED=true`.
- Google auth is either `service_account` (`GOOGLE_SERVICE_ACCOUNT_JSON`) or `user_oauth` (`GOOGLE_OAUTH_CREDENTIAL_JSON`). Compose remaps both credential filenames under `/run/secrets`; generate OAuth credentials on the host first.
- Compose assumes the container listens on port 3000 in its port mapping and health check. Do not set container `APP_PORT` to another value unless Compose is fixed at the same time.
- Backups snapshot SQLite first and copy only DB-referenced verified originals. Restore is supported only to the exact absolute `WHATSAPP_ORIGINALS_DIR` recorded in the manifest.
- Keep `.env`, `secrets/`, `data/`, WhatsApp auth, SQLite/WAL files, originals, backups, and `dist/` out of source control and Docker context.
- The Basic-auth review UI is local/internal; non-local deployment requires a TLS-terminating authenticated reverse proxy.

## Task Tracking

- Use Beads (`bd`) for all task tracking and `bd remember` for persistent project knowledge; do not create markdown task or memory files.
- Run `bd prime` for current workflow and session-close rules. Use `bd ready`/`bd show <id>` or create an issue with `bd create`, claim it with `bd update <id> --claim` before editing, and `bd close <id>` only after verification.
- The default profile is conservative: do not commit, push, or sync Beads remotes unless explicitly authorized. At handoff, report changed files, verification, issue state, and blocked git/sync steps.
