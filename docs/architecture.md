# Architecture

SQLite is the canonical bill ledger. WhatsApp and Telegram supply immutable originals; Mistral and Azure Document Intelligence produce extraction attempts; Drive and Sheets are retryable projections. No provider is used to reconstruct canonical state.

## Ingestion transports

WhatsApp and Telegram normalize into the same durable attachment-ingestion boundary. The boundary allowlists source chat IDs, accepts JPEG/PNG/WebP images and PDFs, stages bounded bytes, publishes an immutable direct-child original, and commits the bill plus initial jobs in a short SQLite transaction. Source-qualified chat/message/attachment identity fences duplicate deliveries; Telegram albums remain separate messages and therefore separate bills. Telegram edited-message updates are safely ignored, and existing bills are immutable, so edits and duplicates cannot replace bytes or metadata.

The Telegram adapter uses the Bot API through bounded native `fetch` calls and serial long polling; there is no Telegram SDK or local session state. A singleton SQLite cursor is initialized with Telegram's `offset=-1`, `limit=1`, `timeout=0` snapshot: earlier pending updates are discarded and the returned tail establishes the first retained ID, so updates arriving afterward are not part of the discard. After initialization, the cursor advances only after durable intake, permanent poison-media rejection, or another safe ignore. Transient polls and downloads leave the cursor unchanged for replay. `src/server.ts` reconciles staged Telegram files before starting the poller, starts WhatsApp and Telegram independently, and aborts the active Telegram poll/download during shutdown.

## Extraction fallback

When `MISTRAL_ENABLED=true`, Mistral is attempted first against verified persisted bytes for normal extraction jobs. When `AZURE_ENABLED=true`, Azure Document Intelligence's `prebuilt-invoice` model is used directly for Azure-only jobs, or as fallback when enabled Mistral has missing or below-threshold native evidence for `vendorName`, `invoiceDate`, or `total`. Disabled providers are not called; with Mistral disabled, Azure must be enabled and handles extraction directly. `OCR_FALLBACK_CONFIDENCE_THRESHOLD` defaults to `0.80` and is bounded to `0..1`.

On the fallback path, the extraction handler records the Mistral result before an Azure request, records an Azure invocation and operation reference before each external operation, and makes no SQLite transaction span a provider call. Azure success becomes the selected canonical extraction. If Azure is disabled or exhausts retries, the Mistral extraction remains available and the bill is retained for blocking manual review; it is not automatically approved.

`src/server.ts` is the composition root. Production creates the Telegram poller when Telegram is enabled, the Mistral HTTP provider when Mistral is enabled, and the Azure REST provider when Azure is enabled; tests inject transports/providers so they remain offline. Credentials are configuration values only and are never logged.
