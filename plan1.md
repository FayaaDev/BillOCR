# Agent-Driven Implementation Plan: Bill Ingestion Ledger

## Goal

Build a small, reliable pipeline that receives bill attachments from a WhatsApp group, extracts normalized accounting data from the original image or PDF, archives the original file in Google Drive, and exposes the resulting ledger in Google Sheets.

The system must treat the database—not WhatsApp, Drive, or Sheets—as the canonical record. External services are projections or delivery targets that can be retried safely.

## scope

**In scope**

- Listen to one WhatsApp group through a dedicated WhatsApp account using Baileys.
- Accept image and PDF attachments, with an optional message caption.
- Persist the exact incoming attachment and message metadata before processing.
- Extract structured bill data with Azure Document Intelligence `prebuilt-invoice`.
- Validate extracted values deterministically and route uncertain records to review.
- Upload the unmodified original attachment to Google Drive.
- Append or update an idempotent row in Google Sheets with a Drive link.
- Provide a minimal review page for correcting uncertain bills.


## Architecture

```text
WhatsApp / Baileys
        │
        ▼
SQLite: bills + jobs + audit metadata
        │
        ├──► Vision extraction ──► validation ──► review decision
        │
        ├──► Google Drive: original file archive
        │
        └──► Google Sheets: client-facing ledger projection
```

Use one Dockerized Bun application. SQLite is both the transactional store and the initial job queue. A background worker claims pending jobs, records every state transition, and retries failed external operations with bounded backoff.

## Agents and ownership

Each implementation agent works only within its assigned scope, writes or updates tests for behavior it introduces, and reports its changed files, verification command, and blockers to the coordinator.

| Agent | Responsibility | Required output |
| --- | --- | --- |
| Coordinator | Maintains this plan, sequencing, contracts, and acceptance status. | Integrated implementation and release checklist. |
| Foundation agent | Application setup, configuration validation, SQLite schema, migrations, and job runner. | Durable records and idempotent job claiming. |
| WhatsApp agent | Baileys connection, group filtering, attachment download, and ingestion transaction. | One persisted bill per unique WhatsApp message attachment. |
| Extraction agent | Azure Document Intelligence `prebuilt-invoice` request, strict schema parsing, retries, and extraction persistence. | Valid structured extraction or a reviewable failure. |
| Validation agent | Deterministic validation and review-routing rules. | Field-level issues and an explicit status decision. |
| Google integration agent | Drive archival and Sheets projection, both idempotent. | Original Drive file and exactly one corresponding sheet row. |
| Review UI agent | Minimal authenticated page to inspect originals, edit extracted fields, and resolve records. | Corrections saved to the database and re-projected to Sheets. |
| QA agent | Fixtures, integration tests with mocked providers, and end-to-end acceptance verification. | Test report and unresolved risks. |

## Canonical data contracts

### Bill record

Persist this before calling a model or Google API:

```ts
type Bill = {
  id: string;
  whatsappMessageId: string;
  whatsappGroupId: string;
  whatsappSenderId: string;
  receivedAt: string;
  caption: string | null;
  originalFilename: string | null;
  mimeType: string;
  originalPath: string;
  contentSha256: string;
  status: "received" | "extracting" | "needs_review" | "approved" | "failed";
  driveFileId: string | null;
  sheetRowKey: string | null;
  createdAt: string;
  updatedAt: string;
};
```

The uniqueness constraint is `(whatsappMessageId, attachment index)`; retain the SHA-256 hash for diagnostics and optional duplicate-content reporting. A repeated provider event must return the existing record without creating another job, Drive file, or Sheet row.

### Extraction response

The Azure provider receives only the original document bytes and MIME type, then calls Azure Document Intelligence `prebuilt-invoice`. The application maps and validates Azure's untrusted output into the versioned schema below. Do not use free-form provider prose as a data source.

```ts
type ExtractedBill = {
  schemaVersion: "1";
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null; // ISO YYYY-MM-DD when known
  currency: string | null; // ISO 4217 when known
  subtotal: number | null;
  vat: number | null;
  total: number | null;
  description: string | null;
  handwritten: boolean | null;
  fields: Record<string, {
    confidence: number; // 0 through 1
    sourceText: string | null;
  }>;
};
```

`null` means unknown; agents must not invent values. The persisted extraction also includes the raw provider response, model name, normalization/schema version, request timestamp, and error details when applicable.

### Job record

Jobs use a durable state machine:

```text
pending → running → succeeded
                 └→ retryable_failure → pending
                 └→ permanent_failure
```

Supported job types: `extract`, `archive_to_drive`, `project_to_sheet`, and `sync_review_correction`. A job has an idempotency key, attempt count, `availableAt`, and last error. Never hold a database transaction open while calling an external service.

## Delivery phases

### Phase 0 — Foundation

**Owner:** Foundation agent

1. Create the Bun service, Docker configuration, environment schema, structured logging, and health endpoint.
2. Add SQLite migrations for `bills`, `extractions`, `jobs`, `review_events`, and provider-projection metadata.
3. Implement transactional bill creation and atomic job claiming.
4. Add configuration keys for WhatsApp credentials, vision provider, Google OAuth/service-account credentials, Drive folder ID, Sheet ID, and review authentication.

**Acceptance checks**

- Applying migrations to an empty database succeeds.
- Re-running migrations is safe.
- Two workers cannot claim the same job.
- No secret value is logged.

### Phase 1 — WhatsApp ingestion

**Owner:** WhatsApp agent

1. Connect a dedicated Baileys account and restrict processing to the configured group ID.
2. Ignore messages without an image or document attachment.
3. For each accepted attachment, download the exact original bytes to durable local storage, calculate SHA-256, and create the bill plus initial jobs in one database transaction.
4. Persist message ID, group ID, sender ID, timestamp, caption, MIME type, original filename, attachment index, and storage path.
5. Acknowledge or log malformed messages without crashing the listener.

**Acceptance checks**

- An image, a PDF, and an image with caption create records with correct metadata.
- A message from another group and a text-only message create no record.
- Redelivering the same WhatsApp event creates no duplicate record or jobs.
- A restart between download and processing leaves a recoverable persisted bill.

### Phase 2 — Azure Document Intelligence extraction

**Owner:** Extraction agent

1. Claim `extract` jobs and submit the original attachment directly to Azure Document Intelligence `prebuilt-invoice`.
2. Submit only the verified original bytes and MIME type to Azure Document Intelligence `prebuilt-invoice`; do not send captions or custom `ExtractedBill` schema instructions.
3. Map and validate Azure's untrusted response into `ExtractedBill` before persistence.
4. Store raw output and normalized parsed output separately for auditability.
5. Treat timeouts, rate limits, and transient provider errors as retryable; malformed Azure output becomes a reviewable extraction failure after the retry policy is exhausted.

**Acceptance checks**

- Fixtures cover printed English, printed Arabic, handwriting, angled photos, and PDF input.
- Invalid provider JSON cannot enter normalized extraction fields.
- Unknown fields remain `null` rather than fabricated.
- Provider calls are not duplicated after a worker restart for an already completed extraction job.

### Phase 3 — Validation and review routing

**Owner:** Validation agent

Implement deterministic checks after extraction:

- Monetary amounts are finite, non-negative numbers.
- If all three exist, `subtotal + vat` equals `total` within the configured currency rounding tolerance.
- Dates parse to valid ISO dates and are not implausibly far in the future.
- Currency uses a known ISO code when supplied.
- Required operational fields are present: vendor, invoice date, and total.
- Any required field below the configured confidence threshold requires review.
- Handwritten documents use a stricter confidence threshold.

Rules must produce field-level issues with code, message, severity, and observed value. A record is `approved` only when no blocking issue exists; otherwise it is `needs_review`. Both outcomes continue to Drive archival. Only approved records are automatically projected to Sheets.

**Acceptance checks**

- Valid totals approve successfully.
- Invalid arithmetic, missing required fields, low confidence, and handwriting cases route to review.
- Thresholds are configuration values with tested defaults.

### Phase 4 — Google projections

**Owner:** Google integration agent

1. Upload the unmodified `originalPath` file to Drive. Organize files as `Bills/YYYY/MM/<bill-id>-<original-filename>`.
2. Store the Drive file ID and web link transactionally after a successful upload. Do not overwrite an existing Drive file for a retried job.
3. Project approved records to a single ledger sheet row. Use `bill.id` as a hidden immutable row key, not row number, for idempotency.
4. Include: received date, vendor, invoice number, invoice date, subtotal, VAT, total, currency, description, sender, confidence, status, Drive hyperlink, and hidden bill ID.
5. Update the existing row after approved review corrections instead of appending a second row.

**Acceptance checks**

- Drive receives byte-identical original content.
- Retrying archival creates no second Drive file.
- Retrying sheet projection leaves exactly one row per bill ID.
- A temporary Drive or Sheets failure leaves a retryable job and never loses the canonical bill.

### Phase 5 — Manual review

**Owner:** Review UI agent

1. Build a minimal authenticated internal page listing `needs_review` and permanent-failure bills.
2. Show the original file, extraction values, confidence, validation issues, and model provenance.
3. Let a reviewer correct fields, approve or reject the bill, and record a mandatory action plus reviewer identity and timestamp.
4. On approval, queue Drive archival if needed and queue the Sheet projection/update. On rejection, preserve the original and audit trail without adding a ledger row.

**Acceptance checks**

- A reviewer can correct a low-confidence total and approve it.
- Every correction is recorded in `review_events`; original model output remains unchanged.
- A corrected approved bill appears once in Sheets.

### Phase 6 — QA and operational hardening

**Owner:** QA agent, coordinated with all implementation agents

1. Build provider mocks and fixture-based tests for every phase.
2. Run an end-to-end test: ingest → extract → validate → Drive archive → Sheets projection.
3. Simulate duplicate WhatsApp events, worker restarts, model failure, Drive failure, and Sheets failure.
4. Document local setup, Docker startup, credential configuration, backup procedure for SQLite and originals, and retry/replay operations.

**Acceptance checks**

- The complete test suite passes in a clean environment.
- All external failures leave a visible job state and can be retried without duplicate side effects.
- Operators can identify a bill from its WhatsApp message ID, internal bill ID, Drive ID, and Sheet row key.

## Coordinator handoff rules

1. Foundation must complete before any agent introduces a provider integration.
2. WhatsApp, extraction, and Google agents may work in parallel once the schema and job interfaces are fixed.
3. Validation owns the approval decision; Google agents must not reimplement validation rules.
4. Review corrections always update the database first, then enqueue projection work.
5. QA receives fixture files and mocked provider contracts from each implementation agent before final integration.
6. Any schema change requires a migration, contract-test update, and coordinator approval before another agent consumes it.

## Release criteria

Make sure the following are true:

- Original attachments are persisted before asynchronous work begins.
- Every provider action is retryable and idempotent.
- The database remains authoritative through external API outages.
- Model output is schema-validated and deterministically checked before auto-approval.
- Uncertain and handwritten bills reach human review rather than silently entering the ledger.
- Drive preserves the original attachment and Sheets contains at most one row per approved bill.
- Tests cover the failure and replay paths, not only the happy path.
