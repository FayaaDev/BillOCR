import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as SqliteDatabase } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase, type RetryPolicy } from "../src/database";
import { transportSourceIdentity } from "../src/contracts";
import { applyMigrations } from "../src/migrations";

const policy: RetryPolicy = { maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1_000, leaseMs: 60_000 };
let directory: string;
let path: string;
let database: BillDatabase;
const input = () => ({ whatsappMessageId: "message-1", whatsappGroupId: "group-1", whatsappSenderId: "sender-1", attachmentIndex: 0, receivedAt: "2026-08-27T00:00:00.000Z", caption: "receipt", originalFilename: "receipt.png", mimeType: "image/png", originalPath: "/durable/receipt.png", contentSha256: "a".repeat(64) });
const jobs = () => [{ type: "extract" as const, idempotencyKey: "extract:message-1:0" }, { type: "archive_to_drive" as const, idempotencyKey: "archive:message-1:0" }];

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "bill-ledger-")); path = join(directory, "ledger.sqlite"); database = new BillDatabase(path); });
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

describe("migrations", () => {
  test("apply on a fresh database and safely reapply", () => {
    database.close();
    const reopened = new BillDatabase(path);
    expect(reopened.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM schema_migrations").get()?.count).toBe(16);
    expect(reopened.sqlite.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'validation_issues'").get()?.name).toBe("validation_issues");
    expect(reopened.sqlite.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extraction_invocations'").get()?.name).toBe("extraction_invocations");
    reopened.close();
    database = new BillDatabase(path);
  });

  test("independent connections safely apply migrations to the same fresh database", async () => {
    database.close();
    const source = `import { BillDatabase } from ${JSON.stringify(new URL("../src/database.ts", import.meta.url).pathname)}; new BillDatabase(Bun.argv[1]).close();`;
    const first = Bun.spawn(["bun", "-e", source, path], { cwd: process.cwd(), stdout: "ignore", stderr: "pipe" });
    const second = Bun.spawn(["bun", "-e", source, path], { cwd: process.cwd(), stdout: "ignore", stderr: "pipe" });
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    database = new BillDatabase(path);
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM schema_migrations").get()?.count).toBe(16);
  });

  test("upgrades a v9 database with existing extraction records without changing canonical data", () => {
    database.close();
    rmSync(path, { force: true });
    const legacy = new SqliteDatabase(path, { create: true, strict: true });
    legacy.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE bills (
        id TEXT PRIMARY KEY, whatsapp_message_id TEXT NOT NULL, whatsapp_group_id TEXT NOT NULL, whatsapp_sender_id TEXT NOT NULL,
        attachment_index INTEGER NOT NULL, received_at TEXT NOT NULL, caption TEXT, original_filename TEXT, mime_type TEXT NOT NULL,
        original_path TEXT NOT NULL, content_sha256 TEXT NOT NULL, status TEXT NOT NULL, drive_file_id TEXT, sheet_row_key TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, content_revision INTEGER NOT NULL DEFAULT 0,
        review_revision INTEGER NOT NULL DEFAULT 0, manual_review_required INTEGER NOT NULL DEFAULT 0,
        UNIQUE (whatsapp_message_id, attachment_index)
      );
      CREATE TABLE jobs (id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id));
      CREATE TABLE extractions (
        id TEXT PRIMARY KEY, bill_id TEXT NOT NULL UNIQUE REFERENCES bills(id), schema_version TEXT NOT NULL,
        normalized_json TEXT, raw_provider_response TEXT, provider_model TEXT, prompt_schema_version TEXT,
        requested_at TEXT, error_details TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE extraction_attempts (
        id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), job_id TEXT NOT NULL REFERENCES jobs(id),
        job_attempt INTEGER NOT NULL, provider_model TEXT, requested_at TEXT NOT NULL, completed_at TEXT NOT NULL,
        outcome TEXT NOT NULL, raw_provider_response TEXT, error_details TEXT, created_at TEXT NOT NULL
      );`);
    const appliedAt = "2026-08-30T00:00:00.000Z";
    for (let version = 1; version <= 9; version += 1) legacy.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, appliedAt);
    legacy.query(`INSERT INTO bills (id, whatsapp_message_id, whatsapp_group_id, whatsapp_sender_id, attachment_index, received_at, mime_type, original_path, content_sha256, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("legacy-bill", "legacy-message", "legacy-group", "legacy-sender", 0, appliedAt, "image/png", "/originals/legacy.png", "a".repeat(64), "received", appliedAt, appliedAt);
    legacy.query("INSERT INTO jobs (id, bill_id) VALUES (?, ?)").run("legacy-job", "legacy-bill");
    legacy.query("INSERT INTO extractions (id, bill_id, schema_version, normalized_json, raw_provider_response, provider_model, prompt_schema_version, requested_at, completed_at, error_details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-extraction", "legacy-bill", "1", JSON.stringify({ schemaVersion: "1", vendorName: "Legacy" }), "legacy raw", "legacy-model", "1", appliedAt, appliedAt, null, appliedAt, appliedAt);
    legacy.query("INSERT INTO extraction_attempts (id, bill_id, job_id, job_attempt, provider_model, requested_at, completed_at, outcome, raw_provider_response, error_details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-attempt", "legacy-bill", "legacy-job", 1, "legacy-model", appliedAt, appliedAt, "succeeded", "legacy raw", null, appliedAt);
    legacy.close();

    database = new BillDatabase(path);
    expect(database.getExtraction("legacy-bill")).toMatchObject({ normalized: { vendorName: "Legacy" }, selectedProvider: null, fallbackStatus: null });
    expect(database.sqlite.query<{ provider: string }, [string]>("SELECT provider FROM extraction_attempts WHERE id = ?").get("legacy-attempt")?.provider).toBe("mistral");
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM schema_migrations").get()?.count).toBe(16);
  });

  test("upgrades historical WhatsApp identity, jobs, foreign keys, and projections without loss", () => {
    database.close();
    rmSync(path, { force: true });
    const legacy = new SqliteDatabase(path, { create: true, strict: true });
    const appliedAt = "2026-08-30T00:00:00.000Z";
    legacy.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE bills (
        id TEXT PRIMARY KEY, whatsapp_message_id TEXT NOT NULL, whatsapp_group_id TEXT NOT NULL, whatsapp_sender_id TEXT NOT NULL, attachment_index INTEGER NOT NULL,
        received_at TEXT NOT NULL, caption TEXT, original_filename TEXT, mime_type TEXT NOT NULL, original_path TEXT NOT NULL, content_sha256 TEXT NOT NULL,
        status TEXT NOT NULL, drive_file_id TEXT, sheet_row_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        content_revision INTEGER NOT NULL DEFAULT 0, review_revision INTEGER NOT NULL DEFAULT 0, manual_review_required INTEGER NOT NULL DEFAULT 0,
        UNIQUE (whatsapp_message_id, attachment_index)
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), type TEXT NOT NULL, state TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, lease_token TEXT, lease_expires_at TEXT, claimed_by TEXT, claimed_at TEXT,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expected_revision INTEGER
      );
      CREATE TABLE provider_projection_metadata (
        id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), provider TEXT NOT NULL, projection_key TEXT NOT NULL,
        external_id TEXT, external_url TEXT, metadata_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (provider, projection_key)
      );`);
    for (let version = 1; version <= 13; version += 1) legacy.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, appliedAt);
    legacy.query(`INSERT INTO bills (id, whatsapp_message_id, whatsapp_group_id, whatsapp_sender_id, attachment_index, received_at, caption, original_filename, mime_type, original_path, content_sha256, status, drive_file_id, sheet_row_key, created_at, updated_at, content_revision, review_revision, manual_review_required)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("legacy-whatsapp", "wamid.legacy", "group@chat", "sender@chat", 2, appliedAt, "فاتورة", "legacy.pdf", "application/pdf", "/originals/legacy.pdf", "b".repeat(64), "approved", "drive-legacy", "sheet-legacy", appliedAt, appliedAt, 7, 3, 0);
    legacy.query("INSERT INTO jobs (id, bill_id, type, state, idempotency_key, attempts, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("legacy-job", "legacy-whatsapp", "archive_to_drive", "succeeded", "archive:legacy", 1, appliedAt, appliedAt, appliedAt);
    legacy.query("INSERT INTO provider_projection_metadata (id, bill_id, provider, projection_key, external_id, external_url, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("legacy-projection", "legacy-whatsapp", "sheets", "legacy-whatsapp", "sheet-legacy", "https://sheet.example", "{}", appliedAt, appliedAt);
    legacy.close();

    database = new BillDatabase(path);
    expect(database.getBill("legacy-whatsapp")).toMatchObject({ sourceMessageId: "wamid.legacy", sourceChatId: "group@chat", sourceSenderId: "sender@chat", attachmentIndex: 2, status: "approved", driveFileId: "drive-legacy", sheetRowKey: "sheet-legacy", contentRevision: 7, reviewRevision: 3, source: "whatsapp", sourceIdentity: transportSourceIdentity("group@chat", "wamid.legacy", 2), extractionPolicy: "mistral_with_azure_fallback", classification: "unclassified", batchItemId: null });
    expect(database.getJob("legacy-job")).toMatchObject({ billId: "legacy-whatsapp", state: "succeeded" });
    expect(database.getProjectionMetadata("sheets", "legacy-whatsapp")).toMatchObject({ billId: "legacy-whatsapp", externalId: "sheet-legacy" });
    const replay = database.createBillWithInitialJobs({ source: "whatsapp", sourceMessageId: "wamid.legacy", sourceChatId: "group@chat", sourceSenderId: "sender@chat", attachmentIndex: 2, receivedAt: appliedAt, mimeType: "application/pdf", originalPath: "/originals/legacy.pdf", contentSha256: "b".repeat(64) }, [{ type: "archive_to_drive", idempotencyKey: "archive:legacy" }]);
    expect(replay).toMatchObject({ created: false, bill: { id: "legacy-whatsapp" } });
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(1);
    expect(database.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("restores foreign-key enforcement and rolls back migration setup after a migration failure", () => {
    database.close();
    rmSync(path, { force: true });
    const failed = new SqliteDatabase(path, { create: true, strict: true });
    failed.exec("PRAGMA foreign_keys = ON; CREATE TABLE bills_rebuilt (id TEXT PRIMARY KEY);");
    expect(() => applyMigrations(failed)).toThrow();
    expect(failed.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(failed.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()).toBeNull();
    failed.close();
    rmSync(path, { force: true });
    database = new BillDatabase(path);
  });

  test("upgrades deployed ZIP batches and their linked bills without breaking foreign keys", () => {
    database.close();
    rmSync(path, { force: true });
    const legacy = new SqliteDatabase(path, { create: true, strict: true });
    const appliedAt = "2026-08-30T00:00:00.000Z";
    legacy.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE admin_upload_batches (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, original_filename TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE admin_upload_batch_items (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES admin_upload_batches(id), item_index INTEGER NOT NULL, entry_path TEXT NOT NULL, state TEXT NOT NULL, error_code TEXT, bill_id TEXT REFERENCES bills(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (batch_id, item_index));
      CREATE TABLE bills (
        id TEXT PRIMARY KEY, whatsapp_message_id TEXT NOT NULL, whatsapp_group_id TEXT NOT NULL, whatsapp_sender_id TEXT NOT NULL, attachment_index INTEGER NOT NULL,
        received_at TEXT NOT NULL, caption TEXT, original_filename TEXT, mime_type TEXT NOT NULL, original_path TEXT NOT NULL, content_sha256 TEXT NOT NULL,
        status TEXT NOT NULL, drive_file_id TEXT, sheet_row_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        content_revision INTEGER NOT NULL DEFAULT 0, review_revision INTEGER NOT NULL DEFAULT 0, manual_review_required INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL, source_identity TEXT, extraction_policy TEXT NOT NULL, classification TEXT NOT NULL, batch_item_id TEXT REFERENCES admin_upload_batch_items(id),
        UNIQUE (whatsapp_message_id, attachment_index)
      );`);
    for (let version = 1; version <= 14; version += 1) legacy.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, appliedAt);
    legacy.query("INSERT INTO admin_upload_batches (id, idempotency_key, original_filename, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("zip-batch", "admin-zip:legacy", "legacy.zip", "processing", appliedAt, appliedAt);
    legacy.query("INSERT INTO admin_upload_batch_items (id, batch_id, item_index, entry_path, state, error_code, bill_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("zip-item", "zip-batch", 0, "nested/receipt.pdf", "processing", null, null, appliedAt, appliedAt);
    legacy.query(`INSERT INTO bills (id, whatsapp_message_id, whatsapp_group_id, whatsapp_sender_id, attachment_index, received_at, mime_type, original_path, content_sha256, status, created_at, updated_at, source, source_identity, extraction_policy, classification, batch_item_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("zip-bill", "admin-upload:zip-batch:0", "admin-upload", "admin-upload", 0, appliedAt, "application/pdf", "/originals/receipt.pdf", "c".repeat(64), "received", appliedAt, appliedAt, "admin_upload", "admin-upload:zip-batch:0", "azure_only", "unclassified", "zip-item");
    legacy.query("UPDATE admin_upload_batch_items SET bill_id = ? WHERE id = ?").run("zip-bill", "zip-item");
    legacy.close();

    database = new BillDatabase(path);
    expect(database.getBill("zip-bill")).toMatchObject({ source: "admin_upload", sourceMessageId: "admin-upload:zip-batch:0", sourceChatId: "admin-upload", sourceSenderId: "admin-upload", batchItemId: "zip-item", extractionPolicy: "azure_only" });
    const batchStatus = database.getAdminUploadBatchStatus("zip-batch");
    expect(batchStatus?.batch).toMatchObject({ originalFilename: "legacy.zip", state: "processing" });
    expect(batchStatus?.items).toContainEqual(expect.objectContaining({ billId: "zip-bill", entryPath: "nested/receipt.pdf" }));
    expect(database.sqlite.query<{ id: string }, []>("SELECT id FROM admin_upload_batch_items WHERE bill_id = 'zip-bill'").get()?.id).toBe("zip-item");
    expect(database.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("dashboard metrics", () => {
  test("returns zero metrics for an empty ledger", () => {
    expect(database.getDashboardMetrics()).toEqual({
      receivedBills: 0,
      approvedBills: 0,
      failedBills: 0,
      retryableJobs: 0,
      permanentFailureJobs: 0,
    });
  });

  test("counts canonical bill and background-job outcomes independently", () => {
    const received = database.createBillWithInitialJobs({ ...input(), whatsappMessageId: "metrics-received" }, [{ type: "extract", idempotencyKey: "metrics-received-job" }]).bill;
    const approved = database.createBillWithInitialJobs({ ...input(), whatsappMessageId: "metrics-approved", attachmentIndex: 1 }, [{ type: "extract", idempotencyKey: "metrics-approved-job" }]).bill;
    const failed = database.createBillWithInitialJobs({ ...input(), whatsappMessageId: "metrics-failed", attachmentIndex: 2 }, [{ type: "extract", idempotencyKey: "metrics-failed-job" }]).bill;
    const needsReview = database.createBillWithInitialJobs({ ...input(), whatsappMessageId: "metrics-review", attachmentIndex: 3 }, [{ type: "extract", idempotencyKey: "metrics-review-job" }]).bill;

    database.sqlite.query("UPDATE bills SET status = 'approved' WHERE id = ?").run(approved.id);
    database.sqlite.query("UPDATE bills SET status = 'failed' WHERE id = ?").run(failed.id);
    database.sqlite.query("UPDATE bills SET status = 'needs_review' WHERE id = ?").run(needsReview.id);
    database.sqlite.query("UPDATE jobs SET state = 'retryable_failure' WHERE bill_id = ?").run(received.id);
    database.sqlite.query("UPDATE jobs SET state = 'permanent_failure' WHERE bill_id = ?").run(approved.id);

    expect(database.getDashboardMetrics()).toEqual({
      receivedBills: 4,
      approvedBills: 1,
      failedBills: 1,
      retryableJobs: 1,
      permanentFailureJobs: 1,
    });
  });
});

describe("dual-provider extraction provenance", () => {
  test("begins only an identity-matched claimed invocation and reports duplicate creation", () => {
    const bill = database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "identity-job" }]).bill;
    const job = database.claimNextJob("worker", policy)!;
    const request = { billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts, provider: "mistral" as const, idempotencyKey: job.idempotencyKey, requestedAt: new Date().toISOString() };
    const first = database.beginExtractionInvocation(request);
    if (!first) throw new Error("expected invocation");
    expect(first.created).toBe(true);
    const duplicate = database.beginExtractionInvocation(request);
    expect(duplicate).toMatchObject({ created: false, invocation: { id: first.invocation.id } });
    expect(database.beginExtractionInvocation({ ...request, billId: "other-bill" })).toBeNull();
    expect(database.beginExtractionInvocation({ ...request, idempotencyKey: "other-key" })).toBeNull();
    expect(database.beginExtractionInvocation({ ...request, jobAttempt: job.attempts + 1 })).toBeNull();
    const archiveBill = database.createBillWithInitialJobs({ ...input(), whatsappMessageId: "archive-message", attachmentIndex: 1 }, [{ type: "archive_to_drive", idempotencyKey: "archive-identity-job" }]).bill;
    const archiveJob = database.claimNextJob("worker", policy, new Date(), ["archive_to_drive"]);
    if (!archiveJob) throw new Error("expected archive claim");
    expect(database.beginExtractionInvocation({ ...request, billId: archiveBill.id, jobId: archiveJob.id, leaseToken: archiveJob.leaseToken, jobAttempt: archiveJob.attempts, idempotencyKey: archiveJob.idempotencyKey })).toBeNull();
  });

  test("audits every provider invocation and retains resumable Azure operation state", () => {
    const bill = database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "provenance-job" }]).bill;
    const job = database.claimNextJob("worker", policy)!;
    const requestedAt = "2026-08-30T00:00:00.000Z";
    const mistral = database.beginExtractionInvocation({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts, provider: "mistral", idempotencyKey: job.idempotencyKey, providerModel: "mistral-model", promptSchemaVersion: "1", requestedAt });
    const azure = database.beginExtractionInvocation({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts, provider: "azure", idempotencyKey: job.idempotencyKey, providerModel: "azure-model", promptSchemaVersion: "1", requestedAt });
    if (!mistral || !azure) throw new Error("expected durable invocations");
    expect(mistral.created).toBe(true); expect(azure.created).toBe(true);
    expect(database.finishExtractionInvocation({ invocationId: mistral.invocation.id, jobId: job.id, leaseToken: job.leaseToken, outcome: "failed", completedAt: "2026-08-30T00:00:01.000Z", rawProviderResponse: null, errorDetails: "low confidence" })).toBe(true);
    const operation = database.persistAzureExtractionOperation({ invocationId: azure.invocation.id, billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, operationLocation: "https://azure.example/operations/1" });
    expect(operation).toMatchObject({ invocationId: azure.invocation.id, state: "submitted" });
    expect(database.listResumableAzureExtractionOperations()).toMatchObject([{ invocationId: azure.invocation.id, operationLocation: "https://azure.example/operations/1" }]);
    expect(database.finishAzureExtractionOperation({ invocationId: azure.invocation.id, jobId: job.id, leaseToken: job.leaseToken, state: "succeeded", completedAt: "2026-08-30T00:00:02.000Z" })).toBe(true);
    expect(database.persistAzureExtractionOperation({ invocationId: azure.invocation.id, billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, operationLocation: "https://azure.example/operations/1", state: "submitted" })).toBeNull();
    expect(database.getAzureExtractionOperation(azure.invocation.id)).toMatchObject({ state: "succeeded" });
    expect(database.finishExtractionInvocation({ invocationId: azure.invocation.id, jobId: job.id, leaseToken: job.leaseToken, outcome: "succeeded", completedAt: "2026-08-30T00:00:02.000Z", rawProviderResponse: "azure response", errorDetails: null })).toBe(true);
    expect(database.getExtractionInvocations(bill.id)).toMatchObject([{ provider: "mistral", outcome: "failed" }, { provider: "azure", outcome: "succeeded" }]);
    const normalized = { schemaVersion: "1" as const, vendorName: "Vendor", invoiceNumber: null, invoiceDate: "2026-08-30", currency: "USD", subtotal: 1, vat: 0, total: 1, description: null, fields: {} };
    expect(database.persistCanonicalExtractionSuccess({ invocationId: azure.invocation.id, billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts, provider: "mistral", idempotencyKey: job.idempotencyKey, normalized, rawProviderResponse: "azure response", providerModel: "azure-model", promptSchemaVersion: "1", requestedAt, completedAt: "2026-08-30T00:00:02.000Z" })).toBe(false);
    expect(database.persistCanonicalExtractionSuccess({ invocationId: azure.invocation.id, billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts, provider: "azure", idempotencyKey: job.idempotencyKey, normalized, rawProviderResponse: "azure response", providerModel: "azure-model", promptSchemaVersion: "1", requestedAt, completedAt: "2026-08-30T00:00:02.000Z" })).toBe(true);
    expect(database.persistExtractionSuccess({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts, provider: "mistral", normalized: { ...normalized, vendorName: "Replacement" }, rawProviderResponse: "mistral response", providerModel: "mistral-model", promptSchemaVersion: "1", requestedAt, completedAt: "2026-08-30T00:00:03.000Z" })).toBe(false);
    expect(database.getExtraction(bill.id)).toMatchObject({ selectedProvider: "azure", fallbackStatus: "succeeded", selectedInvocationId: azure.invocation.id, normalized: { vendorName: "Vendor" } });
  });

  test("persists Azure operation state only while its invocation is requested", () => {
    const bill = database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "completed-invocation-job" }]).bill;
    const job = database.claimNextJob("worker", policy)!;
    const invocation = database.beginExtractionInvocation({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts, provider: "azure", idempotencyKey: job.idempotencyKey, requestedAt: new Date().toISOString() });
    if (!invocation) throw new Error("expected invocation");
    expect(database.finishExtractionInvocation({ invocationId: invocation.invocation.id, jobId: job.id, leaseToken: job.leaseToken, outcome: "failed", completedAt: new Date().toISOString(), rawProviderResponse: null, errorDetails: "failed" })).toBe(true);
    expect(database.persistAzureExtractionOperation({ invocationId: invocation.invocation.id, billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, operationLocation: "https://azure.example/operations/completed" })).toBeNull();
    expect(database.getAzureExtractionOperation(invocation.invocation.id)).toBeNull();
  });

  test("a replacement attempt resumes a persisted Azure operation and selects its original invocation", () => {
    const bill = database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "azure-resume-job" }]).bill;
    const start = new Date();
    const first = database.claimNextJob("first-worker", policy, start)!;
    const begun = database.beginExtractionInvocation({ billId: bill.id, jobId: first.id, leaseToken: first.leaseToken, jobAttempt: first.attempts, provider: "azure", idempotencyKey: first.idempotencyKey, requestedAt: start.toISOString() });
    if (!begun) throw new Error("expected Azure invocation");
    expect(database.persistAzureExtractionOperation({ invocationId: begun.invocation.id, billId: bill.id, jobId: first.id, leaseToken: first.leaseToken, operationLocation: "https://azure.example/operations/resume" })).toMatchObject({ state: "submitted" });

    const reapedAt = new Date(start.getTime() + policy.leaseMs);
    expect(database.claimNextJob("second-worker", policy, reapedAt)).toBeNull();
    const second = database.claimNextJob("second-worker", policy, new Date(reapedAt.getTime() + policy.retryBaseMs))!;
    expect(second.attempts).toBe(2);
    expect(database.listResumableAzureExtractionOperations()).toMatchObject([{ invocationId: begun.invocation.id, jobId: first.id, operationLocation: "https://azure.example/operations/resume" }]);

    expect(database.finishAzureExtractionOperation({ invocationId: begun.invocation.id, jobId: second.id, leaseToken: second.leaseToken, state: "succeeded", completedAt: new Date().toISOString() })).toBe(true);
    expect(database.finishExtractionInvocation({ invocationId: begun.invocation.id, jobId: second.id, leaseToken: second.leaseToken, outcome: "succeeded", completedAt: new Date().toISOString(), rawProviderResponse: "azure response", errorDetails: null })).toBe(true);
    const normalized = { schemaVersion: "1" as const, vendorName: "Resumed vendor", invoiceNumber: null, invoiceDate: "2026-08-30", currency: "USD", subtotal: 1, vat: 0, total: 1, description: null, fields: {} };
    expect(database.persistCanonicalExtractionSuccess({ invocationId: begun.invocation.id, billId: bill.id, jobId: second.id, leaseToken: second.leaseToken, jobAttempt: first.attempts, provider: "azure", idempotencyKey: first.idempotencyKey, normalized, rawProviderResponse: "azure response", providerModel: "azure-model", promptSchemaVersion: "1", requestedAt: start.toISOString(), completedAt: new Date().toISOString() })).toBe(true);
    expect(database.getExtraction(bill.id)).toMatchObject({ selectedInvocationId: begun.invocation.id, selectedProvider: "azure", normalized: { vendorName: "Resumed vendor" } });
    expect(database.getExtractionInvocations(bill.id)).toHaveLength(1);
    expect(database.sqlite.query<{ count: number }, [string]>("SELECT count(*) AS count FROM azure_extraction_operations WHERE bill_id = ?").get(bill.id)?.count).toBe(1);
  });

  test("fences stale workers after a replacement claim from changing Azure operation or canonical provenance", () => {
    const bill = database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "fenced-provenance-job" }]).bill;
    const start = new Date();
    const job = database.claimNextJob("worker", policy, start)!;
    const invocation = database.beginExtractionInvocation({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts, provider: "azure", idempotencyKey: job.idempotencyKey, requestedAt: new Date().toISOString() });
    if (!invocation) throw new Error("expected durable invocation");
    const reapedAt = new Date(start.getTime() + policy.leaseMs);
    expect(database.claimNextJob("replacement-worker", policy, reapedAt)).toBeNull();
    const replacement = database.claimNextJob("replacement-worker", policy, new Date(reapedAt.getTime() + policy.retryBaseMs))!;
    expect(replacement.leaseToken).not.toBe(job.leaseToken);
    expect(database.beginExtractionInvocation({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts, provider: "mistral", idempotencyKey: job.idempotencyKey, requestedAt: new Date().toISOString() })).toBeNull();
    expect(database.persistAzureExtractionOperation({ invocationId: invocation.invocation.id, billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, operationLocation: "https://azure.example/operations/stale" })).toBeNull();
    expect(database.finishExtractionInvocation({ invocationId: invocation.invocation.id, jobId: job.id, leaseToken: job.leaseToken, outcome: "failed", completedAt: new Date().toISOString(), rawProviderResponse: null, errorDetails: "stale" })).toBe(false);
    expect(database.persistExtractionSuccess({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts, provider: "azure", normalized: { schemaVersion: "1", vendorName: "Vendor", invoiceNumber: null, invoiceDate: "2026-08-30", currency: "USD", subtotal: 1, vat: 0, total: 1, description: null, fields: {} }, rawProviderResponse: "response", providerModel: "azure-model", promptSchemaVersion: "1", requestedAt: new Date().toISOString(), completedAt: new Date().toISOString() })).toBe(false);
    expect(database.getExtraction(bill.id)).toBeNull();
  });
});

test("Drive folder reservations converge concurrent logical paths on one generated identity", () => {
  const first = database.reserveDriveId({ key: "folder:Bills/2026", kind: "folder", parentId: "root", logicalPath: "Bills/2026", generatedId: "folder-a" });
  const second = database.reserveDriveId({ key: "folder:Bills/2026", kind: "folder", parentId: "root", logicalPath: "Bills/2026", generatedId: "folder-b" });
  expect(first.drive_id).toBe("folder-a"); expect(second.drive_id).toBe("folder-a");
});

test("operator inspection and explicit replay expose only eligible failed jobs", () => {
  const bill = database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "operator-job" }]).bill;
  const job = database.claimNextJob("worker", policy)!;
  database.failJob(job.id, job.leaseToken, "timeout", policy);
  expect(database.findBillsByIdentifier("message-1").map((item) => item.id)).toEqual([bill.id]);
  expect(database.listJobs(["retryable_failure"]).map((item) => item.id)).toEqual([job.id]);
  expect(database.requeueJob(job.id)).toBe(true);
  expect(database.getJobTransitions(job.id).at(-1)).toMatchObject({ fromState: "retryable_failure", toState: "pending", reason: "operator_replay" });
  const claim = database.claimNextJob("worker", policy)!;
  database.failJob(claim.id, claim.leaseToken, "malformed schema", { ...policy, maxAttempts: 1 });
  expect(database.requeueJob(job.id)).toBe(false);
  expect(database.requeueJob(job.id, true)).toBe(true);
  database.sqlite.query("UPDATE jobs SET last_error = 'validation_invalidated', state = 'permanent_failure' WHERE id = ?").run(job.id);
  expect(database.requeueJob(job.id, true)).toBe(false);
});

describe("canonical bill and jobs", () => {
  test("uses source-scoped, collision-safe identity and permits equal message IDs across chats and transports", () => {
    const base = { sourceMessageId: "42", sourceSenderId: "sender", attachmentIndex: 0, receivedAt: "2026-08-27T00:00:00.000Z", mimeType: "image/png", originalPath: "/durable/source.png", contentSha256: "d".repeat(64) };
    const whatsapp = database.createBillWithInitialJobs({ ...base, source: "whatsapp", sourceChatId: "chat-a", sourceIdentity: "chat-a:42:0" }, [{ type: "extract", idempotencyKey: "source-wa" }]);
    const telegram = database.createBillWithInitialJobs({ ...base, source: "telegram", sourceChatId: "chat-a", sourceIdentity: "chat-a:42:0" }, [{ type: "extract", idempotencyKey: "source-tg" }]);
    const otherChat = database.createBillWithInitialJobs({ ...base, source: "whatsapp", sourceChatId: "chat-b", sourceIdentity: "chat-b:42:0" }, [{ type: "extract", idempotencyKey: "source-other" }]);
    expect([whatsapp.bill.id, telegram.bill.id, otherChat.bill.id]).toHaveLength(3);
    expect(database.getBillBySourceIdentity("telegram", "chat-a:42:0")?.sourceMessageId).toBe("42");
    expect(database.findBillsByIdentifier("chat-b").map((bill) => bill.id)).toEqual([otherChat.bill.id]);
    expect(() => database.createBillWithInitialJobs({ ...base, source: "telegram", sourceChatId: "chat-a", sourceIdentity: "telegram-batch", batchItemId: "nope" }, [])).toThrow("Transport bill");

    const ambiguousFirst = database.createBillWithInitialJobs({ ...base, source: "telegram", sourceChatId: "a:b", sourceMessageId: "c", attachmentIndex: 0 }, [{ type: "extract", idempotencyKey: "identity-ambiguous-first" }]);
    const ambiguousSecond = database.createBillWithInitialJobs({ ...base, source: "telegram", sourceChatId: "a", sourceMessageId: "b:c", attachmentIndex: 0 }, [{ type: "extract", idempotencyKey: "identity-ambiguous-second" }]);
    expect(ambiguousFirst.bill.id).not.toBe(ambiguousSecond.bill.id);
    expect(ambiguousFirst.bill.sourceIdentity).not.toBe(ambiguousSecond.bill.sourceIdentity);
  });

  test("persists a singleton Telegram polling cursor", () => {
    expect(database.getTelegramPollingCursor()).toBeNull();
    database.setTelegramPollingCursor(42);
    database.setTelegramPollingCursor(43);
    expect(database.getTelegramPollingCursor()).toBe(43);
    database.close();
    database = new BillDatabase(path);
    expect(database.getTelegramPollingCursor()).toBe(43);
    expect(() => database.setTelegramPollingCursor(-1)).toThrow("non-negative");
  });
  test("creates a bill and its initial jobs exactly once for a repeated provider event", () => {
    const first = database.createBillWithInitialJobs(input(), jobs());
    const repeated = database.createBillWithInitialJobs(input(), jobs());
    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.bill.id).toBe(first.bill.id);
    expect(database.countJobsForBill(first.bill.id)).toBe(2);
  });

  test("rolls back a new bill when a required job idempotency key belongs to another bill", () => {
    database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "shared-key" }]);
    expect(() => database.createBillWithInitialJobs({ ...input(), whatsappMessageId: "message-2", attachmentIndex: 1 }, [{ type: "extract", idempotencyKey: "shared-key" }])).toThrow("idempotency key");
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(1);
  });

  test("competing workers cannot claim the same job", () => {
    database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "only-job" }]);
    const secondConnection = new BillDatabase(path);
    const firstClaim = database.claimNextJob("worker-a", policy);
    const secondClaim = secondConnection.claimNextJob("worker-b", policy);
    expect(firstClaim).not.toBeNull();
    expect(secondClaim).toBeNull();
    secondConnection.close();
  });

  test("records retryable failure with bounded exponential availability and then reclaims it", () => {
    const start = new Date("2026-08-27T00:00:00.000Z");
    database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "retry-job", availableAt: start.toISOString() }]);
    const claim = database.claimNextJob("worker-a", policy, start);
    if (!claim) throw new Error("expected claim");
    const failed = database.failJob(claim.id, claim.leaseToken, "temporary outage", policy, start);
    expect(failed?.state).toBe("retryable_failure");
    expect(failed?.availableAt).toBe("2026-08-27T00:00:00.100Z");
    expect(database.claimNextJob("worker-b", policy, new Date("2026-08-27T00:00:00.099Z"))).toBeNull();
    const retried = database.claimNextJob("worker-b", policy, new Date("2026-08-27T00:00:00.100Z"));
    expect(retried?.state).toBe("running");
    expect(retried?.attempts).toBe(2);
  });

  test("expires a lease into a delayed, observable retryable failure", () => {
    const start = new Date("2026-08-27T00:00:00.000Z");
    database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "leased-job", availableAt: start.toISOString() }]);
    const claim = database.claimNextJob("worker-a", policy, start);
    if (!claim) throw new Error("expected claim");
    const expires = new Date("2026-08-27T00:01:00.000Z");
    expect(database.claimNextJob("worker-b", policy, expires)).toBeNull();
    expect(database.getJob(claim.id)).toMatchObject({ state: "retryable_failure", attempts: 1, availableAt: "2026-08-27T00:01:00.100Z", lastError: "lease expired" });
    expect(database.getJobTransitions(claim.id).map((transition) => transition.reason)).toEqual(["created", "claimed", "lease_expired"]);
    expect(database.claimNextJob("worker-b", policy, new Date("2026-08-27T00:01:00.099Z"))).toBeNull();
    expect(database.claimNextJob("worker-b", policy, new Date("2026-08-27T00:01:00.100Z"))?.attempts).toBe(2);
  });

  test("records every durable job state transition in history", () => {
    const start = new Date("2026-08-27T00:00:00.000Z");
    const bill = database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "audit-job", availableAt: start.toISOString() }]);
    const first = database.claimNextJob("worker-a", policy, start);
    if (!first) throw new Error("expected first claim");
    database.failJob(first.id, first.leaseToken, "temporary", policy, start);
    const second = database.claimNextJob("worker-b", policy, new Date("2026-08-27T00:00:00.100Z"));
    if (!second) throw new Error("expected retry claim");
    database.completeJob(second.id, second.leaseToken);
    expect(database.getJobTransitions(second.id).map((transition) => `${transition.fromState ?? "none"}->${transition.toState}:${transition.reason}`)).toEqual([
      "none->pending:created", "pending->running:claimed", "running->retryable_failure:handler_failed", "retryable_failure->pending:retry_available", "pending->running:claimed", "running->succeeded:completed",
    ]);
    expect(database.countJobsForBill(bill.bill.id)).toBe(1);
  });

  test("records permanent failure in transition history after the retry limit", () => {
    const start = new Date("2026-08-27T00:00:00.000Z");
    database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "permanent-job", availableAt: start.toISOString() }]);
    const claim = database.claimNextJob("worker", { ...policy, maxAttempts: 1 }, start);
    if (!claim) throw new Error("expected claim");
    expect(database.failJob(claim.id, claim.leaseToken, "fatal", { ...policy, maxAttempts: 1 }, start)?.state).toBe("permanent_failure");
    expect(database.getJobTransitions(claim.id).map((transition) => transition.toState)).toEqual(["pending", "running", "permanent_failure"]);
  });
});

describe("admin-upload source and classification persistence", () => {
  test("creates batches and items idempotently with bounded status counts", () => {
    const first = database.createAdminUploadBatch({ idempotencyKey: "upload:sha256", originalFilename: "invoices.zip" });
    const repeated = database.createAdminUploadBatch({ idempotencyKey: "upload:sha256", originalFilename: "changed.zip" });
    expect(first.created).toBe(true); expect(repeated).toMatchObject({ created: false, batch: { id: first.batch.id, originalFilename: "invoices.zip" } });
    const item = database.createAdminUploadBatchItem({ batchId: first.batch.id, itemIndex: 0, entryPath: "nested/invoice.pdf" });
    expect(database.createAdminUploadBatchItem({ batchId: first.batch.id, itemIndex: 0, entryPath: "other.pdf" })).toMatchObject({ created: false, item: { id: item.item.id, entryPath: "nested/invoice.pdf" } });
    expect(database.getAdminUploadBatchStatusCounts(first.batch.id)).toEqual({ total: 1, queued: 1, processing: 0, complete: 0, notInvoice: 0, rejected: 0, failed: 0 });
    expect(database.transitionAdminUploadBatchItemState({ itemId: item.item.id, state: "rejected", errorCode: "unsupported_mime", expectedStates: ["queued"] })).toBe(true);
    expect(database.transitionAdminUploadBatchItemState({ itemId: item.item.id, state: "processing", expectedStates: ["queued"] })).toBe(false);
    expect(database.transitionAdminUploadBatchItemState({ itemId: item.item.id, state: "failed" })).toBe(false);
    expect(database.getAdminUploadBatchStatusCounts(first.batch.id)).toEqual({ total: 1, queued: 0, processing: 0, complete: 0, notInvoice: 0, rejected: 1, failed: 0 });
    expect(database.setAdminUploadBatchState(first.batch.id, "processing")).toBe(true);
    expect(database.setAdminUploadBatchState(first.batch.id, "queued")).toBe(false);
    expect(database.setAdminUploadBatchState(first.batch.id, "completed")).toBe(true);
    expect(database.setAdminUploadBatchState(first.batch.id, "failed")).toBe(false);
    expect(database.getAdminUploadBatchStatusCounts("missing")).toBeNull();
  });

  test("enforces item terminal states and completes batches only after every item is terminal", () => {
    const batch = database.createAdminUploadBatch({ idempotencyKey: "upload:state-machine", originalFilename: "invoices.zip" }).batch;
    const rejected = database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex: 0, entryPath: "rejected.pdf" }).item;
    const completed = database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex: 1, entryPath: "completed.pdf" }).item;

    expect(database.setAdminUploadBatchState(batch.id, "processing")).toBe(true);
    expect(database.setAdminUploadBatchState(batch.id, "completed")).toBe(false);
    expect(database.transitionAdminUploadBatchItemState({ itemId: rejected.id, state: "rejected", expectedStates: ["queued"] })).toBe(true);
    expect(database.transitionAdminUploadBatchItemState({ itemId: rejected.id, state: "processing", expectedStates: ["rejected"] })).toBe(false);
    expect(database.transitionAdminUploadBatchItemState({ itemId: rejected.id, state: "queued", expectedStates: ["rejected"] })).toBe(false);
    expect(database.transitionAdminUploadBatchItemState({ itemId: completed.id, state: "processing", expectedStates: ["queued"] })).toBe(true);
    expect(database.setAdminUploadBatchState(batch.id, "completed")).toBe(false);
    expect(database.transitionAdminUploadBatchItemState({ itemId: completed.id, state: "complete", expectedStates: ["processing"] })).toBe(true);
    expect(database.transitionAdminUploadBatchItemState({ itemId: completed.id, state: "failed", expectedStates: ["complete"] })).toBe(false);
    expect(database.getAdminUploadBatchStatusCounts(batch.id)).toEqual({ total: 2, queued: 0, processing: 0, complete: 1, notInvoice: 0, rejected: 1, failed: 0 });
    expect(database.getAdminUploadBatchStatus(batch.id)?.batch.state).toBe("completed");
    expect(database.setAdminUploadBatchState(batch.id, "completed")).toBe(false);
    expect(() => database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex: 2, entryPath: "late.pdf" })).toThrow("requires an existing batch");
    expect(database.getAdminUploadBatchStatusCounts(batch.id)?.total).toBe(2);
  });

  test("uses source identity for idempotent uploaded bills and records Azure-only policy", () => {
    const batch = database.createAdminUploadBatch({ idempotencyKey: "upload:source", originalFilename: "invoices.zip" }).batch;
    const item = database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex: 3, entryPath: "invoice.pdf" }).item;
    const uploaded = { ...input(), whatsappMessageId: `admin-upload:${batch.id}:3`, whatsappGroupId: "admin-upload", whatsappSenderId: "admin-upload", attachmentIndex: 0, source: "admin_upload" as const, sourceIdentity: `admin-upload:${batch.id}:3`, extractionPolicy: "azure_only" as const, batchItemId: item.id };
    const first = database.createBillWithInitialJobs(uploaded, [{ type: "extract", idempotencyKey: `extract:${uploaded.sourceIdentity}` }]);
    const repeated = database.createBillWithInitialJobs({ ...uploaded, whatsappMessageId: "changed-legacy-value" }, [{ type: "extract", idempotencyKey: `extract:${uploaded.sourceIdentity}` }]);
    expect(first.created).toBe(true); expect(repeated).toMatchObject({ created: false, bill: { id: first.bill.id, source: "admin_upload", sourceIdentity: uploaded.sourceIdentity, extractionPolicy: "azure_only", batchItemId: item.id } });
    expect(database.getAdminUploadBatchStatusCounts(batch.id)).toEqual({ total: 1, queued: 0, processing: 1, complete: 0, notInvoice: 0, rejected: 0, failed: 0 });
    expect(() => database.createBillWithInitialJobs({ ...input(), whatsappMessageId: "whatsapp-with-batch", batchItemId: item.id }, [{ type: "extract", idempotencyKey: "whatsapp-with-batch" }])).toThrow("Transport bill");
    expect(() => database.createBillWithInitialJobs({ ...uploaded, whatsappMessageId: "admin-missing-item", attachmentIndex: 9, sourceIdentity: "other-upload", batchItemId: "missing-item" }, [{ type: "extract", idempotencyKey: "missing-upload-item" }])).toThrow("batch item");
  });

  test("persists NotInvoice terminally and prevents sheet projection jobs", () => {
    const batch = database.createAdminUploadBatch({ idempotencyKey: "upload:classification", originalFilename: "invoices.zip" }).batch;
    const item = database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex: 0, entryPath: "not-invoice.png" }).item;
    const bill = database.createBillWithInitialJobs({ ...input(), whatsappMessageId: `admin-upload:${batch.id}:0`, whatsappGroupId: "admin-upload", whatsappSenderId: "admin-upload", source: "admin_upload", sourceIdentity: `admin-upload:${batch.id}:0`, extractionPolicy: "azure_only", batchItemId: item.id }, [{ type: "extract", idempotencyKey: `extract:${item.id}` }]).bill;
    const job = database.claimNextJob("azure", policy)!;
    expect(database.transitionBillClassification({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, classification: "not_invoice", actor: "azure", reason: "no_document", expectedContentRevision: 0, expectedReviewRevision: 0 })).toBe(true);
    expect(database.getBill(bill.id)).toMatchObject({ status: "failed", classification: "not_invoice", contentRevision: 1 });
    database.sqlite.query("UPDATE bills SET status = 'approved' WHERE id = ?").run(bill.id);
    database.ensureCurrentProjectionJob(bill.id);
    expect(database.listJobsForBill(bill.id).map((job) => job.type)).toEqual(["extract"]);
    expect(database.isApprovedAtRevision(bill.id, 1)).toBe(false);
    expect(database.getAdminUploadBatchStatusCounts(batch.id)?.notInvoice).toBe(1);
    expect(() => database.createBillWithInitialJobs({ ...input(), whatsappMessageId: "not-invoice", sourceIdentity: "not-invoice", classification: "not_invoice" }, [{ type: "project_to_sheet", idempotencyKey: "not-invoice-project" }])).toThrow("NotInvoice");
  });

  test("review-correction approval terminalizes its item and parent batch", () => {
    const batch = database.createAdminUploadBatch({ idempotencyKey: "upload:review-approval", originalFilename: "invoices.zip" }).batch;
    const item = database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex: 0, entryPath: "review.pdf" }).item;
    expect(database.setAdminUploadBatchState(batch.id, "processing")).toBe(true);
    const bill = database.createBillWithInitialJobs({ ...input(), whatsappMessageId: "review-approval", source: "admin_upload", sourceIdentity: "review-approval", extractionPolicy: "azure_only", classification: "invoice", batchItemId: item.id }, [{ type: "extract", idempotencyKey: "extract:review-approval" }]).bill;
    database.sqlite.query("UPDATE bills SET status = 'needs_review', manual_review_required = 1, content_revision = 3, review_revision = 2 WHERE id = ?").run(bill.id);
    expect(database.approveReviewCorrection({ billId: bill.id, reviewerId: "reviewer", expectedContentRevision: 3, expectedReviewRevision: 2 })).toBe(true);
    expect(database.getAdminUploadBatchStatus(batch.id)?.batch.state).toBe("completed");
    expect(database.getAdminUploadBatchStatus(batch.id)?.items).toMatchObject([{ state: "complete", billId: bill.id }]);
  });

  test("rejecting an approved admin-upload bill updates its completed batch item", () => {
    const batch = database.createAdminUploadBatch({ idempotencyKey: "upload:approved-rejection", originalFilename: "invoices.zip" }).batch;
    const item = database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex: 0, entryPath: "approved.pdf" }).item;
    const bill = database.createBillWithInitialJobs({ ...input(), whatsappMessageId: "approved-rejection", source: "admin_upload", sourceIdentity: "approved-rejection", extractionPolicy: "azure_only", classification: "invoice", batchItemId: item.id }, []).bill;
    database.sqlite.query("UPDATE bills SET status = 'approved', content_revision = 1 WHERE id = ?").run(bill.id);
    database.sqlite.query("UPDATE admin_upload_batch_items SET state = 'complete' WHERE id = ?").run(item.id);
    database.sqlite.query("UPDATE admin_upload_batches SET state = 'completed' WHERE id = ?").run(batch.id);
    const corrected = { schemaVersion: "1" as const, vendorName: "Vendor", invoiceNumber: null, invoiceDate: "2026-08-27", currency: "USD", subtotal: 1, vat: 0, total: 1, description: null, fields: {} };
    expect(database.submitReview({ billId: bill.id, reviewerId: "alice", action: "reject", reason: null, note: null, expectedContentRevision: 1, expectedReviewRevision: 0, corrected }, [])).toBe(true);
    expect(database.getAdminUploadBatchStatus(batch.id)).toMatchObject({ batch: { state: "completed" }, items: [{ state: "rejected", billId: bill.id }] });
    expect(database.submitReview({ billId: bill.id, reviewerId: "alice", action: "approve", reason: null, note: null, expectedContentRevision: 2, expectedReviewRevision: 1, corrected }, [])).toBe(true);
    expect(database.getAdminUploadBatchStatus(batch.id)).toMatchObject({ batch: { state: "completed" }, items: [{ state: "complete", billId: bill.id }] });
  });

  test("fences classification by active extract claim and exact revision while recording one event", () => {
    const bill = database.createBillWithInitialJobs({ ...input(), whatsappMessageId: "classification-fence" }, [{ type: "extract", idempotencyKey: "classification-fence-job" }]).bill;
    const job = database.claimNextJob("azure", policy)!;
    const base = { billId: bill.id, jobId: job.id, classification: "invoice" as const, actor: "azure", expectedContentRevision: 0, expectedReviewRevision: 0 };
    expect(database.transitionBillClassification({ ...base, leaseToken: "stale-token" })).toBe(false);
    expect(database.transitionBillClassification({ ...base, leaseToken: job.leaseToken, expectedContentRevision: 1 })).toBe(false);
    expect(database.transitionBillClassification({ ...base, leaseToken: job.leaseToken })).toBe(true);
    expect(database.transitionBillClassification({ ...base, leaseToken: job.leaseToken })).toBe(false);
    expect(database.getBill(bill.id)).toMatchObject({ classification: "invoice", status: "received", contentRevision: 1 });
    expect(database.sqlite.query<{ count: number }, [string]>("SELECT count(*) AS count FROM bill_classification_events WHERE bill_id = ?").get(bill.id)?.count).toBe(1);
  });

  test("reviewer overrides are revision-fenced, blocked by an active extractor lease, and never auto-approve NotInvoice", () => {
    const bill = database.createBillWithInitialJobs({ ...input(), whatsappMessageId: "review-override" }, [{ type: "extract", idempotencyKey: "review-override-job" }]).bill;
    const job = database.claimNextJob("azure", policy)!;
    expect(database.overrideClassification({ billId: bill.id, reviewerId: "alice", action: "mark_not_invoice", expectedContentRevision: 0, expectedReviewRevision: 0 })).toBe(false);
    expect(database.failJob(job.id, job.leaseToken, "stop", { ...policy, maxAttempts: 1 })).not.toBeNull();
    expect(database.overrideClassification({ billId: bill.id, reviewerId: "alice", action: "mark_not_invoice", expectedContentRevision: 1, expectedReviewRevision: 0 })).toBe(false);
    expect(database.overrideClassification({ billId: bill.id, reviewerId: "alice", action: "mark_not_invoice", expectedContentRevision: 0, expectedReviewRevision: 0 })).toBe(true);
    expect(database.getBill(bill.id)).toMatchObject({ classification: "not_invoice", status: "failed", contentRevision: 1, reviewRevision: 1 });
    expect(database.isApprovedAtRevision(bill.id, 1)).toBe(false);
    expect(database.getReviewEvents(bill.id)).toMatchObject([{ reviewerId: "alice", action: "mark_not_invoice", createdAt: expect.any(String) }]);
    const corrected = { schemaVersion: "1" as const, vendorName: "Vendor", invoiceNumber: null, invoiceDate: "2026-08-27", currency: "USD", subtotal: 1, vat: 0, total: 1, description: null, fields: {} };
    expect(database.submitReview({ billId: bill.id, reviewerId: "alice", action: "approve", reason: null, note: null, expectedContentRevision: 1, expectedReviewRevision: 1, corrected }, [])).toBe(false);
    expect(database.persistValidationDecision({ billId: bill.id, expectedContentRevision: 1, expectedReviewRevision: 1, decision: "approved", issues: [] })).toBe(false);
  });
});
