# Original storage root

`WHATSAPP_ORIGINALS_DIR` must identify a controlled, canonical absolute directory. Service and WhatsApp-ingestion initialization create it if needed and resolve its symlinks once; the resulting canonical path is stored with canonical original paths.

Original readers do not resolve database paths or root paths through the filesystem. They require the configured root to remain a canonical absolute path and open every root component from trusted `/` using descriptor-relative `openat` with `O_DIRECTORY`, `O_NOFOLLOW`, and `O_CLOEXEC`. Database original paths must be exactly one direct child of that root.
