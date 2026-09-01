# Original storage root

`ORIGINALS_DIR` identifies the shared controlled original-storage directory for WhatsApp, Telegram, and admin ZIP ingestion. `WHATSAPP_ORIGINALS_DIR` is only a legacy fallback when `ORIGINALS_DIR` is unset. Service initialization creates the selected directory if needed and resolves its symlinks once; the resulting canonical absolute path is stored with canonical original paths. `MAX_ATTACHMENT_BYTES` applies to both messaging transports.

Original readers do not resolve database paths or root paths through the filesystem. They require the configured root to remain a canonical absolute path and open every root component from trusted `/` using descriptor-relative `openat` with `O_DIRECTORY`, `O_NOFOLLOW`, and `O_CLOEXEC`. Database original paths must be exactly one direct child of that root.

The durable intake layer stages downloads under the shared root, hashes completed bytes, and atomically publishes each canonical original without replacement before committing its database record. Telegram paths include the source in their hashed key so a Telegram identity cannot collide with a WhatsApp identity. Duplicate Telegram deliveries reuse the existing source-qualified record only when its stored hash agrees; conflicting bytes are rejected. Backups include Telegram originals through the same database-referenced verification path.

Compose mounts the existing `bill-originals` volume at `/data/originals` and sets `ORIGINALS_DIR` to that path. The Telegram polling cursor lives in the SQLite database and the bot token lives in the environment, so Telegram requires no additional persistent volume.
