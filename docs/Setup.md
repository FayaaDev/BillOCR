# Setup — two customers on a 2 GB VPS

Use minimal Linux, Docker Compose, and a lightweight HTTPS proxy. Azure handles OCR
remotely. Each customer is capped at 512 MB; leave room for the OS and monitoring.
Build elsewhere, stagger bulk uploads, and upgrade to 4 GB if memory pressure persists.

## Isolated SultanLogistics test deployment — 2026-10-01

- SultanLogistics is deployed alongside `testing` on the configured test server.
  The original `fayaalink/billocr` instance was not contacted or changed.
- Public admin: `https://sultanlogistics-billocr.manfath.link/admin`; backend:
  `127.0.0.1:3001`; Compose project: `bill-sultanlogistics`.
- Restored the local September 30 snapshot: 132 bills, 132 hash-verified originals,
  and 23 migrations. Database integrity, foreign keys, and offline compatibility
  with `bill-ledger:2026-09-30-testing` passed.
- ZIP upload and Azure are enabled. WhatsApp, Telegram, Google, and Mistral are
  disabled in the **deployed** configuration. Historical failed jobs were not
  reset; one copied ZIP batch remains in `processing`.
- Server configuration and untouched recovery copy are under
  `/opt/bill-ledger/customers/sultanlogistics/`; separate `bill-sultanlogistics_*`
  volumes contain the working data. Mounted `secrets/` is empty. The local
  staged `.env` remains source-derived; do not use it to recreate this isolated copy.
- The existing `billOCR` tunnel routes the new hostname through Caddy on port
  `8080`. Its testing route is preserved. The Caddy rollback copy is
  `/etc/caddy/Caddyfile.before-sultan-isolated-20261001`.
- Verified HTTPS login/logout, original-image preview and modal, frontend assets,
  secure host-only session cookies, rejected wrong hosts/origins and cross-customer
  sessions, and readiness of both test-server customers.
- Verified post-restore backup:
  `/data/backups/sultan-isolated-20261001/bill-ledger-2026-10-01T08-36-28-415Z`.
- To roll back, stop only the Sultan Compose service, restore the saved Caddy
  configuration and reload Caddy, then remove only the new Sultan tunnel/DNS route.
  Retain volumes and recovery files; never use `down -v`. Run all test-server
  commands through the bundled Paramiko helper, with approval for service changes.

## Testing-only test server deployment — 2026-09-30

- Only `testing` is deployed, with fresh `bill-testing_*` volumes. Omit
  `customers/testing/docker-compose.volumes.yml`; it selects legacy volumes.
- ZIP upload and Azure are enabled. Google, WhatsApp, Telegram, and Mistral are
  disabled. SultanLogistics and the central monitor are deferred.
- Compose directory: `/opt/bill-ledger`; files: `docker-compose.yml` and
  `docker-compose.customer.yml`; image: `bill-ledger:2026-09-30-testing`.
- Dedicated Cloudflare tunnel: `billOCR`. Its testing route targets
  `http://127.0.0.1:8080`; Caddy proxies to `127.0.0.1:3000`, preserves the public
  hostname and rejects unknown hosts. Authentication uses the dashboard's
  built-in login; Caddy does not add a browser Basic authentication prompt.
- Caddy sets upstream `Referrer-Policy` to `same-origin` so native login,
  correction, and logout forms preserve their browser origin. The application
  source has the same policy; the current image predates that source fix.
- Public admin: `https://testing-billocr.manfath.link/admin`. Its proxied CNAME
  points to the `billOCR` tunnel, and the existing Universal SSL certificate
  covers this first-level hostname; no paid certificate add-on is needed.
- Caddy configuration: `/etc/caddy/Caddyfile`; original saved as
  `/etc/caddy/Caddyfile.before-billOCR`. Tunnel service: `cloudflared.service`;
  its private token is `/etc/cloudflared/billOCR.token`.
- Initial backup inside the testing container:
  `/data/backups/initial-20260930/bill-ledger-2026-09-30T18-42-11-365Z`.
- Verified pre-hostname-change backup:
  `/data/backups/before-universal-ssl/bill-ledger-2026-09-30T19-34-55-067Z`.
  Prior configuration is saved as `customers/testing/.env.before-universal-ssl`
  and `/etc/caddy/Caddyfile.before-universal-ssl` on the server.

## 1. Build once, outside the VPS

On the build machine, from the repository root:

```sh
RELEASE=2026-09-30                  # Use a new tag for each release.
docker buildx build --platform linux/amd64 --load -t bill-ledger:$RELEASE .
docker save -o /tmp/bill-ledger.tar bill-ledger:$RELEASE
```

Match the VPS architecture. Securely transfer the archive, matching checkout, and
private `customers/` and `monitor/` directories (excluded from Git/image). On the
VPS, from `/opt/bill-ledger`; Bun is not required:

```sh
RELEASE=2026-09-30
docker load -i /tmp/bill-ledger.tar
docker tag bill-ledger:$RELEASE bill-testing-bill-ledger
docker tag bill-ledger:$RELEASE bill-sultanlogistics-bill-ledger
docker tag bill-ledger:$RELEASE bill-monitor-monitor
docker network inspect bill-monitoring >/dev/null 2>&1 || docker network create bill-monitoring
```

Tags match Compose's default image names. Always start with `--no-build --pull never`.

## 2. Configure each customer

| Customer | Project | HTTPS hostname | Local backend |
|---|---|---|---|
| testing | `bill-testing` | `testing-billocr.manfath.link` | `127.0.0.1:3000` |
| SultanLogistics (isolated test copy) | `bill-sultanlogistics` | `sultanlogistics-billocr.manfath.link` | `127.0.0.1:3001` |
| Monitor (planned) | `bill-monitor` | `monitor-billocr.manfath.link` | `127.0.0.1:3100` |

Both customers are staged. For another:

```sh
id=customer-2
mkdir -p customers/$id/secrets
cp .env.example customers/$id/.env
chmod 700 customers/$id customers/$id/secrets
chmod 600 customers/$id/.env
```

Set in each customer's `.env`:

- Unique `CUSTOMER_ID`, unused `APP_PORT`, and `REVIEW_ORIGIN=https://<id>-billocr.manfath.link`
  (no port, path, or trailing slash).
- `REVIEW_USERNAME`, `REVIEW_PASSWORD`, and a unique random `MONITOR_TOKEN` of 32+ characters.
- `MISTRAL_ENABLED=false`, `AZURE_ENABLED=true`, `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`,
  and `AZURE_DOCUMENT_INTELLIGENCE_API_KEY`.
- Explicit `WHATSAPP_ENABLED` and `TELEGRAM_ENABLED`; configure group restrictions
  and the Telegram bot token for enabled intake channels.
- Explicit `GOOGLE_ENABLED` and `GOOGLE_AUTH_MODE` (`user_oauth` or `service_account`).
  When enabled, set the Drive folder, Sheet ID/name, and selected credential path
  under `/run/secrets`; place its JSON in `customers/<id>/secrets/`.

For OAuth, generate `google-authorized-user.json` with Bun on the build machine
before transfer; see [Google setup](../README.md#local-setup). The selected account
must access both Google destinations.

**Current staging shares a Google folder and Sheet between testing and SultanLogistics.**
Separate testing destinations or disable its Google integration before concurrent
use. Changing destinations requires reviewing stored projection identities.

## 3. Preserve or restore data before startup

- **testing:** its `customers/testing/docker-compose.volumes.yml` adopts existing
  `billsocr_bill-data`, `billsocr_bill-originals`, and `billsocr_bill-whatsapp-auth`.
  On a new VPS, restore these first, or omit the override and restore into fresh
  `bill-testing_*` volumes. Keep the old writer stopped.
- **SultanLogistics:** restore `customers/sultanlogistics/restore/` into separate
  `bill-sultanlogistics_*` volumes; retain the recovery copy. While the source stays
  live, disable cloned intake/Google integrations. Obtain a final consistent
  snapshot before production cutover.

| Logical volume | Container path | Restored contents |
|---|---|---|
| `bill-data` | `/data` | `bill-ledger.sqlite`, `admin-zip-staging/` |
| `bill-originals` | `/data/originals` | Contents of `originals/` |
| `bill-whatsapp-auth` | `/data/whatsapp-auth` | Contents of `whatsapp-auth/` |

Restore while stopped, preserve the manifest's originals path, and verify hashes
and SQLite integrity. Writable data and mounted secrets must be accessible to `bun`:

```sh
uid=$(docker run --rm --entrypoint id bill-ledger:$RELEASE -u bun)
sudo chown -R "$uid:$uid" customers/*/secrets
```

Secret directories: `0700`; files: `0600`. Environment files remain operator-owned.

## 4. Start customers and monitor

From the repository root, in **Bash**. Retain the testing override only when adopting
restored `billsocr_*` volumes:

```bash
customer() {
  local id=$1; shift
  local files=(-f docker-compose.yml -f docker-compose.customer.yml)
  if [[ $id == testing && -f customers/testing/docker-compose.volumes.yml ]]; then
    files+=(-f customers/testing/docker-compose.volumes.yml)
  fi
  CUSTOMER_ENV_FILE=./customers/$id/.env CUSTOMER_SECRETS_DIR=./customers/$id/secrets \
    docker compose --env-file ./customers/$id/.env -p bill-$id "${files[@]}" "$@"
}
monitor() { docker compose -p bill-monitor -f docker-compose.monitor.yml "$@"; }

customer testing config --quiet
customer sultanlogistics config --quiet
customer testing up -d --no-build --pull never
customer sultanlogistics up -d --no-build --pull never
```

Create `monitor/.env` from `monitor.env.example` with a separate operator login.
Review/use `monitor/customers.staged.json` as `monitor/customers.json`, or start from
`monitor.customers.example.json`. Entries need ID, name,
`http://<id>:3000/monitor/status`, and matching `MONITOR_TOKEN`; preserve other entries.
Both files use `0600`; the mounted list must be readable by `bun`:

```sh
sudo chown "$uid:$uid" monitor/customers.json
monitor up -d --no-build --pull never
```

New customer: tag `bill-<id>-bill-ledger`, configure/start it, add its monitor entry,
then `monitor restart monitor`.

## 5. HTTPS and checks

Point hostnames at the server/tunnel. Use first-level names such as
`testing-billocr.manfath.link` to stay within Universal SSL's `*.manfath.link`
coverage. The proxy must preserve public `Host`,
redirect HTTP to HTTPS and reject unknown hosts. The application requires its
built-in login for dashboard and bill data. Expose only
the proxy; backend ports stay on localhost. See the
[proxy example](../README.md#browser-hostname-isolation).

```sh
curl --fail http://127.0.0.1:3000/ready
curl --fail http://127.0.0.1:3001/ready
curl --fail http://127.0.0.1:3100/health
docker stats --no-stream
```

Sign in at each HTTPS `/admin` and the monitor. Customer `/ready` checks intake,
workers, and SQLite; `/health` is liveness only. Unpaired WhatsApp is degraded.
Monitor health checks polling freshness. Configure webhook/log alerts and
independently monitor its health endpoint.

## Updates and backups

```sh
customer testing logs --tail 100 bill-ledger
customer testing exec bill-ledger bun dist/ops.js failed-jobs
customer testing exec bill-ledger bun dist/ops.js backup /data/backups
```

Back up each customer and copy backups off-server; credentials/WhatsApp auth need
separate backups. Updates: load a new image, retag, then recreate one service at a
time with `up -d --no-build --pull never --force-recreate`. Startup applies migrations.
Use the same helpers for operations. Never `down -v`. Recreate after environment
changes; restart the monitor after list changes. Healthchecks do not restart unhealthy
containers. Watch `docker stats` and disk usage.
