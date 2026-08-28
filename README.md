# Bill Ledger

SQLite is canonical. WhatsApp, Mistral, Google Drive, and Google Sheets are retryable projections.

## Local setup

Install Bun 1.2+, then run `bun install --frozen-lockfile`. Copy `.env.example` to `.env`, create `data/` and `secrets/`, and set strong unique `REVIEW_USERNAME`/`REVIEW_PASSWORD` values. Run migrations with `bun run migrate`, then start with `bun run start`.

Set `WHATSAPP_GROUP_ID` to the target group JID. On first start, scan the locally rendered pairing QR with the dedicated account:

```sh
bun run whatsapp:qr
```

The service writes the current QR token only to `${WHATSAPP_AUTH_PATH}/pairing-qr.token` with mode `0600`; the command refuses unsafe permissions and renders it without printing the token. A replacement QR atomically replaces the old token; it is removed after pairing or shutdown. Retain `WHATSAPP_AUTH_PATH`. Baileys is a release-candidate dependency: do not use a personal production account without an operational recovery plan.

Set `MISTRAL_API_KEY` and `MISTRAL_MODEL`. Google projections use exactly one `GOOGLE_AUTH_MODE`:

- `service_account` is the default. Put its JSON at `secrets/google-service-account.json`, configure `GOOGLE_SERVICE_ACCOUNT_JSON`, and grant that service account access to the configured Drive folder and spreadsheet.
- `user_oauth` uses a personal Gmail account. In Google Cloud, configure the consent screen, add the Gmail account as a **test user** while the app is in testing, enable Drive and Sheets APIs, and create an OAuth **Desktop app** client. Save that downloaded client JSON outside source control (for example `secrets/google-oauth-client.json`). Set `GOOGLE_OAUTH_CLIENT_JSON` to it and `GOOGLE_OAUTH_CREDENTIAL_JSON` to a new, nonexistent private destination, then run this one-time local command:

  ```sh
  bun run google:oauth
  ```

  The command opens a loopback callback only on `127.0.0.1`, prints an authorization URL, and writes a mode-`0600` authorized-user refresh-token credential. It never prints tokens or client secrets and refuses to overwrite the destination. Then set `GOOGLE_ENABLED=true`, `GOOGLE_AUTH_MODE=user_oauth`, and `GOOGLE_OAUTH_CREDENTIAL_JSON` in the service environment. The selected Gmail user must own or have edit access to the Drive folder and spreadsheet.

For either mode, restart the service after changing credentials, inspect failures with `bun run ops failed-jobs`, then retry only the affected retryable jobs with `bun run ops retry <job-id>`. Refresh-token credentials and Desktop client JSON are secrets: keep them in `secrets/`, never commit them, and revoke them from the Google account if exposed.

The review queue is `http://127.0.0.1:3000/review`; it is Basic-auth protected. Put it behind a TLS-terminating authenticated reverse proxy in any non-local deployment.

## Docker

`docker compose up --build` uses persistent named volumes for `/data`, originals, and WhatsApp auth; credentials are mounted read-only from `./secrets`. Compose maps both `/run/secrets/google-service-account.json` and `/run/secrets/google-authorized-user.json`; only the file selected by `GOOGLE_AUTH_MODE` is read. Run `bun run google:oauth` on the local host before starting Compose, not in the container. The image pre-creates and assigns `/data`, `/data/originals`, and `/data/whatsapp-auth` to `bun`, so fresh named volumes inherit usable ownership. Existing root-owned volumes are not repaired automatically: stop the service and run `docker compose run --rm --user root bill-ledger sh -c 'chown -R bun:bun /data /data/originals /data/whatsapp-auth'`. The container runs as `bun`, exposes `/health`, and writes no credentials into its image. Set `APP_PORT`, provider credentials, and IDs in `.env`. Do not publish the review port directly to the Internet.

Run bundled operational commands in Docker with `docker compose run --rm bill-ledger bun dist/ops.js migrate` (replace `migrate` with any command below). For backups, use a persistent path such as `docker compose run --rm bill-ledger bun dist/ops.js backup /data/backups`.

## Operations

All commands are local-only and use SQLite, never provider APIs:

```sh
bun run ops migrate
bun run ops inspect <whatsapp-message-id|bill-id|drive-id|sheet-row-key>
bun run ops failed-jobs
bun run ops retry <retryable-job-id>
bun run ops retry --include-permanent <eligible-job-id>
bun run ops backup ./backups
```

`retry` will not requeue succeeded/running work or a validation-invalidated projection. Provider handlers retain their idempotency key; inspect the job and provider state before replaying a permanent failure. `backup` first creates a WAL-safe SQLite `VACUUM INTO` snapshot, then reads that snapshot's canonical bill records and copies only their referenced originals through descriptor-relative hash/size/MIME verification. Each archive original retains its canonical direct-child basename. Orphan files and bills committed after the snapshot are intentionally omitted; every snapshot bill must have a verified original or backup fails and removes the partial archive. `manifest.json` records each source canonical path, archive-relative basename, database/original SHA-256 checksums, and bill IDs. **Restore only to the same absolute `WHATSAPP_ORIGINALS_DIR` recorded as `originalsRoot` in the manifest**; the snapshot stores those absolute paths and relocation is not supported. Stop the service, restore the archived database file to `APP_DATABASE_PATH` and archive `originals/` directly into that recorded root, verify checksums, run `bun run migrate`, then start one service host.

## Verification and smoke test

```sh
bun run typecheck
bun test
bun run build
```

Live smoke checklist: pair the dedicated account; send one image and one PDF in the configured group; confirm original bytes on disk before provider work; check `ops inspect` for extraction provenance and job transitions; verify a byte-identical Drive original and one hidden-ID Sheet row; send a duplicate WhatsApp event; test one review correction and one rejection; temporarily deny each provider and confirm a visible retryable job before replaying it.

## Security

Never commit `.env`, `secrets/`, WhatsApp auth, SQLite files, originals, backups, or `dist/`. Rotate leaked Mistral/Google/review credentials. Google sharing and a reverse proxy are deployment configuration, not protections provided by the app.
