import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminZipContentConflictError, AdminZipIngestionService } from "../src/backend/admin-zip-ingestion";
import { BillDatabase } from "../src/db/database";
import type { Logger } from "../src/backend/logger";
import { createExtractJobHandler } from "../src/backend/extraction";
import type { AzureInvoiceProvider } from "../src/backend/azure-invoice";
import { createExtractionValidationCallback } from "../src/backend/validation";
import { JobWorker, PermanentJobError } from "../src/backend/worker";
import { createDriveArchiveHandler, createSheetsProjectionHandler, type DriveAdapter, type SheetsAdapter } from "../src/backend/google-projections";

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
let directory: string;
let database: BillDatabase;
let service: AdminZipIngestionService;

type ZipEntry = { name: string; bytes: Uint8Array; flags?: number; externalAttributes?: number; declaredSize?: number; compressedSize?: number };
const encoder = new TextEncoder();
function u16(value: number): number[] { return [value & 255, (value >>> 8) & 255]; }
function u32(value: number): number[] { return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]; }
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Small stored ZIP fixture builder; central-directory fields are intentionally controllable for hostile fixtures. */
function zip(entries: ZipEntry[]): Uint8Array {
  const chunks: number[] = []; const central: number[] = []; let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name); const crc = crc32(entry.bytes); const size = entry.declaredSize ?? entry.bytes.byteLength; const compressedSize = entry.compressedSize ?? entry.bytes.byteLength; const flags = entry.flags ?? 0;
    const local = [0x50, 0x4b, 3, 4, ...u16(20), ...u16(flags), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(compressedSize), ...u32(size), ...u16(name.byteLength), ...u16(0), ...name, ...entry.bytes];
    chunks.push(...local);
    central.push(0x50, 0x4b, 1, 2, ...u16(0x0314), ...u16(20), ...u16(flags), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(compressedSize), ...u32(size), ...u16(name.byteLength), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(entry.externalAttributes ?? 0), ...u32(offset), ...name);
    offset += local.length;
  }
  const centralOffset = chunks.length; chunks.push(...central, 0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(central.length), ...u32(centralOffset), ...u16(0));
  return new Uint8Array(chunks);
}
const pdf = (suffix = "") => encoder.encode(`%PDF-1.7\n${suffix}`);
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
function itemRows() { return database.sqlite.query<{ entry_path: string; state: string; error_code: string | null; bill_id: string | null }, []>("SELECT entry_path, state, error_code, bill_id FROM admin_upload_batch_items ORDER BY item_index").all(); }

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "bill-zip-")));
  database = new BillDatabase(join(directory, "ledger.sqlite"));
  service = new AdminZipIngestionService({ database, logger: silentLogger, originalsDir: join(directory, "originals"), stagingDir: join(directory, "zip-staging") });
});
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

describe("admin ZIP ingestion", () => {
  test("sniffs nested PDF and image bytes, persists immutable originals, and replays once", async () => {
    const archive = zip([{ name: "nested/not-a-name.bin", bytes: pdf("one") }, { name: "images/also-not-an-image.txt", bytes: png }]);
    const first = await service.ingest({ sourceId: "upload-1", originalFilename: "invoices.zip", bytes: archive });
    const replay = await service.ingest({ sourceId: "upload-1", originalFilename: "changed.zip", bytes: archive });
    expect(first.counts.accepted).toBe(2); expect(replay.batch.id).toBe(first.batch.id); expect(replay.counts.accepted).toBe(2);
    const bills = database.sqlite.query<{ id: string; mime_type: string; original_path: string; content_sha256: string; extraction_policy: string }, []>("SELECT id, mime_type, original_path, content_sha256, extraction_policy FROM bills ORDER BY original_path").all();
    expect(bills).toHaveLength(2);
    expect(bills.map((bill) => bill.mime_type).sort()).toEqual(["application/pdf", "image/png"]);
    for (const bill of bills) expect(createHash("sha256").update(readFileSync(bill.original_path)).digest("hex")).toBe(bill.content_sha256);
    expect(bills.every((bill) => bill.extraction_policy === "azure_only")).toBe(true);
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM jobs WHERE type = 'extract'").get()?.count).toBe(2);
    expect(itemRows().map((item) => item.state)).toEqual(["processing", "processing"]);
  });

  test("terminally rejects a ZIP entry whose bytes duplicate an existing bill", async () => {
    const durable = new (await import("../src/backend/durable-attachment-ingestion")).DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["tg"], originalsDir: join(directory, "originals"), database, logger: silentLogger });
    const existing = (await durable.ingest({ id: "tg-existing", chatId: "tg", senderId: "sender", timestamp: "2026-09-01T00:00:00.000Z", attachments: [{ kind: "document", mimeType: "application/pdf", filename: "Receipt.pdf", download: async () => pdf("first") }] })).bills[0]!;
    const result = await service.ingest({ sourceId: "duplicate-name", originalFilename: "duplicates.zip", bytes: zip([{ name: "nested/Other.pdf", bytes: pdf("first") }]) });
    expect(result.counts).toEqual({ accepted: 0, rejected: 1, ignored: 0 });
    expect(database.getAdminUploadBatchStatus(result.batch.id)).toMatchObject({ batch: { state: "completed" }, counts: { queued: 0, processing: 0, rejected: 1 }, items: [{ entryPath: "nested/Other.pdf", state: "rejected", errorCode: "duplicate_content", billId: null }] });
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(1);
    expect(database.countJobsForBill(existing.id)).toBe(2);
  });

  test("cleans a matching ZIP orphan when another source already owns its hash", async () => {
    const batch = database.createAdminUploadBatch({ id: "orphan-batch", idempotencyKey: "admin-zip:orphan-cleanup", originalFilename: "orphan.zip" }).batch;
    const bytes = pdf("orphan"); const hash = createHash("sha256").update(bytes).digest("hex");
    database.createBillWithInitialJobs({ source: "telegram", sourceMessageId: "existing", sourceChatId: "tg", sourceSenderId: "sender", attachmentIndex: 0, receivedAt: batch.createdAt, sourceFilename: "Receipt.pdf", originalFilename: "Receipt.pdf", mimeType: "application/pdf", originalPath: join(directory, "existing.pdf"), contentSha256: hash }, [{ type: "extract", idempotencyKey: "existing-receipt" }]);
    const orphan = join(directory, "originals", `admin-${batch.id}-0-${hash.slice(0, 16)}.pdf`); mkdirSync(join(directory, "originals"), { recursive: true }); writeFileSync(orphan, bytes);
    const result = await service.ingest({ sourceId: "orphan-cleanup", originalFilename: "orphan.zip", bytes: zip([{ name: "nested/Receipt.PDF", bytes }]) });
    expect(result.counts).toEqual({ accepted: 0, rejected: 1, ignored: 0 });
    expect(existsSync(orphan)).toBe(false);
    expect(database.getAdminUploadBatchStatus(batch.id)?.items).toEqual([expect.objectContaining({ state: "rejected", errorCode: "duplicate_content", billId: null })]);
  });

  test("records hostile entries, ignores junk, and accepts valid later entries", async () => {
    const archive = zip([
      { name: "../escape.pdf", bytes: pdf() }, { name: "C:/drive.pdf", bytes: pdf() }, { name: "back\\slash.pdf", bytes: pdf() },
      { name: "encrypted.pdf", bytes: new Uint8Array([...new Uint8Array(12), ...pdf()]), flags: 1, declaredSize: pdf().byteLength, compressedSize: pdf().byteLength + 12 }, { name: "link.pdf", bytes: pdf(), externalAttributes: 0o120777 << 16 },
      { name: "unknown.pdf", bytes: encoder.encode("not a document") }, { name: "folder/", bytes: new Uint8Array(), externalAttributes: 0x10 }, { name: "safe/final.bin", bytes: pdf("valid") },
    ]);
    const result = await service.ingest({ sourceId: "hostile", originalFilename: "hostile.zip", bytes: archive });
    expect(result.counts).toEqual({ accepted: 1, rejected: 5, ignored: 2 });
    expect(itemRows().map((item) => item.error_code)).toEqual(["unsafe_entry_path", "unsafe_entry_path", "unsafe_entry_path", "encrypted_entry", "special_entry", null]);
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(1);
  });

  test("accept returns a batch id without waiting for original publish", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gated = new AdminZipIngestionService({ database, logger: silentLogger, originalsDir: join(directory, "originals"), stagingDir: join(directory, "async-staging"), afterOriginalPublished: () => gate });
    const archive = zip([{ name: "invoice.pdf", bytes: pdf() }]);
    const accepted = await gated.ingest({ sourceId: "async", originalFilename: "async.zip", bytes: archive }, { wait: false });
    expect(accepted.batch.id).toBeTruthy();
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(0);
    release();
    const done = await gated.ingest({ sourceId: "async", originalFilename: "async.zip", bytes: archive });
    expect(done.counts.accepted).toBe(1);
  });

  test("enforces compressed, entry, expanded, and entry-count limits with durable rejection outcomes", async () => {
    const bounded = new AdminZipIngestionService({ database, logger: silentLogger, originalsDir: join(directory, "originals"), stagingDir: join(directory, "bounded"), limits: { maxCompressedBytes: 1_000, maxEntryBytes: 20, maxExpandedBytes: 15, maxEntries: 2 } });
    const archive = zip([{ name: "large.pdf", bytes: pdf("x".repeat(30)) }, { name: "one.pdf", bytes: pdf() }, { name: "two.pdf", bytes: pdf() }]);
    const result = await bounded.ingest({ sourceId: "limits", originalFilename: "limits.zip", bytes: archive });
    expect(result.counts).toEqual({ accepted: 1, rejected: 2, ignored: 0 });
    expect(itemRows().map((item) => item.error_code)).toEqual(["entry_size_limit", null, "entry_count_limit"]);
    const expanded = new AdminZipIngestionService({ database, logger: silentLogger, originalsDir: join(directory, "originals"), stagingDir: join(directory, "expanded"), limits: { maxExpandedBytes: 10 } });
    const expandedResult = await expanded.ingest({ sourceId: "expanded", originalFilename: "expanded.zip", bytes: zip([{ name: "expanded-one.pdf", bytes: pdf("x") }, { name: "expanded-two.pdf", bytes: pdf() }]) });
    expect(database.sqlite.query<{ error_code: string | null }, [string]>("SELECT error_code FROM admin_upload_batch_items WHERE batch_id = ? ORDER BY item_index").all(expandedResult.batch.id).map((item) => item.error_code)).toEqual([null, "expanded_size_limit"]);
    await expect(bounded.ingest({ sourceId: "too-compressed", originalFilename: "too.zip", bytes: new Uint8Array(1_001) })).rejects.toThrow("compressed size limit");
  });

  test("terminally fails a durable batch when safe ingestion fails after publishing an original", async () => {
    let crash = true;
    const crashing = new AdminZipIngestionService({ database, logger: silentLogger, originalsDir: join(directory, "originals"), stagingDir: join(directory, "recovery"), afterOriginalPublished: async () => { if (crash) { crash = false; throw new Error("simulated crash"); } } });
    const failed = await crashing.ingest({ sourceId: "recover", originalFilename: "recover.zip", bytes: zip([{ name: "invoice.bin", bytes: pdf() }]) });
    expect(failed.batch.state).toBe("failed");
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(0);
    const recovered = new AdminZipIngestionService({ database, logger: silentLogger, originalsDir: join(directory, "originals"), stagingDir: join(directory, "recovery") });
    expect((await recovered.reconcilePending())[0]?.batch.state).toBe("failed");
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(0);
  });

  test("rejects a reused source identity whose ZIP bytes differ", async () => {
    await service.ingest({ sourceId: "same-source", originalFilename: "first.zip", bytes: zip([{ name: "first.pdf", bytes: pdf("first") }]) });
    await expect(service.ingest({ sourceId: "same-source", originalFilename: "second.zip", bytes: zip([{ name: "second.pdf", bytes: pdf("second") }]) })).rejects.toBeInstanceOf(AdminZipContentConflictError);
  });

  test("turns a malformed ZIP into a terminal failed batch with a safe diagnostic item", async () => {
    const archive = zip([{ name: "invoice.pdf", bytes: pdf() }]).slice(0, -5);
    const result = await service.ingest({ sourceId: "corrupt", originalFilename: "corrupt.zip", bytes: archive });
    expect(result.batch.state).toBe("failed");
    expect(database.getAdminUploadBatchStatus(result.batch.id)).toMatchObject({ batch: { state: "failed" }, counts: { failed: 1 }, items: [{ entryPath: "[ZIP archive]", state: "failed", errorCode: "zip_processing_failed", billId: null }] });
  });

  test("ZIP Azure review paths terminalize every item and atomically complete the batch", async () => {
    const archive = zip([{ name: "approve.pdf", bytes: pdf("approve") }, { name: "reject.pdf", bytes: pdf("reject") }, { name: "not-invoice.pdf", bytes: pdf("not-invoice") }, { name: "failure.pdf", bytes: pdf("failure") }]);
    const batch = await service.ingest({ sourceId: "terminal-paths", originalFilename: "terminal.zip", bytes: archive });
    const operations = new Map<string, string>(); let operation = 0;
    const valid = { schemaVersion: "1" as const, vendorName: "Store", invoiceNumber: "N", invoiceDate: "2026-08-01", currency: "USD", subtotal: 9, vat: 1, total: 10, description: null, fields: { vendorName: { confidence: 0.1, sourceText: "Store" }, invoiceDate: { confidence: 0.1, sourceText: "2026-08-01" }, total: { confidence: 0.1, sourceText: "10" } } };
    const review = { ...valid, vendorName: null };
    const azure: AzureInvoiceProvider = {
      submit: async ({ bytes }) => { const id = `operation-${operation++}`; operations.set(id, new TextDecoder().decode(bytes)); return { operationLocation: id }; },
      poll: async ({ operationLocation }) => { const kind = operations.get(operationLocation) ?? ""; if (kind.includes("failure")) throw new PermanentJobError("mock permanent failure"); return kind.includes("not-invoice") ? { classification: "not_invoice", bill: valid, rawResponse: "not-invoice", model: "mock" } : { classification: "invoice", bill: kind.includes("approve") || kind.includes("reject") ? review : valid, rawResponse: "invoice", model: "mock" }; },
    };
    const validate = createExtractionValidationCallback(database, { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, () => new Date("2026-08-02T00:00:00.000Z"));
    const worker = new JobWorker(database, { extract: createExtractJobHandler(database, null, 1, validate, { root: join(directory, "originals"), maxBytes: 1024 * 1024 }, undefined, azure) }, { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 }, "zip-azure", silentLogger);
    while (await worker.runOnce()) {}
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM jobs WHERE type = 'extract' AND state = 'permanent_failure'").get()?.count).toBe(1);
    const bills = database.sqlite.query<{ id: string; entry_path: string }, []>("SELECT bills.id, item.entry_path FROM bills JOIN admin_upload_batch_items item ON item.id = bills.batch_item_id ORDER BY item.entry_path").all();
    const id = (name: string) => bills.find((bill) => bill.entry_path === `${name}.pdf`)?.id ?? (() => { throw new Error(`missing ${name}`); })();
    for (const name of ["approve", "reject"]) {
      const billId = id(name); const current = database.getBill(billId)!;
      expect(database.submitReview({ billId, reviewerId: "qa", action: name === "approve" ? "approve" : "reject", reason: null, note: null, expectedContentRevision: current.contentRevision, expectedReviewRevision: current.reviewRevision, corrected: valid }, [])).toBe(true);
    }
    expect(database.getAdminUploadBatchStatus(batch.batch.id)).toMatchObject({ batch: { state: "completed" }, counts: { total: 4, queued: 0, processing: 0, complete: 1, notInvoice: 1, rejected: 1, failed: 1 } });
  });

  test("replays Azure-only ZIP intake through archival and one-row projection while retaining zero-document originals", async () => {
    const archive = zip([
      { name: "approved.pdf", bytes: pdf("approved") },
      { name: "review.pdf", bytes: pdf("review") },
      { name: "zero-document.pdf", bytes: pdf("zero-document") },
    ]);
    const batch = await service.ingest({ sourceId: "integrated-replay", originalFilename: "integrated.zip", bytes: archive });
    const operations = new Map<string, string>(); let sequence = 0;
    const approved = { schemaVersion: "1" as const, vendorName: "Approved Store", invoiceNumber: "A-1", invoiceDate: "2026-08-01", currency: "USD", subtotal: 9, vat: 1, total: 10, description: null, fields: { vendorName: { confidence: .99, sourceText: "Approved Store" }, invoiceDate: { confidence: .99, sourceText: "2026-08-01" }, total: { confidence: .99, sourceText: "10" } } };
    const review = { ...approved, invoiceNumber: "R-1", vendorName: null, fields: { ...approved.fields, vendorName: { confidence: .1, sourceText: "Review Store" } } };
    const empty = { schemaVersion: "1" as const, vendorName: null, invoiceNumber: null, invoiceDate: null, currency: null, subtotal: null, vat: null, total: null, description: null, fields: {} };
    const azure: AzureInvoiceProvider = {
      submit: async ({ bytes }) => { const location = `operation-${sequence++}`; operations.set(location, new TextDecoder().decode(bytes)); return { operationLocation: location }; },
      poll: async ({ operationLocation }) => {
        const kind = operations.get(operationLocation) ?? "";
        if (kind.includes("zero-document")) return { classification: "not_invoice", bill: empty, rawResponse: "zero-document", model: "azure-mock" };
        return { classification: "invoice", bill: kind.includes("review") ? review : approved, rawResponse: "invoice", model: "azure-mock" };
      },
    };
    const uploaded = new Map<string, Uint8Array>();
    const drive: DriveAdapter = {
      findFolder: async () => ({ id: "folder" }), createFolder: async () => ({ id: "folder" }),
      findFilesByBillId: async (billId) => uploaded.has(billId) ? [{ id: `drive-${billId}`, webLink: `https://drive.test/${billId}`, appProperties: { billId, contentSha256: database.getBill(billId)!.contentSha256 } }] : [],
      uploadOriginal: async (input) => { uploaded.set(input.billId, input.bytes); return { id: `drive-${input.billId}`, webLink: `https://drive.test/${input.billId}`, appProperties: { billId: input.billId, contentSha256: input.contentSha256 } }; },
    };
    const rows = new Map<number, readonly (string | number | null)[]>(); let nextRow = 2; let appendOnceFails = true;
    const sheets: SheetsAdapter = {
      initializeLedger: async () => undefined,
      findRowByBillId: async (billId) => [...rows].find(([, values]) => values[13] === billId)?.[0] ?? null,
      findLedgerRows: async (billId) => [...rows].flatMap(([row, values]) => values[13] === billId ? [{ row, revision: Number(values[14]) }] : []),
      appendRow: async (values) => { const row = nextRow++; rows.set(row, values); if (appendOnceFails) { appendOnceFails = false; throw new Error("temporary Sheets outage after append"); } return row; },
      updateRow: async (row, values) => { rows.set(row, values); }, clearRows: async (targets) => { targets.forEach((row) => rows.delete(row)); },
    };
    const validate = createExtractionValidationCallback(database, { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, () => new Date("2026-08-02T00:00:00.000Z"));
    const worker = new JobWorker(database, {
      extract: createExtractJobHandler(database, null, 3, validate, { root: join(directory, "originals"), maxBytes: 1024 * 1024 }, undefined, azure),
      archive_to_drive: createDriveArchiveHandler(database, drive, { driveRootId: "root", originalsRoot: join(directory, "originals") }),
      project_to_sheet: createSheetsProjectionHandler(database, sheets),
    }, { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 }, "zip-integrated", silentLogger);
    for (let attempts = 0; attempts < 40; attempts += 1) { await worker.runOnce(); await Bun.sleep(2); }

    const bills = database.getAdminUploadBatchStatus(batch.batch.id)!.items;
    const byEntry = (entryPath: string) => bills.find((item) => item.entryPath === entryPath)?.billId ?? (() => { throw new Error(`missing ${entryPath}`); })();
    const approvedId = byEntry("approved.pdf"); const reviewId = byEntry("review.pdf"); const zeroDocumentId = byEntry("zero-document.pdf");
    expect(database.getBill(approvedId)).toMatchObject({ classification: "invoice", status: "approved", driveFileId: `drive-${approvedId}` });
    expect(database.getBill(reviewId)).toMatchObject({ classification: "invoice", status: "needs_review", driveFileId: `drive-${reviewId}` });
    expect(database.getBill(zeroDocumentId)).toMatchObject({ classification: "not_invoice", status: "failed", driveFileId: `drive-${zeroDocumentId}` });
    expect(uploaded.get(zeroDocumentId)).toEqual(pdf("zero-document"));
    expect([...rows.values()].filter((values) => values[13] === approvedId)).toHaveLength(1);
    expect(database.getAdminUploadBatchStatus(batch.batch.id)?.batch.state).toBe("processing");

    const current = database.getBill(reviewId)!;
    expect(database.submitReview({ billId: reviewId, reviewerId: "qa", action: "approve", reason: "verified", note: "manual correction", expectedContentRevision: current.contentRevision, expectedReviewRevision: current.reviewRevision, corrected: { ...approved, invoiceNumber: "R-1" } }, [])).toBe(true);
    for (let attempts = 0; attempts < 20; attempts += 1) { await worker.runOnce(); await Bun.sleep(2); }
    expect(database.getAdminUploadBatchStatus(batch.batch.id)).toMatchObject({ batch: { state: "completed" }, counts: { complete: 2, notInvoice: 1, processing: 0 } });
    expect([...rows.values()].filter((values) => values[13] === approvedId)).toHaveLength(1);
    expect([...rows.values()].filter((values) => values[13] === reviewId)).toHaveLength(1);
    expect([...rows.values()].filter((values) => values[13] === zeroDocumentId)).toHaveLength(0);
  });
});
