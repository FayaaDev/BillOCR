# Bill Ledger Agent Guide

## Workflow

- Use Bun: `bun install --frozen-lockfile`. Verify code in this order: `bun run typecheck && bun test && bun run verify-build`; this repo has no lint or formatter script.
- Focus a test with `bun test test/<name>.test.ts -t '<test name>'`. `dist/` is generated and ignored; never edit it.
- Start locally with `bun run start` or `bun run dev`; migrate with `bun run migrate`; health is `GET http://127.0.0.1:3000/health`.
- Operations are `bun run ops inspect <id>`, `failed-jobs`, `retry [--include-permanent] <job-id>`, and `backup <directory>`. They load all configuration, so they still require WhatsApp, Mistral, and review settings when only SQLite is used.
- `APPROVED_EXAMPLE_EVALUATION_AUTHORIZED=true bun run evaluate:approved-examples` makes live Mistral requests; run it only with explicit authorization.

## Architecture and invariants

- `src/server.ts` is the composition root. SQLite is canonical; WhatsApp is input and Drive/Sheets are retryable projections. Do not reconstruct canonical state from a provider.
- Never hold SQLite transactions across external calls. Handlers must preserve durable idempotency, lease/claim-token fencing, revision guards, transition history, and bounded retries.
- `src/validation.ts` is the sole automatic-approval decision point. Approval is completeness-based: `vendorName`, `invoiceDate`, and `total` are required, confidence is informational, and deterministic validation still applies. Manual review is sticky.
- Treat provider output as untrusted: keep bounded runtime normalization, raw-versus-normalized separation, and response size/time limits. Do not use OCR prose as accounting data.
- Originals are immutable direct children of `WHATSAPP_ORIGINALS_DIR`; their DB SHA-256 must match disk bytes. Provider, archive, and backup paths must use `readVerifiedOriginal`, not pathname `readFile`/`stat`.
- Image preprocessing is in-memory and fail-open; PDFs bypass it. Production extraction explicitly uses Sharp-only preprocessing (orientation, enhancement, resize); OpenCV is evaluator-only. The Mistral idempotency key hashes the actual submitted bytes.
- Drive IDs are reserved durably before mutation. Sheet projections are revision-specific; the hidden `bill.id` is the immutable row identity, and writes wait for a persisted Drive URL.

## Testing and changes

- Keep tests offline: inject Mistral, Drive, Sheets, and Baileys adapters through `startService`. With Google enabled in a `startService` test, inject both Drive and Sheets adapters.
- Provider-facing changes need replay and failure coverage, not only happy paths. Add schema changes as new entries in `src/migrations.ts`; never edit an applied migration.
- Never log or commit raw provider errors/bodies, credentials, QR/auth state, `.env`, `secrets/`, `data/`, SQLite/WAL files, originals, backups, or `dist/`.

## Configuration and operations

- Bun auto-loads `.env`. `loadConfig` always requires WhatsApp group/auth, Mistral, and review credentials; enabled Google also requires the selected credential path, Drive folder, and Sheet ID.
- WhatsApp pairing token is mode `0600` under `WHATSAPP_AUTH_PATH`; keep the service running while `bun run whatsapp:qr` renders it. Run personal Gmail OAuth on the host with a nonexistent `GOOGLE_OAUTH_CREDENTIAL_JSON`; `bun run google:oauth` refuses overwrites and writes mode `0600`.
- Compose maps host `APP_PORT` to container port `3000`; change them together. The Basic-auth review UI is local/internal—non-local deployment needs a TLS-terminating authenticated reverse proxy.
- Backups snapshot SQLite then copy only DB-referenced verified originals. Restore only to the exact absolute originals directory recorded in the manifest.

## Task tracking

- Use Beads: run `bd prime`, create/claim an issue before editing, and close it after verification. Use `bd remember` for persistent knowledge, not markdown task or memory files.
- Default to conservative Git: do not commit, push, or sync Beads remotes unless explicitly authorized. At handoff, report changed files, verification, issue state, and blocked git/sync steps.
