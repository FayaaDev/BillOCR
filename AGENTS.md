# Bill Ledger Agent Guide

## Workflow

- Use Bun: `bun install --frozen-lockfile`. Verify code in this order: `bun run lint && bun run typecheck && bun test && bun run verify-build`.
- Focus a test with `bun test test/<name>.test.ts -t '<test name>'`. `dist/` is generated and ignored; never edit it.
- Start locally with `bun run start` or `bun run dev`; the dev script uses `data/dev/` for SQLite, originals, and WhatsApp auth. Production uses Docker Compose volumes. Migrate with `bun run migrate`; health is `GET http://127.0.0.1:3000/health`.
- Operations are `bun run ops inspect <id>`, `failed-jobs`, `retry [--include-permanent] <job-id>`, and `backup <directory>`. They load all configuration, including shared Azure/review settings and settings for configured delivery channels, even when only SQLite is used. To operate on the dev database, explicitly set its `APP_DATA_DIR`, `APP_DATABASE_PATH`, `ORIGINALS_DIR`, and `WHATSAPP_AUTH_PATH`; `bun run ops` does not inherit the dev script's overrides.
- Mistral is disabled and retired; do not run `evaluate:approved-examples`, which targets Mistral.

## Architecture and invariants

- `src/server.ts` is the composition root. SQLite is canonical; Telegram, WhatsApp, and ZIP upload are bill-delivery inputs, and Drive/Sheets are retryable projections. Do not reconstruct canonical state from a provider.
- Intake deduplicates identical original bytes by SHA-256 across delivery channels; filenames do not define bill identity.
- Never hold SQLite transactions across external calls. Handlers must preserve durable idempotency, lease/claim-token fencing, revision guards, transition history, and bounded retries.
- `src/validation.ts` is the sole automatic-approval decision point. Approval is completeness-based: `vendorName`, `invoiceDate`, and `total` are required, confidence is informational, and deterministic validation still applies. Manual review is sticky.
- Treat provider output as untrusted: keep bounded runtime normalization, raw-versus-normalized separation, and response size/time limits. Do not use OCR prose as accounting data.
- Originals are immutable direct children of `ORIGINALS_DIR` (`WHATSAPP_ORIGINALS_DIR` is a legacy fallback); their DB SHA-256 must match disk bytes. Provider, archive, and backup paths must use `readVerifiedOriginal`, not pathname `readFile`/`stat`.
- Image preprocessing is in-memory and fail-open; PDFs bypass it. Production extraction explicitly uses Sharp-only preprocessing (orientation, enhancement, resize); OpenCV is evaluator-only. Azure is the sole OCR engine, and its extraction identity hashes the actual submitted bytes.
- Drive IDs are reserved durably before mutation. Sheet projections are revision-specific; the hidden `bill.id` is the immutable row identity, and writes wait for a persisted Drive URL.

## Testing and changes

- Keep tests offline: inject Azure, Drive, Sheets, Baileys, and Telegram adapters through `startService`. With Google enabled in a `startService` test, inject both Drive and Sheets adapters.
- Provider-facing changes need replay and failure coverage, not only happy paths. Add schema changes as new entries in `src/migrations.ts`; never edit an applied migration.
- Never log or commit raw provider errors/bodies, credentials, QR/auth state, `.env`, `.env.local`, `.secrets/`, `secrets/`, `data/`, SQLite/WAL files, originals, backups, or `dist/`.

## Configuration and operations

- Bun auto-loads `.env` and, outside tests, `.env.local`; Compose explicitly loads `.env` instead. Telegram, WhatsApp, and dashboard ZIP upload are alternative bill-delivery methods; configure credentials and source settings for the channels being used. Azure and review credentials are shared requirements, while enabled Google also requires the selected credential path, Drive folder, and Sheet ID. The dev database is isolated, but Google Drive/Sheets destinations can be shared with production: check the IDs before testing. Mistral is disabled and not configured.
- WhatsApp pairing token is mode `0600` under `WHATSAPP_AUTH_PATH`; keep the service running while `bun run whatsapp:qr` renders it. For personal Gmail OAuth, run `bun run google:oauth` on the host with a Desktop client JSON and a nonexistent `GOOGLE_OAUTH_CREDENTIAL_JSON`; it refuses overwrites and writes mode `0600`. Compose enables `user_oauth` and reads `.secrets/google-authorized-user.json` from a read-only mount.
- Compose maps host `APP_PORT` to container port `3000`; change them together. The Basic-auth review UI is local/internal—non-local deployment needs a TLS-terminating authenticated reverse proxy.
- Backups snapshot SQLite then copy only DB-referenced verified originals. Restore only to the exact absolute originals directory recorded in the manifest.

## Task tracking

- Use Beads: run `bd prime`, create/claim an issue before editing, and close it after verification. Use `bd remember` for persistent knowledge, not markdown task or memory files.
- Default to conservative Git: do not commit, push, or sync Beads remotes unless explicitly authorized. At handoff, report changed files, verification, issue state, and blocked git/sync steps.
