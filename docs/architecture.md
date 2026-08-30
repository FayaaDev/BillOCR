# Architecture

SQLite is the canonical bill ledger. WhatsApp supplies immutable originals; Mistral and Azure Document Intelligence produce extraction attempts; Drive and Sheets are retryable projections. No provider is used to reconstruct canonical state.

## Extraction fallback

Mistral is attempted first against verified persisted bytes. Azure Document Intelligence's `prebuilt-invoice` model is used only when Mistral has missing or below-threshold native evidence for `vendorName`, `invoiceDate`, or `total`. `OCR_FALLBACK_CONFIDENCE_THRESHOLD` defaults to `0.80` and is bounded to `0..1`.

The extraction handler records the Mistral result before an Azure request, records an Azure invocation and operation reference before each external operation, and makes no SQLite transaction span a provider call. Azure success becomes the selected canonical extraction. If Azure exhausts retries, the Mistral extraction remains available and the bill is retained for blocking manual review; it is not automatically approved.

`src/server.ts` is the composition root. Production creates the Azure REST provider from `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` and `AZURE_DOCUMENT_INTELLIGENCE_API_KEY`; tests inject `ServiceDependencies.azureProvider` so they remain offline. Credentials are configuration values only and are never logged.
