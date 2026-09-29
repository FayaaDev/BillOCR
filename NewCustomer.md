# Add another customer

Run these commands from the repository root. Replace `acme2` and port `3001` with a unique customer ID and unused local port. The shared `bill-monitoring` network already exists if the monitor is running; otherwise create it once with `docker network create bill-monitoring`.

1. Create private configuration and a separate secrets directory:

   ```sh
   mkdir -p customers/acme2/secrets
   cp .env.example customers/acme2/.env
   chmod 600 customers/acme2/.env
   ```

   In `customers/acme2/.env`, set `CUSTOMER_ID=acme2`, `APP_PORT=3001`, `REVIEW_ORIGIN=https://acme2.bills.example.com` (replace with your own distinct hostname, no port or trailing slash), a unique random `MONITOR_TOKEN` of at least 32 characters, `REVIEW_USERNAME`, `REVIEW_PASSWORD`, and this customer's Azure and intake settings. Set `GOOGLE_ENABLED` and `GOOGLE_AUTH_MODE` explicitly; if Google is enabled, put only this customer's credentials in `customers/acme2/secrets/` and configure its own Drive folder and Sheet. Do not reuse another customer's delivery tokens, WhatsApp account, or Google destinations. Both `customers/` and `monitor/` are Git-ignored.

   Point this hostname at your TLS-terminating proxy. Route it to `127.0.0.1:3001`, preserve the public `Host` header, redirect public HTTP to HTTPS, and reject unknown virtual hosts. Apply your proxy authentication policy. Use a separate hostname for every customer and for the central monitor. Different localhost ports do not isolate browser cookies; direct port login is rejected once `REVIEW_ORIGIN` is configured. See the proxy example in `README.md`.

2. Start the isolated Compose project:

   ```sh
   CUSTOMER_ENV_FILE=./customers/acme2/.env CUSTOMER_SECRETS_DIR=./customers/acme2/secrets \
     docker compose -f docker-compose.yml -f docker-compose.customer.yml \
     --env-file ./customers/acme2/.env -p bill-acme2 up -d --build
   ```

   Use the same environment variables, Compose files, `--env-file`, and `-p` for later restarts, migrations, and backups. Each project gets separate named volumes. Check `http://127.0.0.1:3001/ready` (503 until intake is ready, including WhatsApp pairing) and sign in to `https://acme2.bills.example.com/admin` with the new review credentials. `/health` checks only process liveness. Recreate containers with `up -d` after changing environment values; `restart` does not reload them.

3. Add this entry to the existing `customers` array in `monitor/customers.json` without removing earlier customers:

   ```json
   {
     "id": "acme2",
     "name": "Acme 2",
     "url": "http://acme2:3000/monitor/status",
     "token": "<the same MONITOR_TOKEN from customers/acme2/.env>"
   }
   ```

   Preserve the monitor file's private ownership and permissions; on Linux it must remain readable by the container's `bun` user. Reload the customer list:

   ```sh
   docker compose -f docker-compose.monitor.yml -p bill-monitor restart monitor
   ```

   Open the monitor's separate HTTPS hostname with the monitoring operator login. With both customers' intake and workers ready, the dashboard should show **2 of 2 ready**. Polling and structured alerts continue without an open browser. Configure `MONITOR_ALERT_WEBHOOK_URL` in `monitor/.env` (then recreate the monitor) or attach log-based alerts for unattended notification. Independently check the monitor's `/health` endpoint so failure of the monitor itself alerts an operator.
