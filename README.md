# Bill Ledger

SQLite is canonical. WhatsApp, Mistral, Azure Document Intelligence, Google Drive, and Google Sheets are retryable projections.

## Local setup

Install Bun 1.2+, then run `bun install --frozen-lockfile`. Copy `.env.example` to `.env`, create `data/` and `secrets/`, and set strong unique `REVIEW_USERNAME`/`REVIEW_PASSWORD` values. Run migrations with `bun run migrate`, then start with `bun run start`.

Set `WHATSAPP_GROUP_ID` to the target group JID. Leave it unset to keep the account connected while ignoring messages from every group. On first start, scan the locally rendered pairing QR with the dedicated account:

```sh
bun run whatsapp:qr
```

The service writes the current QR token only to `${WHATSAPP_AUTH_PATH}/pairing-qr.token` with mode `0600`; the command refuses unsafe permissions and renders it without printing the token. A replacement QR atomically replaces the old token; it is removed after pairing or shutdown. Retain `WHATSAPP_AUTH_PATH`. Baileys is a release-candidate dependency: do not use a personal production account without an operational recovery plan.

For handwritten bills, send JPEG, PNG, or WebP images as WhatsApp documents/files when possible to avoid WhatsApp image recompression. Frame the bill clearly and minimize glare.

Set `MISTRAL_ENABLED=false` to use Azure Document Intelligence as the only extraction provider; Mistral credentials are not required in this mode. Set `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` to the HTTPS origin of the Document Intelligence resource and set `AZURE_DOCUMENT_INTELLIGENCE_API_KEY` privately. `AZURE_ENABLED` defaults to `true`; when enabled, both values are required. `AZURE_MAX_RESPONSE_BYTES` defaults to `2097152` (2 MiB) and is an integer of at least `1`; `AZURE_REQUEST_TIMEOUT_MS` defaults to `60000` ms and is an integer of at least `1`; `AZURE_POLL_INTERVAL_MS` defaults to `500` ms and is an integer of at least `0`; and `OCR_FALLBACK_CONFIDENCE_THRESHOLD` defaults to `0.80` and must be in the inclusive range `0`–`1`. When Mistral is enabled, Azure remains the fallback for missing or low-confidence `vendorName`, `invoiceDate`, or `total` evidence according to that threshold. At least one extraction provider must be enabled.

Google projections use exactly one `GOOGLE_AUTH_MODE`:

- `service_account` is the default. Put its JSON at `secrets/google-service-account.json`, configure `GOOGLE_SERVICE_ACCOUNT_JSON`, and grant that service account access to the configured Drive folder and spreadsheet.
- `user_oauth` uses a personal Gmail account. In Google Cloud, configure the consent screen, add the Gmail account as a **test user** while the app is in testing, enable Drive and Sheets APIs, and create an OAuth **Desktop app** client. Save that downloaded client JSON outside source control (for example `secrets/google-oauth-client.json`). Set `GOOGLE_OAUTH_CLIENT_JSON` to it and `GOOGLE_OAUTH_CREDENTIAL_JSON` to a new, nonexistent private destination, then run this one-time local command:

  ```sh
  bun run google:oauth
  ```

  The command opens a loopback callback only on `127.0.0.1`, prints an authorization URL, and writes a mode-`0600` authorized-user refresh-token credential. It never prints tokens or client secrets and refuses to overwrite the destination. Then set `GOOGLE_ENABLED=true`, `GOOGLE_AUTH_MODE=user_oauth`, and `GOOGLE_OAUTH_CREDENTIAL_JSON` in the service environment. The selected Gmail user must own or have edit access to the Drive folder and spreadsheet.

For either mode, restart the service after changing credentials, inspect failures with `bun run ops failed-jobs`, then retry only the affected retryable jobs with `bun run ops retry <job-id>`. Refresh-token credentials and Desktop client JSON are secrets: keep them in `secrets/`, never commit them, and revoke them from the Google account if exposed.

The review queue is `http://127.0.0.1:3000/review`; it is Basic-auth protected. Put it behind a TLS-terminating authenticated reverse proxy in any non-local deployment.

## Admin ZIP uploads

The Basic-auth-protected admin dashboard at `http://127.0.0.1:3000/admin` can upload a `.zip` archive through `POST /admin/api/zip`. The browser obtains a separate admin-ZIP CSRF token from `GET /admin/api/overview`, sends the ZIP with that token and an opaque upload ID, then shows upload progress. The endpoint accepts `application/zip` or `application/x-zip-compressed` only and returns `202 Accepted` with a batch ID. `GET /admin/api/zip/:batchId` returns the safe batch status; the UI polls it every two seconds until no entry is queued or processing.

ZIP upload availability is controlled solely by `AZURE_ENABLED`: when Azure is disabled, the dashboard disables upload and the POST endpoint returns `503`; it does not disclose provider credentials or provider error bodies. There are no ZIP environment variables. The fixed limits are 50 MiB compressed ZIP bytes, 200 MiB total expanded entry bytes, 20 MiB per entry, and 500 entries. The parser is the direct runtime dependency [`yauzl`](https://www.npmjs.com/package/yauzl) (`^3.4.0` in `package.json`); Bun bundles the server import normally, so no separate native tool or build setting is required.

Archive enumeration creates durable records before the `202` response; the resulting Azure extraction and review work continues asynchronously. Each supported entry becomes an immutable canonical original and an Azure-only extraction job, while the dashboard reports the batch and per-entry outcomes. Entry paths are never extracted to the filesystem. Encrypted entries, directories, special files, unsafe paths, unsupported bytes, and entries exceeding a limit are recorded as `rejected`; malformed/archive-processing failures are `failed`. Valid entries start `queued`/`processing` and finish as `complete`, `not_invoice`, `rejected`, or `failed`; a batch is `queued`, `processing`, `completed` once no entry remains queued or processing, or `failed` for an archive-processing failure. A ZIP retry with the same upload ID and identical bytes reuses its batch; different bytes are rejected.

Azure may classify a valid uploaded document as `not_invoice`. That is a terminal batch-entry outcome, not an approved invoice, and it creates no Google Sheets projection. It remains visible in review and may be reclassified for manual invoice review. ZIP originals are immutable direct children of `WHATSAPP_ORIGINALS_DIR`; their recorded SHA-256 must match the stored bytes. Upload handling stages and validates archive bytes before publishing a canonical original, and no database transaction is held during archive or provider work.

The authenticated `GET /review/export.csv` download contains approved invoices only. It excludes not-invoice records, unapproved/rejected work, and failed entries; it is not a ZIP batch report.

## Image preprocessing policy

`sharp-opencv-v1` is release/job-policy metadata, not an environment setting. New-job preprocessing is disabled by default with `IMAGE_PREPROCESSING_ENABLED=false`; `IMAGE_PREPROCESSING_TIMEOUT_MS=8000` bounds each derivative attempt. Only JPEG, PNG, and WebP attachments may receive an in-memory derivative. PDFs pass through unchanged, and preprocessing never writes or replaces an original.

The approved-example evaluator compares three modes: `original`, forced `sharp`, and forced `opencv`. Production has no selectable sharp-only mode: its fixed `auto` behavior is equivalent to the evaluator's `opencv` request, rectifying only when it finds a reliable quadrilateral and otherwise using Sharp-only processing.

Enable production only when the `opencv`/auto candidate has zero false approvals, fewer than the baseline 12 aggregate exact-field differences, and at most 5 differences for `example3` and 7 for `example4`. Otherwise leave preprocessing disabled. The Sharp-only result is diagnostic and cannot be selected by configuration in this phase.

### Rollout

1. Keep `IMAGE_PREPROCESSING_ENABLED=false`; deploy and confirm `bun run verify-build` plus the container import/health smoke. Existing jobs retain their durable `:original` policy.
2. With written authorization, run `APPROVED_EXAMPLE_EVALUATION_AUTHORIZED=true bun run evaluate:approved-examples`; retain only its six sanitized JSON decision lines in the release record.
3. Enable only when the fixed `opencv`/auto candidate passes the gate. Newly ingested jobs receive `:sharp-opencv-v1`; existing `:original` jobs remain original-input jobs, so rollout does not change their request bytes.
4. Monitor `needs_review` rate and extraction processing latency against the pre-enable interval.
5. To roll back, first pause ingestion and the worker, record jobs already carrying `:sharp-opencv-v1`, set `IMAGE_PREPROCESSING_ENABLED=false`, and restart. Existing preprocessing-policy jobs remain deterministic derivative/fallback jobs and new jobs use `:original`; do not rewrite job keys. The input SHA-256 suffix prevents one provider key from being reused for different bytes.

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
bun run typecheck && bun test && bun run verify-build
bun -e 'import sharp from "sharp"; import { WorkerImagePreprocessor } from "./dist/image-preprocessing.js"; const bytes = new Uint8Array(await sharp({ create: { width: 64, height: 64, channels: 4, background: "white" } }).png().toBuffer()); const result = await new WorkerImagePreprocessor({ timeoutMs: 8000 }).preprocess({ bytes, mimeType: "image/png", mode: "sharp" }); if (!result || result.mode !== "sharp" || result.width !== 64 || result.height !== 64) process.exit(1);'
```

Validate the Compose file separately with `docker compose config --quiet`. For the container smoke, use an empty test database with WhatsApp and Google disabled, while still providing the required non-provider configuration. This direct `docker run` does not load compose `.env` or mount `secrets/`; it must return `/health` 200 and create no jobs or provider calls:

```sh
docker compose config --quiet
docker build -t bill-ledger-health-smoke .
set -e; container=; trap 'test -z "$container" || docker stop "$container" >/dev/null 2>&1 || true' EXIT
container=$(docker run -d --rm -p 3100:3000 -e APP_HOST=0.0.0.0 -e APP_DATA_DIR=/tmp/health-smoke -e APP_DATABASE_PATH=/tmp/health-smoke/bill-ledger.sqlite -e WHATSAPP_ENABLED=false -e WHATSAPP_GROUP_ID=health-smoke@g.us -e WHATSAPP_AUTH_PATH=/tmp/health-smoke/whatsapp-auth -e WHATSAPP_ORIGINALS_DIR=/tmp/health-smoke/originals -e MISTRAL_API_KEY=test -e MISTRAL_MODEL=test -e AZURE_ENABLED=false -e GOOGLE_ENABLED=false -e REVIEW_USERNAME=test -e REVIEW_PASSWORD=test bill-ledger-health-smoke)
curl --fail http://127.0.0.1:3100/health
```

Live smoke checklist: pair the dedicated account; send one image and one PDF in the configured group; confirm original bytes on disk before provider work; check `ops inspect` for extraction provenance and job transitions; verify a byte-identical Drive original and one hidden-ID Sheet row; send a duplicate WhatsApp event; test one review correction and one rejection; temporarily deny each provider and confirm a visible retryable job before replaying it.

## Security

Never commit `.env`, `secrets/`, WhatsApp auth, SQLite files, originals, backups, or `dist/`. Rotate leaked Mistral/Google/review credentials. Google sharing and a reverse proxy are deployment configuration, not protections provided by the app.
