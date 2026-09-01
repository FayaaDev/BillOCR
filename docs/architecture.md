# Architecture

SQLite is the canonical bill ledger. WhatsApp supplies immutable originals; Azure Document Intelligence produces extraction attempts; Drive and Sheets are retryable projections. No provider is used to reconstruct canonical state.

## Azure-only extraction

Azure Document Intelligence's `prebuilt-invoice` model is the mandatory and sole OCR path. There is no local provider, provider toggle, or second-provider fallback. Extraction always begins from verified persisted bytes.

The extraction handler records an Azure invocation and operation reference before each external operation and makes no SQLite transaction span a provider call. Azure success becomes the selected canonical extraction. If Azure exhausts retries, the bill is retained for blocking manual review and is not automatically approved.

`src/server.ts` is the composition root. Production creates the Azure REST provider from `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` and `AZURE_DOCUMENT_INTELLIGENCE_API_KEY`; tests inject `ServiceDependencies.azureProvider` so they remain offline. Credentials are configuration values only and are never logged.
