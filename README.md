# Bill Ledger

SQLite is canonical. WhatsApp and Telegram supply immutable originals; Mistral, Azure Document Intelligence, Google Drive, and Google Sheets are retryable external systems.

## Local setup

Install Bun 1.2+, then run `bun install --frozen-lockfile`. Copy `.env.example` to `.env`, create `data/` and `secrets/`, and set strong unique `REVIEW_USERNAME`/`REVIEW_PASSWORD` values. Run migrations with `bun run migrate`, then start with `bun run start`. For local development, `bun run dev` uses `data/dev/` for its database, originals, and WhatsApp auth, separate from production Docker volumes; `.env.local` can override the dev Telegram settings. Both `data/` and `.env.local` are Git-ignored.

Set `WHATSAPP_GROUP_ID` to the target group JID. Leave it unset to keep the account connected while ignoring messages from every group. On first start, scan the locally rendered pairing QR with the dedicated account:

```sh
bun run whatsapp:qr
```

The service writes the current QR token only to `${WHATSAPP_AUTH_PATH}/pairing-qr.token` with mode `0600`; the command refuses unsafe permissions and renders it without printing the token. A replacement QR atomically replaces the old token; it is removed after pairing or shutdown. Retain `WHATSAPP_AUTH_PATH`. Baileys is a release-candidate dependency: do not use a personal production account without an operational recovery plan.

For handwritten bills, send JPEG, PNG, or WebP images as WhatsApp documents/files when possible to avoid WhatsApp image recompression. Frame the bill clearly and minimize glare.

### Telegram setup

1. In the official `@BotFather` chat, use `/newbot` to create a dedicated bot. Store the returned token only as `TELEGRAM_BOT_TOKEN` in the untracked `.env`; do not put it in source control, shell history, command-line arguments, screenshots, support messages, or logs. Restrict `.env` to the service account (for example mode `0600`) and revoke/regenerate the token in BotFather if it is exposed.
2. In BotFather, use `/setprivacy` to disable privacy mode for this bot, then remove and re-add the bot if it was already a group member. The bot must remain a member of every configured source group and must be able to receive ordinary media messages, not only commands. Administrator privileges are not otherwise required.
3. Obtain each group's signed decimal chat ID from a trusted local Bot API update inspection without retaining or sharing the response, then set the comma-separated allowlist, for example `TELEGRAM_GROUP_IDS=-1001234567890,-1009876543210`. Whitespace and duplicate IDs are removed. An empty list is valid but ingests no chats even though polling continues.
4. Set `TELEGRAM_ENABLED=true` and restart. `TELEGRAM_BOT_TOKEN` is required only while enabled. `TELEGRAM_POLL_TIMEOUT_SECONDS` defaults to `30`; `TELEGRAM_REQUEST_TIMEOUT_MS` defaults to `35000` and must be strictly greater than the poll timeout in milliseconds; `TELEGRAM_MAX_RESPONSE_BYTES` defaults to `2097152` (2 MiB). `MAX_ATTACHMENT_BYTES` is the shared downloaded-media limit.

On the first successful poll for a database with no Telegram cursor, the service uses Telegram's `offset=-1`, `limit=1`, `timeout=0` snapshot to discard queued pre-enablement updates and persist the first retained cursor; updates arriving after that snapshot remain available for ingestion. Wait for this initialization before sending the first test bill. After initialization, updates are processed serially and the cursor advances only after durable intake or safe ignoring. If the service or Telegram is unavailable, retained later updates replay after recovery; transient poll/download failures are not acknowledged. Telegram controls Bot API update retention, so this is bounded outage replay rather than an indefinite queue.

Send a clear Telegram photo, or send JPEG, PNG, WebP, or PDF as a document when preserving original file bytes matters. Other document MIME types and messages without supported media are ignored. For a photo-size set, only Telegram's largest available photo is downloaded. A media album is not one bill: Telegram delivers separate messages and each supported album member is ingested independently. Each supported attachment in a message has its own immutable bill identity. Duplicate deliveries reuse the existing bill without redownloading it. Edited-message updates are ignored and safely cursor-advanced; an edit cannot add, replace, or correct a bill, caption, or original, so use the authenticated review workflow for corrections.

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

Azure may classify a valid uploaded document as `not_invoice`. That is a terminal batch-entry outcome, not an approved invoice, and it creates no Google Sheets projection. It remains visible in review and may be reclassified for manual invoice review. ZIP originals are immutable direct children of `ORIGINALS_DIR`; their recorded SHA-256 must match the stored bytes. Upload handling stages and validates archive bytes before publishing a canonical original, and no database transaction is held during archive or provider work.

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

### Multiple customers and central monitoring

Run one **Compose project per customer**, each with its own environment file, secrets directory, named volumes, review login, Azure OCR credentials, delivery tokens, and (if enabled) Google destinations. No customer data is copied to the central dashboard; it displays only per-customer bill/job counts and availability. Never reuse the same WhatsApp account, Telegram bot, Google Sheet, or credentials between customers.

1. Create the shared private network once: `docker network create bill-monitoring`. Create `customers/acme/.env` from `.env.example` and `customers/acme/secrets/` for that customer's Google credential file(s). Set `CUSTOMER_ID=acme`, a unique `APP_PORT` (e.g. `3001`), `REVIEW_ORIGIN=https://acme.bills.example.com` using your own distinct customer hostname, `REVIEW_USERNAME`, `REVIEW_PASSWORD`, `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`, `AZURE_DOCUMENT_INTELLIGENCE_API_KEY`, channel configuration and `MONITOR_TOKEN` (a unique random value of at least 32 characters). Set `GOOGLE_ENABLED` and `GOOGLE_AUTH_MODE` as appropriate; Compose mounts that customer's secrets at `/run/secrets`. Keep each file private (mode `0600`). `customers/` is Git-ignored.
2. Start with `CUSTOMER_ENV_FILE=./customers/acme/.env CUSTOMER_SECRETS_DIR=./customers/acme/secrets docker compose -f docker-compose.yml -f docker-compose.customer.yml --env-file ./customers/acme/.env -p bill-acme up -d --build`. Repeat with a different hostname, ID, port, env file, secrets directory and project name for each customer. Set `GOOGLE_ENABLED` and `GOOGLE_AUTH_MODE` explicitly in each customer env file. Each project's named volumes are independent. Run migrations/backup with the same environment variables, both `-f` files, `--env-file` and `-p` flags. Open `https://acme.bills.example.com/admin` or `/review` through your TLS-terminating authenticated proxy; the localhost app port is a backend, not a browser login address.
3. Create `monitor/.env` from `monitor.env.example` with a distinct operator login. Create `monitor/customers.json` from `monitor.customers.example.json`; add each customer's ID, display name, `http://<CUSTOMER_ID>:3000/monitor/status` URL and matching `MONITOR_TOKEN`. The IDs must be unique DNS-safe lowercase labels. Keep `monitor/.env` operator-owned with mode `0600` (Compose reads it on the host). On Linux, make the mounted `monitor/customers.json` readable only by the container's `bun` user: `sudo chown "$(docker compose -f docker-compose.monitor.yml -p bill-monitor run --build --rm --no-deps --entrypoint id monitor -u bun)" monitor/customers.json && sudo chmod 600 monitor/customers.json`. Start with `docker compose -f docker-compose.monitor.yml -p bill-monitor up -d --build` and open `http://127.0.0.1:3100/`. Override `MONITOR_PORT` for another local port. `monitor/` is Git-ignored.

The monitor polls customers concurrently at startup and 30 seconds after each completed cycle, independently of browser visits; requests time out after three seconds. The dashboard displays cached **Ready**, **Degraded**, or **Unavailable** states. Missing readiness information is degraded, never healthy. Restart the monitor to reload its customer list; recreate affected containers with `up -d` after environment/token changes. Back up each customer's volumes separately; do not share or rename volumes between projects. The shared Docker network allows customers to reach each other; keep it on a trusted host and restrict Docker access to administrators. To remove a customer, stop that project's containers and remove its entry from the monitoring config; preserve its volumes for restore. Do not use `down -v` unless intentionally deleting that customer's data.

### Browser hostname isolation

`REVIEW_ORIGIN` is required by the customer Compose override. It must be a canonical HTTPS origin with a DNS hostname, no port or trailing slash; localhost and IP addresses are rejected. Each customer and the monitor need different hostnames. Cookies are host-scoped, **not port-scoped**. Configured customers use `__Host-review_session` cookies (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`); localhost development without `REVIEW_ORIGIN` retains the single-instance login.

The TLS proxy must preserve the public `Host`, redirect public HTTP to HTTPS, and reject unknown virtual hosts. Forwarded headers do not authorize a hostname. HTTP between the proxy and private backend is supported; the configured origin determines cookie security. For example, inside an existing Nginx TLS server with your certificates and proxy authentication configured:

```nginx
server_name acme.bills.example.com;
location / {
    proxy_set_header Host $host;
    proxy_pass http://127.0.0.1:3001;
}
```

Use a separate virtual host for each customer and the monitor. Keep backend ports private. Recreate existing customer containers after setting `REVIEW_ORIGIN`, and sign in again at their HTTPS hostnames; legacy localhost sessions are not accepted by configured customers.

### Recovery and alerting

Both Compose services use `restart: unless-stopped` for crash/host-reboot recovery. An explicitly stopped service stays stopped. Customer shutdown has a two-minute grace period. Docker healthchecks **do not themselves restart unhealthy processes**: transient startup failures retry every 30 seconds, and the transports handle reconnects; persistent credential/pairing failures require operator action.

- Customer `/health`: liveness only. `/ready`: 200 when initialization, configured intake, worker and database checks succeed; otherwise 503. Compose checks `/ready`. Unpaired WhatsApp is degraded while the admin UI remains available for pairing.
- Authenticated `/monitor/status`: counts plus sanitized readiness reasons, worker progress, and overdue backlog information. Stalled jobs/backlog are detected after at least 15 minutes (extended for configured provider timeouts).
- Monitor `/health`: 200 only after a background check and while its polling loop is running and fresh; 503 before startup, after shutdown, or when stale. Customer outages do not make the monitor itself unhealthy.
- Structured logs report state changes, recovery, and increases in failed-bill/permanent-job counts. Configure `MONITOR_ALERT_WEBHOOK_URL` in the monitor environment for generic JSON POST alerts, or connect log-based alerting. Webhook requests time out after three seconds; failed deliveries retry next cycle, coalescing the latest event per customer/event kind. Payloads contain customer IDs, states or failure counts, and timestamps—not credentials or bill contents.
- Independently monitor the monitor's `/health` from your host/external alerting service; a dead monitor cannot notify you itself. Before unattended operation, verify receipt by stopping a test customer, restoring it, and observing outage/recovery notifications. For persistent degradation, inspect authenticated status reasons and container logs, correct configuration or pairing, and recreate/restart the affected service as appropriate.

Each `docker compose up --build` uses persistent named volumes for `/data`, originals, and WhatsApp auth; credentials are mounted read-only from the configured customer secrets directory. Without the customer override, the original Compose defaults (Google enabled with user OAuth) remain and no shared network is required. Set `GOOGLE_DRIVE_FOLDER_ID` and `GOOGLE_SHEET_ID` only if Google is enabled; the selected Google credential must access both resources. For OAuth generate the credential on the host with `bun run google:oauth` and mount the resulting file as `google-authorized-user.json` in that customer's secrets directory. Compose sets `ORIGINALS_DIR=/data/originals`; Telegram long polling stores its cursor in SQLite and its token only in that customer's environment. The image pre-creates `/data`, `/data/originals`, and `/data/whatsapp-auth` for the `bun` user. Existing root-owned volumes are not repaired automatically: stop the service and run the corresponding Compose project with `run --rm --user root bill-ledger sh -c 'chown -R bun:bun /data /data/originals /data/whatsapp-auth'`. The container runs as `bun` and exposes `/health`.

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

`retry` will not requeue succeeded/running work or a validation-invalidated projection. Provider handlers retain their idempotency key; inspect the job and provider state before replaying a permanent failure. `backup` first creates a WAL-safe SQLite `VACUUM INTO` snapshot, then reads that snapshot's canonical bill records and copies only their referenced originals through descriptor-relative hash/size/MIME verification. Each archive original retains its canonical direct-child basename. Orphan files and bills committed after the snapshot are intentionally omitted; every snapshot bill must have a verified original or backup fails and removes the partial archive. `manifest.json` records each source canonical path, archive-relative basename, database/original SHA-256 checksums, and bill IDs. **Restore only to the same absolute `ORIGINALS_DIR` recorded as `originalsRoot` in the manifest**; the snapshot stores those absolute paths and relocation is not supported. Stop the service, restore the archived database file to `APP_DATABASE_PATH` and archive `originals/` directly into that recorded root, verify checksums, run `bun run migrate`, then start one service host.

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
container=$(docker run -d --rm -p 3100:3000 -e APP_HOST=0.0.0.0 -e APP_DATA_DIR=/tmp/health-smoke -e APP_DATABASE_PATH=/tmp/health-smoke/bill-ledger.sqlite -e WHATSAPP_ENABLED=false -e WHATSAPP_GROUP_ID=health-smoke@g.us -e WHATSAPP_AUTH_PATH=/tmp/health-smoke/whatsapp-auth -e ORIGINALS_DIR=/tmp/health-smoke/originals -e TELEGRAM_ENABLED=false -e MISTRAL_API_KEY=test -e MISTRAL_MODEL=test -e AZURE_ENABLED=false -e GOOGLE_ENABLED=false -e REVIEW_USERNAME=test -e REVIEW_PASSWORD=test bill-ledger-health-smoke)
curl --fail http://127.0.0.1:3100/health
```

Live smoke checklist:

1. Pair the dedicated WhatsApp account. For Telegram, configure exactly two test group IDs, confirm the bot is a member of both with privacy disabled, start against a disposable database, and wait until its one-time initial backlog discard has persisted a cursor.
2. Send a Telegram image in the first group and a PDF in the second. Confirm each creates one Telegram review record and immutable original before provider work; inspect extraction provenance and job transitions, then verify the byte-identical Drive original and hidden-ID Sheet row where Google is enabled.
3. After the cursor exists, stop the service, send supported media to both groups, and restart within Telegram's update-retention window. Confirm all outage updates replay exactly once.
4. Cause controlled delivery of the same Telegram chat/message/attachment identity twice, using the offline transport test harness or a deployment replay fixture. Confirm one bill, one canonical original, and no duplicate projection row.
5. Edit the caption of an ingested Telegram attachment and confirm the edit is ignored and the immutable bill does not change. Send a multi-item album and confirm each supported member appears as an individual bill.
6. Temporarily deny Telegram network access during a media download, restore it, and confirm the unacknowledged update replays. Separately deny each extraction/projection provider and confirm a visible retryable job before replaying it.
7. Inspect `docker compose logs bill-ledger` for safe event codes only. Verify the bot token is absent without printing it: `docker compose logs bill-ledger 2>&1 | bun -e 'const token=Bun.env.TELEGRAM_BOT_TOKEN; const logs=await Bun.stdin.text(); if(token && logs.includes(token)) process.exit(1)'`. Confirm no Bot API URL, response body, credential, or raw provider error appears.
8. Complete one review correction and one rejection, then repeat the existing WhatsApp duplicate-delivery smoke if WhatsApp is enabled.

## Security

Never commit `.env`, `secrets/`, Telegram bot tokens, WhatsApp auth, SQLite files, originals, backups, or `dist/`. Revoke and regenerate a leaked Telegram token in BotFather; rotate leaked Mistral/Google/review credentials. Google sharing and a reverse proxy are deployment configuration, not protections provided by the app.
