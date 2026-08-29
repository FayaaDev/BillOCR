import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase, type RetryPolicy } from "../src/database";
import { createExtractJobHandler, extractedBillJsonSchema, extractionPrompt, groundRequiredFieldConfidence, MistralHttpOcrProvider, type MistralOcrProvider, parseExtractedBill, parseProviderExtractedBill, RetryableExtractionError } from "../src/extraction";
import { createLogger } from "../src/logger";
import { JobWorker } from "../src/worker";
import { PermanentJobError } from "../src/worker";

const policy: RetryPolicy = { maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 2, leaseMs: 60_000 };
let directory: string;
let database: BillDatabase;

const valid = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: "1", vendorName: "Vendor", invoiceNumber: "INV-1", invoiceDate: "2026-08-28", currency: "USD", subtotal: 10, vat: 1, total: 11, description: "items", handwritten: false, fields: { total: { confidence: 0.99, sourceText: "11.00" } }, ...overrides });
function enqueue(mimeType = "image/png", caption: string | null = "caption", bytes = mimeType === "application/pdf" ? new TextEncoder().encode("%PDF-1.7") : new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])) {
  const originalPath = join(directory, "originals", mimeType === "application/pdf" ? "bill.pdf" : "bill.png");
  writeFileSync(originalPath, bytes);
  return database.createBillWithInitialJobs({ whatsappMessageId: `message-${Math.random()}`, whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: new Date().toISOString(), caption, mimeType, originalPath, contentSha256: createHash("sha256").update(bytes).digest("hex") }, [{ type: "extract", idempotencyKey: `extract-${Math.random()}` }]);
}
const originals = (maxBytes = 20 * 1024 * 1024) => ({ root: join(directory, "originals"), maxBytes });
function worker(provider: MistralOcrProvider) { return new JobWorker(database, { extract: createExtractJobHandler(database, provider, policy.maxAttempts, () => undefined, originals()) }, policy, "extract-test", createLogger("error")); }

beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), "bill-extract-"))); mkdirSync(join(directory, "originals")); database = new BillDatabase(join(directory, "ledger.sqlite")); });
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

test.each([
  ["printed English", "image/png", "english.png", valid({ vendorName: "English Store" })],
  ["printed Arabic", "image/png", "arabic.png", valid({ vendorName: "متجر عربي", description: "فاتورة" })],
  ["handwriting", "image/png", "handwriting.png", valid({ handwritten: true, fields: { total: { confidence: 0.9, sourceText: "١١" } } })],
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
  expect(database.getExtraction(bill.bill.id)).toMatchObject({ normalized: annotation, providerModel: "mock-ocr", promptSchemaVersion: "extracted-bill-v2" });
  expect(database.getJob(database.sqlite.query<{ id: string }, [string]>("SELECT id FROM jobs WHERE bill_id = ?").get(bill.bill.id)!.id)?.state).toBe("succeeded");
});

test("rejects invalid JSON/schema and preserves null unknowns", async () => {
  expect(parseExtractedBill(valid({ vendorName: null, invoiceNumber: null, invoiceDate: null, currency: null, subtotal: null, vat: null, total: null, description: null, handwritten: null }))).toMatchObject({ total: null, handwritten: null });
  expect(() => parseExtractedBill({ ...valid(), currency: "usd" })).toThrow("currency");
  expect(() => parseExtractedBill({ ...valid(), unexpected: true })).toThrow("unknown");
  expect(() => parseExtractedBill({ ...valid(), invoiceDate: "2026-02-30" })).toThrow("invoiceDate");
  expect(() => parseExtractedBill({ ...valid(), vendorName: "x".repeat(513) })).toThrow("vendorName");
  expect(() => parseExtractedBill({ ...valid(), fields: { ["x".repeat(65)]: { confidence: 1, sourceText: "text" } } })).toThrow("invalid key");
  expect(() => parseExtractedBill({ ...valid(), fields: { total: { confidence: 1, sourceText: "x".repeat(2_001) } } })).toThrow("invalid metadata");
  const bill = enqueue();
  const provider: MistralOcrProvider = { extract: async () => ({ annotation: { broken: true }, rawResponse: "{not-valid-schema}", model: "mock" }) };
  await worker(provider).runOnce();
  expect(database.getExtraction(bill.bill.id)).toMatchObject({ normalized: null, rawProviderResponse: "{not-valid-schema}" });
  expect(database.getJob(database.sqlite.query<{ id: string }, [string]>("SELECT id FROM jobs WHERE bill_id = ?").get(bill.bill.id)!.id)?.state).toBe("retryable_failure");
});

test("accepts only numeric provider schemaVersion 1 without normalizing accounting fields", () => {
  const providerAnnotation = { ...valid({ schemaVersion: 1, invoiceNumber: "0042", total: 99 }) };
  expect(() => parseExtractedBill(providerAnnotation)).toThrow("schemaVersion");
  expect(parseProviderExtractedBill(providerAnnotation)).toMatchObject({ schemaVersion: "1", invoiceNumber: "0042", total: 99 });
  expect(() => parseProviderExtractedBill(valid({ schemaVersion: 2 }))).toThrow("schemaVersion");
  expect(() => parseProviderExtractedBill(valid({ schemaVersion: "2" }))).toThrow("schemaVersion");
  expect(() => parseProviderExtractedBill({ ...valid(), schemaVersion: null })).toThrow("schemaVersion");
});

test("normalizes explicit legacy confidence aliases but never maps generic date", () => {
  const normalized = parseExtractedBill(valid({ fields: { vendor_name: { confidence: 0.9, sourceText: "Vendor" }, invoice_date: { confidence: 0.9, sourceText: "2026-08-28" }, grand_total: { confidence: 0.9, sourceText: "11" } } }));
  expect(normalized.fields).toMatchObject({ vendorName: { confidence: 0.9 }, invoiceDate: { confidence: 0.9 }, total: { confidence: 0.9 } });
  const generic = parseExtractedBill(valid({ fields: { vendorName: { confidence: 0.9, sourceText: "Vendor" }, date: { confidence: 0.99, sourceText: "2026-08-28" }, total: { confidence: 0.9, sourceText: "11" } } }));
  expect(generic.fields.invoiceDate).toBeUndefined();
});

test("grounds required confidence in position-verified OCR regions without mutating annotation", () => {
  const annotation = parseExtractedBill(valid({ vendorName: "متجر ١٢", fields: {
    vendorName: { confidence: 0.99, sourceText: "متجر ١٢" },
    invoiceDate: { confidence: 0.99, sourceText: "2026-08-28" },
    total: { confidence: 0.99, sourceText: "11.00" },
  } }));
  const text = "متجر 12 Invoice Date: 2026-08-28 Total: 11.00";
  const grounded = groundRequiredFieldConfidence(annotation, { regions: [{ text, words: ["متجر", "12", "2026-08-28", "11.00"].map((word, index) => ({ text: word, confidence: [0.8, 0.7, 0.6, 0.5][index]!, startIndex: text.indexOf(word) })) }] });
  expect(grounded).not.toBe(annotation);
  expect(annotation.fields.vendorName?.confidence).toBe(0.99);
  expect(grounded.fields).toMatchObject({ vendorName: { confidence: 0.7 }, invoiceDate: { confidence: 0.6 }, total: { confidence: 0.5 } });
});

test("sets required confidence to zero when supplied OCR evidence cannot substantiate source text", () => {
  const annotation = parseExtractedBill(valid({ fields: {
    vendorName: { confidence: 0.99, sourceText: "Vendor" },
    invoiceDate: { confidence: 0.99, sourceText: "2026-08-28" },
    total: { confidence: 0.99, sourceText: "11" },
  } }));
  expect(groundRequiredFieldConfidence(annotation, { regions: [{ text: "unrelated", words: [] }] }).fields).toMatchObject({ vendorName: { confidence: 0 }, invoiceDate: { confidence: 0 }, total: { confidence: 0 } });
  expect(groundRequiredFieldConfidence(annotation, { regions: [{ text: "Vendor 2026-08-28 11", words: [] }] }).fields).toMatchObject({ vendorName: { confidence: 0 }, invoiceDate: { confidence: 0 }, total: { confidence: 0 } });
});

test("persists evidence-grounded required confidence while leaving optional mock evidence backward-compatible", async () => {
  const bill = enqueue();
  const annotation = valid({ fields: {
    vendorName: { confidence: 0.99, sourceText: "Vendor" },
    invoiceDate: { confidence: 0.99, sourceText: "2026-08-28" },
    total: { confidence: 0.99, sourceText: "11" },
  } });
  await worker({ extract: async () => ({ annotation, rawResponse: "raw", model: "mock", evidence: { regions: [{ text: "Vendor Invoice Date 2026-08-28 Total 11", words: [{ text: "Vendor", confidence: 0.8, startIndex: 0 }, { text: "2026-08-28", confidence: 0.7, startIndex: 20 }, { text: "11", confidence: 0.6, startIndex: 37 }] }] } }) }).runOnce();
  expect(database.getExtraction(bill.bill.id)?.normalized?.fields).toMatchObject({ vendorName: { confidence: 0.8 }, invoiceDate: { confidence: 0.7 }, total: { confidence: 0.6 } });
});

test("classifies transient provider failures for retry and malformed exhaustion for review", async () => {
  const malformed = enqueue();
  let calls = 0;
  const malformedProvider: MistralOcrProvider = { extract: async () => { calls += 1; return { annotation: {}, rawResponse: "bad", model: "mock" }; } };
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
  expect(response.evidence).toEqual({ regions: [{ text: "Vendor", words: [{ text: "Vendor", confidence: 0.8, startIndex: 0 }] }, { text: "Total 11", words: [{ text: "Total", confidence: 0.6, startIndex: 0 }, { text: "11", confidence: 0.5, startIndex: 6 }] }] });
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

test("rejects undocumented per-word aliases and grounds their matching source at zero", async () => {
  const adapter = new MistralHttpOcrProvider("key", "model", 1024, 1000, async () => new Response(JSON.stringify({ model: "actual", document_annotation: JSON.stringify(valid()), pages: [{ markdown: "Vendor", confidence_scores: { word_confidence_scores: [{ word: "Vendor", confidence_score: 0.9, start_index: 0 }] } }] })));
  const response = await adapter.extract({ bytes: new Uint8Array([1]), mimeType: "image/png", caption: null, idempotencyKey: "aliases" });
  const annotation = parseExtractedBill(valid({ fields: { vendorName: { confidence: 0.99, sourceText: "Vendor" }, invoiceDate: { confidence: 0.99, sourceText: "missing date" }, total: { confidence: 0.99, sourceText: "missing total" } } }));
  expect(response.evidence).toEqual({ regions: [{ text: "Vendor", words: [] }] });
  expect(groundRequiredFieldConfidence(annotation, response.evidence!).fields.vendorName?.confidence).toBe(0);
});

test("requires semantic source support, preserves monetary punctuation, and grounds table-only totals", () => {
  const base = parseExtractedBill(valid({ fields: { vendorName: { confidence: 0.99, sourceText: "Vendor" }, invoiceDate: { confidence: 0.99, sourceText: "٢٨/٠٨/٢٠٢٦" }, total: { confidence: 0.99, sourceText: "Total: 11.00" } } }));
  const evidence = { regions: [
    { text: "Vendor التاريخ: ٢٨/٠٨/٢٠٢٦", words: [{ text: "Vendor", confidence: 0.8, startIndex: 0 }, { text: "٢٨/٠٨/٢٠٢٦", confidence: 0.7, startIndex: 16 }] },
    { text: "Total: 11.00", words: [{ text: "Total:", confidence: 0.9, startIndex: 0 }, { text: "11.00", confidence: 0.6, startIndex: 7 }] },
  ] };
  expect(groundRequiredFieldConfidence(base, evidence).fields).toMatchObject({ vendorName: { confidence: 0.8 }, invoiceDate: { confidence: 0.7 }, total: { confidence: 0.6 } });
  expect(groundRequiredFieldConfidence(parseExtractedBill(valid({ total: 12, fields: { ...base.fields, total: { confidence: 0.99, sourceText: "Total: 11.00" } } })), evidence).fields.total?.confidence).toBe(0);
  expect(groundRequiredFieldConfidence(parseExtractedBill(valid({ fields: { ...base.fields, total: { confidence: 0.99, sourceText: "Total: 11,00" } } })), evidence).fields.total?.confidence).toBe(0);
  expect(groundRequiredFieldConfidence(parseExtractedBill(valid({ fields: { ...base.fields, total: { confidence: 0.99, sourceText: "1" } } })), { regions: [{ text: "Invoice 1 Total 11.00", words: [{ text: "1", confidence: 0.9, startIndex: 8 }, { text: "1", confidence: 0.2, startIndex: 16 }] }] }).fields.total?.confidence).toBe(0);
  expect(groundRequiredFieldConfidence(parseExtractedBill(valid({ fields: { ...base.fields, total: { confidence: 0.99, sourceText: "11" } } })), { regions: [{ text: "Total: 11 11", words: [{ text: "11", confidence: 0.9, startIndex: 7 }, { text: "11", confidence: 0.2, startIndex: 10 }] }] }).fields.total?.confidence).toBe(0.2);
  expect(groundRequiredFieldConfidence(base, { regions: [{ text: "Total: 11.00", words: [{ text: "11.00", confidence: 0.6, startIndex: 7 }, { text: "Total:", confidence: 0.9, startIndex: 0 }] }] }).fields.total?.confidence).toBe(0.6);
  expect(groundRequiredFieldConfidence(base, { regions: [{ text: "Total: 11.00", words: [{ text: "Total:", confidence: 0.9, startIndex: 1 }, { text: "11.00", confidence: 0.6, startIndex: 7 }] }] }).fields.total?.confidence).toBe(0);
});

test("requires invoice-date and total labels in nearby plain and HTML table context", () => {
  const fields = { vendorName: { confidence: 0.99, sourceText: "Vendor" }, invoiceDate: { confidence: 0.99, sourceText: "28/08/2026" }, total: { confidence: 0.99, sourceText: "11" } };
  const annotation = parseExtractedBill(valid({ fields }));
  const word = (text: string, confidence = 0.95) => ({ text, confidence, startIndex: textRegion.indexOf(text) });
  let textRegion = "Vendor Invoice Date: 28/08/2026 Total: 11";
  expect(groundRequiredFieldConfidence(annotation, { regions: [{ text: textRegion, words: [word("Vendor"), word("28/08/2026"), word("11")] }] }).fields).toMatchObject({ invoiceDate: { confidence: 0.95 }, total: { confidence: 0.95 } });
  textRegion = "Due Date: 28/08/2026 Unit Price: 11";
  expect(groundRequiredFieldConfidence(annotation, { regions: [{ text: textRegion, words: [word("28/08/2026"), word("11")] }] }).fields).toMatchObject({ invoiceDate: { confidence: 0 }, total: { confidence: 0 } });
  textRegion = "Invoice No: 11 Line Total: 11";
  expect(groundRequiredFieldConfidence(annotation, { regions: [{ text: textRegion, words: [{ text: "11", confidence: 0.99, startIndex: 12 }, { text: "11", confidence: 0.99, startIndex: 27 }] }] }).fields.total?.confidence).toBe(0);
  textRegion = "<tr><td>التاريخ</td><td>28/08/2026</td><td>الإجمالي</td><td>11</td></tr>";
  expect(groundRequiredFieldConfidence(annotation, { regions: [{ text: textRegion, words: [word("28/08/2026"), word("11")] }] }).fields).toMatchObject({ invoiceDate: { confidence: 0.95 }, total: { confidence: 0.95 } });
});

test("provider schema uses only closed objects instead of an unsupported dynamic field map", () => {
  const serialized = JSON.stringify(extractedBillJsonSchema);
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
  const provider: MistralOcrProvider = { extract: async () => { providerCalls += 1; return { annotation: valid(), rawResponse: "raw", model: "model" }; } };
  const handler = createExtractJobHandler(database, provider, policy.maxAttempts, async () => { callbackCalls += 1; if (callbackCalls === 1) throw new Error("validation unavailable"); }, originals());
  const replayWorker = new JobWorker(database, { extract: handler }, policy, "callback", createLogger("error"));
  await replayWorker.runOnce();
  await Bun.sleep(2);
  await replayWorker.runOnce();
  expect(providerCalls).toBe(1);
  expect(callbackCalls).toBe(2);
  expect(database.getJob(database.sqlite.query<{ id: string }, [string]>("SELECT id FROM jobs WHERE bill_id = ?").get(bill.bill.id)!.id)?.state).toBe("succeeded");
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

test("a stale worker records an audit but cannot overwrite canonical extraction success", async () => {
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
  expect(database.sqlite.query<{ count: number }, [string]>("SELECT count(*) AS count FROM extraction_attempts WHERE bill_id = ?").get(bill.bill.id)?.count).toBe(3);
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
});
