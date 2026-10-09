export const jobTypes = ["extract", "archive_to_drive", "project_to_sheet", "sync_review_correction", "archive_to_workdrive", "sync_to_zoho_sheet"] as const;
export type JobType = (typeof jobTypes)[number];

export const jobStates = ["pending", "running", "succeeded", "retryable_failure", "permanent_failure"] as const;
export type JobState = (typeof jobStates)[number];

export type BillStatus = "received" | "extracting" | "needs_review" | "approved" | "failed";
export type BillSource = "whatsapp" | "telegram" | "admin_upload";
export type ExtractionPolicy = "mistral_with_azure_fallback" | "azure_only";
export type BillClassification = "unclassified" | "invoice" | "not_invoice";

/**
 * Stable, unambiguous identity for one attachment in a transport message.
 * `source` is deliberately not embedded: it is the first half of the database
 * uniqueness constraint, and keeping it separate permits source-specific lookup.
 */
export function transportSourceIdentity(sourceChatId: string, sourceMessageId: string, attachmentIndex: number): string {
  return JSON.stringify([sourceChatId, sourceMessageId, attachmentIndex]);
}

/** Case-sensitive filename identity; callers supply a bounded basename, never a path. */
export function filenameKeyFromSourceBasename(sourceFilename: string | null | undefined): string | null {
  if (sourceFilename === null || sourceFilename === undefined) return null;
  const finalDot = sourceFilename.lastIndexOf(".");
  return finalDot > 0 ? sourceFilename.slice(0, finalDot) : sourceFilename;
}

/** A persisted source filename is always a complete, bounded leaf name. */
export function isSourceBasename(sourceFilename: unknown): sourceFilename is string {
  return typeof sourceFilename === "string" && sourceFilename.length > 0 && sourceFilename.length <= 512 && !sourceFilename.includes("/") && !sourceFilename.includes("\\") && !sourceFilename.includes("\0");
}

/** Nullable transport metadata; never coerce provider objects into display text. */
export function sourceSenderText(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) return null;
  return value.trim() || null;
}

/** Read-only dashboard totals derived from canonical bill and job state. Processed means approved. */
export interface DashboardMetrics {
  receivedBills: number;
  approvedBills: number;
  failedBills: number;
  retryableJobs: number;
  permanentFailureJobs: number;
}

export type ExtractionProvider = "mistral" | "azure";
export type ExtractionFallbackStatus = "not_needed" | "pending" | "succeeded" | "failed";

/** Native provider evidence for one normalized field. */
export interface FieldEvidence {
  confidence: number | null;
  sourceText: string | null;
}

/** Provenance for the provider whose result is selected as canonical. */
export interface ExtractionProvenance {
  selectedProvider: ExtractionProvider;
  fallbackStatus: ExtractionFallbackStatus;
}

export interface Bill {
  id: string;
  sourceMessageId: string;
  sourceChatId: string;
  sourceSenderId: string;
  sourceSenderName: string | null;
  sourceSenderUsername: string | null;
  sourceSenderPhoneNumber: string | null;
  attachmentIndex: number;
  receivedAt: string;
  caption: string | null;
  originalFilename: string | null;
  sourceFilename: string | null;
  filenameKey: string | null;
  mimeType: string;
  originalPath: string;
  contentSha256: string;
  status: BillStatus;
  driveFileId: string | null;
  sheetRowKey: string | null;
  createdAt: string;
  updatedAt: string;
  contentRevision: number;
  reviewRevision: number;
  source: BillSource;
  sourceIdentity: string;
  extractionPolicy: ExtractionPolicy;
  classification: BillClassification;
  batchItemId: string | null;
}

export interface ExtractedBill {
  schemaVersion: "1";
  vendorName: string | null;
  vendorTaxNumber?: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string | null;
  subtotal: number | null;
  vat: number | null;
  total: number | null;
  description: string | null;
  truckNumber?: string | null;
  fields: Record<string, FieldEvidence>;
}

export interface Extraction {
  id: string;
  billId: string;
  schemaVersion: string;
  selectedProvider: ExtractionProvider | null;
  fallbackStatus: ExtractionFallbackStatus | null;
  selectedInvocationId: string | null;
  normalized: ExtractedBill | null;
  rawProviderResponse: string | null;
  providerModel: string | null;
  promptSchemaVersion: string | null;
  requestedAt: string | null;
  completedAt: string | null;
  errorDetails: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One provider request, persisted before the external call for durable auditability. */
export interface ExtractionInvocation {
  id: string;
  billId: string;
  jobId: string;
  jobAttempt: number;
  provider: ExtractionProvider;
  idempotencyKey: string;
  providerModel: string | null;
  promptSchemaVersion: string | null;
  requestedAt: string;
  completedAt: string | null;
  outcome: "requested" | "succeeded" | "failed";
  rawProviderResponse: string | null;
  errorDetails: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The durable invocation and whether this caller created it (rather than resumed it). */
export interface BeginExtractionInvocationResult {
  invocation: ExtractionInvocation;
  created: boolean;
}

/** Azure's asynchronous operation reference, retained so polling can resume after a restart. */
export interface AzureExtractionOperation {
  id: string;
  invocationId: string;
  billId: string;
  jobId: string;
  operationLocation: string | null;
  state: "submitting" | "submitted" | "running" | "succeeded" | "failed";
  normalized: ExtractedBill | null;
  rawProviderResponse: string | null;
  providerModel: string | null;
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  id: string;
  billId: string;
  field: string | null;
  code: string;
  message: string;
  severity: "warning" | "error" | "blocking";
  observedValue: string | null;
  createdAt: string;
}

export interface ReviewEvent {
  id: string;
  billId: string;
  reviewerId: string;
  action: string;
  previousValues: string | null;
  correctedValues: string | null;
  reason: string | null;
  note: string | null;
  createdAt: string;
}

export interface EffectiveBillData {
  extraction: ExtractedBill;
  revision: number;
  updatedAt: string;
}

export interface ProviderProjectionMetadata {
  id: string;
  billId: string;
  provider: string;
  projectionKey: string;
  externalId: string | null;
  externalUrl: string | null;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  billId: string;
  type: JobType;
  state: JobState;
  idempotencyKey: string;
  attempts: number;
  availableAt: string;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  expectedRevision: number | null;
}

export interface JobTransition {
  id: string;
  jobId: string;
  fromState: JobState | null;
  toState: JobState;
  reason: string;
  createdAt: string;
}

export interface CreateBillInput {
  id?: string;
  sourceMessageId?: string;
  sourceChatId?: string;
  sourceSenderId?: string;
  sourceSenderName?: string | null;
  sourceSenderUsername?: string | null;
  sourceSenderPhoneNumber?: string | null;
  /** @deprecated Use sourceMessageId. Accepted only to preserve existing callers during transport migration. */
  whatsappMessageId?: string;
  /** @deprecated Use sourceChatId. Accepted only to preserve existing callers during transport migration. */
  whatsappGroupId?: string;
  /** @deprecated Use sourceSenderId. Accepted only to preserve existing callers during transport migration. */
  whatsappSenderId?: string;
  attachmentIndex: number;
  receivedAt: string;
  caption?: string | null;
  originalFilename?: string | null;
  /** Bounded, unsanitized source basename retained only for global filename deduplication. */
  sourceFilename?: string | null;
  mimeType: string;
  originalPath: string;
  contentSha256: string;
  source?: BillSource;
  sourceIdentity?: string;
  extractionPolicy?: ExtractionPolicy;
  classification?: BillClassification;
  batchItemId?: string | null;
}

export interface AdminUploadBatch {
  id: string;
  idempotencyKey: string;
  originalFilename: string;
  state: "queued" | "processing" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface AdminUploadBatchItem {
  id: string;
  batchId: string;
  itemIndex: number;
  entryPath: string;
  state: "queued" | "processing" | "complete" | "not_invoice" | "rejected" | "failed";
  errorCode: string | null;
  billId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUploadBatchStatusCounts {
  total: number;
  queued: number;
  processing: number;
  complete: number;
  notInvoice: number;
  rejected: number;
  failed: number;
}

export interface InitialJobInput {
  type: JobType;
  idempotencyKey: string;
  availableAt?: string;
}

export interface ClaimedJob extends Job {
  leaseToken: string;
  leaseExpiresAt: string;
  claimedBy: string;
  claimedAt: string;
}

/**
 * Provider boundary contract: before every external side effect, a handler must call
 * assertLease() and use idempotencyKey with the provider. This fences stale claims but
 * cannot remove the unavoidable crash-after-effect window; provider idempotency is required.
 */
export interface JobHandlerContext {
  idempotencyKey: string;
  assertLease(): void;
  /** Project handlers must call this immediately before and after their provider upsert. External
   * TOCTOU is resolved by the provider's idempotent bill.id upsert in Phase 4; this fences DB ownership. */
  assertCurrentApprovalRevision(): void;
}

export type JobHandler = (job: ClaimedJob, context: JobHandlerContext) => Promise<void>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;
