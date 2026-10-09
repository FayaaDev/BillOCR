# JabOCR standalone deployment

Buildable application source for one Linux amd64 deployment. SQLite and original
attachments are canonical; Google Drive/Sheets and Zoho WorkDrive/Sheet are optional projections.
Azure Document Intelligence provides OCR. WhatsApp, Telegram, and dashboard ZIP
upload are alternative intake methods. The sample disables WhatsApp, Telegram,
Google, and Zoho until configured; keep `AZURE_ENABLED=true` and `MISTRAL_ENABLED=false`.

Run commands from this directory unless stated otherwise. Supply your own domain,
credentials, and integration destinations; none are included.

## 1. Prepare the host

- Linux x86_64, Docker Engine, and Docker Compose v2 (`docker compose version`).
- A dedicated public hostname whose DNS A record points to this server. Publish
  an AAAA record only if IPv6 also reaches it correctly.
- Free TCP ports 80 and 443, allowed through host and provider firewalls. Caddy
  obtains/renews certificates and redirects HTTP to HTTPS. Allow outbound DNS and
  HTTPS for certificate issuance, images, Azure, and enabled integrations.
- Persistent disk space for originals, SQLite, images, and backups. Builds need
  more RAM than normal operation; on a 2 GB server, prefer building off-server.

Compose project `jabocr` runs `bill-ledger` (`jabocr:standalone`, build context `.`,
platform `linux/amd64`) and `caddy` (`caddy:2.10.2-alpine`). Only Caddy publishes
ports 80/443; the backend is private on container port 3000.

```sh
cp .env.example .env
chmod 600 .env
mkdir -p secrets
chmod 700 secrets
```

Edit `.env` privately:

| Setting | Required value |
| --- | --- |
| `APP_DOMAIN` | Qualified hostname, e.g. `bills.example.com`; no scheme, port, or slash |
| `CADDY_EMAIL` | Operator email for certificate registration |
| `REVIEW_USERNAME`, `REVIEW_PASSWORD` | Unique login and strong password |
| `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` | Your resource's HTTPS endpoint |
| `AZURE_DOCUMENT_INTELLIGENCE_API_KEY` | Your resource's key |

Compose loads the app's `.env` and sets `REVIEW_ORIGIN=https://${APP_DOMAIN}`.
Use that hostname for browser access; IP/alternate-host access is rejected.
Keep the supplied Caddy proxy's public Host preservation and HTTPS configuration.

Compose fixes `APP_DATA_DIR=/data`, `APP_DATABASE_PATH=/data/bill-ledger.sqlite`,
`ORIGINALS_DIR=/data/originals`, and `WHATSAPP_AUTH_PATH=/data/whatsapp-auth`.
The host `./secrets` directory mounts read-only at `/run/secrets`. Do not substitute
host-relative paths for these container paths.

## 2. Build and start

Validate without printing resolved secrets, then build:

```sh
docker compose config --quiet
docker compose build bill-ledger
docker compose run --rm --no-deps --entrypoint id bill-ledger
```

The runtime user is expected to be `bun`, UID/GID `1000:1000`; verify the last
command's output for every new image. On the Linux host, give the mounted secrets
directory that ownership, substituting the verified IDs if different:

```sh
sudo chown -R 1000:1000 secrets
sudo chmod 700 secrets
# Repeat for each credential file installed now or later:
# sudo chmod 600 secrets/google-authorized-user.json
docker compose up -d --no-build
docker compose ps
docker compose exec -T bill-ledger bun -e 'const r = await fetch("http://127.0.0.1:3000/ready"); console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1)'
```

Startup applies database migrations automatically. `/health` is liveness only;
`/ready` returns 200 when ready or 503 when degraded. Do not use `up --wait` for
initial WhatsApp setup: an unpaired account is degraded while the dashboard
remains available. Container health status alone does not trigger a restart.

Open `https://YOUR_APP_DOMAIN/admin`; it redirects to `/login`. Sign in with the
review credentials. Routes:

- `/admin`: dashboard and ledger.
- `/admin?view=upload`: ZIP upload.
- `/admin?view=integrations`: intake status and configured groups.
- `/review`: review queue; open a bill to inspect/correct/approve it.
- `/review/export.xlsx`: ledger export.

Upload a small ZIP containing a JPEG, PNG, WebP, or PDF bill. Confirm it appears,
OCR completes, and review works. ZIP limits: 50 MiB compressed, 200 MiB expanded,
20 MiB per entry, 500 entries. Identical original bytes deduplicate across inputs.

### Optional off-server build

On a build machine with this source directory (an ARM machine needs Docker's
amd64 emulation), build and export:

```sh
docker build --platform linux/amd64 -t jabocr:standalone .
docker image save -o jabocr-amd64.tar jabocr:standalone
```

Transfer the archive to the server privately. There, replace the build step with:

```sh
docker image load -i jabocr-amd64.tar
docker compose pull caddy
docker compose up -d --no-build --pull never
```

Perform the same UID/permissions and readiness checks. The server still needs
this directory's Compose/Caddy configuration, `.env`, and `secrets/`.

## 3. Optional integrations

After editing `.env` or installing credentials, validate and recreate the app:

```sh
docker compose config --quiet
docker compose up -d --no-build --no-deps --force-recreate bill-ledger
```

`docker compose restart` does not reload environment files. Domain/email changes
also require recreating Caddy with `docker compose up -d --no-build --force-recreate`.

### WhatsApp

1. Set `WHATSAPP_ENABLED=true`. Initially leave `WHATSAPP_GROUP_ID` unset: this
   allows pairing but ingests no groups. Recreate the app and keep it running.
2. Sign in, then open `/admin/api/whatsapp/pairing-qr` on the same HTTPS hostname.
   Scan with the dedicated account's **Linked devices → Link a device**. Refresh
   for a replacement QR if it expires. A 404 means no QR is currently available;
   inspect integration status and retry while awaiting pairing.
3. After connection, open authenticated `/admin/api/whatsapp/groups`. Copy the
   intended group's `id` into `WHATSAPP_GROUP_ID`, then recreate the app.
4. Send a new test bill in that group and verify its review record. Send images
   as documents/files when preserving original image quality matters.

The integrations page displays status; it does not provide a pairing button.
The current QR token lives privately at `/data/whatsapp-auth/pairing-qr.token`
(mode `0600`) and is removed after pairing or shutdown. Never share QR/token/auth
files. Retain the WhatsApp volume across recreations. If the account logs out,
restore a valid auth backup or stop the app, preserve and clear the old auth
directory contents, then start and pair again. Use one running instance per account.

### Telegram

1. Create a dedicated bot with BotFather `/newbot`; store its token privately in
   `.env` as `TELEGRAM_BOT_TOKEN`.
2. Disable privacy with BotFather `/setprivacy`, add the bot to the intended
   groups (remove/re-add if already present), and permit ordinary media messages.
3. Obtain signed decimal chat IDs through trusted local Bot API update inspection.
   Set `TELEGRAM_GROUP_IDS` to comma-separated IDs, e.g. `-1001234567890`.
   An empty allowlist polls but ingests nothing. Use no other poller/webhook for
   this bot; remove any existing webhook before starting long polling.
4. Set `TELEGRAM_ENABLED=true`, recreate, and wait for initial polling before
   sending a fresh photo or JPEG/PNG/WebP/PDF document.

First initialization discards queued historical updates and persists a cursor in
SQLite. Later outage replay is bounded by Telegram's retention. Albums create
separate bills; message edits do not correct existing bills. Use review for edits.

### Google Drive and Sheets: user OAuth (default mode)

1. Enable Google Drive and Sheets APIs in your Google Cloud project. Configure
   the OAuth consent screen and add your Google account as a test user if in
   testing. Create a **Desktop app** OAuth client and download its JSON privately.
   Testing-mode refresh tokens can expire after seven days for these scopes;
   choose an appropriate production consent configuration for unattended operation.
2. On the **operator machine**, install **Bun 1.3.14** and use a copy of this source
   directory. Save the Desktop client as `secrets/google-oauth-client.json` and
   ensure the output below does not exist. Keep this local directory owned by the
   operator, rather than applying the server's container UID to it.

   ```sh
   bun --version
   bun install --frozen-lockfile
   chmod 700 secrets
   chmod 600 secrets/google-oauth-client.json
   GOOGLE_OAUTH_CLIENT_JSON="$PWD/secrets/google-oauth-client.json" \
   GOOGLE_OAUTH_CREDENTIAL_JSON="$PWD/secrets/google-authorized-user.json" \
   bun run google:oauth
   ```

   These explicit local environment overrides prevent Bun's automatic `.env`
   loading from using the container-only `/run/secrets` path. The included helper
   `src/backend/google-oauth.ts` prints an authorization URL: open it in a browser
   **on that same machine**, within five minutes. Its callback binds only to
   `127.0.0.1` on an ephemeral port; do not run it on a headless server and open
   the URL on another computer. It writes the refresh-token credential as `0600`
   and refuses overwrites. Move an old output aside privately before reauthorizing.
3. Securely transfer only `google-authorized-user.json` into the server's
   `secrets/`; apply verified runtime UID/GID ownership and mode `0600`.
4. Create/select a folder in the authorized user's **My Drive** and a spreadsheet
   writable by that user. Shared drives are not supported by this source snapshot.
   In `.env`, set:

   ```dotenv
   GOOGLE_ENABLED=true
   GOOGLE_AUTH_MODE=user_oauth
   GOOGLE_OAUTH_CREDENTIAL_JSON=/run/secrets/google-authorized-user.json
   GOOGLE_DRIVE_FOLDER_ID=your-folder-id
   GOOGLE_SHEET_ID=your-spreadsheet-id
   GOOGLE_SHEET_NAME=Ledger
   ```

5. Recreate the app. Ingest and approve a new test bill. Verify the actual file in
   the selected Drive folder and the corresponding row/link in the selected Sheet.
   `/ready` does **not** validate Google access. Preserve the Sheet's hidden bill
   ID column, which provides stable row identity. Inspect/retry failed jobs below.

The application also accepts `GOOGLE_AUTH_MODE=service_account` with
`GOOGLE_SERVICE_ACCOUNT_JSON=/run/secrets/google-service-account.json`, but sharing
a My Drive folder does not give a service account storage quota, and this snapshot
lacks shared-drive API support. Use user OAuth with My Drive for this deployment.

### Zoho WorkDrive and Sheet: Saudi Self Client OAuth

Zoho is independent of Google and defaults disabled. Only Saudi-hosted accounts
(`ZOHO_REGION=sa`) are supported. Running the helper prepares credentials;
enable synchronization separately after checking dedicated test destinations.

1. On the operator machine, use Bun and this source directory as in the Google
   setup above. In the Saudi Zoho API Console, create/select a **Self Client**.
   Keep its client ID and secret privately in environment variables named exactly
   `Client_ID` and `Client_Secret` (for example, in your private local `.env.local`).
2. Generate a short-lived grant code for the intended Saudi account with scopes:

   ```text
   WorkDrive.files.CREATE,WorkDrive.files.READ,ZohoFiles.files.READ,ZohoSheet.dataAPI.READ,ZohoSheet.dataAPI.UPDATE
   ```

   `ZohoFiles.files.READ` is required for original-byte download verification.
   If you previously authorized the four-scope setup, move the old credential
   aside privately and re-run `zoho:oauth` with a new grant covering all five
   scopes. The helper refuses overwrites. Destination IDs are not needed by it.
3. Run promptly in an interactive local terminal, explicitly overriding the
   output path for the operator machine:

   ```sh
   ZOHO_OAUTH_CREDENTIAL_JSON="$PWD/secrets/zoho-authorized-user.json" bun run zoho:oauth
   ```

   Bun automatically loads `.env` and `.env.local`; the explicit override avoids
   a container-only credential path. Paste the grant code at the hidden prompt,
   then press Enter. Never pass the code as a command-line argument. Ctrl-C
   cancels and restores the terminal. Input expires after five minutes.

The helper posts only to `https://accounts.zoho.sa/oauth/v2/token`, rejects
redirects, and accepts only `https://www.zohoapis.sa` as the returned API domain.
It stores client ID, client secret, refresh token, token endpoint and API domain;
it does not store the expiring access token. Default output is local
`secrets/zoho-authorized-user.json`; existing output is refused before exchange.
Publication is atomic and exclusive, with file mode `0600` and new directories
`0700`. Existing directory permissions are left intact. Protect the credential
and keep it out of version control; move an old output aside privately before
reauthorizing.

4. Select a private WorkDrive folder writable by this account and a writable
   Zoho Sheet workbook. Precreate its worksheet `Ledger` (or your configured
   name). Use an empty worksheet or one with exactly these headers in A:O:

   ```text
   Received date | Vendor | Invoice number | Invoice date | Subtotal | VAT | Total | Currency | Description | Sender | Confidence summary | Status | WorkDrive hyperlink | Bill ID | Revision
   ```

   Empty sheets receive headers automatically; existing mismatches fail without
   overwriting customer data. Hide columns **N:O** in the Sheet UI and preserve
   their values: Bill ID is immutable identity; Revision is numeric. The official
   Data API definition exposes no column-hide method, so hiding is an operator
   step. Do not manually duplicate Bill IDs or edit revisions. Text is emitted
   as quote-escaped constant-string formulas (`="literal"`) to preserve leading
   zeros and prevent OCR strings becoming executable formula syntax. Numeric
   amounts and revisions remain numbers. Verify evaluated values, Arabic,
   quotes/newlines, leading zeros, empty values, and links in your test worksheet.
5. Transfer `zoho-authorized-user.json` privately into server `secrets/`, owned
   by the verified container UID/GID, mode `0600` (directory `0700`). Set privately:

   ```dotenv
   GOOGLE_ENABLED=false
   ZOHO_ENABLED=true
   ZOHO_REGION=sa
   ZOHO_OAUTH_CREDENTIAL_JSON=/run/secrets/zoho-authorized-user.json
   ZOHO_WORKDRIVE_FOLDER_ID=your-private-folder-id
   ZOHO_SHEET_RESOURCE_ID=your-workbook-resource-id
   ZOHO_SHEET_NAME=Ledger
   ```

   Google configuration/code and existing projections remain available. Avoid
   changing Zoho destinations after archival: persisted intent/projection
   identities reject destination changes. Request timeout defaults to 60 seconds
   (`ZOHO_REQUEST_TIMEOUT_MS`); JSON responses to 2 MiB
   (`ZOHO_MAX_RESPONSE_BYTES`). Original downloads are separately bounded by the
   verified original's byte length. API hosts are allowlisted, never configurable URLs.
6. Recreate the app using the commands above. Ingest and approve a **new** test
   bill, confirm archive bytes/private access and its row, then correct and reject
   it. Approved corrections update the same row. Subsequent non-approved states
   mark it `Rejected`; original files are retained. There is no historical
   backfill: bills approved before migration or while Zoho was disabled are
   excluded, including later corrections/reapprovals. Readiness checks supported
   worker jobs, not provider credentials, scopes, access, or formula interpretation.

#### Ambiguous Zoho mutations and recovery

Run one application worker/replica per database. WorkDrive upload and Sheet
append have **no documented idempotency key or remote uniqueness guarantee**.
SQLite records a one-shot intent **before** sending either request. On a timeout,
malformed success, lost response, or crash (even before send), replay performs
read-only reconciliation; it never sends another upload or append for that bill.
Even definitive upload/add errors retain the intent conservatively.

WorkDrive reconciliation paginates direct children, verifies identity-bearing
names (including timestamp-renamed candidates), checks metadata/parent/size,
downloads bounded bytes and compares SHA-256. Private metadata permalinks must
use `https://workdrive.zoho.sa`; no public share is created. Reviewers need folder
permissions. Sheet reconciliation fetches every Bill ID match and refuses
duplicates/higher revisions; updates include Bill ID and observed Revision,
then re-fetch and compare all mapped values before fenced SQLite persistence.
This is revision-aware convergence, **not a documented atomic remote CAS**.
Stale mutations durably schedule repair for current canonical state, including
rejections; API completion/visibility can still require operator reconciliation.

After bounded retries, inspect `failed-jobs` and `inspect BILL_ID`; the latter
includes separate Zoho projections and upload/append intents. An absent file/row
does not prove the first request never committed. Resolve access/scope issues or
duplicate/conflicting candidates privately, then use `retry --include-permanent
JOB_ID` to re-run reconciliation. **Retry does not reset intents.** If no verified
candidate becomes visible, leave the intent unresolved and raise an operator
issue; no automatic resend/reset command is provided. Do not delete intents or
insert another row/file blindly. Sheet error `2950` starts a five-minute workbook
cooldown; jobs still have bounded retries and can require later operator replay.

Offline checks and a dedicated Saudi test-destination smoke test passed, including
OAuth refresh, verified archival, replay, Sheet insertion, correction, rejection,
and text round trips. The operator also confirmed browser checks. Repeat these
checks for each deployment's credentials, destinations, and reviewer permissions;
the observed replay does not establish a provider-wide idempotency guarantee.

## 4. Operations and persistence

```sh
docker compose logs --tail=100 bill-ledger caddy
docker compose exec -T bill-ledger bun dist/ops.js failed-jobs
docker compose exec -T bill-ledger bun dist/ops.js inspect BILL_ID
docker compose exec -T bill-ledger bun dist/ops.js retry JOB_ID
```

Replace uppercase IDs. Use `retry --include-permanent JOB_ID` only after inspecting
and resolving the cause. Ops commands load the full application configuration,
including credentials for enabled integrations. Treat their output as private.

| Named volume | Container location / contents |
| --- | --- |
| `bill-data` | `/data`: SQLite and local backup output |
| `bill-originals` | `/data/originals`: immutable attachments |
| `bill-whatsapp-auth` | `/data/whatsapp-auth`: device session |
| `caddy-data` | `/data` in Caddy: certificates and ACME state |
| `caddy-config` | `/config` in Caddy: Caddy state |

Compose normally prefixes these names with `jabocr_`. Keep the project name
stable. Never use `docker compose down -v` for routine shutdown or updates.
Never run multiple app replicas against the same SQLite database.

Before updating, back up, retain the previous source/image, build/load the new
image, then `docker compose up -d --no-build` and repeat readiness/intake checks.
Database migrations may prevent image-only rollback; retain a matched backup.

### Backup

```sh
umask 077
mkdir -p backups
docker compose exec -T bill-ledger bun dist/ops.js backup /data/backups
# Replace this with the exact timestamped directory reported by the command:
BACKUP_NAME=bill-ledger-YYYY-MM-DDTHH-MM-SS-mmmZ
docker compose cp "bill-ledger:/data/backups/$BACKUP_NAME" ./backups/
```

The command takes a WAL-safe SQLite `VACUUM INTO` snapshot, then copies only
snapshot-referenced originals, verifying their bytes. A successful archive has
`bill-ledger.sqlite`, `originals/`, and `manifest.json` with SHA-256 checksums.
Copy it to protected off-server storage and test restoration. A backup under
`/data/backups` alone is lost with that disk/volume.

Back up `.env`, `secrets/`, Compose/Caddy files, and the WhatsApp auth volume
separately, privately. Stop the app when copying WhatsApp auth for consistency.
Preserve Caddy volumes if retaining certificate state. These credentials/session
files are not included by `ops backup`.

### Restore

Restore the database and originals **together**, on one host, while the app is
stopped. The manifest's `originalsRoot` must be exactly `/data/originals`; recorded
absolute original paths cannot be relocated. The manifest may call this the
legacy `WHATSAPP_ORIGINALS_DIR`; this deployment uses `ORIGINALS_DIR`.

Use a fresh installation with empty app data/original volumes, restored `.env`
and secrets, and the matching image. For an existing installation, first preserve
its data and move the old database, WAL/SHM sidecars, and originals out of the way
while stopped. Do not merge snapshots or discard the only recoverable copy.

Set `BACKUP_DIR` to an absolute path containing the extracted archive, then verify
its checksums before copying (these commands assume the default database name):

```sh
docker compose stop bill-ledger
BACKUP_DIR="$PWD/backups/$BACKUP_NAME"
docker compose run --rm --no-deps --user root \
  -v "$BACKUP_DIR:/restore:ro" --entrypoint bun bill-ledger -e '
const { readFileSync } = await import("node:fs");
const { createHash } = await import("node:crypto");
const m = JSON.parse(readFileSync("/restore/manifest.json", "utf8"));
if (m.originalsRoot !== "/data/originals" || m.database.path !== "bill-ledger.sqlite") throw Error("Unexpected restore paths");
for (const f of [{ path: m.database.path, sha256: m.database.sha256 }, ...m.originals.map(f => ({ path: `originals/${f.path}`, sha256: f.sha256 }))]) {
  if (f.path.includes("..") || f.path.startsWith("/")) throw Error("Unsafe archive path");
  if (createHash("sha256").update(readFileSync(`/restore/${f.path}`)).digest("hex") !== f.sha256) throw Error("Checksum mismatch");
}
console.log("Backup checksums verified");'
```

Continue only after verification succeeds. The next command refuses a nonempty
database/originals destination; it uses the image's `bun` user for ownership:

```sh
docker compose run --rm --no-deps --user root \
  -v "$BACKUP_DIR:/restore:ro" --entrypoint sh bill-ledger -ec '
test ! -e /data/bill-ledger.sqlite
test ! -e /data/bill-ledger.sqlite-wal
test ! -e /data/bill-ledger.sqlite-shm
test -z "$(ls -A /data/originals)"
cp /restore/bill-ledger.sqlite /data/bill-ledger.sqlite
cp -a /restore/originals/. /data/originals/
chown -R bun:bun /data/bill-ledger.sqlite /data/originals
'
docker compose run --rm --no-deps bill-ledger bun dist/ops.js migrate
docker compose up -d --no-build
```

Restore WhatsApp auth separately before startup or pair again. Repeat readiness,
login, original-download, intake, and enabled Google/Zoho projection checks. Never
copy only a live SQLite main file: committed data may still be in its WAL. The
provided snapshot avoids that problem; stale destination WAL/SHM files must not
be reused. Google/Zoho files and rows are not a substitute for the canonical backup.
