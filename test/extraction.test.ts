import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase, type RetryPolicy } from "../src/db/database";
import { attachMistralNativeConfidence, createExtractJobHandler, extractedBillJsonSchema, extractionPrompt, MalformedStructuredOutputError, MistralHttpOcrProvider, type MistralOcrProvider, parseAzureExtractedBill, parseExtractedBill, parseMistralNativeConfidence, parseProviderExtractedBill, RetryableExtractionError } from "../src/backend/extraction";
import { createLogger } from "../src/backend/logger";
import { JobWorker } from "../src/backend/worker";
import { PermanentJobError } from "../src/backend/worker";
import { IMAGE_PREPROCESSING_VERSION, type ImagePreprocessor } from "../src/backend/image-preprocessing";
import { parseAzureInvoiceAnalysis, type AzureInvoiceProvider } from "../src/backend/azure-invoice";
import { createExtractionValidationCallback } from "../src/backend/validation";

const policy: RetryPolicy = { maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 2, leaseMs: 60_000 };
let directory: string;
let database: BillDatabase;
let nextOriginal = 0;

const valid = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: "1", vendorName: "Vendor", invoiceNumber: "INV-1", invoiceDate: "2026-08-28", currency: "USD", subtotal: 10, vat: 1, total: 11, description: "items", fields: { total: { confidence: 0.99, sourceText: "11.00" } }, ...overrides });
const azureRaw = (documents: unknown[]) => JSON.stringify({ status: "succeeded", analyzeResult: { documents } });
const azureInvoiceRaw = (vendor = "Azure vendor") => azureRaw([{ fields: {
  VendorName: { type: "string", valueString: vendor, content: vendor, confidence: 0.99 },
  InvoiceDate: { type: "date", valueDate: "2026-08-28", content: "2026-08-28", confidence: 0.99 },
  InvoiceTotal: { type: "currency", valueCurrency: { amount: 11, currencyCode: "USD" }, content: "11", confidence: 0.99 },
} }]);
function enqueue(mimeType = "image/png", caption: string | null = "caption", bytes?: Uint8Array) {
  const index = ++nextOriginal;
  bytes ??= mimeType === "application/pdf" ? new TextEncoder().encode(`%PDF-1.7 ${index}`) : new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, index]);
  const originalPath = join(directory, "originals", `bill-${index}.${mimeType === "application/pdf" ? "pdf" : "png"}`);
  writeFileSync(originalPath, bytes);
  return database.createBillWithInitialJobs({ whatsappMessageId: `message-${Math.random()}`, whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: new Date().toISOString(), caption, mimeType, originalPath, contentSha256: createHash("sha256").update(bytes).digest("hex") }, [{ type: "extract", idempotencyKey: `extract-${Math.random()}` }]);
}
const originals = (maxBytes = 20 * 1024 * 1024) => ({ root: join(directory, "originals"), maxBytes });
function worker(provider: MistralOcrProvider) { return new JobWorker(database, { extract: createExtractJobHandler(database, provider, policy.maxAttempts, () => undefined, originals()) }, policy, "extract-test", createLogger("error")); }
function workerWithPreprocessor(provider: MistralOcrProvider, preprocessor: ImagePreprocessor) { return new JobWorker(database, { extract: createExtractJobHandler(database, provider, policy.maxAttempts, () => undefined, originals(), preprocessor) }, policy, "extract-test", createLogger("error")); }
function setExtractKey(billId: string, idempotencyKey: string): void { database.sqlite.query("UPDATE jobs SET idempotency_key = ? WHERE bill_id = ? AND type = 'extract'").run(idempotencyKey, billId); }

beforeEach(() => { nextOriginal = 0; directory = realpathSync(mkdtempSync(join(tmpdir(), "bill-extract-"))); mkdirSync(join(directory, "originals")); database = new BillDatabase(join(directory, "ledger.sqlite")); });
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

test.each([
  ["printed English", "image/png", "english.png", valid({ vendorName: "English Store" })],
  ["printed Arabic", "image/png", "arabic.png", valid({ vendorName: "متجر عربي", description: "فاتورة" })],
  ["handwriting", "image/png", "handwriting.png", valid({ fields: { total: { confidence: 0.9, sourceText: "١١" } } })],
  ["angled photo", "image/png", "angled-photo.png", valid({ invoiceNumber: "ANGLE-1" })],
  ["PDF", "application/pdf", "bill.pdf", valid({ description: "PDF table" })],
])("persists schema-valid %s extraction using the representative fixture bytes", async (_name, mimeType, fixture, annotation) => {
  const bytes = readFileSync(join(import.meta.dir, "fixtures", fixture));
  const bill = enqueue(mimeType, "caption", bytes);
  let received: { bytes: Uint8Array; mimeType: string; caption: string | null; idempotencyKey: string } | undefined;
  const provider: MistralOcrProvider = { extract: async (input) => { received = input; return { annotation, rawResponse: JSON.stringify({ document_annotation: annotation }), model: "mock-ocr" }; } };
  await worker(provider).runOnce();
  expect(received).toMatchObject({ mimeType, caption: "caption" });
  expect(received?.bytes).toEqual(bytes);
  expect(database.getExtraction(bill.bill.id)).toMatchObject({ normalized: expect.objectContaining({ fields: expect.objectContaining({ total: { confidence: null, sourceText: annotation.fields.total.sourceText } }) }), providerModel: "mock-ocr", promptSchemaVersion: "extracted-bill-v4" });
  expect(database.getJob(database.sqlite.query<{ id: string }, [string]>("SELECT id FROM jobs WHERE bill_id = ?").get(bill.bill.id)!.id)?.state).toBe("succeeded");
});

test("a reviewer NotInvoice override before claim short-circuits extraction before any provider call", async () => {
  const bill = enqueue();
  expect(database.overrideClassification({ billId: bill.bill.id, reviewerId: "alice", action: "mark_not_invoice", expectedContentRevision: 0, expectedReviewRevision: 0 })).toBe(true);
  let providerCalls = 0;
  const provider: MistralOcrProvider = { extract: async () => { providerCalls += 1; return { annotation: valid(), rawResponse: "unused", model: "mock" }; } };
  await worker(provider).runOnce();
  expect(providerCalls).toBe(0);
  expect(database.getBill(bill.bill.id)).toMatchObject({ classification: "not_invoice", status: "failed" });
  expect(database.listJobsForBill(bill.bill.id).find((job) => job.type === "extract")?.state).toBe("succeeded");
});

test("keeps the internal canonical parser strict and preserves null unknowns", () => {
  expect(parseExtractedBill(valid({ vendorName: null, invoiceNumber: null, invoiceDate: null, currency: null, subtotal: null, vat: null, total: null, description: null }))).toMatchObject({ total: null });
  expect(parseExtractedBill(valid({ fields: { total: { sourceText: "11.00" } } }))).toMatchObject({ fields: { total: { confidence: null, sourceText: "11.00" } } });
  expect(parseExtractedBill(valid({ fields: {} })).fields).toMatchObject({ vendorName: { confidence: null, sourceText: null }, invoiceDate: { confidence: null, sourceText: null }, total: { confidence: null, sourceText: null } });
  expect(() => parseExtractedBill({ ...valid(), currency: "usd" })).toThrow("currency");
  expect(() => parseExtractedBill({ ...valid(), unexpected: true })).toThrow("unknown");
  expect(() => parseExtractedBill({ ...valid(), handwritten: true })).toThrow("unknown");
  expect(() => parseExtractedBill({ ...valid(), fields: { total: { confidence: 0.99, sourceText: "11.00" }, handwritten: { confidence: 0.99, sourceText: "yes" } } })).toThrow("invalid key");
  expect(() => parseExtractedBill({ ...valid(), invoiceDate: "2026-02-30" })).toThrow("invoiceDate");
  expect(() => parseExtractedBill({ ...valid(), vendorName: "x".repeat(513) })).toThrow("vendorName");
  expect(() => parseExtractedBill({ ...valid(), fields: { ["x".repeat(65)]: { confidence: 1, sourceText: "text" } } })).toThrow("invalid key");
  expect(() => parseExtractedBill({ ...valid(), fields: { total: { confidence: 1, sourceText: "x".repeat(2_001) } } })).toThrow("invalid metadata");
});

test("normalizes permissive provider annotations without manufacturing accounting values", () => {
  const providerAnnotation = { ...valid({ schemaVersion: 1, invoiceNumber: "0042", total: 99, handwritten: null, unexpected: true, fields: { total: { confidence: "unknown", sourceText: "99" }, handwritten: null, unsupported: [], broken: { sourceText: 99 } } }) };
  expect(() => parseExtractedBill(valid({ schemaVersion: 1 }))).toThrow("schemaVersion");
  expect(() => parseExtractedBill(valid({ truckNumber: "TRK-7" }))).toThrow("unknown or missing fields");
  expect(parseProviderExtractedBill(providerAnnotation)).toEqual(expect.objectContaining({ schemaVersion: "1", invoiceNumber: "0042", total: 99, fields: expect.objectContaining({ total: { confidence: null, sourceText: "99" }, vendorName: { confidence: null, sourceText: null }, invoiceDate: { confidence: null, sourceText: null } }) }));
  const unknown = parseProviderExtractedBill({ schemaVersion: "unexpected", vendorName: 42, invoiceNumber: [], invoiceDate: "2026-02-30", currency: "usd", subtotal: Infinity, vat: "1", total: NaN, description: "", fields: null });
  expect(unknown).toEqual({ schemaVersion: "1", vendorName: null, vendorTaxNumber: null, invoiceNumber: null, invoiceDate: null, currency: null, subtotal: null, vat: null, total: null, description: null, fields: { vendorName: { confidence: null, sourceText: null }, invoiceDate: { confidence: null, sourceText: null }, total: { confidence: null, sourceText: null } } });
  expect(parseProviderExtractedBill({ schemaVersion: 2, fields: [] }).total).toBeNull();
  expect(() => parseProviderExtractedBill({ fields: Array.from({ length: 51 }) })).toThrow("too many");
  expect(() => parseProviderExtractedBill(Object.fromEntries(Array.from({ length: 61 }, (_, index) => [`unknown${index}`, null])))).toThrow("too many");
});

test("rejects malformed annotation JSON at the Mistral provider boundary", async () => {
  const adapter = new MistralHttpOcrProvider("key", "model", 1024, 1000, async () => new Response(JSON.stringify({ model: "actual", document_annotation: "{not-json" })));
  await expect(adapter.extract({ bytes: new Uint8Array([1]), mimeType: "image/png", caption: null, idempotencyKey: "bad-json" })).rejects.toBeInstanceOf(MalformedStructuredOutputError);
});

test("retains only bounded Azure native field confidence for deterministic validation", () => {
  const parsed = parseAzureExtractedBill(valid({ fields: { vendorName: { confidence: 0.99, sourceText: "Vendor" }, invoiceDate: { confidence: 0.99, sourceText: "2026-08-28" }, total: { confidence: 0.99, sourceText: "11" } } }));
  expect(parsed.fields).toMatchObject({ vendorName: { confidence: 0.99 }, invoiceDate: { confidence: 0.99 }, total: { confidence: 0.99 } });
  expect(parseAzureExtractedBill(valid({ fields: { total: { confidence: Infinity, sourceText: "11" } } })).fields.total?.confidence).toBeNull();
});

test("normalizes explicit legacy source-text aliases but never maps generic date", () => {
  const normalized = parseExtractedBill(valid({ fields: { vendor_name: { confidence: 0.9, sourceText: "Vendor" }, invoice_date: { confidence: 0.9, sourceText: "2026-08-28" }, grand_total: { confidence: 0.9, sourceText: "11" } } }));
  expect(normalized.fields).toMatchObject({ vendorName: { confidence: null, sourceText: "Vendor" }, invoiceDate: { confidence: null, sourceText: "2026-08-28" }, total: { confidence: null, sourceText: "11" } });
  const generic = parseExtractedBill(valid({ fields: { vendorName: { confidence: 0.9, sourceText: "Vendor" }, date: { confidence: 0.99, sourceText: "2026-08-28" }, total: { confidence: 0.9, sourceText: "11" } } }));
  expect(generic.fields.invoiceDate).toEqual({ confidence: null, sourceText: null });
});

test("discards model-supplied confidence while preserving source text", async () => {
  const bill = enqueue();
  const annotation = valid({ fields: {
    vendorName: { confidence: 0.99, sourceText: "Vendor" },
    invoiceDate: { confidence: 0.99, sourceText: "2026-08-28" },
    total: { confidence: 0.99, sourceText: "11" },
  } });
  await worker({ extract: async () => ({ annotation, rawResponse: "raw", model: "mock" }) }).runOnce();
  expect(database.getExtraction(bill.bill.id)?.normalized?.fields).toMatchObject({ vendorName: { confidence: null, sourceText: "Vendor" }, invoiceDate: { confidence: null, sourceText: "2026-08-28" }, total: { confidence: null, sourceText: "11" } });
});

test("persists only native confidence supplied through the provider boundary", async () => {
  const bill = enqueue();
  const annotation = valid({ fields: { total: { confidence: 1, sourceText: "11.00" } } });
  const nativeConfidence = parseMistralNativeConfidence({ pages: [{ markdown: "Total 11.00", confidence_scores: { word_confidence_scores: [{ text: "11.00", confidence: 0.74, start_index: 6 }] } }] });
  await worker({ extract: async () => ({ annotation, rawResponse: "raw", model: "mock", nativeConfidence }) }).runOnce();
  expect(database.getExtraction(bill.bill.id)?.normalized?.fields.total).toEqual({ confidence: 0.74, sourceText: "11.00" });
});

test("classifies transient provider failures and malformed annotation exhaustion for review", async () => {
  const malformed = enqueue();
  let calls = 0;
  const malformedProvider: MistralOcrProvider = { extract: async () => { calls += 1; return { annotation: [], rawResponse: "bad", model: "mock" }; } };
  await worker(malformedProvider).runOnce();
  await Bun.sleep(2);
  await worker(malformedProvider).runOnce();
  expect(calls).toBe(2);
  expect(database.getBill(malformed.bill.id)?.status).toBe("needs_review");
  expect(database.getJob(database.sqlite.query<{ id: string }, [string]>("SELECT id FROM jobs WHERE bill_id = ?").get(malformed.bill.id)!.id)?.state).toBe("permanent_failure");
  const transient = enqueue();
  await worker({ extract: async () => { throw new RetryableExtractionError("timeout"); } }).runOnce();
  expect(database.getJob(database.sqlite.query<{ id: string }, [string]>("SELECT id FROM jobs WHERE bill_id = ?").get(transient.bill.id)!.id)?.state).toBe("retryable_failure");
});

test("replay after a simulated pre-persistence crash reuses the durable provider idempotency key", async () => {
  const bill = enqueue();
  const keys: string[] = [];
  const provider: MistralOcrProvider = { extract: async (input) => { keys.push(input.idempotencyKey); if (keys.length === 1) throw new RetryableExtractionError("simulated crash after provider receipt"); return { annotation: valid(), rawResponse: "raw", model: "actual-model" }; } };
  await worker(provider).runOnce();
  await Bun.sleep(2);
  await worker(provider).runOnce();
  expect(keys[1]).toBe(keys[0]);
  expect(keys[0]).toStartWith("extract-");
  expect(database.getExtraction(bill.bill.id)?.normalized).not.toBeNull();
});

test("replay selects the handler-persisted Mistral invocation without recalling Mistral", async () => {
  const bill = enqueue();
  let providerCalls = 0;
  const rawResponse = JSON.stringify({ model: "mistral-ocr", document_annotation: JSON.stringify(valid()), pages: [] });
  const persistCanonical = database.persistCanonicalExtractionSuccess.bind(database);
  let interrupted = true;
  database.persistCanonicalExtractionSuccess = (input) => interrupted ? (interrupted = false, false) : persistCanonical(input);
  const replayWorker = worker({ extract: async () => { providerCalls += 1; return { annotation: valid(), rawResponse, model: "mistral-ocr" }; } });
  await replayWorker.runOnce();
  const invocation = database.getExtractionInvocations(bill.bill.id).find((item) => item.provider === "mistral");
  expect(invocation).toMatchObject({ outcome: "succeeded", rawProviderResponse: rawResponse });
  expect(database.getExtraction(bill.bill.id)?.normalized).toBeNull();
  await Bun.sleep(2);
  await replayWorker.runOnce();
  expect(providerCalls).toBe(1);
  expect(database.getExtraction(bill.bill.id)).toMatchObject({ selectedProvider: "mistral", normalized: { vendorName: "Vendor" } });
  expect(database.getExtractionInvocations(bill.bill.id)).toMatchObject([{ id: invocation?.id, outcome: "succeeded" }]);
});

test("replay normalizes a completed permissive provider annotation without recalling Mistral", async () => {
  const bill = enqueue();
  let providerCalls = 0;
  const annotation = { schemaVersion: 1, vendorName: "Vendor", total: 11, fields: { handwritten: null, total: { sourceText: "11" } }, providerOnly: "ignored" };
  const rawResponse = JSON.stringify({ model: "mistral-ocr", document_annotation: JSON.stringify(annotation), pages: [] });
  const persistCanonical = database.persistCanonicalExtractionSuccess.bind(database);
  let interrupted = true;
  database.persistCanonicalExtractionSuccess = (input) => interrupted ? (interrupted = false, false) : persistCanonical(input);
  const replayWorker = worker({ extract: async () => { providerCalls += 1; return { annotation, rawResponse, model: "mistral-ocr" }; } });
  await replayWorker.runOnce();
  await Bun.sleep(2);
  await replayWorker.runOnce();
  expect(providerCalls).toBe(1);
  expect(database.getExtraction(bill.bill.id)?.normalized).toMatchObject({ schemaVersion: "1", vendorName: "Vendor", total: 11, invoiceDate: null, fields: { total: { confidence: null, sourceText: "11" } } });
});

test("tagged image jobs send a derivative and assert the lease immediately before the provider", async () => {
  const original = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const derivative = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42]);
  const bill = enqueue("image/png", "caption", original);
  const durableKey = `extract:${bill.bill.id}:${IMAGE_PREPROCESSING_VERSION}`;
  setExtractKey(bill.bill.id, durableKey);
  const job = database.claimNextJob("preprocess", policy)!;
  const events: string[] = []; let input: Parameters<MistralOcrProvider["extract"]>[0] | undefined;
  const handler = createExtractJobHandler(database, { extract: async (received) => { events.push("provider"); input = received; return { annotation: valid(), rawResponse: "raw", model: "mock" }; } }, policy.maxAttempts, () => undefined, originals(), { preprocess: async (received) => { events.push("preprocess"); expect(received).toEqual({ bytes: original, mimeType: "image/png", mode: "sharp" }); return { bytes: derivative, mimeType: "image/png", mode: "sharp", width: 1, height: 1 }; } });
  await handler(job, { idempotencyKey: durableKey, assertLease: () => events.push("lease"), assertCurrentApprovalRevision: () => undefined });
  expect(events[events.indexOf("provider") - 1]).toBe("lease");
  expect(input).toMatchObject({ bytes: derivative, mimeType: "image/png", caption: "caption" });
  expect(input!.idempotencyKey).toBe(`${durableKey}:mistral:input:${createHash("sha256").update(derivative).digest("hex")}`);
  expect(input!.idempotencyKey).not.toContain(Buffer.from(derivative).toString("base64"));
  expect(readFileSync(bill.bill.originalPath)).toEqual(Buffer.from(original));
  expect(createHash("sha256").update(readFileSync(bill.bill.originalPath)).digest("hex")).toBe(bill.bill.contentSha256);
});

test("tagged image preprocessing null or errors and PDFs use the exact verified original", async () => {
  const original = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const keys: string[] = [];
  for (const [index, preprocessor] of ([{ preprocess: async () => null }, { preprocess: async () => { throw new Error("unavailable"); } }] satisfies ImagePreprocessor[]).entries()) {
    const bytes = new Uint8Array([...original, index]);
    const bill = enqueue("image/png", null, bytes);
    setExtractKey(bill.bill.id, `extract:${bill.bill.id}:${IMAGE_PREPROCESSING_VERSION}`);
    await workerWithPreprocessor({ extract: async (input) => { expect(input.bytes).toEqual(bytes); expect(input.mimeType).toBe("image/png"); keys.push(input.idempotencyKey); return { annotation: valid(), rawResponse: "raw", model: "mock" }; } }, preprocessor).runOnce();
  }
  const pdf = enqueue("application/pdf");
  setExtractKey(pdf.bill.id, `extract:${pdf.bill.id}:${IMAGE_PREPROCESSING_VERSION}`);
  let preprocessCalls = 0;
  await workerWithPreprocessor({ extract: async (input) => { expect(input.mimeType).toBe("application/pdf"); return { annotation: valid(), rawResponse: "raw", model: "mock" }; } }, { preprocess: async () => { preprocessCalls += 1; return null; } }).runOnce();
  expect(preprocessCalls).toBe(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
});

test("replay keeps an identical selected-input key, but fallback after a preprocessing failure gets a new key", async () => {
  const first = enqueue();
  setExtractKey(first.bill.id, `extract:${first.bill.id}:${IMAGE_PREPROCESSING_VERSION}`);
  const derivative = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const repeatedKeys: string[] = [];
  await workerWithPreprocessor({ extract: async (input) => { repeatedKeys.push(input.idempotencyKey); throw new RetryableExtractionError("crash"); } }, { preprocess: async () => ({ bytes: derivative, mimeType: "image/png", mode: "sharp", width: 1, height: 1 }) }).runOnce();
  await Bun.sleep(2);
  await workerWithPreprocessor({ extract: async (input) => { repeatedKeys.push(input.idempotencyKey); return { annotation: valid(), rawResponse: "raw", model: "mock" }; } }, { preprocess: async () => ({ bytes: derivative, mimeType: "image/png", mode: "sharp", width: 1, height: 1 }) }).runOnce();
  expect(repeatedKeys[1]).toBe(repeatedKeys[0]);

  const fallback = enqueue();
  setExtractKey(fallback.bill.id, `extract:${fallback.bill.id}:${IMAGE_PREPROCESSING_VERSION}`);
  const fallbackKeys: string[] = []; let attempts = 0;
  const preprocessor: ImagePreprocessor = { preprocess: async () => ++attempts === 1 ? { bytes: derivative, mimeType: "image/png", mode: "sharp", width: 1, height: 1 } : null };
  const provider: MistralOcrProvider = { extract: async (input) => { fallbackKeys.push(input.idempotencyKey); if (fallbackKeys.length === 1) throw new RetryableExtractionError("crash"); return { annotation: valid(), rawResponse: "raw", model: "mock" }; } };
  await workerWithPreprocessor(provider, preprocessor).runOnce();
  await Bun.sleep(2);
  await workerWithPreprocessor(provider, preprocessor).runOnce();
  expect(fallbackKeys).toHaveLength(2);
  expect(fallbackKeys[1]).not.toBe(fallbackKeys[0]);
});

test("HTTP adapter sends original data URL, caption, compatible schema, and does not expose its API key", async () => {
  let request: Request | undefined;
  const adapter = new MistralHttpOcrProvider("super-secret-api-key-value", "mistral-ocr-latest", 1024 * 1024, 1000, async (input, init) => { request = new Request(input, init); return new Response(JSON.stringify({ model: "mistral-ocr-response-model", document_annotation: JSON.stringify(valid()), pages: [{ markdown: "Vendor", confidence_scores: { word_confidence_scores: [{ text: "Vendor", confidence: 0.8, start_index: 0 }] }, tables: [{ content: "Total 11", word_confidence_scores: [{ text: "Total", confidence: 0.6, start_index: 0 }, { text: "11", confidence: 0.5, start_index: 6 }] }] }] })); });
  const fixtureBytes = readFileSync(join(import.meta.dir, "fixtures", "bill.pdf"));
  const response = await adapter.extract({ bytes: fixtureBytes, mimeType: "application/pdf", caption: "فاتورة", idempotencyKey: "extract:fixture:0" });
  const body = await request!.json() as Record<string, any>;
  expect(request!.headers.get("authorization")).toBe("Bearer super-secret-api-key-value");
  expect(request!.headers.get("idempotency-key")).toBe("extract:fixture:0");
  expect(body.document.document_url).toBe(`data:application/pdf;base64,${Buffer.from(fixtureBytes).toString("base64")}`);
  expect(body.document_annotation_format).toEqual({ type: "json_schema", json_schema: { name: "ExtractedBill", schema: extractedBillJsonSchema } });
  expect(body.document_annotation_format.json_schema.schema).toEqual(extractedBillJsonSchema);
  expect(body.document_annotation_prompt).toContain("فاتورة");
  expect(body.document_annotation_prompt).toContain("<untrusted_caption>");
  expect(extractionPrompt).toContain("schemaVersion 1");
  expect(body.table_format).toBe("html");
  expect(body.include_blocks).toBe(false);
  expect(body.confidence_scores_granularity).toBe("word");
  expect(response.annotation).toEqual(valid());
  expect(response.model).toBe("mistral-ocr-response-model");
  expect(response.nativeConfidence).toMatchObject({ segments: [expect.objectContaining({ text: "Vendor" }), expect.objectContaining({ text: "Total 11" })] });
});

test("derives required field confidence only from bounded native OCR word scores and source-text offsets", () => {
  const markdown = "Vendor\nDate 2026-08-28\nTotal 11.00";
  const evidence = parseMistralNativeConfidence({ pages: [{ markdown, confidence_scores: { word_confidence_scores: [
    { text: "Vendor", confidence: 0.97, start_index: 0 },
    { text: "2026-08-28", confidence: 0.83, start_index: markdown.indexOf("2026-08-28") },
  ] }, tables: [{ content: "Total 11.00", confidence_scores: { word_confidence_scores: [
    { text: "Total", confidence: 0.91, start_index: 0 },
    { text: "11.00", confidence: 0.72, start_index: 6 },
  ] } }] }] });
  const normalized = attachMistralNativeConfidence(parseProviderExtractedBill(valid({ fields: {
    vendorName: { confidence: 1, sourceText: "Vendor" }, invoiceDate: { confidence: 1, sourceText: "2026-08-28" }, total: { confidence: 1, sourceText: "11.00" },
  } })), evidence);
  expect(normalized.fields).toMatchObject({
    vendorName: { confidence: 0.97, sourceText: "Vendor" },
    invoiceDate: { confidence: 0.83, sourceText: "2026-08-28" },
    total: { confidence: 0.72, sourceText: "11.00" },
  });
});

test("ignores malformed, unbounded, and non-matching native OCR evidence without synthesizing confidence", () => {
  const annotation = parseProviderExtractedBill(valid({ fields: { total: { confidence: 1, sourceText: "11.00" } } }));
  const malformed = parseMistralNativeConfidence({ pages: [{ markdown: "Total 11.00", confidence_scores: { word_confidence_scores: [{ text: "11.00", confidence: 2, start_index: 6 }] } }] });
  const mismatched = parseMistralNativeConfidence({ pages: [{ markdown: "Total 11.00", confidence_scores: { word_confidence_scores: [{ text: "invented", confidence: 0.99, start_index: 6 }] } }] });
  const oversized = parseMistralNativeConfidence({ pages: Array.from({ length: 101 }, () => ({ markdown: "Total 11.00", confidence_scores: { word_confidence_scores: [] } })) });
  for (const evidence of [malformed, mismatched, oversized, null]) expect(attachMistralNativeConfidence(annotation, evidence).fields.total).toEqual({ confidence: null, sourceText: "11.00" });
});

test("structured extraction instructions cover independent bilingual photographed fields", () => {
  expect(extractionPrompt).toContain("Extract each field independently");
  expect(extractionPrompt).toContain("YYYY/M/D");
  expect(extractionPrompt).toContain("D/M/YYYY");
  expect(extractionPrompt).toContain("٧٠");
  expect(extractionPrompt).toContain("bottom Total/الإجمالي");
  expect(extractedBillJsonSchema).toMatchObject({
    properties: {
      invoiceDate: {
        anyOf: [{ description: expect.stringContaining("YYYY/M/D") }, { type: "null" }],
      },
    },
  });
});

test("HTTP adapter accepts only supported original MIME types", async () => {
  const documents: Array<{ type: string }> = [];
  const adapter = new MistralHttpOcrProvider("key", "model", 1024, 1000, async (input, init) => {
    documents.push((await new Request(input, init).json() as { document: { type: string } }).document);
    return new Response(JSON.stringify({ model: "actual", document_annotation: JSON.stringify(valid()) }));
  });
  for (const [mimeType, type] of [["image/jpeg", "image_url"], ["image/png", "image_url"], ["image/webp", "image_url"], ["application/pdf", "document_url"]] as const) {
    await adapter.extract({ bytes: new Uint8Array([1]), mimeType, caption: null, idempotencyKey: mimeType });
    expect(documents.at(-1)?.type).toBe(type);
  }
  for (const mimeType of ["image/gif", "__proto__", "constructor"]) {
    await expect(adapter.extract({ bytes: new Uint8Array([1]), mimeType, caption: null, idempotencyKey: mimeType })).rejects.toBeInstanceOf(PermanentJobError);
  }
});

test("provider schema uses only closed objects instead of an unsupported dynamic field map", () => {
  const serialized = JSON.stringify(extractedBillJsonSchema);
  expect(serialized).not.toContain('"confidence"');
  expect(serialized).not.toContain('"propertyNames"');
  expect(serialized).not.toContain('"maxProperties"');
  expect(extractedBillJsonSchema).toMatchObject({
    properties: {
      fields: {
        type: "object",
        additionalProperties: false,
        required: ["vendorName", "invoiceDate", "total"],
      },
    },
  });
});

test("HTTP adapter uses image_url for image originals and bounds response and deadline", async () => {
  let imageBody: Record<string, any> | undefined;
  const image = new MistralHttpOcrProvider("key", "model", 1024, 1000, async (_input, init) => { imageBody = JSON.parse(init!.body as string) as Record<string, any>; return new Response(JSON.stringify({ model: "actual", document_annotation: JSON.stringify(valid()) })); });
  await image.extract({ bytes: new Uint8Array([1]), mimeType: "image/png", caption: null, idempotencyKey: "image-key" });
  expect(imageBody?.document).toEqual({ type: "image_url", image_url: "data:image/png;base64,AQ==" });
  const oversized = new MistralHttpOcrProvider("key", "model", 2, 1000, async () => new Response("abc"));
  await expect(oversized.extract({ bytes: new Uint8Array(), mimeType: "image/png", caption: null, idempotencyKey: "large" })).rejects.toThrow("size limit");
  const timeout = new MistralHttpOcrProvider("key", "model", 1024, 1, async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }));
  await expect(timeout.extract({ bytes: new Uint8Array(), mimeType: "image/png", caption: null, idempotencyKey: "timeout" })).rejects.toThrow("timeout");
  let completedSignal: AbortSignal | undefined;
  const completes = new MistralHttpOcrProvider("key", "model", 1024, 1, async (_input, init) => { completedSignal = init?.signal ?? undefined; return new Response(JSON.stringify({ model: "actual", document_annotation: JSON.stringify(valid()) })); });
  await completes.extract({ bytes: new Uint8Array(), mimeType: "image/png", caption: null, idempotencyKey: "complete" });
  await Bun.sleep(5);
  expect(completedSignal?.aborted).toBe(false);
  let rejectedSignal: AbortSignal | undefined;
  const rejectsImmediately = new MistralHttpOcrProvider("key", "model", 1024, 1, async (_input, init) => { rejectedSignal = init?.signal ?? undefined; throw new Error("offline"); });
  await expect(rejectsImmediately.extract({ bytes: new Uint8Array(), mimeType: "image/png", caption: null, idempotencyKey: "reject" })).rejects.toThrow("network failure");
  await Bun.sleep(5);
  expect(rejectedSignal?.aborted).toBe(false);
});

test("oversized persisted originals fail permanently before calling the provider", async () => {
  const bill = enqueue();
  writeFileSync(bill.bill.originalPath, new Uint8Array([1, 2, 3]));
  let calls = 0;
  const provider: MistralOcrProvider = { extract: async () => { calls += 1; return { annotation: valid(), rawResponse: "raw", model: "model" }; } };
  const limited = new JobWorker(database, { extract: createExtractJobHandler(database, provider, policy.maxAttempts, () => undefined, originals(2)) }, policy, "size", createLogger("error"));
  await limited.runOnce();
  expect(calls).toBe(0);
  expect(database.getBill(bill.bill.id)?.status).toBe("needs_review");
});

test.each([
  ["missing", (bill: { originalPath: string }) => rmSync(bill.originalPath)],
  ["replaced bytes", (bill: { originalPath: string }) => writeFileSync(bill.originalPath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 99]))],
  ["symlink", (bill: { originalPath: string }) => { const outside = join(directory, "outside.png"); writeFileSync(outside, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])); rmSync(bill.originalPath); symlinkSync(outside, bill.originalPath); }],
  ["outside root path", (bill: { id: string }) => { const outside = join(directory, "outside.png"); writeFileSync(outside, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])); database.sqlite.query("UPDATE bills SET original_path = ? WHERE id = ?").run(outside, bill.id); }],
  ["MIME mismatch", (bill: { id: string }) => database.sqlite.query("UPDATE bills SET mime_type = ? WHERE id = ?").run("application/pdf", bill.id)],
])("makes %s original verification failures reviewable permanent jobs without provider access", async (_name, corrupt) => {
  const bill = enqueue();
  corrupt(bill.bill);
  let calls = 0;
  await worker({ extract: async () => { calls += 1; return { annotation: valid(), rawResponse: "raw", model: "model" }; } }).runOnce();
  const job = database.getJob(database.sqlite.query<{ id: string }, [string]>("SELECT id FROM jobs WHERE bill_id = ?").get(bill.bill.id)!.id)!;
  const audit = database.sqlite.query<{ error_details: string; raw_provider_response: string | null; provider_model: string | null }, [string]>("SELECT error_details, raw_provider_response, provider_model FROM extraction_attempts WHERE bill_id = ?").get(bill.bill.id)!;
  expect(calls).toBe(0);
  expect(database.getBill(bill.bill.id)?.status).toBe("needs_review");
  expect(job.state).toBe("permanent_failure");
  expect(audit).toEqual({ error_details: "Persisted original verification failed", raw_provider_response: null, provider_model: null });
});

test("does not send an oversized verified original to the provider", async () => {
  const bill = enqueue();
  let calls = 0;
  const limited = new JobWorker(database, { extract: createExtractJobHandler(database, { extract: async () => { calls += 1; return { annotation: valid(), rawResponse: "raw", model: "model" }; } }, policy.maxAttempts, () => undefined, originals(2)) }, policy, "oversize", createLogger("error"));
  await limited.runOnce();
  expect(calls).toBe(0);
  expect(database.getBill(bill.bill.id)?.status).toBe("needs_review");
});

test("replay retries a failed idempotent downstream callback without another provider call", async () => {
  const bill = enqueue();
  let providerCalls = 0;
  let callbackCalls = 0;
  const annotation = valid({ fields: {
    vendorName: { sourceText: "Vendor" }, invoiceDate: { sourceText: "2026-08-28" }, total: { sourceText: "11" },
  } });
  const nativeConfidence = parseMistralNativeConfidence({ pages: [{ markdown: "Vendor 2026-08-28 11", confidence_scores: { word_confidence_scores: [
    { text: "Vendor", confidence: 0.9, start_index: 0 }, { text: "2026-08-28", confidence: 0.9, start_index: 7 }, { text: "11", confidence: 0.9, start_index: 18 },
  ] } }] });
  const provider: MistralOcrProvider = { extract: async () => { providerCalls += 1; return { annotation, rawResponse: "raw", model: "model", nativeConfidence }; } };
  const handler = createExtractJobHandler(database, provider, policy.maxAttempts, async () => { callbackCalls += 1; if (callbackCalls === 1) throw new Error("validation unavailable"); }, originals());
  const replayWorker = new JobWorker(database, { extract: handler }, policy, "callback", createLogger("error"));
  await replayWorker.runOnce();
  await Bun.sleep(2);
  await replayWorker.runOnce();
  expect(providerCalls).toBe(1);
  expect(callbackCalls).toBe(2);
  expect(database.getJob(database.sqlite.query<{ id: string }, [string]>("SELECT id FROM jobs WHERE bill_id = ?").get(bill.bill.id)!.id)?.state).toBe("succeeded");
});

test("skips Azure when all required Mistral native evidence meets the fallback threshold", async () => {
  const bill = enqueue();
  let azureCalls = 0;
  const annotation = valid({ fields: {
    vendorName: { sourceText: "Vendor" }, invoiceDate: { sourceText: "2026-08-28" }, total: { sourceText: "11" },
  } });
  const nativeConfidence = parseMistralNativeConfidence({ pages: [{ markdown: "Vendor 2026-08-28 11", confidence_scores: { word_confidence_scores: [
    { text: "Vendor", confidence: 0.8, start_index: 0 }, { text: "2026-08-28", confidence: 0.8, start_index: 7 }, { text: "11", confidence: 0.8, start_index: 18 },
  ] } }] });
  const azure: AzureInvoiceProvider = { submit: async () => { azureCalls += 1; return { operationLocation: "https://azure.example/result" }; }, poll: async () => { azureCalls += 1; return { classification: "invoice", bill: parseExtractedBill(valid()), rawResponse: "azure", model: "azure" }; } };
  const handler = createExtractJobHandler(database, { extract: async () => ({ annotation, rawResponse: "mistral", model: "mistral", nativeConfidence }) }, policy.maxAttempts, () => undefined, originals(), undefined, azure);
  await new JobWorker(database, { extract: handler }, policy, "fallback", createLogger("error")).runOnce();
  expect(azureCalls).toBe(0);
  expect(database.getExtraction(bill.bill.id)).toMatchObject({ selectedProvider: "mistral", fallbackStatus: "not_needed" });
  expect(database.getExtractionInvocations(bill.bill.id)).toMatchObject([{ provider: "mistral", outcome: "succeeded" }]);
});

test("Azure-only mode invokes Azure directly without creating a Mistral invocation", async () => {
  const bill = enqueue();
  let submissions = 0;
  let polls = 0;
  const azure: AzureInvoiceProvider = {
    submit: async () => { submissions += 1; return { operationLocation: "https://azure.example/operations/direct" }; },
    poll: async () => { polls += 1; return { classification: "invoice", bill: parseAzureExtractedBill(valid({ vendorName: "Azure only", fields: { vendorName: { confidence: 0.99, sourceText: "Azure only" }, invoiceDate: { confidence: 0.99, sourceText: "2026-08-28" }, total: { confidence: 0.99, sourceText: "11" } } })), rawResponse: azureInvoiceRaw("Azure only"), model: "prebuilt-invoice" }; },
  };
  const validate = createExtractionValidationCallback(database, { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 }, () => new Date("2026-08-28T00:00:00.000Z"));
  const handler = createExtractJobHandler(database, null, policy.maxAttempts, validate, originals(), undefined, azure);
  await new JobWorker(database, { extract: handler }, policy, "azure-only", createLogger("error")).runOnce();
  expect({ submissions, polls }).toEqual({ submissions: 1, polls: 1 });
  expect(database.getExtraction(bill.bill.id)).toMatchObject({ selectedProvider: "azure", fallbackStatus: "not_needed", normalized: { vendorName: "Azure only" } });
  expect(database.getBill(bill.bill.id)).toMatchObject({ classification: "invoice", status: "approved" });
  expect(database.getExtractionInvocations(bill.bill.id)).toMatchObject([{ provider: "azure", outcome: "succeeded" }]);
});

test("Azure content-only attached Arabic ISO currency total completes through validation", async () => {
  const bill = enqueue();
  const rawResponse = azureRaw([{ fields: {
    VendorName: { type: "string", valueString: "متجر", content: "متجر" },
    InvoiceDate: { type: "date", valueDate: "2026-08-28", content: "2026-08-28" },
    InvoiceTotal: { type: "currency", content: "١٢٫٥٠٠,٠٠SAR" },
  } }]);
  const azure: AzureInvoiceProvider = {
    submit: async () => ({ operationLocation: "https://azure.example/operations/localized-total" }),
    poll: async () => parseAzureInvoiceAnalysis(rawResponse),
  };
  const validate = createExtractionValidationCallback(database, { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 }, () => new Date("2026-08-28T00:00:00.000Z"));
  await new JobWorker(database, { extract: createExtractJobHandler(database, null, policy.maxAttempts, validate, originals(), undefined, azure) }, policy, "azure-localized-total", createLogger("error")).runOnce();
  expect(database.getExtraction(bill.bill.id)?.normalized).toMatchObject({ total: 12500, currency: "SAR" });
  expect(database.getBill(bill.bill.id)?.status).toBe("approved");
});

test("persisted Azure-only admin uploads bypass configured Mistral while WhatsApp remains Mistral-compatible", async () => {
  const adminBill = (index: number) => {
    const batch = database.createAdminUploadBatch({ idempotencyKey: `admin-batch-${index}`, originalFilename: "invoices.zip" }).batch;
    const item = database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex: 0, entryPath: `invoice-${index}.pdf` }).item;
    const bytes = new TextEncoder().encode(`%PDF-1.7 ${index}`);
    const originalPath = join(directory, "originals", `admin-${index}.pdf`);
    writeFileSync(originalPath, bytes);
    return database.createBillWithInitialJobs({
      whatsappMessageId: `admin-upload:${batch.id}:0`, whatsappGroupId: "admin-upload", whatsappSenderId: "admin-upload", attachmentIndex: 0,
      receivedAt: new Date().toISOString(), mimeType: "application/pdf", originalPath, contentSha256: createHash("sha256").update(bytes).digest("hex"),
      source: "admin_upload", sourceIdentity: `admin-upload:${batch.id}:0`, extractionPolicy: "azure_only", batchItemId: item.id,
    }, [{ type: "extract", idempotencyKey: `extract:admin-${index}` }]).bill;
  };
  const invoice = adminBill(1);
  const notInvoice = adminBill(2);
  const whatsapp = enqueue();
  let mistralCalls = 0;
  let azureSubmissions = 0;
  const mistralAnnotation = valid({ fields: {
    vendorName: { sourceText: "Vendor" }, invoiceDate: { sourceText: "2026-08-28" }, total: { sourceText: "11" },
  } });
  const mistralNativeConfidence = parseMistralNativeConfidence({ pages: [{ markdown: "Vendor 2026-08-28 11", confidence_scores: { word_confidence_scores: [
    { text: "Vendor", confidence: 0.99, start_index: 0 }, { text: "2026-08-28", confidence: 0.99, start_index: 7 }, { text: "11", confidence: 0.99, start_index: 18 },
  ] } }] });
  const azure: AzureInvoiceProvider = {
    submit: async () => ({ operationLocation: `https://azure.example/operations/${++azureSubmissions}` }),
    poll: async ({ operationLocation }) => operationLocation.endsWith("/1")
      ? { classification: "invoice", bill: parseAzureExtractedBill(valid({ vendorName: "Azure upload", fields: { vendorName: { confidence: 0.99, sourceText: "Azure upload" }, invoiceDate: { confidence: 0.99, sourceText: "2026-08-28" }, total: { confidence: 0.99, sourceText: "11" } } })), rawResponse: azureInvoiceRaw("Azure upload"), model: "prebuilt-invoice" }
      : { classification: "not_invoice", bill: parseExtractedBill(valid({ vendorName: null, invoiceNumber: null, invoiceDate: null, currency: null, subtotal: null, vat: null, total: null, description: null, fields: {} })), rawResponse: azureRaw([]), model: "prebuilt-invoice" },
  };
  const validate = createExtractionValidationCallback(database, { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 }, () => new Date("2026-08-28T00:00:00.000Z"));
  const handler = createExtractJobHandler(database, { extract: async () => { mistralCalls += 1; return { annotation: mistralAnnotation, rawResponse: "mistral", model: "mistral", nativeConfidence: mistralNativeConfidence }; } }, policy.maxAttempts, validate, originals(), undefined, azure);
  const extractionWorker = new JobWorker(database, { extract: handler }, policy, "dual-provider", createLogger("error"));
  await extractionWorker.runOnce();
  await extractionWorker.runOnce();
  await extractionWorker.runOnce();

  expect(azureSubmissions).toBe(2);
  expect(mistralCalls).toBe(1);
  expect(database.getExtraction(invoice.id)).toMatchObject({ selectedProvider: "azure", normalized: { vendorName: "Azure upload" } });
  expect(database.getBill(invoice.id)).toMatchObject({ extractionPolicy: "azure_only", classification: "invoice", status: "approved" });
  expect(database.getExtractionInvocations(invoice.id).map((item) => item.provider)).toEqual(["azure"]);
  expect(database.getExtraction(notInvoice.id)).toMatchObject({ selectedProvider: "azure", rawProviderResponse: azureRaw([]) });
  expect(database.getBill(notInvoice.id)).toMatchObject({ classification: "not_invoice", status: "failed", driveFileId: null, sheetRowKey: null });
  expect(database.listJobsForBill(notInvoice.id).map((job) => job.type)).toEqual(["extract"]);
  expect(database.getExtraction(whatsapp.bill.id)).toMatchObject({ selectedProvider: "mistral", normalized: { vendorName: "Vendor" } });
  expect(database.getExtractionInvocations(whatsapp.bill.id).map((item) => item.provider)).toEqual(["mistral"]);
});

test("an incomplete Azure invoice remains invoice and reaches deterministic validation review", async () => {
  const bill = enqueue();
  const validate = createExtractionValidationCallback(database, { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 }, () => new Date("2026-08-28T00:00:00.000Z"));
  const azure: AzureInvoiceProvider = {
    submit: async () => ({ operationLocation: "https://azure.example/operations/incomplete" }),
    poll: async () => ({ classification: "invoice", bill: parseExtractedBill(valid({ vendorName: "Vendor", invoiceDate: null, total: null, fields: {} })), rawResponse: azureRaw([{ fields: { VendorName: { type: "string", valueString: "Vendor" } } }]), model: "prebuilt-invoice" }),
  };
  await new JobWorker(database, { extract: createExtractJobHandler(database, null, policy.maxAttempts, validate, originals(), undefined, azure) }, policy, "azure-incomplete", createLogger("error")).runOnce();
  expect(database.getBill(bill.bill.id)).toMatchObject({ classification: "invoice", status: "needs_review" });
});

test.each([
  ["invoice", azureInvoiceRaw(), "invoice"],
  ["not invoice", azureRaw([]), "not_invoice"],
] as const)("replays a durable Azure %s result after classification crash without polling", async (_name, rawResponse, classification) => {
  const bill = enqueue();
  let submissions = 0;
  let polls = 0;
  const azure: AzureInvoiceProvider = {
    submit: async () => { submissions += 1; return { operationLocation: `https://azure.example/operations/${classification}` }; },
    poll: async () => { polls += 1; return { classification, bill: classification === "invoice" ? parseAzureExtractedBill(valid({ fields: { vendorName: { confidence: 0.99, sourceText: "Vendor" }, invoiceDate: { confidence: 0.99, sourceText: "2026-08-28" }, total: { confidence: 0.99, sourceText: "11" } } })) : parseExtractedBill(valid({ vendorName: null, invoiceNumber: null, invoiceDate: null, currency: null, subtotal: null, vat: null, total: null, description: null, fields: {} })), rawResponse, model: "prebuilt-invoice" }; },
  };
  const transition = database.transitionBillClassification.bind(database);
  let crashed = true;
  database.transitionBillClassification = (input) => crashed ? (crashed = false, false) : transition(input);
  const extractionWorker = new JobWorker(database, { extract: createExtractJobHandler(database, null, policy.maxAttempts, () => undefined, originals(), undefined, azure) }, policy, "azure-replay-classification", createLogger("error"));
  await extractionWorker.runOnce();
  expect(database.getAzureExtractionOperation(database.getExtractionInvocations(bill.bill.id)[0]!.id)).toMatchObject({ state: "succeeded", rawProviderResponse: rawResponse });
  await Bun.sleep(2);
  await extractionWorker.runOnce();
  expect({ submissions, polls }).toEqual({ submissions: 1, polls: 1 });
  expect(database.getBill(bill.bill.id)?.classification).toBe(classification);
});

test("replay treats a persisted malformed Azure document member as retryable output that becomes reviewable when exhausted", async () => {
  const bill = enqueue();
  let polls = 0;
  const rawResponse = azureRaw([null]);
  const azure: AzureInvoiceProvider = {
    submit: async () => ({ operationLocation: "https://azure.example/operations/malformed-replay" }),
    poll: async () => { polls += 1; return { classification: "invoice", bill: parseAzureExtractedBill(valid()), rawResponse, model: "prebuilt-invoice" }; },
  };
  const transition = database.transitionBillClassification.bind(database);
  let crashed = true;
  database.transitionBillClassification = (input) => crashed ? (crashed = false, false) : transition(input);
  const worker = new JobWorker(database, { extract: createExtractJobHandler(database, null, policy.maxAttempts, () => undefined, originals(), undefined, azure) }, policy, "azure-malformed-replay", createLogger("error"));
  await worker.runOnce();
  await Bun.sleep(2);
  await worker.runOnce();
  expect(polls).toBe(1);
  expect(database.getJob(database.listJobsForBill(bill.bill.id)[0]!.id)?.state).toBe("permanent_failure");
  expect(database.getBill(bill.bill.id)?.status).toBe("needs_review");
  expect(database.getLatestExtractionAttempt(bill.bill.id)?.errorDetails).not.toContain(rawResponse);
});

test("Azure-only no-document analysis persists not_invoice without invoking validation", async () => {
  const bill = enqueue();
  let submissions = 0;
  let polls = 0;
  let callbacks = 0;
  const azure: AzureInvoiceProvider = {
    submit: async () => { submissions += 1; return { operationLocation: "https://azure.example/operations/no-invoice" }; },
    poll: async () => { polls += 1; return { classification: "not_invoice", bill: parseExtractedBill(valid({ vendorName: null, invoiceNumber: null, invoiceDate: null, currency: null, subtotal: null, vat: null, total: null, description: null, fields: {} })), rawResponse: "azure-no-invoice", model: "prebuilt-invoice" }; },
  };
  const handler = createExtractJobHandler(database, null, policy.maxAttempts, () => { callbacks += 1; }, originals(), undefined, azure);
  const extractionWorker = new JobWorker(database, { extract: handler }, policy, "azure-no-invoice", createLogger("error"));
  await extractionWorker.runOnce();
  expect({ submissions, polls }).toEqual({ submissions: 1, polls: 1 });
  expect(callbacks).toBe(0);
  expect(database.getExtraction(bill.bill.id)).toMatchObject({ selectedProvider: "azure", fallbackStatus: "not_needed", rawProviderResponse: "azure-no-invoice", normalized: { vendorName: null, invoiceDate: null, total: null } });
  expect(database.getBill(bill.bill.id)).toMatchObject({ classification: "not_invoice", status: "failed" });
  expect(database.getJob(database.listJobsForBill(bill.bill.id).find((job) => job.type === "extract")!.id)?.state).toBe("succeeded");
});

test("Azure fallback exhaustion records a blocking validation issue and preserves sticky review", async () => {
  const bill = enqueue();
  const validate = createExtractionValidationCallback(database, { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 }, () => new Date("2026-08-28T00:00:00.000Z"));
  const handler = createExtractJobHandler(database, { extract: async () => ({ annotation: valid(), rawResponse: "mistral", model: "mistral" }) }, policy.maxAttempts, validate, originals());
  const fallbackWorker = new JobWorker(database, { extract: handler }, policy, "fallback", createLogger("error"));
  await fallbackWorker.runOnce();
  const extractJob = database.listJobsForBill(bill.bill.id).find((job) => job.type === "extract")!;
  expect(database.getBill(bill.bill.id)).toMatchObject({ status: "needs_review" });
  expect(database.getExtraction(bill.bill.id)).toMatchObject({ selectedProvider: "mistral", fallbackStatus: "failed", normalized: { vendorName: "Vendor" } });
  expect(database.getValidationIssues(bill.bill.id)).toContainEqual(expect.objectContaining({ code: "azure_fallback_failed", severity: "blocking" }));
  expect(database.requeueJob(extractJob.id, true)).toBe(false);
});

test("persists an Azure operation before polling, selects Azure, and replays only the callback", async () => {
  const bill = enqueue();
  const inputs: Array<{ bytes: Uint8Array; mimeType: string }> = [];
  let polls = 0;
  let callbacks = 0;
  const azure: AzureInvoiceProvider = {
    submit: async (input) => { inputs.push(input); return { operationLocation: "https://azure.example/operations/1" }; },
    poll: async () => { polls += 1; return { classification: "invoice", bill: parseExtractedBill(valid({ vendorName: "Azure vendor" })), rawResponse: azureInvoiceRaw(), model: "prebuilt-invoice" }; },
  };
  const handler = createExtractJobHandler(database, { extract: async () => ({ annotation: valid(), rawResponse: "mistral", model: "mistral" }) }, policy.maxAttempts, async () => { callbacks += 1; if (callbacks === 1) throw new Error("callback unavailable"); }, originals(), undefined, azure);
  const fallbackWorker = new JobWorker(database, { extract: handler }, policy, "fallback", createLogger("error"));
  await fallbackWorker.runOnce();
  await Bun.sleep(2);
  await fallbackWorker.runOnce();
  expect(inputs).toHaveLength(1);
  expect(polls).toBe(1);
  expect(callbacks).toBe(2);
  expect(inputs[0]!.bytes).toEqual(readFileSync(bill.bill.originalPath));
  expect(database.getExtraction(bill.bill.id)).toMatchObject({ selectedProvider: "azure", fallbackStatus: "succeeded", normalized: { vendorName: "Azure vendor" } });
  expect(database.getExtractionInvocations(bill.bill.id)).toMatchObject([{ provider: "mistral", outcome: "succeeded" }, { provider: "azure", outcome: "succeeded" }]);
  expect(database.getAzureExtractionOperation(database.getExtractionInvocations(bill.bill.id)[1]!.id)).toMatchObject({ state: "succeeded", operationLocation: "https://azure.example/operations/1" });
});

test("replay after Azure submission without a persisted operation URL never resubmits", async () => {
  const bill = enqueue();
  let submissions = 0;
  let polls = 0;
  const azure: AzureInvoiceProvider = {
    submit: async () => { submissions += 1; return { operationLocation: "https://azure.example/operations/submission-window" }; },
    poll: async () => { polls += 1; return { classification: "invoice", bill: parseExtractedBill(valid()), rawResponse: "azure", model: "prebuilt-invoice" }; },
  };
  const persistOperation = database.persistAzureExtractionOperation.bind(database);
  let interrupted = true;
  database.persistAzureExtractionOperation = (input) => interrupted ? (interrupted = false, null) : persistOperation(input);
  const handler = createExtractJobHandler(database, { extract: async () => ({ annotation: valid(), rawResponse: "mistral", model: "mistral" }) }, policy.maxAttempts, () => undefined, originals(), undefined, azure);
  const fallbackWorker = new JobWorker(database, { extract: handler }, policy, "fallback", createLogger("error"));
  await fallbackWorker.runOnce();
  const azureInvocation = database.getExtractionInvocations(bill.bill.id).find((item) => item.provider === "azure")!;
  expect(database.getAzureExtractionOperation(azureInvocation.id)).toMatchObject({ state: "submitting", operationLocation: null });
  await Bun.sleep(2);
  await fallbackWorker.runOnce();
  expect({ submissions, polls }).toEqual({ submissions: 1, polls: 0 });
  expect(database.getBill(bill.bill.id)).toMatchObject({ status: "needs_review" });
  expect(database.getAzureExtractionOperation(azureInvocation.id)).toMatchObject({ state: "failed", operationLocation: null });
});

test("replay completes an invocation from its succeeded Azure operation without provider calls", async () => {
  const bill = enqueue();
  let mistralCalls = 0;
  let submissions = 0;
  let polls = 0;
  const azure: AzureInvoiceProvider = {
    submit: async () => { submissions += 1; return { operationLocation: "https://azure.example/operations/invocation-window" }; },
    poll: async () => { polls += 1; return { classification: "invoice", bill: parseExtractedBill(valid({ vendorName: "Azure vendor" })), rawResponse: azureInvoiceRaw(), model: "prebuilt-invoice" }; },
  };
  const finishInvocation = database.finishExtractionInvocation.bind(database);
  let interrupted = true;
  database.finishExtractionInvocation = (input) => {
    const invocation = database.getExtractionInvocations(bill.bill.id).find((item) => item.id === input.invocationId);
    return interrupted && invocation?.provider === "azure" ? (interrupted = false, false) : finishInvocation(input);
  };
  const handler = createExtractJobHandler(database, { extract: async () => { mistralCalls += 1; return { annotation: valid(), rawResponse: "mistral", model: "mistral" }; } }, policy.maxAttempts, () => undefined, originals(), undefined, azure);
  const fallbackWorker = new JobWorker(database, { extract: handler }, policy, "fallback", createLogger("error"));
  await fallbackWorker.runOnce();
  const azureInvocation = database.getExtractionInvocations(bill.bill.id).find((item) => item.provider === "azure")!;
  expect(database.getAzureExtractionOperation(azureInvocation.id)).toMatchObject({ state: "succeeded", normalized: { vendorName: "Azure vendor" } });
  expect(azureInvocation.outcome).toBe("requested");
  await Bun.sleep(2);
  await fallbackWorker.runOnce();
  expect({ mistralCalls, submissions, polls }).toEqual({ mistralCalls: 1, submissions: 1, polls: 1 });
  expect(database.getExtraction(bill.bill.id)).toMatchObject({ selectedProvider: "azure", normalized: { vendorName: "Azure vendor" } });
  expect(database.getExtractionInvocations(bill.bill.id).find((item) => item.provider === "azure")).toMatchObject({ outcome: "succeeded" });
});

test("replay selects canonical output from a succeeded Azure invocation without provider calls", async () => {
  const bill = enqueue();
  let mistralCalls = 0;
  let submissions = 0;
  let polls = 0;
  const azure: AzureInvoiceProvider = {
    submit: async () => { submissions += 1; return { operationLocation: "https://azure.example/operations/canonical-window" }; },
    poll: async () => { polls += 1; return { classification: "invoice", bill: parseExtractedBill(valid({ vendorName: "Azure vendor" })), rawResponse: azureInvoiceRaw(), model: "prebuilt-invoice" }; },
  };
  const persistCanonical = database.persistCanonicalExtractionSuccess.bind(database);
  let interrupted = true;
  database.persistCanonicalExtractionSuccess = (input) => input.provider === "azure" && interrupted ? (interrupted = false, false) : persistCanonical(input);
  const handler = createExtractJobHandler(database, { extract: async () => { mistralCalls += 1; return { annotation: valid(), rawResponse: "mistral", model: "mistral" }; } }, policy.maxAttempts, () => undefined, originals(), undefined, azure);
  const fallbackWorker = new JobWorker(database, { extract: handler }, policy, "fallback", createLogger("error"));
  await fallbackWorker.runOnce();
  const azureInvocation = database.getExtractionInvocations(bill.bill.id).find((item) => item.provider === "azure")!;
  expect(azureInvocation.outcome).toBe("succeeded");
  expect(database.getExtraction(bill.bill.id)?.normalized?.vendorName).toBe("Vendor");
  await Bun.sleep(2);
  await fallbackWorker.runOnce();
  expect({ mistralCalls, submissions, polls }).toEqual({ mistralCalls: 1, submissions: 1, polls: 1 });
  expect(database.getExtraction(bill.bill.id)).toMatchObject({ selectedProvider: "azure", normalized: { vendorName: "Azure vendor" } });
});

test("retains Mistral output and blocks review after Azure retry exhaustion without resubmitting", async () => {
  const bill = enqueue();
  let submissions = 0;
  let polls = 0;
  const azure: AzureInvoiceProvider = {
    submit: async () => { submissions += 1; return { operationLocation: "https://azure.example/operations/exhausted" }; },
    poll: async () => { polls += 1; throw new RetryableExtractionError("Azure timeout"); },
  };
  const handler = createExtractJobHandler(database, { extract: async () => ({ annotation: valid(), rawResponse: "mistral", model: "mistral" }) }, policy.maxAttempts, () => undefined, originals(), undefined, azure);
  const fallbackWorker = new JobWorker(database, { extract: handler }, policy, "fallback", createLogger("error"));
  await fallbackWorker.runOnce();
  await Bun.sleep(2);
  await fallbackWorker.runOnce();
  expect(submissions).toBe(1);
  expect(polls).toBe(2);
  expect(database.getBill(bill.bill.id)?.status).toBe("needs_review");
  expect(database.getExtraction(bill.bill.id)).toMatchObject({ selectedProvider: "mistral", fallbackStatus: "failed", normalized: { vendorName: "Vendor" } });
  expect(database.getExtractionInvocations(bill.bill.id).find((item) => item.provider === "azure")).toMatchObject({ outcome: "failed" });
});

test("rejects invalid injected Azure output before it becomes canonical", async () => {
  const bill = enqueue();
  const azure: AzureInvoiceProvider = {
    submit: async () => ({ operationLocation: "https://azure.example/operations/invalid" }),
    poll: async () => ({ classification: "invoice", bill: { ...parseExtractedBill(valid()), total: Number.POSITIVE_INFINITY } as unknown as ReturnType<typeof parseExtractedBill>, rawResponse: "invalid azure", model: "prebuilt-invoice" }),
  };
  const singleAttempt = { ...policy, maxAttempts: 1 };
  const handler = createExtractJobHandler(database, { extract: async () => ({ annotation: valid(), rawResponse: "mistral", model: "mistral" }) }, singleAttempt.maxAttempts, () => undefined, originals(), undefined, azure);
  await new JobWorker(database, { extract: handler }, singleAttempt, "fallback", createLogger("error")).runOnce();
  expect(database.getExtraction(bill.bill.id)).toMatchObject({ selectedProvider: "mistral", fallbackStatus: "failed", normalized: { total: 11 } });
  expect(database.getExtractionInvocations(bill.bill.id).find((item) => item.provider === "azure")).toMatchObject({ outcome: "failed" });
});

test("Azure-only malformed output retries, becomes reviewable when exhausted, and stores no raw output in its error", async () => {
  const bill = enqueue();
  let polls = 0;
  const azure: AzureInvoiceProvider = {
    submit: async () => ({ operationLocation: "https://azure.example/operations/malformed" }),
    poll: async () => { polls += 1; return { classification: "invoice", bill: { ...parseExtractedBill(valid()), total: Infinity } as ReturnType<typeof parseExtractedBill>, rawResponse: "azure-private-body", model: "prebuilt-invoice" }; },
  };
  const extractionWorker = new JobWorker(database, { extract: createExtractJobHandler(database, null, policy.maxAttempts, () => undefined, originals(), undefined, azure) }, policy, "azure-malformed", createLogger("error"));
  await extractionWorker.runOnce();
  expect(database.getJob(database.listJobsForBill(bill.bill.id)[0]!.id)?.state).toBe("retryable_failure");
  await Bun.sleep(2);
  await extractionWorker.runOnce();
  expect(polls).toBe(2);
  expect(database.getJob(database.listJobsForBill(bill.bill.id)[0]!.id)?.state).toBe("permanent_failure");
  expect(database.getBill(bill.bill.id)?.status).toBe("needs_review");
  const attempt = database.getLatestExtractionAttempt(bill.bill.id)!;
  expect(attempt.errorDetails).not.toContain("azure-private-body");
  expect(database.getExtraction(bill.bill.id)?.rawProviderResponse).toBe("azure-private-body");
});

test("replaying a terminal Azure fallback failure keeps manual review sticky without provider calls", async () => {
  const bill = enqueue();
  let mistralCalls = 0;
  let azureCalls = 0;
  const annotation = valid({ fields: {
    vendorName: { sourceText: "Vendor" }, invoiceDate: { sourceText: "2026-08-28" }, total: { sourceText: "11" },
  } });
  const nativeConfidence = parseMistralNativeConfidence({ pages: [{ markdown: "Vendor 2026-08-28 11", confidence_scores: { word_confidence_scores: [
    { text: "Vendor", confidence: 0.9, start_index: 0 }, { text: "2026-08-28", confidence: 0.9, start_index: 7 }, { text: "11", confidence: 0.9, start_index: 18 },
  ] } }] });
  const azure: AzureInvoiceProvider = {
    submit: async () => { azureCalls += 1; return { operationLocation: "https://azure.example/operations/failure" }; },
    poll: async () => { azureCalls += 1; throw new RetryableExtractionError("Azure timeout"); },
  };
  const singleAttempt = { ...policy, maxAttempts: 1 };
  const validate = createExtractionValidationCallback(database, { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 }, () => new Date("2026-08-28T00:00:00.000Z"));
  const handler = createExtractJobHandler(database, { extract: async () => { mistralCalls += 1; return { annotation, rawResponse: "mistral", model: "mistral", nativeConfidence }; } }, singleAttempt.maxAttempts, validate, originals(), undefined, azure, 0.95);
  const fallbackWorker = new JobWorker(database, { extract: handler }, singleAttempt, "fallback", createLogger("error"));
  await fallbackWorker.runOnce();
  const extractJob = database.listJobsForBill(bill.bill.id).find((job) => job.type === "extract")!;
  expect(database.getBill(bill.bill.id)).toMatchObject({ status: "needs_review" });
  expect(database.requeueJob(extractJob.id, true)).toBe(true);
  await fallbackWorker.runOnce();
  expect({ mistralCalls, azureCalls }).toEqual({ mistralCalls: 1, azureCalls: 2 });
  expect(database.getBill(bill.bill.id)).toMatchObject({ status: "needs_review" });
  expect(database.listJobsForBill(bill.bill.id).filter((job) => job.type === "project_to_sheet")).toHaveLength(0);
});

test("HTTP adapter classifies transient and auth errors and redacts provider error secrets", async () => {
  const transient = new MistralHttpOcrProvider("key", "model", 1024, 1000, async () => new Response("unavailable", { status: 503 }));
  await expect(transient.extract({ bytes: new Uint8Array(), mimeType: "image/png", caption: null, idempotencyKey: "key" })).rejects.toBeInstanceOf(RetryableExtractionError);
  const auth = new MistralHttpOcrProvider("key", "model", 1024, 1000, async () => new Response("Bearer provider-secret-value-123456", { status: 401 }));
  try {
    await auth.extract({ bytes: new Uint8Array(), mimeType: "image/png", caption: null, idempotencyKey: "key" });
    throw new Error("expected auth error");
  } catch (error) {
    expect(error).toBeInstanceOf(PermanentJobError);
    expect((error as Error).message).not.toContain("provider-secret-value-123456");
  }
});

test("records sanitized failure attempts for read, network, auth, malformed, and lease errors without overwriting success", async () => {
  const slowWorker = (provider: MistralOcrProvider) => new JobWorker(database, { extract: createExtractJobHandler(database, provider, policy.maxAttempts, () => undefined, originals()) }, { ...policy, retryBaseMs: 60_000, retryMaxMs: 60_000 }, "audit-test", createLogger("error"));
  const missing = enqueue();
  rmSync(missing.bill.originalPath);
  await slowWorker({ extract: async () => { throw new Error("not reached"); } }).runOnce();
  const network = enqueue();
  await slowWorker({ extract: async () => { throw new RetryableExtractionError("Bearer a-very-long-provider-secret-value"); } }).runOnce();
  const auth = enqueue();
  await slowWorker({ extract: async () => { throw new PermanentJobError("bad credentials"); } }).runOnce();
  const malformed = enqueue();
  await slowWorker({ extract: async () => ({ annotation: {}, rawResponse: "raw-malformed", model: "actual-malformed-model" }) }).runOnce();
  const audit = database.sqlite.query<{ bill_id: string; outcome: string; provider_model: string | null; error_details: string | null }, []>("SELECT bill_id, outcome, provider_model, error_details FROM extraction_attempts ORDER BY rowid").all();
  expect(audit).toHaveLength(4);
  expect(audit.find((row) => row.bill_id === missing.bill.id)?.error_details).toBe("Persisted original verification failed");
  expect(audit.find((row) => row.bill_id === network.bill.id)?.error_details).not.toContain("a-very-long-provider-secret-value");
  expect(audit.find((row) => row.bill_id === malformed.bill.id)).toMatchObject({ provider_model: "actual-malformed-model" });
  expect(database.getExtraction(malformed.bill.id)?.providerModel).toBe("actual-malformed-model");
  expect(database.getBill(auth.bill.id)?.status).toBe("failed");
});

test("a stale worker cannot overwrite canonical extraction or extraction-attempt state", async () => {
  const bill = enqueue();
  const stale = database.claimNextJob("stale", policy)!;
  let releaseStale: (() => void) | undefined;
  let providerStarted!: () => void;
  const started = new Promise<void>((resolve) => { providerStarted = resolve; });
  let providerCalls = 0;
  const staleBlocked = new Promise<void>((resolve) => { releaseStale = resolve; });
  const provider: MistralOcrProvider = { extract: async () => {
    const call = ++providerCalls;
    if (call === 1) { providerStarted(); await staleBlocked; }
    return { annotation: valid({ vendorName: call === 1 ? "stale" : "canonical" }), rawResponse: "raw", model: "actual-model" };
  } };
  const handler = createExtractJobHandler(database, provider, policy.maxAttempts, () => undefined, originals());
  const staleRun = handler(stale, { idempotencyKey: stale.idempotencyKey, assertLease: () => undefined, assertCurrentApprovalRevision: () => undefined });
  await started;
  database.failJob(stale.id, stale.leaseToken, "expired", policy, new Date());
  const current = database.claimNextJob("current", policy, new Date(Date.now() + 2))!;
  await handler(current, { idempotencyKey: current.idempotencyKey, assertLease: () => undefined, assertCurrentApprovalRevision: () => undefined });
  releaseStale?.();
  await expect(staleRun).rejects.toThrow("lost job lease");
  expect(database.getExtraction(bill.bill.id)?.normalized?.vendorName).toBe("canonical");
  expect(database.sqlite.query<{ count: number }, [string]>("SELECT count(*) AS count FROM extraction_attempts WHERE bill_id = ?").get(bill.bill.id)?.count).toBe(1);
});

test("an expired but unreaped lease cannot persist canonical extraction or review status", () => {
  const bill = enqueue();
  const claim = database.claimNextJob("expired", policy)!;
  database.markBillExtracting(bill.bill.id);
  database.sqlite.query("UPDATE jobs SET lease_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1).toISOString(), claim.id);
  const common = { billId: bill.bill.id, jobId: claim.id, leaseToken: claim.leaseToken, jobAttempt: claim.attempts, promptSchemaVersion: "test", requestedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
  expect(database.persistExtractionSuccess({ ...common, normalized: parseExtractedBill(valid()), rawProviderResponse: "raw", providerModel: "model" })).toBe(false);
  expect(database.persistExtractionFailure({ ...common, rawProviderResponse: "bad", providerModel: "model", errorDetails: "bad", status: "needs_review" })).toBe(false);
  expect(database.getExtraction(bill.bill.id)).toBeNull();
  expect(database.getBill(bill.bill.id)?.status).toBe("extracting");
  expect(database.sqlite.query<{ count: number }, [string]>("SELECT count(*) AS count FROM extraction_attempts WHERE bill_id = ?").get(bill.bill.id)?.count).toBe(0);
});
