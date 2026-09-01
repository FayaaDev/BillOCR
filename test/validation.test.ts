import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimedJob, ExtractedBill } from "../src/contracts";
import { BillDatabase } from "../src/database";
import { createExtractionValidationCallback, parseObservedValue, serializeObservedValue, validateExtractedBill, type ValidationConfig } from "../src/validation";
import { ISO_4217_DATASET_VERSION, currencyMinorUnits, iso4217MinorUnits, knownIso4217Codes, minorUnitPolicy } from "../src/currency";

const config: ValidationConfig = { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 };
const extracted = (overrides: Partial<ExtractedBill> = {}): ExtractedBill => ({
  schemaVersion: "1", vendorName: "Vendor", invoiceNumber: "INV-1", invoiceDate: "2026-08-28", currency: "USD", subtotal: 10, vat: 1, total: 11, description: null,
  fields: { vendorName: { confidence: 0.9, sourceText: "Vendor" }, invoiceDate: { confidence: 0.9, sourceText: "2026-08-28" }, total: { confidence: 0.9, sourceText: "11" } }, ...overrides,
});
const now = new Date("2026-08-28T12:00:00.000Z");
let directory: string;
let database: BillDatabase;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "bill-validation-")); database = new BillDatabase(join(directory, "ledger.sqlite")); });
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

function persistAzureExtraction(billId: string, job: ClaimedJob, normalized: ExtractedBill): void {
  const requestedAt = now.toISOString();
  const invocation = database.beginExtractionInvocation({ billId, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts, provider: "azure", idempotencyKey: job.idempotencyKey, providerModel: "azure-mock", promptSchemaVersion: "prebuilt-invoice", requestedAt });
  if (!invocation) throw new Error("expected Azure invocation");
  expect(database.finishExtractionInvocation({ invocationId: invocation.invocation.id, jobId: job.id, leaseToken: job.leaseToken, outcome: "succeeded", completedAt: requestedAt, rawProviderResponse: "raw", errorDetails: null })).toBe(true);
  expect(database.persistCanonicalExtractionSuccess({ invocationId: invocation.invocation.id, billId, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts, idempotencyKey: job.idempotencyKey, normalized, rawProviderResponse: "raw", providerModel: "azure-mock", promptSchemaVersion: "prebuilt-invoice", requestedAt, completedAt: requestedAt })).toBe(true);
}

test("approves valid totals within configured rounding tolerance", () => {
  expect(validateExtractedBill(extracted({ total: 11.009 }), config, now)).toEqual({ decision: "approved", issues: [] });
});

test("blocks arithmetic and required fields while confidence remains informational", () => {
  expect(validateExtractedBill(extracted({ total: 12 }), config, now).issues).toContainEqual(expect.objectContaining({ code: "total_mismatch", field: "total" }));
  expect(validateExtractedBill(extracted({ vendorName: null }), config, now).issues).toContainEqual(expect.objectContaining({ code: "required_field_missing", field: "vendorName" }));
  for (const confidence of [null, 0, 0.01, 0.79, 1]) expect(validateExtractedBill(extracted({ fields: { vendorName: { confidence, sourceText: "Vendor" }, invoiceDate: { confidence, sourceText: "date" }, total: { confidence, sourceText: "11" } } }), config, now)).toEqual({ decision: "approved", issues: [] });
});

test("blocks invalid dates, unknown currencies, and invalid monetary values defensively", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const result = validateExtractedBill(extracted({ total: value }), config, now);
    expect(result.decision).toBe("needs_review");
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "monetary_value_invalid", field: "total" }));
  }
  expect(validateExtractedBill(extracted({ invoiceDate: "2026-02-30" }), config, now).issues).toContainEqual(expect.objectContaining({ code: "invoice_date_invalid" }));
  expect(validateExtractedBill(extracted({ invoiceDate: "2026-09-28" }), config, now).issues).toContainEqual(expect.objectContaining({ code: "invoice_date_too_future" }));
  expect(validateExtractedBill(extracted({ currency: "ZZZ" }), config, now).issues).toContainEqual(expect.objectContaining({ code: "currency_unknown" }));
});

test("uses exact decimal arithmetic and ISO minor-unit boundaries", () => {
  expect(validateExtractedBill(extracted({ subtotal: 0.1, vat: 0.2, total: 0.3 }), config, now).decision).toBe("approved");
  expect(validateExtractedBill(extracted({ total: 11.01 }), config, now).decision).toBe("approved");
  expect(validateExtractedBill(extracted({ total: 11.0101 }), config, now).issues).toContainEqual(expect.objectContaining({ code: "total_mismatch" }));
  expect(validateExtractedBill(extracted({ currency: "JPY", subtotal: 10, vat: 1, total: 12 }), config, now).decision).toBe("approved");
  expect(validateExtractedBill(extracted({ currency: "JPY", subtotal: 10, vat: 1, total: 12.001 }), config, now).issues).toContainEqual(expect.objectContaining({ code: "total_mismatch" }));
  expect(validateExtractedBill(extracted({ currency: "BHD", subtotal: 10, vat: 1, total: 11.001 }), config, now).decision).toBe("approved");
  expect(validateExtractedBill(extracted({ currency: "BHD", subtotal: 10, vat: 1, total: 11.0011 }), config, now).issues).toContainEqual(expect.objectContaining({ code: "total_mismatch" }));
});

test("uses the versioned ISO policy and JSON-safe observed values", () => {
  expect(ISO_4217_DATASET_VERSION).toBe("iso4217-policy-2025-03");
  expect([currencyMinorUnits("JPY"), currencyMinorUnits("ISK"), currencyMinorUnits("USD"), currencyMinorUnits("KWD"), currencyMinorUnits("CLF"), currencyMinorUnits("UYW")]).toEqual([0, 0, 2, 3, 4, 4]);
  expect(Object.keys(iso4217MinorUnits).sort()).toEqual([...knownIso4217Codes].sort());
  expect(Object.values(iso4217MinorUnits).every((unit) => unit === null || (Number.isInteger(unit) && unit >= 0 && unit <= 4))).toBe(true);
  expect(knownIso4217Codes.has("XDR")).toBe(true);
  expect(knownIso4217Codes.has("XAU")).toBe(false);
  const encoded = serializeObservedValue({ nan: Number.NaN, infinity: Number.POSITIVE_INFINITY, missing: undefined });
  expect(parseObservedValue(encoded)).toEqual({ nan: { $number: "NaN" }, infinity: { $number: "Infinity" }, missing: { $undefined: true } });
  expect(() => JSON.parse(encoded)).not.toThrow();
  expect(() => JSON.parse(serializeObservedValue(() => undefined))).not.toThrow();
});

test("audits declared zero, three, and four-decimal ISO policy lists", () => {
  expect(minorUnitPolicy.zero).toEqual(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"]);
  expect(minorUnitPolicy.three).toEqual(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);
  expect(minorUnitPolicy.four).toEqual(["CLF", "UYW"]);
  expect([...new Set([...minorUnitPolicy.zero, ...minorUnitPolicy.three, ...minorUnitPolicy.four])]).toHaveLength(minorUnitPolicy.zero.length + minorUnitPolicy.three.length + minorUnitPolicy.four.length);
  expect([...minorUnitPolicy.zero, ...minorUnitPolicy.three, ...minorUnitPolicy.four].every((code) => knownIso4217Codes.has(code))).toBe(true);
  expect(currencyMinorUnits("MGA")).toBe(2);
});

test("Phase 2 callback persists and replays one authoritative decision without duplicate jobs or issues", () => {
  const bill = database.createBillWithInitialJobs({ whatsappMessageId: "message", whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: now.toISOString(), mimeType: "image/png", originalPath: "/original", contentSha256: "a".repeat(64) }, [{ type: "extract", idempotencyKey: "extract:message" }]).bill;
  const job = database.claimNextJob("worker", { maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 })!;
  persistAzureExtraction(bill.id, job, extracted());
  const callback = createExtractionValidationCallback(database, config, () => now);
  callback(bill.id);
  callback(bill.id);
  expect(database.getBill(bill.id)?.status).toBe("approved");
  expect(database.getValidationIssues(bill.id)).toEqual([]);
  expect(database.sqlite.query<{ count: number }, [string]>("SELECT count(*) AS count FROM jobs WHERE bill_id = ? AND type = 'archive_to_drive'").get(bill.id)?.count).toBe(1);
  expect(database.sqlite.query<{ count: number }, [string]>("SELECT count(*) AS count FROM jobs WHERE bill_id = ? AND type = 'project_to_sheet'").get(bill.id)?.count).toBe(1);
});

test("needs-review callback persists replacement issues and archives without Sheets projection", () => {
  const bill = database.createBillWithInitialJobs({ whatsappMessageId: "message-2", whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: now.toISOString(), mimeType: "image/png", originalPath: "/original", contentSha256: "b".repeat(64) }, [{ type: "extract", idempotencyKey: "extract:message-2" }]).bill;
  const job = database.claimNextJob("worker", { maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 })!;
  persistAzureExtraction(bill.id, job, extracted({ total: 20 }));
  const callback = createExtractionValidationCallback(database, config, () => now);
  callback(bill.id); callback(bill.id);
  expect(database.getBill(bill.id)?.status).toBe("needs_review");
  expect(database.getValidationIssues(bill.id)).toHaveLength(1);
  expect(database.sqlite.query<{ count: number }, [string]>("SELECT count(*) AS count FROM jobs WHERE bill_id = ? AND type = 'archive_to_drive'").get(bill.id)?.count).toBe(1);
  expect(database.sqlite.query<{ count: number }, [string]>("SELECT count(*) AS count FROM jobs WHERE bill_id = ? AND type = 'project_to_sheet'").get(bill.id)?.count).toBe(0);
});

test("callback rejects a missing extraction without changing a bill to approved", () => {
  const bill = database.createBillWithInitialJobs({ whatsappMessageId: "message-3", whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: now.toISOString(), mimeType: "image/png", originalPath: "/original", contentSha256: "c".repeat(64) }, [{ type: "extract", idempotencyKey: "extract:message-3" }]).bill;
  expect(() => createExtractionValidationCallback(database, config, () => now)(bill.id)).toThrow("missing normalized extraction");
  expect(database.getBill(bill.id)?.status).toBe("received");
});

test("manual-review supersession is sticky until explicit reviewer approval", () => {
  const bill = database.createBillWithInitialJobs({ whatsappMessageId: "message-4", whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: now.toISOString(), mimeType: "image/png", originalPath: "/original", contentSha256: "d".repeat(64) }, [{ type: "extract", idempotencyKey: "extract:message-4" }]).bill;
  const job = database.claimNextJob("worker", { maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 })!;
  persistAzureExtraction(bill.id, job, extracted());
  const snapshot = database.getValidationSnapshot(bill.id)!;
  const decision = validateExtractedBill(snapshot.extraction.normalized!, config, now);
  expect(database.supersedeForReview(bill.id, "reviewer")).toBe(true);
  expect(database.persistValidationDecision({ billId: bill.id, expectedContentRevision: snapshot.contentRevision, expectedReviewRevision: snapshot.reviewRevision, decision: decision.decision, issues: decision.issues })).toBe(false);
  expect(database.getBill(bill.id)?.status).toBe("needs_review");
  const callback = createExtractionValidationCallback(database, config, () => now);
  callback(bill.id);
  expect(database.getBill(bill.id)).toMatchObject({ status: "needs_review", contentRevision: 2, reviewRevision: 1 });
  const review = database.getBill(bill.id)!;
  expect(database.approveReviewCorrection({ billId: bill.id, reviewerId: "reviewer", expectedContentRevision: review.contentRevision, expectedReviewRevision: review.reviewRevision })).toBe(true);
  callback(bill.id); // A replay after manual approval still cannot be the authority that approves.
  const project = database.sqlite.query<{ state: string; expected_revision: number; idempotency_key: string }, [string]>("SELECT state, expected_revision, idempotency_key FROM jobs WHERE bill_id = ? AND type = 'project_to_sheet'").get(bill.id)!;
  expect(database.getBill(bill.id)?.status).toBe("approved");
  expect(database.sqlite.query<{ count: number }, [string]>("SELECT count(*) AS count FROM jobs WHERE bill_id = ? AND type = 'project_to_sheet'").get(bill.id)?.count).toBe(1);
  expect(project).toMatchObject({ state: "pending", expected_revision: 2, idempotency_key: `project:${bill.id}:2` });
  expect(database.isApprovedAtRevision(bill.id, project.expected_revision)).toBe(true);
});

test("minor-unit boundaries cover ISK and four-decimal CLF/UYW", () => {
  for (const currency of ["ISK", "CLF", "UYW"]) {
    const unit = currencyMinorUnits(currency)!;
    const tolerance = 10 ** -unit;
    expect(validateExtractedBill(extracted({ currency, subtotal: 10, vat: 1, total: 11 + tolerance }), config, now).decision).toBe("approved");
    expect(validateExtractedBill(extracted({ currency, subtotal: 10, vat: 1, total: 11 + tolerance * 1.1 }), config, now).issues).toContainEqual(expect.objectContaining({ code: "total_mismatch" }));
  }
});

test("MGA uses the two-decimal ISO boundary", () => {
  expect(validateExtractedBill(extracted({ currency: "MGA", subtotal: 10, vat: 1, total: 11.01 }), config, now).decision).toBe("approved");
  expect(validateExtractedBill(extracted({ currency: "MGA", subtotal: 10, vat: 1, total: 11.0101 }), config, now).issues).toContainEqual(expect.objectContaining({ code: "total_mismatch" }));
});

test("an approved project is invalidated before effect when review starts", () => {
  const bill = database.createBillWithInitialJobs({ whatsappMessageId: "message-5", whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: now.toISOString(), mimeType: "image/png", originalPath: "/original", contentSha256: "e".repeat(64) }, [{ type: "extract", idempotencyKey: "extract:message-5" }]).bill;
  const job = database.claimNextJob("worker", { maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 })!;
  persistAzureExtraction(bill.id, job, extracted());
  createExtractionValidationCallback(database, config, () => now)(bill.id);
  const revision = database.getBill(bill.id)!.contentRevision;
  expect(database.supersedeForReview(bill.id, "reviewer")).toBe(true);
  expect(database.sqlite.query<{ state: string }, [string]>("SELECT state FROM jobs WHERE bill_id = ? AND type = 'project_to_sheet'").get(bill.id)?.state).toBe("permanent_failure");
  expect(database.isApprovedAtRevision(bill.id, revision)).toBe(false);
});

test("running old projection keeps its lease while reviewer approval creates one new revision job", () => {
  const policy = { maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 };
  const bill = database.createBillWithInitialJobs({ whatsappMessageId: "message-6", whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: now.toISOString(), mimeType: "image/png", originalPath: "/original", contentSha256: "f".repeat(64) }, [{ type: "extract", idempotencyKey: "extract:message-6" }]).bill;
  const extractJob = database.claimNextJob("extractor", policy)!;
  persistAzureExtraction(bill.id, extractJob, extracted());
  createExtractionValidationCallback(database, config, () => now)(bill.id);
  const old = database.claimNextJob("old-worker", policy, new Date(), ["project_to_sheet"])!;
  expect(old.expectedRevision).toBe(1);
  expect(database.supersedeForReview(bill.id, "reviewer")).toBe(true);
  expect(database.getJob(old.id)).toMatchObject({ state: "running", leaseToken: old.leaseToken, expectedRevision: 1 });
  const revision = database.getBill(bill.id)!;
  expect(database.approveReviewCorrection({ billId: bill.id, reviewerId: "reviewer", expectedContentRevision: revision.contentRevision, expectedReviewRevision: revision.reviewRevision })).toBe(true);
  const next = database.claimNextJob("new-worker", policy, new Date(), ["project_to_sheet"]);
  expect(next).toMatchObject({ expectedRevision: 2, idempotencyKey: `project:${bill.id}:2` });
  expect(database.claimNextJob("other-worker", policy, new Date(), ["project_to_sheet"])).toBeNull();
  expect(database.isApprovedAtRevision(bill.id, old.expectedRevision)).toBe(false);
  expect(database.isApprovedAtRevision(bill.id, next!.expectedRevision)).toBe(true);
});
