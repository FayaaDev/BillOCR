# JabOCR Agent Guide

## Scope

- This directory is a self-contained, one-time source snapshot for a customer's own Linux x86_64 server. All paths and commands below are relative to this directory.
- Read `README.md` for setup, integrations, operations, backup, and restore. Keep it consistent with deployment changes.
- Keep changes within this package unless explicitly asked otherwise. Do not automatically synchronize it with a parent repository or depend on parent files, customer configurations, shared monitoring networks, or existing customer credentials.
- Preserve the standalone build: `docker build --platform linux/amd64 -t jabocr:standalone .` must work with only this directory as context.

## Development and verification

- Use Bun; the Dockerfile pins Bun 1.3.14. Install with `bun install --frozen-lockfile`.
- Verify code changes in order: `bun run lint && bun run typecheck && bun test && bun run verify-build`.
- Focus deployment checks with `bun test test/deployment.test.ts`. This snapshot includes deployment tests, not the parent application's complete test suite; add focused offline regression coverage for behavior changes.
- `dist/` is generated and ignored; never edit it. Use new entries in `src/db/migrations.ts` for schema changes; never modify applied migrations.
- Keep provider tests offline. Inject Azure, Drive, Sheets, WhatsApp, and Telegram adapters through `startService`; when Google is enabled, inject both Drive and Sheets adapters.
- For deployment changes, validate Compose using `docker compose config --quiet` with a private configured `.env`, build the amd64 image, and verify Caddy routing and persistent storage with disposable data. Avoid printing resolved environment values.
- A successful `/ready` response does not verify provider credentials, Google access, or public certificate issuance. Report those checks separately from local tests.

## Deployment contract

- `docker-compose.yml` uses project `jabocr`, application image `jabocr:standalone`, and Caddy for HTTPS. Only Caddy publishes ports 80/443; keep the backend private on container port 3000.
- `APP_DOMAIN` is a qualified public DNS hostname with no scheme, port, or slash. Compose derives `REVIEW_ORIGIN=https://${APP_DOMAIN}`. Preserve public `Host`, HTTPS redirects, unknown-host rejection, and secure host-only `__Host-review_session` cookies.
- Caddy depends on application startup, not readiness: unpaired WhatsApp is degraded while its authenticated pairing UI must remain reachable.
- Keep the non-root runtime user, two-minute shutdown grace period, restart policy, and `/ready` healthcheck. Healthchecks do not automatically restart unhealthy containers.
- Keep the project name and named volumes stable. Never use `docker compose down -v` for routine operations or run multiple app replicas against one SQLite database.
- Recreate the affected service after environment changes; `docker compose restart` does not reload `.env`. Follow the README commands for application and domain changes.

## Configuration and credentials

- Azure is the sole OCR provider; Compose enforces `AZURE_ENABLED=true` and `MISTRAL_ENABLED=false`. Do not enable retired Mistral flows.
- ZIP upload is always available. The sample disables WhatsApp, Telegram, and Google until the customer supplies their own settings; retain independent enable switches.
- WhatsApp requires pairing and an intended group ID. Telegram requires a bot token and chat allowlist. Empty group settings ingest nothing.
- Google uses customer-owned destinations and credentials. User OAuth with My Drive is the supported setup for this snapshot; its Drive adapter lacks shared-drive API support. Service-account configuration alone does not solve storage-quota restrictions.
- Run `bun run google:oauth` on the operator machine with a local browser and explicit local credential-path overrides, as documented in the README. The helper refuses to overwrite existing credentials.
- `.env` must be private (`0600`). Mount `secrets/` read-only at `/run/secrets`; directories need `0700`, credential files `0600`, readable by the image's runtime UID/GID. Verify ownership for each image; currently `1000:1000`.
- Bun auto-loads `.env` and may load `.env.local`; Compose loads `.env`. Use disposable paths and disabled or mocked integrations during testing rather than customer settings.
- Never log or commit credentials, raw provider errors/bodies, QR/auth state, `.env`, `secrets/`, `.secrets/`, data, originals, SQLite/WAL files, backups, or generated bundles. Keep the Docker build-context allowlist in `.dockerignore`.

## Data and application invariants

- `src/backend/server.ts` is the composition root. SQLite is canonical; Drive and Sheets are retryable projections, never recovery sources for canonical state.
- Deduplicate intake across channels by SHA-256 of original bytes, not filename. Originals are immutable direct children of `/data/originals`; provider, archive, and backup reads must use `readVerifiedOriginal` and verify database hashes.
- Never hold SQLite transactions across external calls. Preserve durable idempotency, lease/claim-token fencing, revision guards, transition history, and bounded retries.
- `src/backend/validation.ts` is the sole automatic-approval decision point. Required fields are `vendorName`, `invoiceDate`, and `total`; confidence is informational, deterministic validation still applies, and manual review is sticky.
- Treat provider output as untrusted: retain bounded normalization, raw-versus-normalized separation, and response size/time limits. OCR prose is not accounting data.
- Image preprocessing is in-memory and fail-open; PDFs bypass it. Production uses Sharp-only preprocessing, and extraction identity hashes actual submitted bytes.
- Reserve Drive IDs durably before mutation. Sheets writes are revision-specific, use hidden `bill.id` as immutable row identity, and wait for a persisted Drive URL.
- Keep readiness aligned with supported worker jobs; pending Google jobs must not degrade a Google-disabled deployment. Keep bill/job counts out of public readiness responses.

## Operations and handoff

- Run operations inside the application container: `docker compose exec -T bill-ledger bun dist/ops.js <command>`. Available commands include `inspect <id>`, `failed-jobs`, `retry [--include-permanent] <job-id>`, `migrate`, and `backup <directory>`.
- Backups snapshot SQLite and copy only database-referenced verified originals. Restore database and originals together while stopped, to the exact absolute originals path in the manifest (`/data/originals` here). Back up credentials and WhatsApp auth separately; keep protected copies off-server.
- Follow available repository task tracking. Do not require a parent Beads workspace to operate this standalone package. When Beads is available, create/claim work before editing and close it after verification.
- Do not commit, push, or sync remotes without explicit authorization. At handoff, report changed files, verification, task state when applicable, and any blocked checks.
