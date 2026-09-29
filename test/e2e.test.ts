import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase, type RetryPolicy } from "../src/db/database";
import { createExtractJobHandler, RetryableExtractionError, type MistralOcrProvider } from "../src/backend/extraction";
import { createDriveArchiveHandler, createSheetsProjectionHandler, type DriveAdapter, type DriveFile, type SheetsAdapter } from "../src/backend/google-projections";
import { createLogger } from "../src/backend/logger";
import { createExtractionValidationCallback } from "../src/backend/validation";
import { WhatsAppIngestionService } from "../src/backend/whatsapp-ingestion";
import { JobWorker } from "../src/backend/worker";

const policy: RetryPolicy = { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 };
const logger = createLogger("error");
const valid = { schemaVersion: "1" as const, vendorName: "Fixture Store", invoiceNumber: "E2E-1", invoiceDate: "2026-08-27", currency: "USD", subtotal: 10, vat: 1, total: 11, description: "fixture", fields: { vendorName: { confidence: .99, sourceText: "Fixture Store" }, invoiceDate: { confidence: .99, sourceText: "2026-08-27" }, total: { confidence: .99, sourceText: "11.00" } } };
let directory: string; let database: BillDatabase;

class MemoryDrive implements DriveAdapter {
  files = new Map<string, DriveFile>(); bytes = new Map<string, Uint8Array>(); uploads = 0; ids = 0; failUploadResponse = false;
  async findFolder(): Promise<{ id: string } | null> { return { id: "folder" }; }
  async createFolder(): Promise<{ id: string }> { return { id: "folder" }; }
  async findFilesByBillId(billId: string): Promise<DriveFile[]> { return [...this.files.values()].filter((file) => file.appProperties.billId === billId); }
  async generateId(): Promise<string> { return `drive-${this.ids++}`; }
  async getFile(id: string): Promise<DriveFile | null> { return this.files.get(id) ?? null; }
  async createFolderWithId(input: { id: string }): Promise<{ id: string }> { return { id: input.id }; }
  async uploadOriginalWithId(input: { id: string; bytes: Uint8Array; billId: string; contentSha256: string }): Promise<DriveFile> { this.uploads += 1; const file = { id: input.id, webLink: `https://drive.test/${input.id}`, appProperties: { billId: input.billId, contentSha256: input.contentSha256 } }; this.files.set(input.id, file); this.bytes.set(input.id, input.bytes); if (this.failUploadResponse) { this.failUploadResponse = false; throw new Error("network lost response"); } return file; }
  async uploadOriginal(input: { bytes: Uint8Array; billId: string; contentSha256: string }): Promise<DriveFile> { return this.uploadOriginalWithId({ id: `legacy-${this.ids++}`, ...input }); }
}
class MemorySheets implements SheetsAdapter {
  rows = new Map<number, readonly (string | number | null)[]>(); next = 2; appendCalls = 0; failAppendResponse = false;
  async initializeLedger(): Promise<void> {}
  async findRowByBillId(billId: string): Promise<number | null> { return [...this.rows].find(([, row]) => row[13] === billId)?.[0] ?? null; }
  async findLedgerRows(billId: string): Promise<Array<{ row: number; revision: number | null }>> { return [...this.rows].flatMap(([row, value]) => value[13] === billId ? [{ row, revision: Number(value[14]) }] : []); }
  async appendRow(values: readonly (string | number | null)[]): Promise<number> { this.appendCalls += 1; const row = this.next++; this.rows.set(row, values); if (this.failAppendResponse) { this.failAppendResponse = false; throw new Error("network lost response"); } return row; }
  async updateRow(row: number, values: readonly (string | number | null)[]): Promise<void> { this.rows.set(row, values); }
  async clearRows(rows: number[]): Promise<void> { rows.forEach((row) => this.rows.delete(row)); }
}
function ingest(bytes: Uint8Array, mimeType = "image/png") {
  const service = new WhatsAppIngestionService({ groupId: "group", originalsDir: join(directory, "originals"), database, logger });
  const event = { id: "wa-e2e-1", groupId: "group", senderId: "sender", timestamp: "2026-08-27T10:00:00.000Z", caption: "receipt", attachments: [{ kind: mimeType === "application/pdf" ? "document" as const : "image" as const, mimeType, filename: mimeType === "application/pdf" ? "bill.pdf" : "english.png", download: async () => bytes }] };
  return { service, event };
}
function worker(provider: MistralOcrProvider, drive: DriveAdapter, sheets: SheetsAdapter) {
  const validate = createExtractionValidationCallback(database, { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, () => new Date("2026-08-28T00:00:00.000Z"));
  return new JobWorker(database, { extract: createExtractJobHandler(database, provider, policy.maxAttempts, validate, { root: join(directory, "originals"), maxBytes: 20 * 1024 * 1024 }), archive_to_drive: createDriveArchiveHandler(database, drive, { driveRootId: "root", originalsRoot: join(directory, "originals") }), project_to_sheet: createSheetsProjectionHandler(database, sheets) }, policy, "e2e", logger);
}
function extractWorker(provider: MistralOcrProvider) {
  const validate = createExtractionValidationCallback(database, { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, () => new Date("2026-08-28T00:00:00.000Z"));
  return new JobWorker(database, { extract: createExtractJobHandler(database, provider, policy.maxAttempts, validate, { root: join(directory, "originals"), maxBytes: 20 * 1024 * 1024 }) }, policy, "e2e-extract", logger);
}
async function drain(item: JobWorker): Promise<void> { while (await item.runOnce()) {} }
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), "bill-e2e-"))); database = new BillDatabase(join(directory, "ledger.sqlite")); });
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

test("public ingest, worker, SQLite, and mocked providers archive a reviewable byte-identical original exactly once", async () => {
  const bytes = readFileSync(join(import.meta.dir, "fixtures", "english.png")); const { service, event } = ingest(bytes);
  const first = await service.ingest(event); const duplicate = await service.ingest(event); const bill = first.bills[0]!;
  expect(duplicate.bills[0]?.id).toBe(bill.id); expect(database.countJobsForBill(bill.id)).toBe(2);
  let requests = 0; const provider: MistralOcrProvider = { extract: async (input) => { requests += 1; expect(input.bytes).toEqual(bytes); return { annotation: valid, rawResponse: JSON.stringify({ document_annotation: valid }), model: "mistral-mock" }; } };
  const drive = new MemoryDrive(); const sheets = new MemorySheets(); await drain(worker(provider, drive, sheets));
  const stored = database.getBill(bill.id)!; const extraction = database.getExtraction(bill.id)!;
  expect(stored).toMatchObject({ id: bill.id, sourceMessageId: "wa-e2e-1", status: "needs_review", driveFileId: "drive-3", sheetRowKey: null });
  expect(extraction).toMatchObject({ providerModel: "mistral-mock", normalized: expect.objectContaining({ fields: expect.objectContaining({ total: { confidence: null, sourceText: "11.00" } }) }), rawProviderResponse: expect.stringContaining("Fixture Store") });
  expect(drive.bytes.get(stored.driveFileId!)).toEqual(bytes); expect(createHash("sha256").update(bytes).digest("hex")).toBe(stored.contentSha256);
  expect([...sheets.rows.values()].filter((row) => row[13] === bill.id)).toHaveLength(0); expect(requests).toBe(1);
  for (const job of database.listJobsForBill(bill.id)) { expect(job.state).toBe("succeeded"); expect(database.getJobTransitions(job.id).map((transition) => transition.toState)).toContain("succeeded"); }
});

test("provider exhaustion, restart replay, and lost Drive/Sheets responses stay visible and converge without duplicate effects", async () => {
  const bytes = readFileSync(join(import.meta.dir, "fixtures", "bill.pdf")); const { service, event } = ingest(bytes, "application/pdf"); const bill = (await service.ingest(event)).bills[0]!;
  let calls = 0; const provider: MistralOcrProvider = { extract: async () => { calls += 1; if (calls === 1) throw new RetryableExtractionError("timeout"); if (calls === 2) throw new RetryableExtractionError("HTTP 429 rate limit"); return { annotation: [], rawResponse: "malformed", model: "mistral-mock" }; } };
  const drive = new MemoryDrive(); const sheets = new MemorySheets(); const firstWorker = extractWorker(provider);
  await firstWorker.runOnce(); let extract = database.listJobsForBill(bill.id).find((job) => job.type === "extract")!; expect(extract).toMatchObject({ state: "retryable_failure", lastError: "provider_timeout" }); expect(database.requeueJob(extract.id)).toBe(true);
  database.close(); database = new BillDatabase(join(directory, "ledger.sqlite")); // process restart after persisted failure
  const restarted = extractWorker(provider); await restarted.runOnce(); extract = database.getJob(extract.id)!; expect(extract).toMatchObject({ state: "retryable_failure", lastError: "provider_http_429" }); expect(database.requeueJob(extract.id)).toBe(true);
  await restarted.runOnce(); expect(database.getBill(bill.id)?.status).toBe("needs_review"); expect(database.getJob(extract.id)?.state).toBe("permanent_failure"); expect(database.getExtraction(bill.id)?.rawProviderResponse).toBe("malformed");
  const projections = worker(provider, drive, sheets); drive.failUploadResponse = true; expect(await projections.runOnce()).toBe(false);
  const corrected = { ...valid, fields: valid.fields }; const current = database.getBill(bill.id)!; expect(database.submitReview({ billId: bill.id, reviewerId: "qa", action: "approve", reason: "verified", note: "manual correction", expectedContentRevision: current.contentRevision, expectedReviewRevision: current.reviewRevision, corrected }, [])).toBe(true);
  await projections.runOnce(); const archive = database.listJobsForBill(bill.id).find((job) => job.type === "archive_to_drive")!; expect(archive.state).toBe("retryable_failure"); expect(database.requeueJob(archive.id)).toBe(true); for (let attempt = 0; attempt < 3 && !database.getBill(bill.id)?.driveFileId; attempt += 1) await projections.runOnce(); expect(drive.uploads).toBe(1); expect(database.getBill(bill.id)?.driveFileId).not.toBeNull();
  sheets.failAppendResponse = true; await projections.runOnce(); const project = database.listJobsForBill(bill.id).find((job) => job.type === "project_to_sheet")!; expect(project.state).toBe("retryable_failure"); expect(database.requeueJob(project.id)).toBe(true); await projections.runOnce(); expect(sheets.appendCalls).toBe(1); expect([...sheets.rows.values()].filter((row) => row[13] === bill.id)).toHaveLength(1);
});
