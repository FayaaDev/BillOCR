export const jobTypes = ["extract", "archive_to_drive", "project_to_sheet", "sync_review_correction"] as const;
export type JobType = (typeof jobTypes)[number];

export const jobStates = ["pending", "running", "succeeded", "retryable_failure", "permanent_failure"] as const;
export type JobState = (typeof jobStates)[number];

export type BillStatus = "received" | "extracting" | "needs_review" | "approved" | "failed";
export type BillSource = "whatsapp" | "admin_upload";
export type ExtractionPolicy = "azure_only";
export type BillClassification = "unclassified" | "invoice" | "not_invoice";

/** Read-only dashboard totals derived from canonical bill and job state. Processed means approved. */
export interface DashboardMetrics {
  receivedBills: number;
  approvedBills: number;
  failedBills: number;
  retryableJobs: number;
  permanentFailureJobs: number;
}

export type ExtractionProvider = "azure";

/** Native provider evidence for one normalized field. */
export interface FieldEvidence {
  confidence: number | null;
  sourceText: string | null;
}

/** Provenance for the provider whose result is selected as canonical. */
export interface ExtractionProvenance {
  selectedProvider: ExtractionProvider;
}

export interface Bill {
  id: string;
  whatsappMessageId: string;
  whatsappGroupId: string;
  whatsappSenderId: string;
  attachmentIndex: number;
  receivedAt: string;
  caption: string | null;
  originalFilename: string | null;
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
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string | null;
  subtotal: number | null;
  vat: number | null;
  total: number | null;
  description: string | null;
  fields: Record<string, FieldEvidence>;
}

export interface Extraction {
  id: string;
  billId: string;
  schemaVersion: string;
  selectedProvider: ExtractionProvider | null;
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
  whatsappMessageId: string;
  whatsappGroupId: string;
  whatsappSenderId: string;
  attachmentIndex: number;
  receivedAt: string;
  caption?: string | null;
  originalFilename?: string | null;
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
