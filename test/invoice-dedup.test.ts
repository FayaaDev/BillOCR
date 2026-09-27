import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase, type RetryPolicy } from "../src/database";
import type { ExtractedBill } from "../src/contracts";
import { createExtractionValidationCallback } from "../src/validation";
import { createDriveArchiveHandler, type DriveAdapter } from "../src/google-projections";
import { JobWorker } from "../src/worker";
import { createLogger } from "../src/logger";

const policy: RetryPolicy = { maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 };
const now = "2026-09-01T00:00:00.000Z";
const extracted = (invoiceNumber: string | null, invoiceDate = "2026-08-28", vendorName = "Vendor", total = 11): ExtractedBill => ({
  schemaVersion: "1", invoiceNumber, invoiceDate, vendorName, total, currency: "USD", subtotal: null, vat: null, description: null, fields: {},
});
let directory: string;
let path: string;
let db: BillDatabase;

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "invoice-dedup-")); path = join(directory, "db.sqlite"); db = new BillDatabase(path); });
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

function create(database: BillDatabase, id: string, hash = "a".repeat(64)) {
  return database.createBillWithInitialJobs({ id, source: "telegram", sourceMessageId: id, sourceChatId: "chat", sourceSenderId: "sender", attachmentIndex: 0,
    receivedAt: now, mimeType: "application/pdf", originalPath: join(directory, `${id}.pdf`), contentSha256: hash },
  [{ type: "extract", idempotencyKey: `extract:${id}` }, { type: "archive_to_drive", idempotencyKey: `archive:${id}` }]).bill;
}
function finish(database: BillDatabase, id: string, value: ExtractedBill): void {
  const job = database.claimNextJob("extractor", policy, new Date(), ["extract"]);
  expect(job?.billId).toBe(id);
  expect(database.persistExtractionSuccess({ billId: id, jobId: job!.id, leaseToken: job!.leaseToken, jobAttempt: job!.attempts,
    normalized: value, rawProviderResponse: "{}", providerModel: "mock", promptSchemaVersion: "1", requestedAt: now, completedAt: now })).toBe(true);
  createExtractionValidationCallback(database, { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 }, () => new Date(now))(id);
  expect(database.completeJob(job!.id, job!.leaseToken)).toBe(true);
}

test("hashes, vendor and total do not determine identity; replay retains the first invoice owner and both originals", () => {
  const first = create(db, "first"); const second = create(db, "second", first.contentSha256);
  expect(first.id).not.toBe(second.id);
  expect(db.claimNextJob("archiver", policy, new Date(), ["archive_to_drive"])).toBeNull();
  finish(db, first.id, extracted("INV-1"));
  finish(db, second.id, extracted("INV-1", "2026-08-28", "Other", 999));
  expect(db.getInvoiceDedupOwner(second.id)).toBe(first.id);
  expect(db.getBill(second.id)?.status).toBe("failed");
  expect(db.getValidationIssues(second.id)).toContainEqual(expect.objectContaining({ code: "duplicate_invoice" }));
  expect(db.listCanonicalOriginals().map((item) => item.id)).toEqual([first.id, second.id]);
  expect(db.listJobsForBill(second.id).filter((job) => job.type === "project_to_sheet")).toHaveLength(0);
  const suppressed = db.listJobsForBill(second.id).find((job) => job.type === "archive_to_drive")!;
  expect(suppressed).toMatchObject({ state: "permanent_failure", lastError: "duplicate_invoice", attempts: 0 });
  expect(db.getJobTransitions(suppressed.id).at(-1)).toMatchObject({ fromState: "pending", toState: "permanent_failure", reason: "duplicate_invoice" });
  expect(db.requeueJob(suppressed.id, true)).toBe(false);
  const archive = db.claimNextJob("archiver", policy, new Date(), ["archive_to_drive"]);
  expect(archive?.billId).toBe(first.id);
  expect(db.listReviewBills().map((bill) => bill.id)).not.toContain(second.id);
  expect(db.listReviewBills({ status: "failed" })).toEqual([]);
  expect(db.getDashboardMetrics()).toMatchObject({ receivedBills: 1, approvedBills: 1, failedBills: 0, permanentFailureJobs: 0 });
  const before = db.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM invoice_dedup_decisions").get()?.count;
  createExtractionValidationCallback(db, { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 })(second.id);
  expect(db.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM invoice_dedup_decisions").get()?.count).toBe(before);
  expect(db.getBill(second.id)?.status).toBe("failed");
  expect(db.getJob(suppressed.id)).toMatchObject({ state: "permanent_failure", lastError: "duplicate_invoice" });
  expect(db.getJobTransitions(suppressed.id)).toHaveLength(2);
});

test("the same hash with another invoice number is approved; missing identity does not reserve a key", () => {
  create(db, "one"); create(db, "two"); create(db, "unknown");
  finish(db, "one", extracted("A")); finish(db, "two", extracted("B")); finish(db, "unknown", extracted(null));
  expect(db.getBill("two")?.status).toBe("approved");
  expect(db.getBill("unknown")?.status).toBe("approved");
  expect(db.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM invoice_dedup_owners").get()?.count).toBe(2);
});

test("ignores surrounding whitespace in extracted invoice identity", () => {
  create(db, "owner"); create(db, "copy");
  finish(db, "owner", extracted(" 4371 ", " 2026-08-28 "));
  finish(db, "copy", extracted("4371", "2026-08-28"));
  expect(db.getInvoiceDedupOwner("copy")).toBe("owner");
});

test("two SQLite connections serialize first-owner selection and failed decisions roll back together with validation", () => {
  const other = new BillDatabase(path);
  try {
    create(db, "a"); create(other, "b");
    finish(db, "a", extracted("X")); finish(other, "b", extracted("X"));
    expect(other.getInvoiceDedupOwner("b")).toBe("a");
    expect(other.isApprovedAtRevision("b", other.getBill("b")!.contentRevision)).toBe(false);
    create(db, "rollback");
    const job = db.claimNextJob("extractor", policy, new Date(), ["extract"])!;
    db.persistExtractionSuccess({ billId: "rollback", jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts,
      normalized: extracted("Y", "2026-08-28", ""), rawProviderResponse: "{}", providerModel: "mock", promptSchemaVersion: "1", requestedAt: now, completedAt: now });
    db.sqlite.exec("CREATE TRIGGER abort_validation BEFORE INSERT ON validation_issues BEGIN SELECT RAISE(ABORT, 'injected validation failure'); END");
    // Force a validation issue so the trigger fires after the unique owner is provisionally inserted.
    const validate = createExtractionValidationCallback(db, { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 });
    expect(() => validate("rollback")).toThrow("injected validation failure");
    expect(db.getInvoiceDedupOwner("rollback")).toBeNull();
    expect(db.sqlite.query("SELECT * FROM invoice_dedup_owners WHERE invoice_number = 'Y'").get()).toBeNull();
    db.sqlite.exec("DROP TRIGGER abort_validation");
    validate("rollback");
    expect(db.getInvoiceDedupOwner("rollback")).toBe("rollback");
  } finally { other.close(); }
});

test("future upload links to the earliest historical owner without mutating colliding historical bills", () => {
  const earliest = "458b2a13-27b8-44b2-b8ae-ce19ac7dd5da";
  const later = "1d9da371-996f-45ee-be51-464b50effa03";
  for (const id of [earliest, later]) {
    create(db, id);
    db.sqlite.query("UPDATE bills SET invoice_dedup_required = 0 WHERE id = ?").run(id);
    db.sqlite.query(`INSERT INTO extractions (id, bill_id, schema_version, normalized_json, created_at, updated_at) VALUES (?, ?, '1', ?, ?, ?)`).run(`extract-${id}`, id, JSON.stringify(extracted("OLD")), now, now);
    db.sqlite.query("UPDATE jobs SET state = 'succeeded' WHERE bill_id = ?").run(id);
  }
  db.sqlite.query("UPDATE bills SET created_at = '2025-01-01' WHERE id = ?").run(earliest);
  db.sqlite.query("UPDATE bills SET created_at = '2025-01-02' WHERE id = ?").run(later);
  const snapshots = [earliest, later].map((id) => db.getBill(id));
  create(db, "new"); finish(db, "new", extracted("OLD", "2026-08-28", "Unrelated", 5));
  expect(db.getInvoiceDedupOwner("new")).toBe(earliest);
  expect([earliest, later].map((id) => db.getBill(id))).toEqual(snapshots);
});

test("historical reviewer data remains a dedup candidate even without an OCR extraction row", () => {
  create(db, "historical");
  db.sqlite.query("UPDATE bills SET invoice_dedup_required = 0 WHERE id = 'historical'").run();
  db.sqlite.query("INSERT INTO effective_bill_data (bill_id, normalized_json, revision, updated_at) VALUES (?, ?, 1, ?)").run("historical", JSON.stringify(extracted("REVIEWED")), now);
  db.sqlite.query("UPDATE jobs SET state = 'succeeded' WHERE bill_id = 'historical'").run();
  const historical = db.getBill("historical");
  create(db, "new"); finish(db, "new", extracted("REVIEWED", "2026-08-28", "Other"));
  expect(db.getInvoiceDedupOwner("new")).toBe("historical");
  expect(db.getBill("historical")).toEqual(historical);
});

test("review cannot approve a duplicate or bypass identity by correcting an OCR-missing number", () => {
  create(db, "owner"); create(db, "duplicate"); create(db, "missing");
  finish(db, "owner", extracted("SAME"));
  finish(db, "duplicate", extracted("SAME"));
  finish(db, "missing", extracted(null));
  const approve = (id: string, number: string) => {
    const bill = db.getBill(id)!;
    return db.submitReview({ billId: id, reviewerId: "qa", action: "approve", reason: null, note: null,
      expectedContentRevision: bill.contentRevision, expectedReviewRevision: bill.reviewRevision, corrected: extracted(number) }, []);
  };
  expect(approve("duplicate", "NEW")).toBe(false);
  expect(approve("missing", "SAME")).toBe(false);
  expect(db.getInvoiceDedupOwner("missing")).toBe("missing");
  expect(approve("missing", "NEW")).toBe(true);
  expect(db.sqlite.query<{ invoice_number: string }, [string]>("SELECT invoice_number FROM invoice_dedup_decisions WHERE bill_id = ?").get("missing")?.invoice_number).toBe("NEW");
  create(db, "later"); finish(db, "later", extracted("NEW"));
  expect(db.getInvoiceDedupOwner("later")).toBe("missing");
  expect(db.prepareBillDeletion({ billId: "missing", expectedContentRevision: db.getBill("missing")!.contentRevision, expectedReviewRevision: db.getBill("missing")!.reviewRevision })).toEqual({ busy: true });
});

test("a later reviewer-only approval cannot accept an effective correction matching another owner", () => {
  create(db, "owner"); create(db, "reviewed");
  finish(db, "owner", extracted("EXISTING")); finish(db, "reviewed", extracted("DIFFERENT"));
  const current = db.getBill("reviewed")!;
  expect(db.submitReview({ billId: current.id, reviewerId: "qa", action: "reject", reason: null, note: null,
    expectedContentRevision: current.contentRevision, expectedReviewRevision: current.reviewRevision, corrected: extracted("EXISTING") }, [])).toBe(true);
  expect(db.supersedeForReview("reviewed", "qa")).toBe(true);
  const pending = db.getBill("reviewed")!;
  expect(db.approveReviewCorrection({ billId: pending.id, reviewerId: "qa", expectedContentRevision: pending.contentRevision, expectedReviewRevision: pending.reviewRevision })).toBe(false);
  expect(db.getBill("reviewed")?.status).toBe("needs_review");
  expect(db.getInvoiceDedupOwner("reviewed")).toBe("reviewed");
});

test("terminal OCR failure keeps archival pending until a reviewer supplies the invoice decision", () => {
  create(db, "unreadable");
  expect(db.claimNextJob("archive", policy, new Date(), ["archive_to_drive"])).toBeNull();
  const extractJob = db.claimNextJob("extract", policy, new Date(), ["extract"])!;
  db.markBillExtracting("unreadable");
  db.persistExtractionFailure({ billId: "unreadable", jobId: extractJob.id, leaseToken: extractJob.leaseToken, jobAttempt: extractJob.attempts,
    rawProviderResponse: null, providerModel: null, promptSchemaVersion: "1", requestedAt: now, completedAt: now, errorDetails: "unreadable", status: "needs_review" });
  db.failJob(extractJob.id, extractJob.leaseToken, "unreadable", policy, new Date(), false);
  expect(db.getInvoiceDedupOwner("unreadable")).toBeNull();
  expect(db.claimNextJob("archive", policy, new Date(), ["archive_to_drive"])).toBeNull();
  const bill = db.getBill("unreadable")!;
  expect(db.submitReview({ billId: bill.id, reviewerId: "qa", action: "approve", reason: null, note: null,
    expectedContentRevision: bill.contentRevision, expectedReviewRevision: bill.reviewRevision, corrected: extracted("REVIEW-1") }, [])).toBe(true);
  expect(db.claimNextJob("archive", policy, new Date(), ["archive_to_drive"])?.billId).toBe("unreadable");
});

test("manual approval cannot publish an interim identity while extraction can still finish", () => {
  create(db, "owner"); finish(db, "owner", extracted("WAIT-1"));
  create(db, "pending");
  db.sqlite.query("UPDATE bills SET status = 'needs_review', manual_review_required = 1 WHERE id = 'pending'").run();
  const bill = db.getBill("pending")!;
  expect(db.submitReview({ billId: bill.id, reviewerId: "qa", action: "approve", reason: null, note: null,
    expectedContentRevision: bill.contentRevision, expectedReviewRevision: bill.reviewRevision, corrected: extracted("DIFFERENT") }, [])).toBe(false);
  expect(db.getInvoiceDedupOwner("pending")).toBeNull();
  expect(db.claimNextJob("archive", policy, new Date(), ["archive_to_drive"])?.billId).toBe("owner");
  finish(db, "pending", extracted("WAIT-1"));
  expect(db.getInvoiceDedupOwner("pending")).toBe("owner");
  expect(db.getBill("pending")?.status).toBe("failed");
});

test("a ZIP delivery with the owner's invoice key retains a local audit record and suppresses archival", () => {
  create(db, "owner"); finish(db, "owner", extracted("ZIP-1"));
  const batch = db.createAdminUploadBatch({ idempotencyKey: "zip-1", originalFilename: "upload.zip" }).batch;
  const item = db.createAdminUploadBatchItem({ batchId: batch.id, itemIndex: 0, entryPath: "other.pdf" }).item;
  db.setAdminUploadBatchState(batch.id, "processing");
  const duplicate = db.createBillWithInitialJobs({ id: "zip", source: "admin_upload", sourceIdentity: "zip-1:0", sourceMessageId: "zip-1:0", sourceChatId: "admin-upload", sourceSenderId: "admin-upload", attachmentIndex: 0,
    receivedAt: now, mimeType: "application/pdf", originalPath: join(directory, "zip.pdf"), contentSha256: "b".repeat(64), batchItemId: item.id, extractionPolicy: "azure_only" },
  [{ type: "extract", idempotencyKey: "extract:zip" }, { type: "archive_to_drive", idempotencyKey: "archive:zip" }]).bill;
  finish(db, duplicate.id, extracted("ZIP-1", "2026-08-28", "Another", 999));
  expect(db.getAdminUploadBatchStatus(batch.id)).toMatchObject({ batch: { state: "completed" }, items: [{ state: "rejected", errorCode: "duplicate_invoice", billId: duplicate.id }] });
  expect(db.getInvoiceDedupOwner(duplicate.id)).toBe("owner");
  expect(db.listJobsForBill(duplicate.id).find((job) => job.type === "archive_to_drive")).toMatchObject({ state: "permanent_failure", lastError: "duplicate_invoice" });
  expect(db.listReviewBills({ batchId: batch.id })).toEqual([]);
  expect(db.listCanonicalOriginals().map((original) => original.id)).toContain(duplicate.id);
});

test("duplicate archival cannot be forced by operator replay or a stale claimed worker", async () => {
  create(db, "owner"); create(db, "duplicate");
  finish(db, "owner", extracted("D-1"));
  db.sqlite.query("UPDATE jobs SET state = 'succeeded' WHERE bill_id = 'owner' AND type = 'archive_to_drive'").run();
  let calls = 0;
  const drive: DriveAdapter = {
    findFolder: async () => { calls++; return null; }, createFolder: async () => { calls++; return { id: "folder" }; },
    findFilesByBillId: async () => { calls++; return []; }, uploadOriginal: async () => { calls++; throw new Error("duplicate uploaded"); },
  };
  // Simulate a claim obtained before the OCR decision; that lease must be revoked atomically.
  db.sqlite.query("INSERT INTO invoice_dedup_decisions (bill_id, owner_id, decided_at) VALUES (?, ?, ?)").run("duplicate", "duplicate", now);
  const claimed = db.claimNextJob("old-archive", policy, new Date(), ["archive_to_drive"]);
  expect(claimed?.billId).toBe("duplicate");
  db.sqlite.query("DELETE FROM invoice_dedup_decisions WHERE bill_id = ?").run("duplicate");
  finish(db, "duplicate", extracted("D-1"));
  const suppressed = db.getJob(claimed!.id)!;
  expect(suppressed).toMatchObject({ state: "permanent_failure", lastError: "duplicate_invoice", leaseToken: null });
  expect(db.getJobTransitions(claimed!.id).at(-1)).toMatchObject({ fromState: "running", toState: "permanent_failure", reason: "duplicate_invoice" });
  expect(db.renewLease(claimed!.id, claimed!.leaseToken, policy.leaseMs)).toBe(false);
  expect(db.persistDriveArchive({ billId: "duplicate", jobId: claimed!.id, leaseToken: claimed!.leaseToken, contentSha256: "a".repeat(64), fileId: "remote", webLink: "remote" })).toBe(false);
  expect(db.requeueJob(claimed!.id, true)).toBe(false);
  const handler = createDriveArchiveHandler(db, drive, { driveRootId: "root" });
  await expect(handler(claimed!, { idempotencyKey: claimed!.idempotencyKey, assertLease() {
    if (!db.renewLease(claimed!.id, claimed!.leaseToken, policy.leaseMs)) throw new Error("Job lease is no longer owned");
  }, assertCurrentApprovalRevision() {} })).rejects.toThrow();
  db.sqlite.query("UPDATE jobs SET state = 'pending' WHERE id = ?").run(claimed!.id);
  expect(db.claimNextJob("replayed", policy, new Date(), ["archive_to_drive"])).toBeNull();
  expect(await new JobWorker(db, { archive_to_drive: handler }, policy, "replayed", createLogger("error")).runOnce()).toBe(false);
  expect(calls).toBe(0);
  expect(db.getProjectionMetadata("drive", "duplicate")).toBeNull();
});

test("an in-flight archive lease is fenced before upload when OCR resolves to a duplicate", async () => {
  create(db, "owner"); create(db, "racing"); finish(db, "owner", extracted("RACE"));
  db.sqlite.query("UPDATE jobs SET state = 'succeeded' WHERE bill_id = 'owner' AND type = 'archive_to_drive'").run();
  db.sqlite.query("INSERT INTO invoice_dedup_decisions (bill_id, owner_id, decided_at) VALUES ('racing', 'racing', ?)").run(now);
  let release!: () => void; let started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let uploads = 0;
  const drive: DriveAdapter = {
    findFolder: async () => { throw new Error("folder mutation after duplicate"); },
    createFolder: async () => { throw new Error("folder mutation after duplicate"); },
    findFilesByBillId: async () => { started(); await waiting; return []; },
    uploadOriginal: async () => { uploads++; throw new Error("duplicate uploaded"); },
  };
  const worker = new JobWorker(db, { archive_to_drive: createDriveArchiveHandler(db, drive, { driveRootId: "root" }) }, policy, "in-flight", createLogger("error"));
  const running = worker.runOnce();
  await entered;
  db.sqlite.query("DELETE FROM invoice_dedup_decisions WHERE bill_id = 'racing'").run();
  finish(db, "racing", extracted("RACE"));
  release();
  expect(await running).toBe(true);
  expect(uploads).toBe(0);
  expect(db.getProjectionMetadata("drive", "racing")).toBeNull();
  expect(db.listJobsForBill("racing").find((job) => job.type === "archive_to_drive")).toMatchObject({ state: "permanent_failure", lastError: "duplicate_invoice" });
});

test("upgrade suppresses an already-decided duplicate's legacy pending archive with history", () => {
  create(db, "owner"); create(db, "duplicate");
  finish(db, "owner", extracted("OLD-JOB")); finish(db, "duplicate", extracted("OLD-JOB"));
  const archive = db.listJobsForBill("duplicate").find((job) => job.type === "archive_to_drive")!;
  db.sqlite.query("UPDATE jobs SET state = 'pending', last_error = NULL WHERE id = ?").run(archive.id);
  db.sqlite.query("DELETE FROM schema_migrations WHERE version = 22").run();
  db.close(); db = new BillDatabase(path);
  expect(db.getJob(archive.id)).toMatchObject({ state: "permanent_failure", lastError: "duplicate_invoice" });
  expect(db.getJobTransitions(archive.id).at(-1)).toMatchObject({ fromState: "pending", toState: "permanent_failure", reason: "duplicate_invoice" });
  expect(db.claimNextJob("worker", policy, new Date(), ["archive_to_drive"])?.billId).toBe("owner");
  expect(db.getBill("duplicate")).not.toBeNull();
});
