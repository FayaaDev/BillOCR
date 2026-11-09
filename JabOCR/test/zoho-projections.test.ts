import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase } from "../src/db/database";
import { loadConfig } from "../src/backend/config";
import type { ClaimedJob, ExtractedBill, JobHandlerContext } from "../src/backend/contracts";
import { createZohoAdapters, createWorkDriveArchiveHandler, createZohoSheetHandler, encodeRecord, readZohoCredential, zohoLedgerHeaders, type WorkDriveAdapter, type WorkDriveFile, type ZohoRecord, type ZohoSheetAdapter } from "../src/backend/zoho-projections";
import { BackgroundWorkerLoop, JobWorker, PermanentJobError } from "../src/backend/worker";
import { createLogger } from "../src/backend/logger";
import { startService } from "../src/backend/server";
import { runOps } from "../src/backend/ops";
import { ProviderCooldownError, RetryableExtractionError } from "../src/backend/extraction-errors";

const credential = JSON.stringify({ client_id: "client", client_secret: "secret", refresh_token: "refresh", token_uri: "https://accounts.zoho.sa/oauth/v2/token", api_domain: "https://www.zohoapis.sa" });
const config = { region: "sa" as const, workdriveFolderId: "folder", sheetResourceId: "workbook", sheetName: "Ledger" };
const policy = { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 };
const extraction: ExtractedBill = { schemaVersion: "1", vendorName: 'متجر "=SUM(A1)"', invoiceNumber: "000123", invoiceDate: "2026-01-01", currency: "SAR", subtotal: 100, vat: 15, total: 115, description: "=HYPERLINK(\"bad\")", fields: {} };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function cooldownClock(start = Date.parse("2026-01-01T00:00:00Z")) {
  const clock = spyOn(Date, "now").mockReturnValue(start);
  cleanups.push(() => { clock.mockRestore(); });
  return clock;
}
function context(database: BillDatabase, job: ClaimedJob): JobHandlerContext {
  return { idempotencyKey: job.idempotencyKey, assertLease() { if (!database.renewLease(job.id, job.leaseToken, policy.leaseMs)) throw new Error("lease lost"); }, assertCurrentApprovalRevision() {} };
}
function fixture(enabled = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jabocr-zoho-"))); const database = new BillDatabase(join(dir, "bills.sqlite")); database.zohoEnabled = enabled;
  cleanups.push(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });
  const bytes = Buffer.from("%PDF-1.4\noriginal\n"); const path = join(dir, "original.pdf"); writeFileSync(path, bytes);
  const bill = database.createBillWithInitialJobs({ classification: "invoice", sourceMessageId: "message", sourceChatId: "chat", sourceSenderId: "sender", attachmentIndex: 0, receivedAt: "2026-01-01T00:00:00Z", mimeType: "application/pdf", originalPath: path, contentSha256: createHash("sha256").update(bytes).digest("hex") }, [{ type: "extract", idempotencyKey: "extract" }]).bill;
  const job = database.claimNextJob("test", policy, new Date(), ["extract"])!;
  expect(database.persistExtractionSuccess({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: 1, normalized: extraction, rawProviderResponse: "{}", providerModel: "offline", promptSchemaVersion: "1", requestedAt: new Date().toISOString(), completedAt: new Date().toISOString() })).toBe(true);
  database.completeJob(job.id, job.leaseToken);
  const approve = () => { const bill = database.getBill(job.billId)!; expect(database.persistValidationDecision({ billId: bill.id, expectedContentRevision: bill.contentRevision, expectedReviewRevision: bill.reviewRevision, decision: "approved", issues: [] })).toBe(true); };
  const review = (action: "approve" | "reject", corrected = extraction) => {
    const current = database.getBill(bill.id)!;
    expect(database.submitReview({ billId: bill.id, reviewerId: "operator", action, corrected, expectedContentRevision: current.contentRevision, expectedReviewRevision: current.reviewRevision, reason: null, note: null }, [])).toBe(true);
  };
  const claim = (type: "archive_to_workdrive" | "sync_to_zoho_sheet") => database.claimNextJob("test", policy, new Date(), [type])!;
  return { database, dir, bytes, billId: bill.id, approve, review, claim };
}
function remote(bytes: Uint8Array) {
  const files: WorkDriveFile[] = []; let uploads = 0; let adds = 0; let updates = 0; const records: ZohoRecord[] = [];
  const workdrive: WorkDriveAdapter = {
    async list(_folder, offset) { return files.slice(offset, offset + 50).map(({ id, name }) => ({ id, name })); },
    async metadata(id) { return files.find((file) => file.id === id)!; }, async download() { return bytes; },
    async uploadOnce(input) { uploads++; files.push({ id: "file", name: input.name, parentId: input.folderId, size: bytes.byteLength, permalink: "https://workdrive.zoho.sa/file/file" }); return "file"; },
  };
  const sheet: ZohoSheetAdapter = { async initializeLedger() {}, async find(id) { return records.filter((row) => row["Bill ID"] === id).map((row) => ({ ...row })); }, async addOnce(record) { adds++; records.push({ ...record }); }, async update(id, revision, record) { updates++; const rows = records.filter((row) => row["Bill ID"] === id && row.Revision === revision); for (const row of rows) Object.assign(row, record); return rows.length; } };
  return { files, records, workdrive, sheet, counts: () => ({ uploads, adds, updates }) };
}
async function archive(f: ReturnType<typeof fixture>, r: ReturnType<typeof remote>) {
  const job = f.claim("archive_to_workdrive"); await createWorkDriveArchiveHandler(f.database, r.workdrive, { ...config, originalsRoot: f.dir })(job, context(f.database, job)); f.database.completeJob(job.id, job.leaseToken); return job;
}
async function project(f: ReturnType<typeof fixture>, r: ReturnType<typeof remote>) {
  const job = f.claim("sync_to_zoho_sheet"); await createZohoSheetHandler(f.database, r.sheet, config)(job, context(f.database, job)); f.database.completeJob(job.id, job.leaseToken); return job;
}

test("fresh approvals alone enroll, independent of Google; historical approved corrections do not backfill", () => {
  const f = fixture(false); f.approve(); expect(f.database.isZohoEnrolled(f.billId)).toBe(false);
  f.database.zohoEnabled = true; f.review("approve"); expect(f.database.isZohoEnrolled(f.billId)).toBe(false);
  f.review("reject"); f.review("approve"); expect(f.database.isZohoEnrolled(f.billId)).toBe(false);
  expect(f.database.listJobsForBill(f.billId).filter((job) => job.type.includes("zoho") || job.type === "archive_to_workdrive")).toHaveLength(0);
  const fresh = fixture(); fresh.approve(); expect(fresh.database.isZohoEnrolled(fresh.billId)).toBe(true);
  expect(fresh.database.getProjectionMetadata("drive", fresh.billId)).toBeNull();
});

test("explicit backfill uses latest approval without changing Google or invoices; repeat/reopen preserves failed jobs and intents", () => {
  const f = fixture(false); f.approve(); f.review("approve", { ...extraction, total: 230 });
  expect(() => f.database.backfillZohoApprovals()).toThrow("enabled");
  const bill = f.database.getBill(f.billId); const google = f.database.listJobsForBill(f.billId);
  const transitions = google.map((job) => f.database.getJobTransitions(job.id));
  f.database.zohoEnabled = true;
  expect(f.database.backfillZohoApprovals()).toEqual({ enrolled: 1 });
  expect(f.database.getBill(f.billId)).toEqual(bill);
  expect(google.map((job) => f.database.getJob(job.id))).toEqual(google);
  expect(google.map((job) => f.database.getJobTransitions(job.id))).toEqual(transitions);
  const jobs = f.database.listJobsForBill(f.billId).filter((job) => job.type === "archive_to_workdrive" || job.type === "sync_to_zoho_sheet");
  expect(jobs).toHaveLength(2);
  expect(jobs.every((job) => job.expectedRevision === bill!.contentRevision)).toBe(true);
  expect(jobs.every((job) => f.database.getJobTransitions(job.id).length === 1)).toBe(true);
  const upload = f.claim("archive_to_workdrive");
  f.database.beginZohoMutation(upload, "upload", { folderId: "folder" }, bill!.contentRevision, "approved");
  f.database.failJob(upload.id, upload.leaseToken, "ambiguous", { ...policy, maxAttempts: 1 });
  const before = f.database.listJobsForBill(f.billId); const intent = f.database.getZohoIntent(f.billId, "upload");
  expect(f.database.backfillZohoApprovals()).toEqual({ enrolled: 0 });
  const reopened = new BillDatabase(join(f.dir, "bills.sqlite"));
  try {
    reopened.zohoEnabled = true;
    expect(reopened.backfillZohoApprovals()).toEqual({ enrolled: 0 });
    expect(reopened.listJobsForBill(f.billId)).toEqual(before);
    expect(reopened.getZohoIntent(f.billId, "upload")).toEqual(intent);
  } finally { reopened.close(); }
});

test("backfill skips nonapproved, noninvoice, undecided, duplicate and deleting invoices", () => {
  for (const mode of ["nonapproved", "noninvoice", "unclassified", "undecided", "duplicate", "legacy-duplicate", "deleting", "missing-data"]) {
    const f = fixture(false); f.approve(); f.database.zohoEnabled = true;
    if (mode === "nonapproved") f.review("reject");
    if (mode === "noninvoice" || mode === "unclassified") f.database.sqlite.query("UPDATE bills SET classification = ? WHERE id = ?").run(mode === "noninvoice" ? "not_invoice" : "unclassified", f.billId);
    if (mode === "undecided") f.database.sqlite.query("DELETE FROM invoice_dedup_decisions WHERE bill_id = ?").run(f.billId);
    if (mode === "duplicate" || mode === "legacy-duplicate") {
      const owner = f.database.createBillWithInitialJobs({ sourceMessageId: "owner", sourceChatId: "chat", sourceSenderId: "sender", attachmentIndex: 0, receivedAt: "2026-01-01T00:00:00Z", mimeType: "application/pdf", originalPath: join(f.dir, "owner.pdf"), contentSha256: "a".repeat(64) }, []).bill;
      f.database.sqlite.query("UPDATE invoice_dedup_decisions SET owner_id = ? WHERE bill_id = ?").run(owner.id, f.billId);
      if (mode === "legacy-duplicate") f.database.sqlite.query("UPDATE bills SET invoice_dedup_required = 0 WHERE id = ?").run(f.billId);
    }
    if (mode === "deleting") {
      const bill = f.database.getBill(f.billId)!;
      expect(f.database.prepareBillDeletion({ billId: bill.id, expectedContentRevision: bill.contentRevision, expectedReviewRevision: bill.reviewRevision })).toEqual({ prepared: true });
    }
    if (mode === "missing-data") f.database.sqlite.query("UPDATE extractions SET normalized_json = NULL WHERE bill_id = ?").run(f.billId);
    expect(f.database.backfillZohoApprovals()).toEqual({ enrolled: 0 });
    expect(f.database.isZohoEnrolled(f.billId)).toBe(false);
    expect(f.database.sqlite.query("SELECT 1 FROM zoho_historical_approvals WHERE bill_id = ?").get(f.billId)).not.toBeNull();
  }
});

test("backfill rolls enrollment, exclusion removal, jobs and transitions back together", () => {
  const f = fixture(false); f.approve(); f.database.zohoEnabled = true;
  const jobs = f.database.listJobsForBill(f.billId);
  const transitions = f.database.sqlite.query("SELECT * FROM job_transition_history ORDER BY rowid").all();
  f.database.sqlite.exec(`CREATE TRIGGER fail_backfill BEFORE INSERT ON jobs WHEN NEW.type = 'sync_to_zoho_sheet'
    BEGIN SELECT RAISE(ABORT, 'offline failure'); END`);
  expect(() => f.database.backfillZohoApprovals()).toThrow("offline failure");
  expect(f.database.isZohoEnrolled(f.billId)).toBe(false);
  expect(f.database.sqlite.query("SELECT 1 FROM zoho_historical_approvals WHERE bill_id = ?").get(f.billId)).not.toBeNull();
  expect(f.database.listJobsForBill(f.billId)).toEqual(jobs);
  expect(f.database.sqlite.query("SELECT * FROM job_transition_history ORDER BY rowid").all()).toEqual(transitions);
});

test("backfill-zoho ops requires enabled configuration and rejects arguments", async () => {
  const f = fixture(false); f.approve();
  const app = loadConfig({ APP_DATA_DIR: f.dir, WHATSAPP_AUTH_PATH: join(f.dir, "auth"), MISTRAL_ENABLED: "false", AZURE_ENABLED: "true", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://offline.example", AZURE_DOCUMENT_INTELLIGENCE_API_KEY: "offline", REVIEW_USERNAME: "offline", REVIEW_PASSWORD: "offline" });
  const output: string[] = []; const dependencies = { config: { ...app, databasePath: join(f.dir, "bills.sqlite") }, output: (line: string) => { output.push(line); } };
  await expect(runOps(["backfill-zoho"], dependencies)).rejects.toThrow("enabled");
  dependencies.config.zoho.enabled = true;
  await expect(runOps(["backfill-zoho", "--unknown"], dependencies)).rejects.toThrow("Usage");
  await expect(runOps(["unknown-command"], dependencies)).rejects.toThrow("Usage");
  expect(f.database.isZohoEnrolled(f.billId)).toBe(false);
  await runOps(["backfill-zoho"], dependencies); await runOps(["backfill-zoho"], dependencies);
  expect(output.map((line) => JSON.parse(line))).toEqual([{ enrolled: 1 }, { enrolled: 0 }]);
});

test("verified archive precedes Sheet; corrections update same row and rejection retains original and archive", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve();
  const pending = f.claim("sync_to_zoho_sheet");
  await expect(createZohoSheetHandler(f.database, r.sheet, config)(pending, context(f.database, pending))).rejects.toThrow();
  f.database.failJob(pending.id, pending.leaseToken, "archive pending", policy);
  await archive(f, r); await new Promise((resolve) => setTimeout(resolve, 3)); await project(f, r);
  f.review("approve", { ...extraction, total: 230 }); await project(f, r);
  f.review("reject"); await project(f, r);
  expect(r.records).toHaveLength(1); expect(r.records[0]!.Status).toBe("Rejected"); expect(r.records[0]!.Revision).toBe(f.database.getBill(f.billId)!.contentRevision);
  expect(r.counts()).toEqual({ uploads: 1, adds: 1, updates: 2 });
  expect(f.database.getProjectionMetadata("workdrive", f.billId)!.externalUrl).toBe("https://workdrive.zoho.sa/file/file");
  expect(await Bun.file(join(f.dir, "original.pdf")).bytes()).toEqual(f.bytes);
});

test("Sheet archive waits outlast the retry budget and then project successfully", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve();
  const job = f.database.listJobsForBill(f.billId).find((job) => job.type === "sync_to_zoho_sheet")!;
  const worker = new JobWorker(f.database, { sync_to_zoho_sheet: createZohoSheetHandler(f.database, r.sheet, config) }, policy, "test", createLogger("error", () => {}));
  for (let wait = 0; wait < policy.maxAttempts + 2; wait++) {
    f.database.sqlite.query("UPDATE jobs SET available_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(job.id);
    const before = Date.now();
    expect(await worker.runOnce()).toBe(true);
    expect(f.database.getJob(job.id)).toMatchObject({ state: "pending", attempts: 0, leaseToken: null });
    expect(Date.parse(f.database.getJob(job.id)!.availableAt)).toBeGreaterThanOrEqual(before + 60_000);
    expect(await worker.runOnce()).toBe(false);
    expect(f.database.getZohoIntent(f.billId, "append")).toBeNull();
    expect(r.counts().adds).toBe(0);
  }
  await archive(f, r);
  f.database.sqlite.query("UPDATE jobs SET available_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(job.id);
  expect(await worker.runOnce()).toBe(true);
  expect(f.database.getJob(job.id)).toMatchObject({ state: "succeeded", attempts: 1 });
  expect(r.counts()).toEqual({ uploads: 1, adds: 1, updates: 0 });
  expect(f.database.getProjectionMetadata("zoho_sheet", f.billId)).not.toBeNull();
});

test("Sheet missing extraction remains a bounded failure rather than an archive wait", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve();
  const missing = spyOn(f.database, "getEffectiveExtraction").mockReturnValue(null);
  cleanups.push(() => { missing.mockRestore(); });
  const job = f.database.listJobsForBill(f.billId).find((job) => job.type === "sync_to_zoho_sheet")!;
  const worker = new JobWorker(f.database, { sync_to_zoho_sheet: createZohoSheetHandler(f.database, r.sheet, config) }, policy, "test", createLogger("error", () => {}));
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    f.database.sqlite.query("UPDATE jobs SET available_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(job.id);
    expect(await worker.runOnce()).toBe(true);
    expect(f.database.getJob(job.id)).toMatchObject({ state: attempt === policy.maxAttempts ? "permanent_failure" : "retryable_failure", attempts: attempt });
  }
  expect(f.database.getZohoIntent(f.billId, "append")).toBeNull();
  expect(r.counts().adds).toBe(0);
});

test("lost upload response and timestamp rename reconcile bytes; no second upload on replay", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve();
  const upload = r.workdrive.uploadOnce;
  r.workdrive.uploadOnce = async (input) => { await upload(input); r.files[0]!.name = `${input.name}-timestamp`; throw new Error("private raw provider body"); };
  const job = f.claim("archive_to_workdrive"); const handler = createWorkDriveArchiveHandler(f.database, r.workdrive, { ...config, originalsRoot: f.dir });
  await expect(handler(job, context(f.database, job))).rejects.toThrow("Zoho temporary");
  await handler(job, context(f.database, job)); expect(r.counts().uploads).toBe(1);
  expect(f.database.getProjectionMetadata("workdrive", f.billId)!.externalId).toBe("file");
});

test("crash before upload send remains unresolved across reopen and operator retry", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve(); const job = f.claim("archive_to_workdrive");
  const bill = f.database.getBill(f.billId)!;
  expect(f.database.beginZohoMutation(job, "upload", { folderId: "folder", name: `${bill.id}-${bill.contentSha256}.pdf`, hash: bill.contentSha256, size: f.bytes.byteLength }, bill.contentRevision, bill.status)).toBe(true);
  f.database.failJob(job.id, job.leaseToken, "crash", { ...policy, maxAttempts: 1 });
  expect(f.database.requeueJob(job.id, true)).toBe(true);
  const replay = f.claim("archive_to_workdrive");
  await expect(createWorkDriveArchiveHandler(f.database, r.workdrive, { ...config, originalsRoot: f.dir })(replay, context(f.database, replay))).rejects.toThrow();
  const reopened = new BillDatabase(join(f.dir, "bills.sqlite"));
  try { expect(reopened.getZohoIntent(f.billId, "upload")).not.toBeNull(); } finally { reopened.close(); }
  expect(r.counts().uploads).toBe(0);
});

test("checksum conflicts, duplicate candidates and changed destination fail closed", async () => {
  for (const mode of ["hash", "duplicates", "destination"]) {
    const f = fixture(); const r = remote(f.bytes); f.approve(); const job = f.claim("archive_to_workdrive"); const bill = f.database.getBill(f.billId)!;
    r.files.push({ id: "file", name: `${bill.id}-${bill.contentSha256}.pdf`, parentId: "folder", size: f.bytes.byteLength, permalink: "https://workdrive.zoho.sa/file/file" });
    if (mode === "hash") r.workdrive.download = async () => Buffer.alloc(f.bytes.byteLength);
    if (mode === "duplicates") r.files.push({ ...r.files[0]!, id: "other" });
    if (mode === "destination") f.database.beginZohoMutation(job, "upload", { folderId: "old" }, bill.contentRevision, bill.status);
    await expect(createWorkDriveArchiveHandler(f.database, r.workdrive, { ...config, originalsRoot: f.dir })(job, context(f.database, job))).rejects.toBeInstanceOf(PermanentJobError);
    expect(r.counts().uploads).toBe(0); expect(f.database.getProjectionMetadata("workdrive", f.billId)).toBeNull();
  }
});

test("ambiguous append never re-adds when absent, and reconciles visible success", async () => {
  for (const committed of [true, false]) {
    const f = fixture(); const r = remote(f.bytes); f.approve(); await archive(f, r);
    const add = r.sheet.addOnce; let calls = 0;
    r.sheet.addOnce = async (record) => { calls++; if (committed) await add(record); throw new Error("timeout"); };
    const job = f.claim("sync_to_zoho_sheet"); const handler = createZohoSheetHandler(f.database, r.sheet, config);
    await expect(handler(job, context(f.database, job))).rejects.toThrow();
    if (committed) await handler(job, context(f.database, job)); else await expect(handler(job, context(f.database, job))).rejects.toThrow();
    expect(calls).toBe(1); expect(f.database.listJobsForBill(f.billId).filter((job) => job.idempotencyKey.startsWith("zoho-repair"))).toHaveLength(0);
  }
});

test("rejection races an append; old job repairs latest canonical tombstone", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve(); await archive(f, r);
  const add = r.sheet.addOnce;
  r.sheet.addOnce = async (record) => { await add(record); f.review("reject"); };
  const job = f.claim("sync_to_zoho_sheet");
  await expect(createZohoSheetHandler(f.database, r.sheet, config)(job, context(f.database, job))).rejects.toThrow();
  expect(f.database.getProjectionMetadata("zoho_sheet", f.billId)).toBeNull();
  const repair = f.claim("sync_to_zoho_sheet"); await createZohoSheetHandler(f.database, r.sheet, config)(repair, context(f.database, repair));
  expect(r.records[0]!.Status).toBe("Rejected"); expect(r.counts().adds).toBe(1);
  expect(f.database.listJobsForBill(f.billId).some((job) => job.idempotencyKey.startsWith("zoho-repair:"))).toBe(true);
});

test("expired lease after stale update cannot persist and produces repair even if new revision already ran", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve(); await archive(f, r); await project(f, r); f.review("approve", { ...extraction, total: 200 });
  const old = f.claim("sync_to_zoho_sheet"); const update = r.sheet.update;
  r.sheet.update = async (id, revision, record) => {
    const captured = r.records.filter((row) => row["Bill ID"] === id && row.Revision === revision);
    f.database.sqlite.query("UPDATE jobs SET lease_expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00Z", old.id);
    f.review("reject");
    r.sheet.update = update;
    const newer = f.claim("sync_to_zoho_sheet"); await createZohoSheetHandler(f.database, r.sheet, config)(newer, context(f.database, newer)); f.database.completeJob(newer.id, newer.leaseToken);
    // Model a provider evaluating criteria before blocking: no atomic CAS is promised.
    for (const row of captured) Object.assign(row, record);
    return captured.length;
  };
  await expect(createZohoSheetHandler(f.database, r.sheet, config)(old, context(f.database, old))).rejects.toThrow();
  expect(JSON.parse(f.database.getProjectionMetadata("zoho_sheet", f.billId)!.metadata!).revision).toBe(3);
  expect(r.records[0]!.Revision).toBe(2);
  expect(f.database.listJobsForBill(f.billId).some((job) => job.idempotencyKey.startsWith("zoho-repair"))).toBe(true);
  r.sheet.update = update; const repair = f.claim("sync_to_zoho_sheet"); await createZohoSheetHandler(f.database, r.sheet, config)(repair, context(f.database, repair)); expect(r.records[0]!.Status).toBe("Rejected");
});

test("higher remote revision and duplicate Bill ID rows are never overwritten", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve(); await archive(f, r); await project(f, r); f.review("approve");
  const job = f.claim("sync_to_zoho_sheet"); r.records[0]!.Revision = 100;
  await expect(createZohoSheetHandler(f.database, r.sheet, config)(job, context(f.database, job))).rejects.toBeInstanceOf(PermanentJobError);
  r.records.push({ ...r.records[0]! });
  await expect(createZohoSheetHandler(f.database, r.sheet, config)(job, context(f.database, job))).rejects.toBeInstanceOf(PermanentJobError); expect(r.counts().updates).toBe(0);
});

test("Saudi configuration defaults disabled; endpoints and credentials reject foreign regions", () => {
  const env = { APP_DATA_DIR: "/tmp/offline", WHATSAPP_AUTH_PATH: "/tmp/offline/auth", MISTRAL_ENABLED: "false", AZURE_ENABLED: "true", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://offline.example", AZURE_DOCUMENT_INTELLIGENCE_API_KEY: "offline", REVIEW_USERNAME: "offline", REVIEW_PASSWORD: "offline" };
  expect(loadConfig(env).zoho?.enabled).toBe(false);
  expect(loadConfig(env).zoho.region).toBe("sa");
  expect(loadConfig({ ...env, ZOHO_REGION: "us" }).zoho.region).toBe("us");
  expect(() => loadConfig({ ...env, ZOHO_REGION: "com" })).toThrow("sa");
  expect(() => loadConfig({ ...env, ZOHO_ENABLED: "true" })).toThrow("ZOHO_WORKDRIVE_FOLDER_ID");
  const enabled = loadConfig({ ...env, ZOHO_ENABLED: "true", ZOHO_WORKDRIVE_FOLDER_ID: "folder", ZOHO_SHEET_RESOURCE_ID: "book" });
  expect(enabled.zoho?.credentialJson).toBe("/run/secrets/zoho-authorized-user.json"); expect(enabled.google.enabled).toBe(false);
  expect(() => readZohoCredential(credential.replace("accounts.zoho.sa", "evil.example"))).toThrow("Saudi");
});

test("fixed Saudi and US profiles route refresh, WorkDrive and Sheet requests without redirects", async () => {
  for (const [region, suffix] of [["sa", "sa"], ["us", "com"]] as const) {
    const regionalCredential = credential.replaceAll(".sa", `.${suffix}`); const calls: string[] = [];
    const link = `https://workdrive.zoho.${suffix}/file/file`;
    const record = { "Bill ID": "bill", Revision: 2, "WorkDrive hyperlink": link };
    const adapters = createZohoAdapters(regionalCredential, { ...config, region }, async (input, init) => {
      const url = String(input); calls.push(url); expect(init?.redirect).toBe("error");
      if (url.includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600, api_domain: `https://www.zohoapis.${suffix}` });
      expect(new Headers(init?.headers).get("Authorization")).toBe("Zoho-oauthtoken token");
      if (url.includes("/download/")) return new Response("original");
      if (url.endsWith("/upload")) return Response.json({ data: [{ id: "file" }] });
      if (url.includes("/workdrive/api/")) return Response.json({ data: url.includes("?") ? [] : { id: "file", attributes: { name: "x.pdf", parent_id: "folder", is_folder: false, storage_info: { size_in_bytes: 8 }, permalink: link } } });
      const form = init!.body as URLSearchParams; const method = form.get("method");
      if (method === "worksheet.records.add") expect(JSON.parse(form.get("json_data")!)).toEqual([encodeRecord(record, region)]);
      if (method === "worksheet.records.update") expect(JSON.parse(form.get("data")!)).toEqual(encodeRecord(record, region));
      return Response.json({ method, status: "success", records: [], no_of_affected_rows: 1, used_row: 1, used_column: 15, range_details: [{ row_index: 1, row_details: zohoLedgerHeaders.map((content, index) => ({ content, column_index: index + 1 })) }] });
    });
    expect(readZohoCredential(regionalCredential, region).api_domain).toBe(`https://www.zohoapis.${suffix}`);
    expect(await adapters.workdrive.list("folder", 0)).toEqual([]);
    expect((await adapters.workdrive.metadata("file")).permalink).toBe(link);
    expect(await adapters.workdrive.download("file", 8)).toEqual(Buffer.from("original"));
    expect(await adapters.workdrive.uploadOnce({ folderId: "folder", name: "x.pdf", mimeType: "application/pdf", bytes: Buffer.from("original") })).toBe("file");
    await adapters.sheet.initializeLedger(); await adapters.sheet.find("bill"); await adapters.sheet.addOnce(record); await adapters.sheet.update("bill", 1, record);
    expect(calls).toEqual([
      `https://accounts.zoho.${suffix}/oauth/v2/token`,
      `https://www.zohoapis.${suffix}/workdrive/api/v1/files/folder/files?filter%5Btype%5D=allfiles&page%5Boffset%5D=0&page%5Blimit%5D=50&sort=name`,
      `https://www.zohoapis.${suffix}/workdrive/api/v1/files/file`,
      region === "us" ? "https://download.zoho.com/v1/workdrive/download/file" : "https://files.zoho.sa/v1/workdrive/download/file",
      `https://www.zohoapis.${suffix}/workdrive/api/v1/upload`,
      ...Array(4).fill(`https://sheet.zoho.${suffix}/api/v2/workbook`),
    ]);
  }
});

test("regions reject mismatched credentials, refresh domains and permalinks", async () => {
  let calls = 0;
  const noFetch = async () => { calls++; throw new Error("must not fetch"); };
  for (const region of ["sa", "us"] as const) {
    const suffix = region === "sa" ? "sa" : "com"; const other = region === "sa" ? "com" : "sa";
    const regionalCredential = credential.replaceAll(".sa", `.${suffix}`);
    const foreignCredential = credential.replaceAll(".sa", `.${other}`);
    expect(() => readZohoCredential(foreignCredential, region)).toThrow("OAuth credential");
    expect(() => createZohoAdapters(foreignCredential, { ...config, region }, noFetch)).toThrow("OAuth credential");
    for (const field of ["token_uri", "api_domain"]) {
      const mixed = { ...JSON.parse(regionalCredential), [field]: JSON.parse(foreignCredential)[field] };
      expect(() => readZohoCredential(JSON.stringify(mixed), region)).toThrow("OAuth credential");
    }
    expect(() => encodeRecord({ "WorkDrive hyperlink": `https://workdrive.zoho.${other}/file/file` }, region)).toThrow("permalink");
    const adapters = createZohoAdapters(regionalCredential, { ...config, region }, async (input) => String(input).includes("/oauth/") ? Response.json({ access_token: "token", expires_in: 3600 }) : Response.json({ data: { id: "file", attributes: { name: "x", parent_id: "folder", is_folder: false, storage_info: { size_in_bytes: 1 }, permalink: `https://workdrive.zoho.${other}/file/file` } } }));
    await expect(adapters.workdrive.metadata("file")).rejects.toThrow("permalink");
    const badRefresh = createZohoAdapters(regionalCredential, { ...config, region }, async () => Response.json({ access_token: "token", expires_in: 3600, api_domain: `https://www.zohoapis.${other}` }));
    await expect(badRefresh.workdrive.list("folder", 0)).rejects.toThrow("refresh rejected");
  }
  expect(() => createZohoAdapters(credential, { ...config, region: "eu" as "sa" }, noFetch)).toThrow("unsupported region");
  expect(calls).toBe(0);
});

test("US handlers archive and project matching links, rejecting persisted cross-region links", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve();
  const usConfig = { ...config, region: "us" as const }; const upload = r.workdrive.uploadOnce;
  r.workdrive.uploadOnce = async (input) => { const id = await upload(input); r.files[0]!.permalink = "https://workdrive.zoho.com/file/file"; return id; };
  const job = f.claim("archive_to_workdrive"); const handler = createWorkDriveArchiveHandler(f.database, r.workdrive, { ...usConfig, originalsRoot: f.dir });
  await handler(job, context(f.database, job)); await handler(job, context(f.database, job));
  await expect(createWorkDriveArchiveHandler(f.database, r.workdrive, config)(job, context(f.database, job))).rejects.toThrow("permalink");
  f.database.completeJob(job.id, job.leaseToken);
  const sheetJob = f.claim("sync_to_zoho_sheet");
  await expect(createZohoSheetHandler(f.database, r.sheet, config)(sheetJob, context(f.database, sheetJob))).rejects.toThrow("permalink");
  await createZohoSheetHandler(f.database, r.sheet, usConfig)(sheetJob, context(f.database, sheetJob));
  expect(r.records[0]!["WorkDrive hyperlink"]).toBe("https://workdrive.zoho.com/file/file");
});

test("refresh caches tokens, one read auth retry, mutations never transparently retry", async () => {
  let tokens = 0; let lists = 0; let uploads = 0;
  const adapters = createZohoAdapters(credential, config, async (input, init) => {
    const url = String(input); expect(init?.redirect).toBe("error");
    if (url.includes("/oauth/")) { tokens++; return Response.json({ access_token: `token${tokens}`, expires_in: 3600 }); }
    if (url.endsWith("/upload")) { uploads++; return new Response(null, { status: 401 }); }
    lists++; if (lists === 1) return new Response(null, { status: 401 });
    return Response.json({ data: [] });
  });
  await adapters.workdrive.list("folder", 0); await adapters.workdrive.list("folder", 50);
  expect(tokens).toBe(2); expect(lists).toBe(3);
  await expect(adapters.workdrive.uploadOnce({ folderId: "folder", name: "safe.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-") })).rejects.toThrow("401"); expect(uploads).toBe(1);
});

test("bounded malformed responses, stalled body timeout and unexpected permalink are rejected", async () => {
  for (const response of [() => new Response("x".repeat(1000)), () => Response.json({ data: [{ id: {}, attributes: { name: "x" } }] }), () => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("{")); } }))]) {
    const adapters = createZohoAdapters(credential, { ...config, maxResponseBytes: 100, requestTimeoutMs: 15 }, async (input) => String(input).includes("/oauth/") ? Response.json({ access_token: "token", expires_in: 3600 }) : response());
    await expect(adapters.workdrive.list("folder", 0)).rejects.toThrow();
  }
  const adapters = createZohoAdapters(credential, config, async (input) => String(input).includes("/oauth/") ? Response.json({ access_token: "token", expires_in: 3600 }) : Response.json({ data: { id: "file", attributes: { name: "x", parent_id: "folder", is_folder: false, storage_info: { size_in_bytes: 1 }, permalink: "https://evil.example/file" } } }));
  await expect(adapters.workdrive.metadata("file")).rejects.toThrow("permalink");
});

test("Sheet initializes empty headers without destructive changes; existing mismatches fail", async () => {
  let written = false; const methods: string[] = [];
  const adapters = createZohoAdapters(credential, config, async (input, init) => {
    if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
    const form = init!.body as URLSearchParams; const method = form.get("method")!; methods.push(method);
    if (method === "row.content.set") { expect(JSON.parse(form.get("data_array")!)).toEqual(zohoLedgerHeaders); written = true; return Response.json({ status: "success", method }); }
    return Response.json({ status: "success", method, used_row: written ? 1 : 0, used_column: written ? 15 : 0, range_details: written ? [{ row_index: 1, row_details: zohoLedgerHeaders.map((content, index) => ({ content, column_index: index + 1 })) }] : [] });
  });
  await adapters.sheet.initializeLedger(); expect(methods).toEqual(["worksheet.content.get", "row.content.set", "worksheet.content.get"]);
  const mismatch = createZohoAdapters(credential, config, async (input, init) => String(input).includes("/oauth/") ? Response.json({ access_token: "token", expires_in: 3600 }) : Response.json({ status: "success", method: (init!.body as URLSearchParams).get("method"), used_row: 2, used_column: 1, range_details: [{ row_index: 1, row_details: [{ column_index: 1, content: "Customer data" }] }] }));
  await expect(mismatch.sheet.initializeLedger()).rejects.toBeInstanceOf(PermanentJobError);
});

test("Sheet confirms Saudi empty 1x1 sentinel before initializing headers", async () => {
  let written = false; const methods: string[] = [];
  const adapters = createZohoAdapters(credential, config, async (input, init) => {
    if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
    const form = init!.body as URLSearchParams; const method = form.get("method")!; methods.push(method);
    if (method === "cell.content.get") { expect(form.get("row")).toBe("1"); expect(form.get("column")).toBe("1"); return Response.json({ method, status: "success", row_index: 1, columnIndex: 1, content: "" }); }
    if (method === "row.content.set") { expect(JSON.parse(form.get("data_array")!)).toEqual(zohoLedgerHeaders); written = true; return Response.json({ method, status: "success" }); }
    expect(form.get("visible_rows_only")).toBe("false"); expect(form.get("visible_columns_only")).toBe("false");
    return Response.json({ method, status: "success", used_row: 1, used_column: written ? 15 : 1, range_details: written ? [{ row_index: 1, row_details: zohoLedgerHeaders.map((content, index) => ({ column_index: index + 1, content })) }] : [] });
  });
  await adapters.sheet.initializeLedger();
  expect(methods).toEqual(["worksheet.content.get", "cell.content.get", "row.content.set", "worksheet.content.get"]);
});

test("Sheet occupied sentinel and malformed blank evidence preserve existing cells without writes", async () => {
  const empty = { method: "worksheet.content.get", status: "success", used_row: 1, used_column: 1, range_details: [] };
  const cell = { method: "cell.content.get", status: "success", row_index: 1, columnIndex: 1, content: "" };
  const cases = [
    { header: empty, cell: { ...cell, content: "Existing data" } },
    { header: empty, cell: { ...cell, formula: '=IF(TRUE,"","")' } },
    { header: empty, cell: { ...cell, value: "" } },
    { header: empty, cell: { ...cell, content: 0 } },
    { header: empty, cell: { ...cell, content: null } },
    { header: empty, cell: { ...cell, content: undefined } },
    { header: empty, cell: { ...cell, row_index: 2 } },
    { header: empty, cell: { ...cell, columnIndex: "1" } },
    { header: empty, cell: { ...cell, method: "worksheet.content.get" } },
    { header: { ...empty, used_row: 2 }, cell },
    { header: { ...empty, used_column: 2 }, cell },
    { header: { ...empty, used_row: "1" }, cell },
    { header: { ...empty, range_details: null }, cell },
    { header: { ...empty, formula: "" }, cell },
    { header: { ...empty, range_details: [{ row_index: 1, row_details: [{ column_index: 1, content: "" }] }] }, cell },
    { header: { ...empty, range_details: [{ row_index: 1, row_details: [{ column_index: 1, content: "", formula: '=IF(TRUE,"","")' }] }] }, cell },
    { header: { ...empty, range_details: [{ row_index: 1, row_details: [{ column_index: 1, content: "Existing data" }] }] }, cell },
  ];
  for (const evidence of cases) {
    let writes = 0;
    const adapters = createZohoAdapters(credential, config, async (input, init) => {
      if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
      const method = (init!.body as URLSearchParams).get("method");
      if (method === "worksheet.content.get") return Response.json(evidence.header);
      if (method === "cell.content.get") return Response.json(evidence.cell);
      writes++; return Response.json({ method, status: "success" });
    });
    await expect(adapters.sheet.initializeLedger()).rejects.toThrow(); expect(writes).toBe(0);
  }
});

test("Sheet form payloads quote literal OCR strings and update uses Bill ID plus observed revision", async () => {
  const record = Object.fromEntries(zohoLedgerHeaders.map((header) => [header, ""])) as ZohoRecord;
  Object.assign(record, { "Bill ID": "bill-123", Revision: 2, Status: "Approved", Vendor: '=HYPERLINK("evil")', "Invoice number": "000123", Description: "العربية\n'quote", "WorkDrive hyperlink": "https://workdrive.zoho.sa/file/file" });
  const methods: string[] = [];
  const adapters = createZohoAdapters(credential, config, async (input, init) => {
    if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
    const form = init!.body as URLSearchParams; const method = form.get("method")!; methods.push(method);
    if (method === "worksheet.records.fetch") { expect(form.get("criteria")).toBe('"Bill ID"="bill-123"'); expect(form.get("render_option")).toBe("unformatted"); return Response.json({ method, status: "success", records: [record] }); }
    if (method === "worksheet.records.add") expect(JSON.parse(form.get("json_data")!)[0]).toEqual(encodeRecord(record));
    if (method === "worksheet.records.update") { expect(form.get("criteria")).toBe('"Bill ID"="bill-123" and "Revision"=1'); expect(form.has("json_data")).toBe(false); }
    return Response.json({ method, status: "success", no_of_affected_rows: 1 });
  });
  expect(encodeRecord(record).Vendor).toBe('="=HYPERLINK(""evil"")"');
  expect(encodeRecord(record)["Invoice number"]).toBe('="000123"');
  expect(encodeRecord(record)["WorkDrive hyperlink"]).toBe('=HYPERLINK("https://workdrive.zoho.sa/file/file","https://workdrive.zoho.sa/file/file")');
  await adapters.sheet.addOnce(record); expect(await adapters.sheet.update("bill-123", 1, record)).toBe(1); expect(await adapters.sheet.find("bill-123")).toEqual([record]);
  await expect(adapters.sheet.find('bad" or true')).rejects.toThrow(); expect(methods).toHaveLength(3);
});

test("Sheet throttle code 2950 blocks workbook calls for five minutes and redacts provider errors", async () => {
  const clock = cooldownClock();
  let calls = 0;
  const start = Date.now();
  const adapters = createZohoAdapters(credential, { ...config, requestTimeoutMs: 100 }, async (input) => {
    if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
    if (calls) expect(Date.now() - start).toBe(300_000);
    calls++; return Response.json({ status: "failure", error_code: "2950", error_message: "private secret" });
  });
  await expect(adapters.sheet.find("bill")).rejects.toMatchObject({ retryAfterMs: 300_000 });
  await expect(adapters.sheet.find("bill")).rejects.toBeInstanceOf(ProviderCooldownError); expect(calls).toBe(1);
  clock.mockReturnValue(start + 300_000);
  await expect(adapters.sheet.find("bill")).rejects.toBeInstanceOf(ProviderCooldownError); expect(calls).toBe(2);
});

test("WorkDrive 429 reads and uploads are one-shot and share a bounded cooldown across endpoints", async () => {
  const clock = cooldownClock();
  const start = Date.now();
  for (const mutation of [false, true]) for (const [header, delay] of [["120", 120_000], ["Thu, 01 Jan 2026 00:02:00 GMT", 120_000], [null, 60_000], ["invalid", 60_000], ["-1", 60_000], ["0", 60_000], ["Wed, 31 Dec 2025 23:59:00 GMT", 60_000], ["999999999999", 3_600_000]] as const) {
    clock.mockReturnValue(start); let calls = 0;
    const adapters = createZohoAdapters(credential, { ...config, requestTimeoutMs: 100 }, async (input) => {
      if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 86400 });
      calls++;
      if (calls === 1) return new Response("private provider body", { status: 429, headers: header === null ? {} : { "retry-after": header } });
      expect(Date.now()).toBe(start + delay);
      if (String(input).includes("/download/")) return new Response("original");
      return Response.json({ data: [] });
    });
    const first = mutation ? adapters.workdrive.uploadOnce({ folderId: "folder", name: "x.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]) }) : adapters.workdrive.list("folder", 0);
    await expect(first).rejects.toBeInstanceOf(RetryableExtractionError);
    expect(calls).toBe(1);
    clock.mockReturnValue(start + 1000);
    await expect(adapters.workdrive.download("file", 10)).rejects.toMatchObject({ retryAfterMs: delay - 1000 }); expect(calls).toBe(1);
    clock.mockReturnValue(start + delay);
    expect(await adapters.workdrive.download("file", 10)).toEqual(Buffer.from("original"));
    expect(calls).toBe(2); expect(Date.now()).toBe(start + delay);
    expect(await adapters.workdrive.list("folder", 0)).toEqual([]); expect(calls).toBe(3);
  }
});

test("Sheet HTTP 429 reads and appends preserve retry delay without retrying mutations", async () => {
  const clock = cooldownClock();
  for (const mutation of [false, true]) for (const header of [undefined, "90"]) {
    let calls = 0; const start = Date.now(); const delay = header ? 90_000 : 300_000;
    const adapters = createZohoAdapters(credential, { ...config, requestTimeoutMs: 100 }, async (input) => {
      if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (calls) { expect(Date.now()).toBe(start + delay); calls++; return Response.json({ method: "worksheet.records.fetch", status: "success", records: [] }); }
      calls++; return new Response(null, { status: 429, headers: header ? { "retry-after": header } : {} });
    });
    await expect(mutation ? adapters.sheet.addOnce({ "Bill ID": "bill" }) : adapters.sheet.find("bill")).rejects.toMatchObject({ retryAfterMs: header ? 90_000 : 300_000 });
    await expect(adapters.sheet.find("bill")).rejects.toBeInstanceOf(ProviderCooldownError); expect(calls).toBe(1);
    clock.mockReturnValue(start + delay);
    expect(await adapters.sheet.find("bill")).toEqual([]); expect(calls).toBe(2);
  }
});

test("fresh WorkDrive 429 on the final archive attempt defers without changing intents", async () => {
  const f = fixture(); f.approve(); let requests = 0;
  const previous = f.claim("archive_to_workdrive"); const bill = f.database.getBill(f.billId)!;
  expect(f.database.beginZohoMutation(previous, "upload", { folderId: "folder", name: `${bill.id}-${bill.contentSha256}.pdf`, hash: bill.contentSha256, size: f.bytes.byteLength }, bill.contentRevision, bill.status)).toBe(true);
  const intent = f.database.getZohoIntent(f.billId, "upload");
  f.database.failJob(previous.id, previous.leaseToken, "previous deployment", policy, new Date(Date.now() - 1000));
  f.database.sqlite.query("UPDATE jobs SET attempts = ? WHERE id = ?").run(policy.maxAttempts - 1, previous.id);
  const adapters = createZohoAdapters(credential, config, async (input) => {
    if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
    requests++; return new Response(null, { status: 429, headers: { "retry-after": "120" } });
  });
  const now = Date.now();
  const worker = new JobWorker(f.database, { archive_to_workdrive: createWorkDriveArchiveHandler(f.database, adapters.workdrive, { ...config, originalsRoot: f.dir }) }, policy, "test", createLogger("error", () => {}), { now: () => now });
  expect(await worker.runOnce()).toBe(true);
  const job = f.database.listJobsForBill(f.billId).find((job) => job.type === "archive_to_workdrive")!;
  expect(job.state).toBe("pending"); expect(job.attempts).toBe(policy.maxAttempts - 1); expect(Date.parse(job.availableAt)).toBe(now + 120_000);
  expect(await worker.runOnce()).toBe(false); expect(requests).toBe(1); expect(f.database.getZohoIntent(f.billId, "upload")).toEqual(intent);
});

test("fresh Sheet 2950 and HTTP 429 defer the final projection attempt without consuming it", async () => {
  for (const throttle of [2950, 429]) {
    const f = fixture(); const r = remote(f.bytes); f.approve(); await archive(f, r);
    let calls = 0;
    const adapters = createZohoAdapters(credential, config, async (input) => {
      if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
      calls++;
      return throttle === 2950 ? Response.json({ status: "failure", error_code: "2950", error_message: "private secret" }) : new Response(null, { status: 429, headers: { "retry-after": "90" } });
    });
    const job = f.database.listJobsForBill(f.billId).find((job) => job.type === "sync_to_zoho_sheet")!;
    f.database.sqlite.query("UPDATE jobs SET attempts = ? WHERE id = ?").run(policy.maxAttempts - 1, job.id);
    const now = Date.now();
    const worker = new JobWorker(f.database, { sync_to_zoho_sheet: createZohoSheetHandler(f.database, adapters.sheet, config) }, policy, "test", createLogger("error", () => {}), { now: () => now });
    expect(await worker.runOnce()).toBe(true);
    expect(f.database.getJob(job.id)).toMatchObject({ state: "pending", attempts: policy.maxAttempts - 1, leaseToken: null, availableAt: new Date(now + (throttle === 2950 ? 300_000 : 90_000)).toISOString() });
    expect(f.database.getJobTransitions(job.id).at(-1)?.reason).toBe("provider_cooldown");
    expect(f.database.getZohoIntent(f.billId, "append")).toBeNull();
    expect(await worker.runOnce()).toBe(false); expect(calls).toBe(1);
  }
});

test("throttled upload and append retain one-shot intents and replay only reconciliation", async () => {
  const clock = cooldownClock(Date.now());
  for (const provider of ["workdrive", "sheet"] as const) {
    clock.mockReturnValue(new Date().getTime());
    const start = Date.now(); const f = fixture(); const r = remote(f.bytes); f.approve();
    if (provider === "sheet") await archive(f, r);
    let mutations = 0;
    const adapters = createZohoAdapters(credential, config, async (input, init) => {
      const url = String(input);
      if (url.includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
      const method = init?.body instanceof URLSearchParams ? init.body.get("method") : null;
      if (url.endsWith("/upload") || method === "worksheet.records.add") {
        mutations++; return new Response(null, { status: 429, headers: { "retry-after": "60" } });
      }
      if (provider === "workdrive") return Response.json({ data: [] });
      return Response.json({ method, status: "success", records: [], used_row: 1, used_column: 15, range_details: [{ row_index: 1, row_details: zohoLedgerHeaders.map((content, index) => ({ content, column_index: index + 1 })) }] });
    });
    const type = provider === "workdrive" ? "archive_to_workdrive" : "sync_to_zoho_sheet";
    const kind = provider === "workdrive" ? "upload" : "append";
    const handler = provider === "workdrive" ? createWorkDriveArchiveHandler(f.database, adapters.workdrive, { ...config, originalsRoot: f.dir }) : createZohoSheetHandler(f.database, adapters.sheet, config);
    const job = f.database.listJobsForBill(f.billId).find((job) => job.type === type)!;
    const worker = new JobWorker(f.database, { [type]: handler }, policy, "test", createLogger("error", () => {}));
    expect(await worker.runOnce()).toBe(true);
    expect(f.database.getJob(job.id)).toMatchObject({ state: "pending", attempts: 0 });
    const intent = f.database.getZohoIntent(f.billId, kind); expect(intent).not.toBeNull();
    clock.mockReturnValue(start + 60_000);
    f.database.sqlite.query("UPDATE jobs SET available_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(job.id);
    expect(await worker.runOnce()).toBe(true);
    expect(f.database.getJob(job.id)).toMatchObject({ state: "retryable_failure", attempts: 1 });
    expect(mutations).toBe(1); expect(f.database.getZohoIntent(f.billId, kind)).toEqual(intent);
  }
});

test("WorkDrive HTTP 429 does not wait for a provider error body", async () => {
  const adapters = createZohoAdapters(credential, { ...config, requestTimeoutMs: 100 }, async (input) => {
    if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } }), { status: 429 });
  });
  await expect(adapters.workdrive.list("folder", 0)).rejects.toMatchObject({ retryAfterMs: 60_000 });
});

test("queued WorkDrive and Sheet final attempts defer without requests, preserve intents and respect cooldown on replay", async () => {
  const clock = cooldownClock(Date.now());
  for (const provider of ["workdrive", "sheet"] as const) {
    clock.mockReturnValue(new Date().getTime());
    const f = fixture(); f.approve(); let calls = 0;
    const start = Date.now();
    const adapters = createZohoAdapters(credential, { ...config, requestTimeoutMs: 100 }, async (input) => {
      if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
      calls++;
      if (calls === 1) return new Response(null, { status: 429, headers: { "retry-after": "60" } });
      expect(Date.now()).toBe(start + 60_000);
      return Response.json(provider === "workdrive" ? { data: [] } : { method: "worksheet.records.fetch", status: "success", records: [] });
    });
    const read = () => provider === "workdrive" ? adapters.workdrive.list("folder", 0) : adapters.sheet.find(f.billId);
    await expect(read()).rejects.toMatchObject({ retryAfterMs: 60_000 });
    const type = provider === "workdrive" ? "archive_to_workdrive" : "sync_to_zoho_sheet";
    const job = f.database.listJobsForBill(f.billId).find((job) => job.type === type)!;
    const previous = f.claim(type);
    expect(f.database.beginZohoMutation(previous, provider === "workdrive" ? "upload" : "append", {}, f.database.getBill(f.billId)!.contentRevision, "approved")).toBe(true);
    f.database.failJob(previous.id, previous.leaseToken, "previous failure", { ...policy, maxAttempts: 5 }, new Date(start - 1000));
    const intent = f.database.getZohoIntent(f.billId, provider === "workdrive" ? "upload" : "append");
    f.database.sqlite.query("UPDATE jobs SET attempts = 4 WHERE id = ?").run(job.id);
    const worker = new JobWorker(f.database, { [type]: async () => { await read(); } }, { ...policy, maxAttempts: 5 }, "test", createLogger("error", () => {}));
    expect(await worker.runOnce()).toBe(true);
    expect(f.database.getJob(job.id)).toMatchObject({ state: "pending", attempts: 4, leaseToken: null, leaseExpiresAt: null, claimedBy: null, claimedAt: null });
    expect(Date.parse(f.database.getJob(job.id)!.availableAt)).toBe(start + 60_000);
    expect(f.database.getJobTransitions(job.id).at(-1)?.reason).toBe("provider_cooldown");
    expect(calls).toBe(1); expect(await worker.runOnce()).toBe(false);
    const reopened = new BillDatabase(join(f.dir, "bills.sqlite"));
    try { expect(reopened.getJob(job.id)).toEqual(f.database.getJob(job.id)); } finally { reopened.close(); }
    // An explicit replay of a previously exhausted job must still obey the active provider cooldown.
    f.database.sqlite.query("UPDATE jobs SET state = 'permanent_failure' WHERE id = ?").run(job.id);
    expect(f.database.requeueJob(job.id, true)).toBe(true);
    expect(await worker.runOnce()).toBe(true); expect(calls).toBe(1);
    expect(f.database.getJob(job.id)).toMatchObject({ state: "pending", attempts: 4 });
    expect(f.database.getZohoIntent(f.billId, provider === "workdrive" ? "upload" : "append")).toEqual(intent);
    clock.mockReturnValue(start + 60_000);
    f.database.sqlite.query("UPDATE jobs SET available_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    expect(await worker.runOnce()).toBe(true);
    expect(f.database.getJob(job.id)).toMatchObject({ state: "succeeded", attempts: 5 }); expect(calls).toBe(2);
  }
});

test("cooldown releases the single worker for extraction and Google and does not delay stop", async () => {
  const f = fixture(); f.approve(); let requests = 0;
  const adapters = createZohoAdapters(credential, config, async (input) => {
    if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 86400 });
    requests++; return new Response(null, { status: 429, headers: { "retry-after": "3600" } });
  });
  await expect(adapters.workdrive.list("folder", 0)).rejects.toBeInstanceOf(RetryableExtractionError);
  const job = f.database.listJobsForBill(f.billId).find((job) => job.type === "archive_to_workdrive")!;
  f.database.sqlite.query("UPDATE jobs SET available_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(job.id);
  f.database.createBillWithInitialJobs({ sourceMessageId: "next", sourceChatId: "chat", sourceSenderId: "sender", attachmentIndex: 0, receivedAt: new Date().toISOString(), mimeType: "application/pdf", originalPath: join(f.dir, "next.pdf"), contentSha256: "b".repeat(64) }, [{ type: "extract", idempotencyKey: "next-extract" }]);
  const progress: string[] = [];
  const logger = createLogger("error", () => {});
  const worker = new JobWorker(f.database, {
    archive_to_workdrive: createWorkDriveArchiveHandler(f.database, adapters.workdrive, { ...config, originalsRoot: f.dir }),
    extract: async () => { progress.push("extract"); },
    archive_to_drive: async () => { progress.push("google"); },
  }, policy, "test", logger);
  let started!: () => void;
  const active = new Promise<void>((resolve) => { started = resolve; });
  const loop = new BackgroundWorkerLoop({ async runOnce() { started(); return worker.runOnce(); } }, logger);
  loop.start(); await active;
  const start = performance.now();
  await loop.stop();
  expect(performance.now() - start).toBeLessThan(200);
  expect(f.database.getJob(job.id)).toMatchObject({ state: "pending", attempts: 0 });
  expect(requests).toBe(1);
  expect(await worker.runOnce()).toBe(true); expect(await worker.runOnce()).toBe(true);
  expect(progress.sort()).toEqual(["extract", "google"]);
});

test("cooldown deferral is lease fenced, bounded and compensates only the current claim", () => {
  const f = fixture(); f.approve();
  const job = f.claim("archive_to_workdrive");
  f.database.sqlite.query("UPDATE jobs SET attempts = 5 WHERE id = ?").run(job.id);
  const before = f.database.getJob(job.id); const history = f.database.getJobTransitions(job.id);
  expect(f.database.deferJob(job.id, "wrong-token", 60_000)).toBe(false);
  expect(f.database.deferJob(job.id, job.leaseToken, 60_000, new Date(Date.parse(job.leaseExpiresAt) + 1))).toBe(false);
  expect(f.database.getJob(job.id)).toEqual(before); expect(f.database.getJobTransitions(job.id)).toEqual(history);
  const now = new Date();
  expect(f.database.deferJob(job.id, job.leaseToken, Number.MAX_VALUE, now)).toBe(true);
  expect(f.database.getJob(job.id)).toMatchObject({ state: "pending", attempts: 4, availableAt: new Date(now.getTime() + 3_600_000).toISOString() });
  expect(f.database.deferJob(job.id, job.leaseToken, 1000)).toBe(false);
  expect(f.database.getJob(job.id)!.attempts).toBe(4);
});

test("append intent before send survives rejection and reapproval without blind add", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve(); await archive(f, r); const job = f.claim("sync_to_zoho_sheet"); const bill = f.database.getBill(f.billId)!;
  expect(f.database.beginZohoMutation(job, "append", { resourceId: "workbook", worksheet: "Ledger" }, bill.contentRevision, bill.status)).toBe(true);
  const handler = createZohoSheetHandler(f.database, r.sheet, config);
  await expect(handler(job, context(f.database, job))).rejects.toThrow("unresolved");
  f.review("reject"); const rejected = f.claim("sync_to_zoho_sheet"); await expect(handler(rejected, context(f.database, rejected))).rejects.toThrow("unresolved");
  f.review("approve"); const approved = f.claim("sync_to_zoho_sheet"); await expect(handler(approved, context(f.database, approved))).rejects.toThrow("unresolved");
  expect(r.counts().adds).toBe(0); expect(f.database.getZohoIntent(f.billId, "append")).not.toBeNull();
});

test("upload varied ID schemas and folder full-page pagination are normalized", async () => {
  for (const data of [{ id: "file" }, { attributes: { resource_id: "file" } }, { attributes: { "File INFO": JSON.stringify({ RESOURCE_ID: "file" }) } }]) {
    const offsets: string[] = [];
    const adapters = createZohoAdapters(credential, config, async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (url.pathname.endsWith("/upload")) { const body = init!.body as FormData; expect(body.get("override-name-exist")).toBe("false"); return Response.json({ data: [data] }); }
      offsets.push(url.searchParams.get("page[offset]")!);
      if (offsets.length === 2) return new Response(null, { status: 204 });
      return Response.json({ data: Array.from({ length: 50 }, (_, index) => ({ id: `file${index}`, attributes: { name: `name${index}` } })) });
    });
    expect(await adapters.workdrive.uploadOnce({ folderId: "folder", name: "x.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]) })).toBe("file");
    expect(await adapters.workdrive.list("folder", 0)).toHaveLength(50); expect(await adapters.workdrive.list("folder", 50)).toEqual([]); expect(offsets).toEqual(["0", "50"]);
  }
});

test("expired token refreshes; Sheet auth failure retries reads but never adds", async () => {
  let tokens = 0; let reads = 0; let adds = 0;
  const adapters = createZohoAdapters(credential, config, async (input, init) => {
    if (String(input).includes("/oauth/")) { tokens++; return Response.json({ access_token: "token", expires_in: 1 }); }
    const method = (init!.body as URLSearchParams).get("method");
    if (method === "worksheet.records.add") { adds++; return Response.json({ status: "failure", error_code: 2401 }); }
    reads++; if (reads === 1) return Response.json({ status: "failure", error_code: 2401 });
    return Response.json({ status: "success", method, records: [] });
  });
  expect(await adapters.sheet.find("bill")).toEqual([]); expect(reads).toBe(2); expect(tokens).toBeGreaterThan(1);
  await expect(adapters.sheet.addOnce({ "Bill ID": "bill", Revision: 1 })).rejects.toThrow("2401"); expect(adds).toBe(1);
});

test("Sheet read gets one total auth retry across HTTP and JSON auth failures", async () => {
  let tokens = 0; let calls = 0;
  const adapters = createZohoAdapters(credential, config, async (input) => {
    if (String(input).includes("/oauth/")) { tokens++; return Response.json({ access_token: "token", expires_in: 3600 }); }
    calls++; return calls === 1 ? new Response(null, { status: 401 }) : Response.json({ status: "failure", error_code: 2401 });
  });
  await expect(adapters.sheet.find("bill")).rejects.toThrow("2401"); expect(calls).toBe(2); expect(tokens).toBe(2);
});

test("scope errors are permanent, transient HTTP errors bounded by worker and raw detail never persists", async () => {
  for (const status of [403, 503]) {
    const f = fixture(); f.approve();
    const adapters = createZohoAdapters(credential, config, async (input) => String(input).includes("/oauth/") ? Response.json({ access_token: "token", expires_in: 3600 }) : new Response("private credentials raw provider body", { status }));
    const worker = new JobWorker(f.database, { archive_to_workdrive: createWorkDriveArchiveHandler(f.database, adapters.workdrive, { ...config, originalsRoot: f.dir }) }, policy, "test", createLogger("error", () => {}));
    expect(await worker.runOnce()).toBe(true); const job = f.database.listJobsForBill(f.billId).find((job) => job.type === "archive_to_workdrive")!;
    expect(job.state).toBe(status === 403 ? "permanent_failure" : "retryable_failure"); expect(job.lastError).toBe(`provider_http_${status}`); expect(JSON.stringify(job)).not.toContain("credentials");
  }
});

test("migration rebuild preserves Google jobs, leases, transitions and marks historical approvals", () => {
  const f = fixture(false); f.approve(); const google = f.database.claimNextJob("google", policy, new Date(), ["archive_to_drive"])!;
  const transitions = f.database.getJobTransitions(google.id);
  const version = f.database.sqlite.query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_migrations").get()!.version;
  f.database.sqlite.exec("DROP TABLE zoho_mutation_intents; DROP TABLE zoho_enrollment; DROP TABLE zoho_historical_approvals;");
  f.database.sqlite.query("DELETE FROM schema_migrations WHERE version = ?").run(version);
  const reopened = new BillDatabase(join(f.dir, "bills.sqlite"));
  try {
    expect(reopened.getJob(google.id)).toEqual(google); expect(reopened.getJobTransitions(google.id)).toEqual(transitions);
    expect(reopened.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    reopened.zohoEnabled = true; const bill = reopened.getBill(f.billId)!;
    expect(reopened.submitReview({ billId: bill.id, reviewerId: "operator", action: "reject", reason: null, note: null, expectedContentRevision: bill.contentRevision, expectedReviewRevision: bill.reviewRevision, corrected: extraction }, [])).toBe(true);
    const rejected = reopened.getBill(f.billId)!;
    expect(reopened.submitReview({ billId: bill.id, reviewerId: "operator", action: "approve", reason: null, note: null, expectedContentRevision: rejected.contentRevision, expectedReviewRevision: rejected.reviewRevision, corrected: extraction }, [])).toBe(true);
    expect(reopened.isZohoEnrolled(f.billId)).toBe(false);
    expect(reopened.backfillZohoApprovals()).toEqual({ enrolled: 1 });
    expect(reopened.backfillZohoApprovals()).toEqual({ enrolled: 0 });
  } finally { reopened.close(); }
});

test("disabled jobs are excluded from worker readiness; service projects to Google and Zoho together", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve();
  const worker = new JobWorker(f.database, { extract: async () => {} }, policy, "test", createLogger("error", () => {}));
  expect(worker.supportedTypes).toEqual(["extract"]); expect(f.database.getJobHealth(new Date(), worker.supportedTypes).overdueJobs).toBe(0); expect(await worker.runOnce()).toBe(false);
  const serviceDir = mkdtempSync(join(tmpdir(), "jabocr-zoho-service-")); cleanups.push(() => rmSync(serviceDir, { recursive: true, force: true }));
  const app = loadConfig({ APP_DATA_DIR: serviceDir, WHATSAPP_AUTH_PATH: join(serviceDir, "auth"), WHATSAPP_ENABLED: "false", MISTRAL_ENABLED: "false", AZURE_ENABLED: "true", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://offline.example", AZURE_DOCUMENT_INTELLIGENCE_API_KEY: "offline", REVIEW_USERNAME: "offline", REVIEW_PASSWORD: "offline", ZOHO_ENABLED: "true", ZOHO_WORKDRIVE_FOLDER_ID: "folder", ZOHO_SHEET_RESOURCE_ID: "workbook" });
  app.port = 0;
  app.databasePath = join(f.dir, "bills.sqlite"); app.originals.dir = f.dir;
  app.google = { ...app.google, enabled: true, authMode: "user_oauth", credentialJson: "not-read", driveFolderId: "google-folder", sheetId: "google-book" };
  let googleUploads = 0; let googleRows = 0;
  const service = startService(app, {}, {
    driveAdapter: {
      async findFolder() { return { id: "google-folder" }; }, async createFolder() { return { id: "google-folder" }; }, async findFilesByBillId() { return []; },
      async uploadOriginal(input) { googleUploads++; expect(input.bytes).toEqual(f.bytes); return { id: "google-file", webLink: "https://drive.google.com/file/d/google-file/view", appProperties: { contentSha256: input.contentSha256 } }; },
    },
    sheetsAdapter: { async initializeLedger() {}, async findRowByBillId() { return null; }, async appendRow() { googleRows++; return 2; }, async updateRow() {} },
    workdriveAdapter: r.workdrive, zohoSheetAdapter: r.sheet, azureProvider: { async submit() { throw new Error("offline"); }, async poll() { throw new Error("offline"); } },
  });
  cleanups.push(() => service.shutdown());
  const deadline = Date.now() + 3_000;
  while ((!f.database.getProjectionMetadata("sheets", f.billId) || !f.database.getProjectionMetadata("zoho_sheet", f.billId)) && Date.now() < deadline) await Bun.sleep(10);
  expect(googleUploads).toBe(1); expect(googleRows).toBe(1); expect(r.counts()).toEqual({ uploads: 1, adds: 1, updates: 0 });
  expect(f.database.getProjectionMetadata("sheets", f.billId)).not.toBeNull(); expect(f.database.getProjectionMetadata("zoho_sheet", f.billId)).not.toBeNull();
  const response = await fetch(new URL("ready", service.url)); expect(response.status).toBe(200); expect(await response.text()).not.toContain("overdueJobs");
});
