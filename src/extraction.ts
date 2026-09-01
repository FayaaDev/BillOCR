import { createHash } from "node:crypto";
import type { ClaimedJob, ExtractedBill, FieldEvidence, JobHandler, JobHandlerContext } from "./contracts";
import type { BillDatabase } from "./database";
import { AzureMalformedInvoiceOutputError, parseAzureInvoiceAnalysis, type AzureInvoiceProvider } from "./azure-invoice";
import { RetryableExtractionError } from "./extraction-errors";
import { IMAGE_PREPROCESSING_VERSION, isPreprocessableMimeType, type ImagePreprocessor } from "./image-preprocessing";
import { OriginalVerificationError, readVerifiedOriginal } from "./originals";
import { PermanentJobError } from "./worker";

export { RetryableExtractionError } from "./extraction-errors";

export const EXTRACTED_BILL_SCHEMA_VERSION = "1";
export const AZURE_INVOICE_PROMPT_VERSION = "prebuilt-invoice-2024-11-30";
const MAX_VENDOR_LENGTH = 512;
const MAX_INVOICE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_SOURCE_TEXT_LENGTH = 2_000;
const MAX_FIELD_KEY_LENGTH = 64;
const MAX_FIELDS = 50;
const noImagePreprocessor: ImagePreprocessor = { preprocess: async () => null };

export class PermanentExtractionInputError extends PermanentJobError {}
export class MalformedStructuredOutputError extends RetryableExtractionError {
  constructor(message: string, readonly rawProviderResponse: string, readonly providerModel: string | null = null) { super(message); }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function nullableValue(value: unknown, name: string, predicate: (value: unknown) => boolean): void {
  if (value !== null && !predicate(value)) throw new Error(`${name} has an invalid value`);
}
function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

/** Strict runtime guard for Azure's bounded structured output. */
export function parseExtractedBill(value: unknown): ExtractedBill {
  const parsed = object(value, "ExtractedBill");
  const keys = ["schemaVersion", "vendorName", "invoiceNumber", "invoiceDate", "currency", "subtotal", "vat", "total", "description", "fields"];
  if (Object.keys(parsed).length !== keys.length || Object.keys(parsed).some((key) => !keys.includes(key))) throw new Error("ExtractedBill has unknown or missing fields");
  if (parsed.schemaVersion !== EXTRACTED_BILL_SCHEMA_VERSION) throw new Error("ExtractedBill schemaVersion must be 1");
  nullableValue(parsed.vendorName, "vendorName", (item) => typeof item === "string" && item.trim().length > 0 && item.length <= MAX_VENDOR_LENGTH);
  nullableValue(parsed.invoiceNumber, "invoiceNumber", (item) => typeof item === "string" && item.trim().length > 0 && item.length <= MAX_INVOICE_LENGTH);
  nullableValue(parsed.description, "description", (item) => typeof item === "string" && item.trim().length > 0 && item.length <= MAX_DESCRIPTION_LENGTH);
  nullableValue(parsed.invoiceDate, "invoiceDate", (item) => typeof item === "string" && validIsoDate(item));
  nullableValue(parsed.currency, "currency", (item) => typeof item === "string" && /^[A-Z]{3}$/.test(item));
  for (const key of ["subtotal", "vat", "total"]) nullableValue(parsed[key], key, (item) => typeof item === "number" && Number.isFinite(item));
  const fields = object(parsed.fields, "fields");
  if (Object.keys(fields).length > MAX_FIELDS) throw new Error("fields has too many entries");
  const normalizedFields: Record<string, FieldEvidence> = {};
  for (const [field, metadata] of Object.entries(fields)) {
    if (!field || field.length > MAX_FIELD_KEY_LENGTH || field === "handwritten") throw new Error("fields has invalid key");
    const entry = object(metadata, `fields.${field}`);
    if (!(Object.keys(entry).every((key) => key === "sourceText" || key === "confidence") && "sourceText" in entry && (entry.sourceText === null || (typeof entry.sourceText === "string" && !!entry.sourceText && entry.sourceText.length <= MAX_SOURCE_TEXT_LENGTH)))) throw new Error(`fields.${field} has invalid metadata`);
    const confidence = entry.confidence;
    normalizedFields[field] = { sourceText: entry.sourceText as string | null, confidence: typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null };
  }
  return { ...parsed, fields: normalizedFields } as unknown as ExtractedBill;
}

export function parseAzureExtractedBill(value: unknown): ExtractedBill { return parseExtractedBill(value); }

/** Replays a completed Azure operation from its immutable provider response, never bill state. */
function parsePersistedAzureOperation(rawProviderResponse: string | null, providerModel: string | null): { normalized: ExtractedBill; classification: "invoice" | "not_invoice" } {
  if (!rawProviderResponse || !providerModel) throw new RetryableExtractionError("Completed Azure operation is missing its result");
  try {
    const parsed = parseAzureInvoiceAnalysis(rawProviderResponse);
    return { normalized: parseAzureExtractedBill(parsed.bill), classification: parsed.classification };
  } catch (error) {
    if (error instanceof AzureMalformedInvoiceOutputError) throw new MalformedStructuredOutputError(error.message, rawProviderResponse, providerModel);
    throw new MalformedStructuredOutputError(error instanceof Error ? error.message : "Completed Azure operation has invalid structured output", rawProviderResponse, providerModel);
  }
}
function sanitizeErrorDetails(error: string): string { return error.slice(0, 500).replace(/(?:bearer\s+)?[A-Za-z0-9._-]{20,}/gi, "[REDACTED]"); }

export function createExtractJobHandler(database: BillDatabase, azureProvider: AzureInvoiceProvider, maxAttempts: number, onExtracted: (billId: string) => Promise<void> | void = () => undefined, originals: { root: string; maxBytes: number }, preprocessor: ImagePreprocessor = noImagePreprocessor): JobHandler {
  return async (job: ClaimedJob, context: JobHandlerContext): Promise<void> => {
    const bill = database.getBill(job.billId);
    if (!bill) throw new PermanentJobError("Extract job references a missing bill");
    context.assertLease();
    if (bill.classification === "not_invoice") return;
    database.markBillExtracting(bill.id);
    const requestedAt = new Date().toISOString();
    const existing = database.getExtraction(bill.id);
    let canonicalPersisted = existing?.normalized != null;
    let rawProviderResponse: string | null = null;
    let providerModel: string | null = null;
    let invocationId: string | null = null;
    let operationPersisted = false;
    const completedAt = () => new Date().toISOString();
    const failure = (error: unknown, status?: "needs_review" | "failed", supersedeApproved = false) => database.persistExtractionFailure({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts, rawProviderResponse, providerModel, promptSchemaVersion: AZURE_INVOICE_PROMPT_VERSION, requestedAt, completedAt: completedAt(), errorDetails: sanitizeErrorDetails(error instanceof Error ? error.message : String(error)), status, supersedeApproved });
    try {
      if (canonicalPersisted) {
        context.assertLease();
        await onExtracted(bill.id);
        return;
      }
      let originalBytes: Uint8Array;
      try { originalBytes = (await readVerifiedOriginal({ path: bill.originalPath, root: originals.root, maxBytes: originals.maxBytes, sha256: bill.contentSha256, mimeType: bill.mimeType, requireMagic: true })).bytes; }
      catch (error) { if (error instanceof OriginalVerificationError) throw new PermanentExtractionInputError("Persisted original verification failed"); throw error; }
      let bytes = originalBytes;
      let mimeType = bill.mimeType;
      if (context.idempotencyKey.endsWith(`:${IMAGE_PREPROCESSING_VERSION}`) && isPreprocessableMimeType(mimeType)) {
        try { const derivative = await preprocessor.preprocess({ bytes: originalBytes, mimeType, mode: "sharp" }); if (derivative) { bytes = derivative.bytes; mimeType = derivative.mimeType; } } catch { /* optional in-memory optimization */ }
      }
      const inputHash = createHash("sha256").update(bytes).digest("hex");
      let idempotencyKey = `${context.idempotencyKey}:azure:input:${inputHash}`;
      let operation = database.getResumableAzureExtractionOperation(bill.id) ?? database.getSucceededAzureExtractionOperation(bill.id) ?? database.getSubmittingAzureExtractionOperation(bill.id);
      let invocationAttempt: number;
      let azureRequestedAt: string;
      let invocationOutcome: "requested" | "succeeded" | "failed";
      if (operation) {
        invocationId = operation.invocationId;
        const invocation = database.getExtractionInvocations(bill.id).find((item) => item.id === invocationId);
        if (!invocation) throw new RetryableExtractionError("Azure operation is missing its invocation");
        idempotencyKey = invocation.idempotencyKey;
        invocationAttempt = invocation.jobAttempt;
        azureRequestedAt = invocation.requestedAt;
        invocationOutcome = invocation.outcome;
        operationPersisted = true;
        if (operation.state === "submitting") throw new PermanentJobError("Azure submission outcome is unknown after restart");
      } else {
        const begun = database.beginExtractionInvocation({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: job.attempts, provider: "azure", idempotencyKey, jobIdempotencyKey: context.idempotencyKey, providerModel: "prebuilt-invoice", promptSchemaVersion: AZURE_INVOICE_PROMPT_VERSION, requestedAt });
        if (!begun) throw new RetryableExtractionError("Azure invocation lost job lease");
        invocationId = begun.invocation.id;
        invocationAttempt = begun.invocation.jobAttempt;
        azureRequestedAt = begun.invocation.requestedAt;
        invocationOutcome = begun.invocation.outcome;
        const submission = database.beginAzureExtractionSubmission({ invocationId, billId: bill.id, jobId: job.id, leaseToken: job.leaseToken });
        if (!submission) throw new RetryableExtractionError("Azure submission persistence lost job lease");
        if (!submission.created) throw new PermanentJobError("Azure submission outcome is unknown after restart");
        operation = submission.operation;
        operationPersisted = true;
        context.assertLease();
        const submitted = await azureProvider.submit({ bytes, mimeType });
        if (!database.persistAzureExtractionOperation({ invocationId, billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, operationLocation: submitted.operationLocation })) throw new RetryableExtractionError("Azure operation persistence lost job lease");
        operation = database.getAzureExtractionOperation(invocationId);
        if (!operation) throw new RetryableExtractionError("Azure operation persistence failed");
      }
      let normalized: ExtractedBill;
      let classification: "invoice" | "not_invoice";
      if (operation.state === "succeeded") {
        const replayed = parsePersistedAzureOperation(operation.rawProviderResponse, operation.providerModel);
        normalized = replayed.normalized; classification = replayed.classification; rawProviderResponse = operation.rawProviderResponse; providerModel = operation.providerModel;
      } else {
        if (!operation.operationLocation) throw new RetryableExtractionError("Azure operation is missing its location");
        context.assertLease();
        const result = await azureProvider.poll({ operationLocation: operation.operationLocation });
        rawProviderResponse = result.rawResponse; providerModel = result.model; classification = result.classification;
        try { normalized = parseAzureExtractedBill(result.bill); } catch (error) { throw new MalformedStructuredOutputError(error instanceof Error ? error.message : "Invalid Azure invoice output", result.rawResponse, result.model); }
        context.assertLease();
        if (!database.finishAzureExtractionOperation({ invocationId, jobId: job.id, leaseToken: job.leaseToken, state: "succeeded", completedAt: completedAt(), normalized, rawProviderResponse, providerModel })) throw new RetryableExtractionError("Azure operation completion lost job lease");
      }
      context.assertLease();
      const currentBill = database.getBill(bill.id);
      if (!currentBill) throw new PermanentJobError("Extract job references a missing bill");
      if (currentBill.classification === "unclassified" && !database.transitionBillClassification({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, classification, actor: "azure_document_intelligence", reason: "prebuilt-invoice", expectedContentRevision: currentBill.contentRevision, expectedReviewRevision: currentBill.reviewRevision })) throw new RetryableExtractionError("Azure classification persistence lost job lease");
      if (currentBill.classification !== "unclassified" && currentBill.classification !== classification) throw new PermanentJobError("Azure classification conflicts with the persisted bill classification");
      if (invocationOutcome === "requested" && !database.finishExtractionInvocation({ invocationId, jobId: job.id, leaseToken: job.leaseToken, outcome: "succeeded", completedAt: completedAt(), rawProviderResponse, errorDetails: null })) throw new RetryableExtractionError("Azure invocation persistence lost job lease");
      if (invocationOutcome === "failed") throw new RetryableExtractionError("Azure operation has a failed invocation");
      if (!database.persistCanonicalExtractionSuccess({ invocationId, billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: invocationAttempt, idempotencyKey, normalized, rawProviderResponse: rawProviderResponse!, providerModel: providerModel!, promptSchemaVersion: AZURE_INVOICE_PROMPT_VERSION, requestedAt: azureRequestedAt, completedAt: completedAt() })) throw new RetryableExtractionError("Azure canonical persistence lost job lease");
      canonicalPersisted = true;
      if (classification === "invoice") await onExtracted(bill.id);
    } catch (error) {
      const terminal = error instanceof PermanentJobError || job.attempts >= maxAttempts;
      if (terminal && invocationId) {
        const errorDetails = sanitizeErrorDetails(error instanceof Error ? error.message : String(error));
        if (operationPersisted) database.finishAzureExtractionOperation({ invocationId, jobId: job.id, leaseToken: job.leaseToken, state: "failed", completedAt: completedAt(), lastError: errorDetails });
        database.finishExtractionInvocation({ invocationId, jobId: job.id, leaseToken: job.leaseToken, outcome: "failed", completedAt: completedAt(), rawProviderResponse, errorDetails });
      }
      if (canonicalPersisted) failure(error, terminal ? "needs_review" : undefined, terminal);
      else if (error instanceof MalformedStructuredOutputError) {
        rawProviderResponse = error.rawProviderResponse; providerModel = error.providerModel;
        failure(error, job.attempts >= maxAttempts ? "needs_review" : undefined);
        if (job.attempts >= maxAttempts) throw new PermanentJobError(error.message);
      } else if (error instanceof PermanentExtractionInputError) failure(error, "needs_review");
      else if (error instanceof PermanentJobError) failure(error, "failed");
      else failure(error, terminal ? "needs_review" : undefined);
      throw error;
    }
  };
}
