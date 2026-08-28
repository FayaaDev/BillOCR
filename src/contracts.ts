export const jobTypes = ["extract", "archive_to_drive", "project_to_sheet", "sync_review_correction"] as const;
export type JobType = (typeof jobTypes)[number];

export const jobStates = ["pending", "running", "succeeded", "retryable_failure", "permanent_failure"] as const;
export type JobState = (typeof jobStates)[number];

export type BillStatus = "received" | "extracting" | "needs_review" | "approved" | "failed";

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
  handwritten: boolean | null;
  fields: Record<string, { confidence: number; sourceText: string | null }>;
}

export interface Extraction {
  id: string;
  billId: string;
  schemaVersion: string;
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
