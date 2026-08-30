import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as SqliteDatabase } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase, type RetryPolicy } from "../src/database";

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
    expect(reopened.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM schema_migrations").get()?.count).toBe(13);
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
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM schema_migrations").get()?.count).toBe(13);
  });

  test("upgrades a v9 database with existing extraction records without changing canonical data", () => {
    database.close();
    rmSync(path, { force: true });
    const legacy = new SqliteDatabase(path, { create: true, strict: true });
    legacy.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE bills (id TEXT PRIMARY KEY);
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
    legacy.query("INSERT INTO bills (id) VALUES (?)").run("legacy-bill");
    legacy.query("INSERT INTO jobs (id, bill_id) VALUES (?, ?)").run("legacy-job", "legacy-bill");
    legacy.query("INSERT INTO extractions (id, bill_id, schema_version, normalized_json, raw_provider_response, provider_model, prompt_schema_version, requested_at, completed_at, error_details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-extraction", "legacy-bill", "1", JSON.stringify({ schemaVersion: "1", vendorName: "Legacy" }), "legacy raw", "legacy-model", "1", appliedAt, appliedAt, null, appliedAt, appliedAt);
    legacy.query("INSERT INTO extraction_attempts (id, bill_id, job_id, job_attempt, provider_model, requested_at, completed_at, outcome, raw_provider_response, error_details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-attempt", "legacy-bill", "legacy-job", 1, "legacy-model", appliedAt, appliedAt, "succeeded", "legacy raw", null, appliedAt);
    legacy.close();

    database = new BillDatabase(path);
    expect(database.getExtraction("legacy-bill")).toMatchObject({ normalized: { vendorName: "Legacy" }, selectedProvider: null, fallbackStatus: null });
    expect(database.sqlite.query<{ provider: string }, [string]>("SELECT provider FROM extraction_attempts WHERE id = ?").get("legacy-attempt")?.provider).toBe("mistral");
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM schema_migrations").get()?.count).toBe(13);
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
