# Install on a machine

This guide deploys Bill Ledger with Docker Compose on a machine with Docker,
Docker Compose, Git, and Bun installed. Bun is only needed for the optional
Google user-OAuth setup.

Do not expose port `3000` directly to the Internet. Put the service behind a
TLS-terminating, authenticated reverse proxy or Cloudflare Tunnel.

## 1. Get the application

```sh
sudo mkdir -p /opt/bill-ledger
sudo chown "$USER" /opt/bill-ledger
git clone <REPOSITORY_URL> /opt/bill-ledger
cd /opt/bill-ledger
```

## 2. Configure secrets

```sh
cp .env.example .env
mkdir -p secrets
chmod 700 secrets
chmod 600 .env
```

Edit `.env` and set production values for:

- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`
- `AZURE_DOCUMENT_INTELLIGENCE_API_KEY`
- `REVIEW_USERNAME`
- `REVIEW_PASSWORD`
- `TELEGRAM_ENABLED`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_GROUP_IDS` if using Telegram
- `WHATSAPP_ENABLED` and `WHATSAPP_GROUP_ID` if using WhatsApp

Google Drive and Sheets projections are optional. To run without them, set:

```ini
GOOGLE_ENABLED=false
```

## 3. Optional Google projections

For service-account authentication, write the service-account JSON to
`secrets/google-service-account.json`, restrict it to the service user, then
set `GOOGLE_ENABLED=true`, the Drive and Sheet IDs, and the auth mode in
`.env`:

```sh
chmod 600 secrets/google-service-account.json
```

For user OAuth, put the downloaded Desktop OAuth client JSON in `secrets/`,
configure `GOOGLE_AUTH_MODE=user_oauth` and its paths in `.env`, then run this
on the host before starting Compose:

```sh
bun install --frozen-lockfile
bun run google:oauth
chmod 600 secrets/google-authorized-user.json
```

## 4. Build and start

```sh
docker compose build
docker compose run --rm bill-ledger bun dist/ops.js migrate
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:3000/health
```

Follow the service logs during the first startup:

```sh
docker compose logs -f bill-ledger
```

## Operations

```sh
docker compose run --rm bill-ledger bun dist/ops.js failed-jobs
docker compose run --rm bill-ledger bun dist/ops.js backup /data/backups
docker compose down
docker compose up -d --build
```

Compose retains SQLite data, originals, and WhatsApp auth in named Docker
volumes. Do not remove those volumes unless intentionally discarding the
service state.
