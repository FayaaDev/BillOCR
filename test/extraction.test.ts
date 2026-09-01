import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AzureInvoiceProvider } from "../src/azure-invoice";
import { BillDatabase, type RetryPolicy } from "../src/database";
import { createExtractJobHandler, parseAzureExtractedBill, parseExtractedBill, RetryableExtractionError } from "../src/extraction";
import { IMAGE_PREPROCESSING_VERSION, type ImagePreprocessor } from "../src/image-preprocessing";
import { createLogger } from "../src/logger";
import { createExtractionValidationCallback } from "../src/validation";
import { PermanentJobError, JobWorker } from "../src/worker";

const policy: RetryPolicy = { maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 2, leaseMs: 60_000 };
let directory: string;
let database: BillDatabase;
const valid = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: "1", vendorName: "Vendor", invoiceNumber: "INV-1", invoiceDate: "2026-08-28", currency: "USD", subtotal: 10, vat: 1, total: 11, description: "items", fields: { vendorName: { confidence: 0.99, sourceText: "Vendor" }, invoiceDate: { confidence: 0.99, sourceText: "2026-08-28" }, total: { confidence: 0.99, sourceText: "11" } }, ...overrides });
const raw = (vendor = "Vendor") => JSON.stringify({ status: "succeeded", analyzeResult: { documents: [{ fields: { VendorName: { type: "string", valueString: vendor, content: vendor, confidence: 0.99 }, InvoiceDate: { type: "date", valueDate: "2026-08-28", content: "2026-08-28", confidence: 0.99 }, InvoiceTotal: { type: "currency", valueCurrency: { amount: 11, currencyCode: "USD" }, content: "11", confidence: 0.99 } } }] } });
function enqueue(mimeType = "image/png", bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])) {
  const originalPath = join(directory, "originals", mimeType === "application/pdf" ? `bill-${Math.random()}.pdf` : `bill-${Math.random()}.png`);
  writeFileSync(originalPath, bytes);
  return database.createBillWithInitialJobs({ whatsappMessageId: `message-${Math.random()}`, whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: new Date().toISOString(), mimeType, originalPath, contentSha256: createHash("sha256").update(bytes).digest("hex") }, [{ type: "extract", idempotencyKey: `extract-${Math.random()}` }]);
}
const originals = (maxBytes = 20 * 1024 * 1024) => ({ root: join(directory, "originals"), maxBytes });
function worker(azure: AzureInvoiceProvider, callback: (billId: string) => Promise<void> | void = () => undefined, preprocessor?: ImagePreprocessor, retryPolicy = policy) {
  return new JobWorker(database, { extract: createExtractJobHandler(database, azure, retryPolicy.maxAttempts, callback, originals(), preprocessor) }, retryPolicy, "extract-test", createLogger("error"));
}

beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), "bill-extract-"))); mkdirSync(join(directory, "originals")); database = new BillDatabase(join(directory, "ledger.sqlite")); });
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

test("submits, polls, classifies, and durably selects the Azure result", async () => {
  const bill = enqueue();
  const calls: string[] = [];
  const azure: AzureInvoiceProvider = { submit: async (input) => { calls.push(`submit:${input.mimeType}`); return { operationLocation: "https://azure.example/operations/1" }; }, poll: async () => { calls.push("poll"); return { classification: "invoice", bill: parseAzureExtractedBill(valid({ vendorName: "Azure vendor" })), rawResponse: raw("Azure vendor"), model: "prebuilt-invoice" }; } };
  await worker(azure).runOnce();
  expect(calls).toEqual(["submit:image/png", "poll"]);
  expect(database.getExtraction(bill.bill.id)).toMatchObject({ selectedProvider: "azure", normalized: { vendorName: "Azure vendor" }, providerModel: "prebuilt-invoice" });
  expect(database.getExtractionInvocations(bill.bill.id)).toMatchObject([{ provider: "azure", outcome: "succeeded" }]);
  expect(database.getBill(bill.bill.id)?.classification).toBe("invoice");
});

test("uses actual preprocessed bytes in its durable Azure idempotency key and bypasses PDFs", async () => {
  const original = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const derivative = new Uint8Array([...original, 42]);
  const bill = enqueue("image/png", original);
  database.sqlite.query("UPDATE jobs SET idempotency_key = ? WHERE bill_id = ?").run(`extract:${bill.bill.id}:${IMAGE_PREPROCESSING_VERSION}`, bill.bill.id);
  let submitted: Uint8Array | undefined;
  const azure: AzureInvoiceProvider = { submit: async (input) => { submitted = input.bytes; return { operationLocation: "https://azure.example/operations/bytes" }; }, poll: async () => ({ classification: "invoice", bill: parseAzureExtractedBill(valid()), rawResponse: raw(), model: "prebuilt-invoice" }) };
  await worker(azure, () => undefined, { preprocess: async () => ({ bytes: derivative, mimeType: "image/png", mode: "sharp", width: 1, height: 1 }) }).runOnce();
  expect(submitted).toEqual(derivative);
  expect(database.getExtractionInvocations(bill.bill.id)[0]?.idempotencyKey).toBe(`extract:${bill.bill.id}:${IMAGE_PREPROCESSING_VERSION}:azure:input:${createHash("sha256").update(derivative).digest("hex")}`);
  expect(readFileSync(bill.bill.originalPath)).toEqual(Buffer.from(original));
});

test("fails open image preprocessing with verified original bytes and never preprocesses PDFs", async () => {
  const image = readFileSync(join(import.meta.dir, "fixtures", "english.png"));
  const imageBill = enqueue("image/png", image);
  database.sqlite.query("UPDATE jobs SET idempotency_key = ? WHERE bill_id = ?").run(`extract:${imageBill.bill.id}:${IMAGE_PREPROCESSING_VERSION}`, imageBill.bill.id);
  let imageBytes: Uint8Array | undefined;
  let imageMimeType: string | undefined;
  const imageAzure: AzureInvoiceProvider = { submit: async (input) => { imageBytes = input.bytes; imageMimeType = input.mimeType; return { operationLocation: "https://azure.example/operations/image-fail-open" }; }, poll: async () => ({ classification: "invoice", bill: parseAzureExtractedBill(valid()), rawResponse: raw(), model: "prebuilt-invoice" }) };
  await worker(imageAzure, () => undefined, { preprocess: async () => { throw new Error("unavailable"); } }).runOnce();
  expect({ imageBytes, imageMimeType }).toEqual({ imageBytes: image, imageMimeType: "image/png" });

  const pdf = enqueue("application/pdf", new TextEncoder().encode("%PDF-1.7"));
  let preprocessCalls = 0;
  let mimeType: string | undefined;
  const azure: AzureInvoiceProvider = { submit: async (input) => { mimeType = input.mimeType; return { operationLocation: "https://azure.example/operations/pdf" }; }, poll: async () => ({ classification: "invoice", bill: parseAzureExtractedBill(valid()), rawResponse: raw(), model: "prebuilt-invoice" }) };
  await worker(azure, () => undefined, { preprocess: async () => { preprocessCalls += 1; throw new Error("unavailable"); } }).runOnce();
  expect(pdf.bill.mimeType).toBe("application/pdf");
  expect({ preprocessCalls, mimeType }).toEqual({ preprocessCalls: 0, mimeType: "application/pdf" });
});

test("retries a transient poll without resubmitting the durable operation", async () => {
  const bill = enqueue();
  let submissions = 0; let polls = 0;
  const azure: AzureInvoiceProvider = { submit: async () => ({ operationLocation: `https://azure.example/operations/${++submissions}` }), poll: async () => { polls += 1; if (polls === 1) throw new RetryableExtractionError("timeout"); return { classification: "invoice", bill: parseAzureExtractedBill(valid()), rawResponse: raw(), model: "prebuilt-invoice" }; } };
  const extractionWorker = worker(azure);
  await extractionWorker.runOnce(); await Bun.sleep(2); await extractionWorker.runOnce();
  expect({ submissions, polls }).toEqual({ submissions: 1, polls: 2 });
  expect(database.getExtraction(bill.bill.id)?.normalized).not.toBeNull();
});

test("never resubmits after an interrupted Azure submission window", async () => {
  const bill = enqueue();
  let submissions = 0;
  const azure: AzureInvoiceProvider = { submit: async () => ({ operationLocation: `https://azure.example/operations/${++submissions}` }), poll: async () => ({ classification: "invoice", bill: parseAzureExtractedBill(valid()), rawResponse: raw(), model: "prebuilt-invoice" }) };
  const persist = database.persistAzureExtractionOperation.bind(database);
  let interrupted = true;
  database.persistAzureExtractionOperation = (input) => interrupted ? (interrupted = false, null) : persist(input);
  const extractionWorker = worker(azure);
  await extractionWorker.runOnce(); await Bun.sleep(2); await extractionWorker.runOnce();
  expect(submissions).toBe(1);
  expect(database.getBill(bill.bill.id)?.status).toBe("failed");
});

test("replays a completed Azure operation without polling or resubmitting", async () => {
  const bill = enqueue();
  let submissions = 0; let polls = 0;
  const azure: AzureInvoiceProvider = { submit: async () => ({ operationLocation: `https://azure.example/operations/${++submissions}` }), poll: async () => { polls += 1; return { classification: "invoice", bill: parseAzureExtractedBill(valid({ vendorName: "replayed" })), rawResponse: raw("replayed"), model: "prebuilt-invoice" }; } };
  const transition = database.transitionBillClassification.bind(database);
  let interrupted = true;
  database.transitionBillClassification = (input) => interrupted ? (interrupted = false, false) : transition(input);
  const extractionWorker = worker(azure);
  await extractionWorker.runOnce(); await Bun.sleep(2); await extractionWorker.runOnce();
  expect({ submissions, polls }).toEqual({ submissions: 1, polls: 1 });
  expect(database.getExtraction(bill.bill.id)?.normalized?.vendorName).toBe("replayed");
});

test("retries callback failure without another Azure submit or poll", async () => {
  const bill = enqueue();
  let submissions = 0; let polls = 0; let callbacks = 0;
  const azure: AzureInvoiceProvider = { submit: async () => ({ operationLocation: `https://azure.example/operations/${++submissions}` }), poll: async () => { polls += 1; return { classification: "invoice", bill: parseAzureExtractedBill(valid()), rawResponse: raw(), model: "prebuilt-invoice" }; } };
  const extractionWorker = worker(azure, () => { if (++callbacks === 1) throw new Error("validation unavailable"); });
  await extractionWorker.runOnce(); await Bun.sleep(2); await extractionWorker.runOnce();
  expect({ submissions, polls, callbacks }).toEqual({ submissions: 1, polls: 1, callbacks: 2 });
  expect(database.getJob(database.listJobsForBill(bill.bill.id)[0]!.id)?.state).toBe("succeeded");
});

test("callback failure through exhaustion marks the canonical bill needs_review", async () => {
  const bill = enqueue();
  const azure: AzureInvoiceProvider = { submit: async () => ({ operationLocation: "https://azure.example/operations/callback-exhausted" }), poll: async () => ({ classification: "invoice", bill: parseAzureExtractedBill(valid()), rawResponse: raw(), model: "prebuilt-invoice" }) };
  const extractionWorker = worker(azure, () => { throw new Error("validation unavailable"); });
  await extractionWorker.runOnce(); await Bun.sleep(2); await extractionWorker.runOnce();
  expect(database.getBill(bill.bill.id)).toMatchObject({ status: "needs_review", contentRevision: 3, reviewRevision: 1 });
  expect(database.sqlite.query<{ manual_review_required: number }, [string]>("SELECT manual_review_required FROM bills WHERE id = ?").get(bill.bill.id)?.manual_review_required).toBe(1);
  expect(database.getReviewEvents(bill.bill.id)).toContainEqual(expect.objectContaining({ reviewerId: "system", action: "extraction_callback_failed" }));
  expect(database.getJob(database.listJobsForBill(bill.bill.id)[0]!.id)?.state).toBe("permanent_failure");
});

test("a post-validation callback failure supersedes an approved bill for review", async () => {
  const bill = enqueue();
  let observedApproval = false;
  const validate = createExtractionValidationCallback(database, { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 }, () => new Date("2026-08-28T00:00:00.000Z"));
  const azure: AzureInvoiceProvider = { submit: async () => ({ operationLocation: "https://azure.example/operations/post-validation" }), poll: async () => ({ classification: "invoice", bill: parseAzureExtractedBill(valid()), rawResponse: raw(), model: "prebuilt-invoice" }) };
  const extractionWorker = worker(azure, (billId) => { validate(billId); observedApproval ||= database.getBill(billId)?.status === "approved"; throw new Error("downstream unavailable"); });
  await extractionWorker.runOnce(); await Bun.sleep(2); await extractionWorker.runOnce();
  expect(observedApproval).toBe(true);
  expect(database.getBill(bill.bill.id)?.status).toBe("needs_review");
  expect(database.getJob(database.listJobsForBill(bill.bill.id).find((job) => job.type === "extract")!.id)?.state).toBe("permanent_failure");
  expect(database.listJobsForBill(bill.bill.id).filter((job) => job.type === "project_to_sheet").map((job) => job.state)).toEqual(["permanent_failure"]);
  expect(database.getBill(bill.bill.id)).toMatchObject({ contentRevision: 3, reviewRevision: 1 });
  expect(database.sqlite.query<{ manual_review_required: number }, [string]>("SELECT manual_review_required FROM bills WHERE id = ?").get(bill.bill.id)?.manual_review_required).toBe(1);
  expect(database.getReviewEvents(bill.bill.id)).toContainEqual(expect.objectContaining({ reviewerId: "system", action: "extraction_callback_failed" }));
  expect(database.listJobsForBill(bill.bill.id).find((job) => job.type === "sync_review_correction")).toMatchObject({ state: "pending", idempotencyKey: `sync_review_correction:${bill.bill.id}:1`, expectedRevision: 1 });
});

test("makes malformed Azure output reviewable only after bounded retries and keeps raw output out of errors", async () => {
  const bill = enqueue();
  let polls = 0;
  const azure: AzureInvoiceProvider = { submit: async () => ({ operationLocation: "https://azure.example/operations/malformed" }), poll: async () => { polls += 1; return { classification: "invoice", bill: { ...parseExtractedBill(valid()), total: Infinity } as ReturnType<typeof parseExtractedBill>, rawResponse: "azure-private-body", model: "prebuilt-invoice" }; } };
  const extractionWorker = worker(azure);
  await extractionWorker.runOnce(); await Bun.sleep(2); await extractionWorker.runOnce();
  expect(polls).toBe(2);
  expect(database.getBill(bill.bill.id)?.status).toBe("needs_review");
  expect(database.getLatestExtractionAttempt(bill.bill.id)?.errorDetails).not.toContain("azure-private-body");
  expect(database.getExtraction(bill.bill.id)?.rawProviderResponse).toBe("azure-private-body");
});

test("does not persist extraction state from a stale lease", async () => {
  const bill = enqueue();
  const stale = database.claimNextJob("stale", policy)!;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const azure: AzureInvoiceProvider = { submit: async () => { if (++calls === 1) await blocked; return { operationLocation: "https://azure.example/operations/lease" }; }, poll: async () => ({ classification: "invoice", bill: parseAzureExtractedBill(valid()), rawResponse: raw(), model: "prebuilt-invoice" }) };
  const handler = createExtractJobHandler(database, azure, policy.maxAttempts, () => undefined, originals());
  const staleRun = handler(stale, { idempotencyKey: stale.idempotencyKey, assertLease: () => undefined, assertCurrentApprovalRevision: () => undefined });
  await Bun.sleep(1);
  database.failJob(stale.id, stale.leaseToken, "expired", policy, new Date());
  release();
  await expect(staleRun).rejects.toBeInstanceOf(RetryableExtractionError);
  expect(database.getExtraction(bill.bill.id)).toBeNull();
});

test("rejects permanent provider failures and verified-original failures without a submit", async () => {
  const providerFailure = enqueue();
  const rejected: AzureInvoiceProvider = { submit: async () => { throw new PermanentJobError("bad credentials"); }, poll: async () => { throw new Error("unreachable"); } };
  await worker(rejected).runOnce();
  expect(database.getBill(providerFailure.bill.id)?.status).toBe("failed");
  const badOriginal = enqueue();
  writeFileSync(badOriginal.bill.originalPath, new Uint8Array([1]));
  let submits = 0;
  await worker({ submit: async () => { submits += 1; return { operationLocation: "unused" }; }, poll: async () => { throw new Error("unreachable"); } }).runOnce();
  expect(submits).toBe(0);
  expect(database.getBill(badOriginal.bill.id)?.status).toBe("needs_review");
});
