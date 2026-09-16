import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { transportSourceIdentity, type AdminUploadBatch, type AdminUploadBatchItem, type AdminUploadBatchStatusCounts, type AzureExtractionOperation, type BeginExtractionInvocationResult, type Bill, type BillClassification, type BillSource, type ClaimedJob, type CreateBillInput, type DashboardMetrics, type EffectiveBillData, type ExtractedBill, type Extraction, type ExtractionFallbackStatus, type ExtractionInvocation, type ExtractionPolicy, type ExtractionProvider, type InitialJobInput, type Job, type JobState, type JobTransition, type JobType, type ProviderProjectionMetadata, type ReviewEvent, type ValidationIssue } from "./contracts";
import { applyMigrations } from "./migrations";
import { jobTypes } from "./contracts";

type JobRow = {
  id: string; bill_id: string; type: JobType; state: JobState; idempotency_key: string; attempts: number; available_at: string;
  lease_token: string | null; lease_expires_at: string | null; claimed_by: string | null; claimed_at: string | null;
  last_error: string | null; created_at: string; updated_at: string; expected_revision: number | null;
};
type BillRow = {
  id: string; source_message_id: string; source_chat_id: string; source_sender_id: string; attachment_index: number;
  received_at: string; caption: string | null; original_filename: string | null; mime_type: string; original_path: string;
  content_sha256: string; status: Bill["status"]; drive_file_id: string | null; sheet_row_key: string | null; created_at: string; updated_at: string; content_revision: number; review_revision: number; manual_review_required: number;
  source: BillSource; source_identity: string; extraction_policy: ExtractionPolicy; classification: BillClassification; batch_item_id: string | null;
};
type JobTransitionRow = { id: string; job_id: string; from_state: JobState | null; to_state: JobState; reason: string; created_at: string };
type ExtractionRow = { id: string; bill_id: string; schema_version: string; selected_provider: ExtractionProvider | null; fallback_status: ExtractionFallbackStatus | null; selected_invocation_id: string | null; normalized_json: string | null; raw_provider_response: string | null; provider_model: string | null; prompt_schema_version: string | null; requested_at: string | null; completed_at: string | null; error_details: string | null; created_at: string; updated_at: string };
type ExtractionInvocationRow = { id: string; bill_id: string; job_id: string; job_attempt: number; provider: ExtractionProvider; idempotency_key: string; provider_model: string | null; prompt_schema_version: string | null; requested_at: string; completed_at: string | null; outcome: ExtractionInvocation["outcome"]; raw_provider_response: string | null; error_details: string | null; created_at: string; updated_at: string };
type AzureExtractionOperationRow = { id: string; invocation_id: string; bill_id: string; job_id: string; operation_location: string | null; state: AzureExtractionOperation["state"]; normalized_json: string | null; raw_provider_response: string | null; provider_model: string | null; last_error: string | null; completed_at: string | null; created_at: string; updated_at: string };
type ValidationIssueRow = { id: string; bill_id: string; field: string | null; code: string; message: string; severity: ValidationIssue["severity"]; observed_value: string | null; created_at: string };
type ProjectionRow = { id: string; bill_id: string; provider: string; projection_key: string; external_id: string | null; external_url: string | null; metadata_json: string | null; created_at: string; updated_at: string };
type DriveReservationRow = { reservation_key: string; kind: "file" | "folder"; parent_id: string | null; logical_path: string; drive_id: string; state: "reserved" | "confirmed"; bill_id: string | null; content_sha256: string | null; created_at: string; updated_at: string };
type ReviewEventRow = { id: string; bill_id: string; reviewer_id: string; action: string; previous_values: string | null; corrected_values: string | null; reason: string | null; note: string | null; created_at: string };
type DashboardMetricsRow = { received_bills: number; approved_bills: number; failed_bills: number; retryable_jobs: number; permanent_failure_jobs: number };
type AdminUploadBatchRow = { id: string; idempotency_key: string; original_filename: string; state: AdminUploadBatch["state"]; created_at: string; updated_at: string };
type AdminUploadBatchItemRow = { id: string; batch_id: string; item_index: number; entry_path: string; state: AdminUploadBatchItem["state"]; error_code: string | null; bill_id: string | null; created_at: string; updated_at: string };

function toJob(row: JobRow): Job {
  return { id: row.id, billId: row.bill_id, type: row.type, state: row.state, idempotencyKey: row.idempotency_key, attempts: row.attempts, availableAt: row.available_at, leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at, claimedBy: row.claimed_by, claimedAt: row.claimed_at, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at, expectedRevision: row.expected_revision };
}
function toBill(row: BillRow): Bill {
  return { id: row.id, sourceMessageId: row.source_message_id, sourceChatId: row.source_chat_id, sourceSenderId: row.source_sender_id, attachmentIndex: row.attachment_index, receivedAt: row.received_at, caption: row.caption, originalFilename: row.original_filename, mimeType: row.mime_type, originalPath: row.original_path, contentSha256: row.content_sha256, status: row.status, driveFileId: row.drive_file_id, sheetRowKey: row.sheet_row_key, createdAt: row.created_at, updatedAt: row.updated_at, contentRevision: row.content_revision, reviewRevision: row.review_revision, source: row.source, sourceIdentity: row.source_identity, extractionPolicy: row.extraction_policy, classification: row.classification, batchItemId: row.batch_item_id };
}
function toJobTransition(row: JobTransitionRow): JobTransition {
  return { id: row.id, jobId: row.job_id, fromState: row.from_state, toState: row.to_state, reason: row.reason, createdAt: row.created_at };
}
function toExtraction(row: ExtractionRow): Extraction {
  return { id: row.id, billId: row.bill_id, schemaVersion: row.schema_version, selectedProvider: row.selected_provider, fallbackStatus: row.fallback_status, selectedInvocationId: row.selected_invocation_id, normalized: row.normalized_json ? JSON.parse(row.normalized_json) as ExtractedBill : null, rawProviderResponse: row.raw_provider_response, providerModel: row.provider_model, promptSchemaVersion: row.prompt_schema_version, requestedAt: row.requested_at, completedAt: row.completed_at, errorDetails: row.error_details, createdAt: row.created_at, updatedAt: row.updated_at };
}
function toExtractionInvocation(row: ExtractionInvocationRow): ExtractionInvocation {
  return { id: row.id, billId: row.bill_id, jobId: row.job_id, jobAttempt: row.job_attempt, provider: row.provider, idempotencyKey: row.idempotency_key, providerModel: row.provider_model, promptSchemaVersion: row.prompt_schema_version, requestedAt: row.requested_at, completedAt: row.completed_at, outcome: row.outcome, rawProviderResponse: row.raw_provider_response, errorDetails: row.error_details, createdAt: row.created_at, updatedAt: row.updated_at };
}
function toAzureExtractionOperation(row: AzureExtractionOperationRow): AzureExtractionOperation {
  return { id: row.id, invocationId: row.invocation_id, billId: row.bill_id, jobId: row.job_id, operationLocation: row.operation_location, state: row.state, normalized: row.normalized_json ? JSON.parse(row.normalized_json) as ExtractedBill : null, rawProviderResponse: row.raw_provider_response, providerModel: row.provider_model, lastError: row.last_error, completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
function toValidationIssue(row: ValidationIssueRow): ValidationIssue {
  return { id: row.id, billId: row.bill_id, field: row.field, code: row.code, message: row.message, severity: row.severity, observedValue: row.observed_value, createdAt: row.created_at };
}
function toProjection(row: ProjectionRow): ProviderProjectionMetadata {
  return { id: row.id, billId: row.bill_id, provider: row.provider, projectionKey: row.projection_key, externalId: row.external_id, externalUrl: row.external_url, metadata: row.metadata_json, createdAt: row.created_at, updatedAt: row.updated_at };
}
function recordTransition(db: Database, jobId: string, fromState: JobState | null, toState: JobState, reason: string, createdAt: string): void {
  db.query("INSERT INTO job_transition_history (id, job_id, from_state, to_state, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), jobId, fromState, toState, reason, createdAt);
}

export interface RetryPolicy { maxAttempts: number; retryBaseMs: number; retryMaxMs: number; leaseMs: number; }
export interface CreateBillResult { bill: Bill; created: boolean; }
export interface ReviewSubmission { billId: string; reviewerId: string; action: "approve" | "reject"; reason: string | null; note: string | null; expectedContentRevision: number; expectedReviewRevision: number; corrected: ExtractedBill; }
export interface CompletedInvoiceExportRecord { receivedAt: string; senderId: string | null; extraction: ExtractedBill; }
export interface ReviewQueueFilters { source?: BillSource; batchId?: string; status?: "complete" | "not_invoice" | Bill["status"]; }
export interface ReviewQueueBill extends Bill { batchId: string | null; displayStatus: "Complete" | "NotInvoice" | Bill["status"]; extraction: ExtractedBill | null; }
export interface ReviewClassificationOverride { billId: string; reviewerId: string; action: "mark_not_invoice" | "reclassify_invoice"; expectedContentRevision: number; expectedReviewRevision: number; }

function retryTransition(attempts: number, policy: RetryPolicy, now: Date): { state: "retryable_failure" | "permanent_failure"; availableAt: string } {
  if (attempts >= policy.maxAttempts) return { state: "permanent_failure", availableAt: now.toISOString() };
  const delay = Math.min(policy.retryMaxMs, policy.retryBaseMs * 2 ** Math.max(0, attempts - 1));
  return { state: "retryable_failure", availableAt: new Date(now.getTime() + delay).toISOString() };
}
function safeJobError(error: string): string {
  if (/timeout/i.test(error)) return "provider_timeout";
  if (/lease/i.test(error)) return "lease_lost";
  if (/malformed|invalid structured|schema/i.test(error)) return "malformed_provider_output";
  if (/cannot be read|size limit/i.test(error)) return "original_unreadable_or_too_large";
  const status = /HTTP\s+(\d{3})/i.exec(error)?.[1];
  return status ? `provider_http_${status}` : "job_handler_failed";
}

/** Canonical SQLite store. Every method completes its transaction before returning. */
export class BillDatabase {
  readonly sqlite: Database;

  constructor(path: string) {
    this.sqlite = new Database(path, { create: true, strict: true });
    this.sqlite.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    applyMigrations(this.sqlite);
  }

  close(): void { this.sqlite.close(); }

  createBillWithInitialJobs(input: CreateBillInput, initialJobs: InitialJobInput[]): CreateBillResult {
    const now = new Date().toISOString();
    const billId = input.id ?? randomUUID();
    const source = input.source ?? "whatsapp";
    const sourceMessageId = input.sourceMessageId ?? input.whatsappMessageId;
    const sourceChatId = input.sourceChatId ?? input.whatsappGroupId;
    const sourceSenderId = input.sourceSenderId ?? input.whatsappSenderId;
    if (!sourceMessageId || !sourceChatId || !sourceSenderId) throw new Error("Bill source message, chat, and sender IDs are required");
    const sourceIdentity = input.sourceIdentity ?? transportSourceIdentity(sourceChatId, sourceMessageId, input.attachmentIndex);
    const extractionPolicy = input.extractionPolicy ?? "mistral_with_azure_fallback";
    const classification = input.classification ?? "unclassified";
    if (!sourceIdentity) throw new Error("Bill source identity is required");
    if (source !== "admin_upload" && input.batchItemId) throw new Error("Transport bill cannot link an admin-upload batch item");
    if (source === "admin_upload" && !input.batchItemId) throw new Error("Admin-upload bill requires a batch item");
    if (classification === "not_invoice" && initialJobs.some((job) => job.type === "project_to_sheet")) throw new Error("NotInvoice bills cannot create sheet projection jobs");
    const insertBill = this.sqlite.query(`INSERT INTO bills (id, source_message_id, source_chat_id, source_sender_id, attachment_index, received_at, caption, original_filename, mime_type, original_path, content_sha256, status, source, source_identity, extraction_policy, classification, batch_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
    const bySource = this.sqlite.query<BillRow, [BillSource, string]>("SELECT * FROM bills WHERE source = ? AND source_identity = ?");
    const insertJob = this.sqlite.query(`INSERT INTO jobs (id, bill_id, type, state, idempotency_key, attempts, available_at, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?)`);
    const jobByKey = this.sqlite.query<{ bill_id: string }, [string]>("SELECT bill_id FROM jobs WHERE idempotency_key = ?");
    return this.sqlite.transaction(() => {
      const jobKeys = new Set<string>();
      for (const job of initialJobs) {
        if (jobKeys.has(job.idempotencyKey)) throw new Error(`Duplicate required job idempotency key: ${job.idempotencyKey}`);
        jobKeys.add(job.idempotencyKey);
      }
      const existingBill = bySource.get(source, sourceIdentity);
      if (source === "admin_upload" && input.batchItemId && !existingBill) {
        const compatible = this.sqlite.query<{ value: number }, [string]>(`SELECT 1 AS value FROM admin_upload_batch_items item
          JOIN admin_upload_batches batch ON batch.id = item.batch_id WHERE item.id = ? AND item.bill_id IS NULL AND item.state = 'queued'`).get(input.batchItemId);
        if (!compatible) throw new Error("Admin-upload batch item is missing or already linked");
      }
      const result = insertBill.run(billId, sourceMessageId, sourceChatId, sourceSenderId, input.attachmentIndex, input.receivedAt, input.caption ?? null, input.originalFilename ?? null, input.mimeType, input.originalPath, input.contentSha256, source, sourceIdentity, extractionPolicy, classification, input.batchItemId ?? null, now, now);
      const row = existingBill ?? bySource.get(source, sourceIdentity);
      if (!row) throw new Error("Bill source identity conflicts with another bill");
      const created = result.changes === 1;
      for (const job of initialJobs) {
        const existing = jobByKey.get(job.idempotencyKey);
        if (existing && existing.bill_id !== row.id) throw new Error(`Required job idempotency key belongs to another bill: ${job.idempotencyKey}`);
        if (!created && !existing) throw new Error(`Required initial job is missing for existing bill: ${job.idempotencyKey}`);
        if (created) {
          const jobId = randomUUID();
          if (insertJob.run(jobId, row.id, job.type, job.idempotencyKey, job.availableAt ?? now, now, now).changes !== 1) throw new Error(`Could not create required initial job: ${job.idempotencyKey}`);
          recordTransition(this.sqlite, jobId, null, "pending", "created", now);
        }
      }
      if (created && input.batchItemId) {
        const linked = this.sqlite.query(`UPDATE admin_upload_batch_items SET bill_id = ?, state = 'processing', updated_at = ?
          WHERE id = ? AND bill_id IS NULL AND state = 'queued' AND EXISTS (SELECT 1 FROM admin_upload_batches WHERE id = admin_upload_batch_items.batch_id)`).run(row.id, now, input.batchItemId);
        if (linked.changes !== 1) throw new Error("Admin-upload batch item is missing or already linked");
      }
      return { bill: toBill(row), created };
    })();
  }

  getBillBySourceIdentity(source: BillSource, sourceIdentity: string): Bill | null {
    const row = this.sqlite.query<BillRow, [BillSource, string]>("SELECT * FROM bills WHERE source = ? AND source_identity = ?").get(source, sourceIdentity);
    return row ? toBill(row) : null;
  }

  getTelegramPollingCursor(): number | null {
    return this.sqlite.query<{ next_update_id: number }, []>("SELECT next_update_id FROM telegram_polling_cursor WHERE id = 1").get()?.next_update_id ?? null;
  }

  setTelegramPollingCursor(nextUpdateId: number): void {
    if (!Number.isInteger(nextUpdateId) || nextUpdateId < 0) throw new Error("Telegram polling cursor must be a non-negative integer");
    const now = new Date().toISOString();
    this.sqlite.query("INSERT INTO telegram_polling_cursor (id, next_update_id, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET next_update_id = excluded.next_update_id, updated_at = excluded.updated_at").run(nextUpdateId, now);
  }

  getBill(id: string): Bill | null {
    const row = this.sqlite.query<BillRow, [string]>("SELECT * FROM bills WHERE id = ?").get(id);
    return row ? toBill(row) : null;
  }

  /** Deletes canonical bill data and ZIP-upload tracking, without touching originals or non-bill state. */
  clearAllBills(): { deleted: number } | { busy: true } {
    return this.sqlite.transaction(() => {
      if (this.sqlite.query<{ value: number }, []>("SELECT 1 AS value FROM jobs WHERE state = 'running' LIMIT 1").get()) return { busy: true as const };
      const deleted = this.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count ?? 0;
      // These two nullable links form the bills <-> batch-items cycle.
      this.sqlite.query("UPDATE bills SET batch_item_id = NULL WHERE batch_item_id IS NOT NULL").run();
      this.sqlite.query("UPDATE admin_upload_batch_items SET bill_id = NULL WHERE bill_id IS NOT NULL").run();
      this.sqlite.query("UPDATE extractions SET selected_invocation_id = NULL WHERE selected_invocation_id IS NOT NULL").run();
      this.sqlite.query("DELETE FROM job_transition_history").run();
      this.sqlite.query("DELETE FROM azure_extraction_operations").run();
      this.sqlite.query("DELETE FROM extraction_invocations").run();
      this.sqlite.query("DELETE FROM extraction_attempts").run();
      this.sqlite.query("DELETE FROM jobs").run();
      this.sqlite.query("DELETE FROM validation_issues").run();
      this.sqlite.query("DELETE FROM review_events").run();
      this.sqlite.query("DELETE FROM bill_classification_events").run();
      this.sqlite.query("DELETE FROM provider_projection_metadata").run();
      this.sqlite.query("DELETE FROM effective_bill_data").run();
      this.sqlite.query("DELETE FROM drive_reservations WHERE bill_id IS NOT NULL").run();
      this.sqlite.query("DELETE FROM extractions").run();
      this.sqlite.query("DELETE FROM bills").run();
      this.sqlite.query("DELETE FROM admin_upload_batch_items").run();
      this.sqlite.query("DELETE FROM admin_upload_batches").run();
      return { deleted };
    })();
  }

  createAdminUploadBatch(input: { id?: string; idempotencyKey: string; originalFilename: string }): { batch: AdminUploadBatch; created: boolean } {
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    return this.sqlite.transaction(() => {
      const result = this.sqlite.query("INSERT INTO admin_upload_batches (id, idempotency_key, original_filename, state, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?) ON CONFLICT(idempotency_key) DO NOTHING").run(id, input.idempotencyKey, input.originalFilename, now, now);
      const row = this.sqlite.query<AdminUploadBatchRow, [string]>("SELECT * FROM admin_upload_batches WHERE idempotency_key = ?").get(input.idempotencyKey);
      if (!row) throw new Error("Admin-upload batch insert did not produce a batch");
      return { batch: { id: row.id, idempotencyKey: row.idempotency_key, originalFilename: row.original_filename, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at }, created: result.changes === 1 };
    })();
  }

  createAdminUploadBatchItem(input: { id?: string; batchId: string; itemIndex: number; entryPath: string }): { item: AdminUploadBatchItem; created: boolean } {
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    return this.sqlite.transaction(() => {
      const byIndex = this.sqlite.query<AdminUploadBatchItemRow, [string, number]>("SELECT * FROM admin_upload_batch_items WHERE batch_id = ? AND item_index = ?");
      const existing = byIndex.get(input.batchId, input.itemIndex);
      if (existing) return { item: { id: existing.id, batchId: existing.batch_id, itemIndex: existing.item_index, entryPath: existing.entry_path, state: existing.state, errorCode: existing.error_code, billId: existing.bill_id, createdAt: existing.created_at, updatedAt: existing.updated_at }, created: false };
      const result = this.sqlite.query(`INSERT INTO admin_upload_batch_items (id, batch_id, item_index, entry_path, state, created_at, updated_at)
        SELECT ?, ?, ?, ?, 'queued', ?, ? WHERE EXISTS (SELECT 1 FROM admin_upload_batches WHERE id = ? AND state IN ('queued', 'processing'))`).run(id, input.batchId, input.itemIndex, input.entryPath, now, now, input.batchId);
      const row = byIndex.get(input.batchId, input.itemIndex);
      if (!row) throw new Error("Admin-upload batch item requires an existing batch");
      return { item: { id: row.id, batchId: row.batch_id, itemIndex: row.item_index, entryPath: row.entry_path, state: row.state, errorCode: row.error_code, billId: row.bill_id, createdAt: row.created_at, updatedAt: row.updated_at }, created: result.changes === 1 };
    })();
  }

  setAdminUploadBatchState(batchId: string, state: AdminUploadBatch["state"]): boolean {
    const now = new Date().toISOString();
    const expected = state === "processing" ? "queued" : state === "completed" ? "processing" : "";
    if (state === "completed") {
      return this.sqlite.query(`UPDATE admin_upload_batches SET state = ?, updated_at = ? WHERE id = ? AND state = ?
        AND NOT EXISTS (SELECT 1 FROM admin_upload_batch_items WHERE batch_id = admin_upload_batches.id AND state IN ('queued', 'processing'))`).run(state, now, batchId, expected).changes === 1;
    }
    if (state === "failed") return this.sqlite.query("UPDATE admin_upload_batches SET state = ?, updated_at = ? WHERE id = ? AND state IN ('queued', 'processing')").run(state, now, batchId).changes === 1;
    return this.sqlite.query("UPDATE admin_upload_batches SET state = ?, updated_at = ? WHERE id = ? AND state = ?").run(state, now, batchId, expected).changes === 1;
  }

  /** Seals ZIP enumeration and atomically chooses processing or completed from item state. */
  finalizeAdminUploadBatch(batchId: string): boolean {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => this.sqlite.query(`UPDATE admin_upload_batches SET state = CASE WHEN NOT EXISTS
      (SELECT 1 FROM admin_upload_batch_items WHERE batch_id = admin_upload_batches.id AND state IN ('queued', 'processing')) THEN 'completed' ELSE 'processing' END, updated_at = ?
      WHERE id = ? AND state = 'queued'`).run(now, batchId).changes === 1)();
  }

  /** Completes the parent in the same transaction as the terminal item transition. */
  private completeAdminUploadBatchIfTerminal(itemId: string, now: string): void {
    this.sqlite.query(`UPDATE admin_upload_batches SET state = 'completed', updated_at = ?
      WHERE id = (SELECT batch_id FROM admin_upload_batch_items WHERE id = ?) AND state = 'processing'
        AND NOT EXISTS (SELECT 1 FROM admin_upload_batch_items WHERE batch_id = admin_upload_batches.id AND state IN ('queued', 'processing'))`).run(now, itemId);
  }

  transitionAdminUploadBatchItemState(input: { itemId: string; state: AdminUploadBatchItem["state"]; errorCode?: string | null; expectedStates?: readonly AdminUploadBatchItem["state"][] }): boolean {
    if (input.expectedStates?.length === 0) return false;
    const now = new Date().toISOString();
    const allowedPrevious: Record<AdminUploadBatchItem["state"], readonly AdminUploadBatchItem["state"][]> = {
      queued: [], processing: ["queued"], complete: ["processing"], not_invoice: ["processing"], rejected: ["queued", "processing"], failed: ["queued", "processing"],
    };
    const expected = input.expectedStates
      ? input.expectedStates.filter((state) => allowedPrevious[input.state].includes(state))
      : allowedPrevious[input.state];
    if (expected.length === 0) return false;
    const placeholders = expected.map(() => "?").join(",");
    return this.sqlite.transaction(() => {
      const result = this.sqlite.query(`UPDATE admin_upload_batch_items SET state = ?, error_code = ?, updated_at = ? WHERE id = ? AND state IN (${placeholders})`).run(input.state, input.errorCode ?? null, now, input.itemId, ...expected);
      if (result.changes === 1 && input.state !== "processing") this.completeAdminUploadBatchIfTerminal(input.itemId, now);
      return result.changes === 1;
    })();
  }

  getAdminUploadBatchStatusCounts(batchId: string): AdminUploadBatchStatusCounts | null {
    const batch = this.sqlite.query<{ value: number }, [string]>("SELECT 1 AS value FROM admin_upload_batches WHERE id = ?").get(batchId);
    if (!batch) return null;
    const row = this.sqlite.query<AdminUploadBatchStatusCounts, [string]>(`SELECT COUNT(*) AS total,
      COALESCE(SUM(state = 'queued'), 0) AS queued, COALESCE(SUM(state = 'processing'), 0) AS processing, COALESCE(SUM(state = 'complete'), 0) AS complete,
      COALESCE(SUM(state = 'not_invoice'), 0) AS notInvoice, COALESCE(SUM(state = 'rejected'), 0) AS rejected, COALESCE(SUM(state = 'failed'), 0) AS failed
      FROM admin_upload_batch_items WHERE batch_id = ?`).get(batchId);
    return row ? { total: row.total, queued: row.queued, processing: row.processing, complete: row.complete, notInvoice: row.notInvoice, rejected: row.rejected, failed: row.failed } : { total: 0, queued: 0, processing: 0, complete: 0, notInvoice: 0, rejected: 0, failed: 0 };
  }

  getAdminUploadBatchStatus(batchId: string): { batch: AdminUploadBatch; counts: AdminUploadBatchStatusCounts; items: Array<Pick<AdminUploadBatchItem, "entryPath" | "state" | "errorCode" | "billId">> } | null {
    const row = this.sqlite.query<AdminUploadBatchRow, [string]>("SELECT * FROM admin_upload_batches WHERE id = ?").get(batchId);
    if (!row) return null;
    const counts = this.getAdminUploadBatchStatusCounts(batchId);
    if (!counts) return null;
    const items = this.sqlite.query<AdminUploadBatchItemRow, [string]>("SELECT * FROM admin_upload_batch_items WHERE batch_id = ? ORDER BY item_index").all(batchId)
      .map((item) => ({ entryPath: item.entry_path, state: item.state, errorCode: item.error_code, billId: item.bill_id }));
    return { batch: { id: row.id, idempotencyKey: row.idempotency_key, originalFilename: row.original_filename, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at }, counts, items };
  }

  /** A claimed extract job and the exact bill revision fence this provider-derived transition. */
  transitionBillClassification(input: { billId: string; jobId: string; leaseToken: string; classification: "invoice" | "not_invoice"; actor: string; reason?: string | null; expectedContentRevision: number; expectedReviewRevision: number }): boolean {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      const owned = this.sqlite.query<{ value: number }, [string, string, string, string]>(`SELECT 1 AS value FROM jobs
        WHERE id = ? AND bill_id = ? AND type = 'extract' AND state = 'running' AND lease_token = ? AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`).get(input.jobId, input.billId, input.leaseToken, now);
      if (!owned) return false;
      const bill = this.sqlite.query<BillRow, [string, number, number]>("SELECT * FROM bills WHERE id = ? AND content_revision = ? AND review_revision = ?").get(input.billId, input.expectedContentRevision, input.expectedReviewRevision);
      if (!bill || bill.classification !== "unclassified") return false;
      const contentRevision = bill.content_revision + 1;
      if (input.classification === "not_invoice") this.sqlite.query("UPDATE bills SET classification = ?, status = 'failed', manual_review_required = 1, content_revision = ?, updated_at = ? WHERE id = ?").run(input.classification, contentRevision, now, input.billId);
      else this.sqlite.query("UPDATE bills SET classification = ?, content_revision = ?, updated_at = ? WHERE id = ?").run(input.classification, contentRevision, now, input.billId);
      this.sqlite.query("INSERT INTO bill_classification_events (id, bill_id, from_classification, to_classification, actor, reason, content_revision, review_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), input.billId, bill.classification, input.classification, input.actor, input.reason ?? null, contentRevision, bill.review_revision, now);
      if (bill.batch_item_id) {
        if (input.classification === "not_invoice") {
          this.sqlite.query("UPDATE admin_upload_batch_items SET state = 'not_invoice', updated_at = ? WHERE id = ? AND state = 'processing'").run(now, bill.batch_item_id);
          this.completeAdminUploadBatchIfTerminal(bill.batch_item_id, now);
        }
      }
      if (input.classification === "not_invoice") this.invalidatePendingProjectJobs(input.billId, now);
      return true;
    })();
  }

  /** Read-only canonical dashboard totals. Bill and background-job failures are distinct. */
  getDashboardMetrics(): DashboardMetrics {
    const row = this.sqlite.query<DashboardMetricsRow, []>(`SELECT
      (SELECT COUNT(*) FROM bills) AS received_bills,
      (SELECT COUNT(*) FROM bills WHERE status = 'approved') AS approved_bills,
      (SELECT COUNT(*) FROM bills WHERE status = 'failed') AS failed_bills,
      (SELECT COUNT(*) FROM jobs WHERE state = 'retryable_failure') AS retryable_jobs,
      (SELECT COUNT(*) FROM jobs WHERE state = 'permanent_failure') AS permanent_failure_jobs`).get();
    if (!row) throw new Error("Dashboard metrics query returned no row");
    return {
      receivedBills: row.received_bills,
      approvedBills: row.approved_bills,
      failedBills: row.failed_bills,
      retryableJobs: row.retryable_jobs,
      permanentFailureJobs: row.permanent_failure_jobs,
    };
  }

  getExtraction(billId: string): Extraction | null {
    const row = this.sqlite.query<ExtractionRow, [string]>("SELECT * FROM extractions WHERE bill_id = ?").get(billId);
    return row ? toExtraction(row) : null;
  }

  getExtractionInvocations(billId: string): ExtractionInvocation[] {
    return this.sqlite.query<ExtractionInvocationRow, [string]>("SELECT * FROM extraction_invocations WHERE bill_id = ? ORDER BY requested_at, rowid").all(billId).map(toExtractionInvocation);
  }

  /** Persists the audit record before a provider call. A stale worker cannot create new work. */
  beginExtractionInvocation(input: { billId: string; jobId: string; leaseToken: string; jobAttempt: number; provider: ExtractionProvider; idempotencyKey: string; jobIdempotencyKey?: string; providerModel?: string | null; promptSchemaVersion?: string | null; requestedAt: string }): BeginExtractionInvocationResult | null {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      const claimedJob = this.sqlite.query<{ value: number }, [string, string, string, number, string, string]>(`SELECT 1 AS value FROM jobs
        WHERE id = ? AND bill_id = ? AND type = 'extract' AND idempotency_key = ? AND attempts = ? AND state = 'running'
          AND lease_token = ? AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`).get(input.jobId, input.billId, input.jobIdempotencyKey ?? input.idempotencyKey, input.jobAttempt, input.leaseToken, now);
      if (!claimedJob) return null;
      const inserted = this.sqlite.query(`INSERT INTO extraction_invocations (id, bill_id, job_id, job_attempt, provider, idempotency_key, provider_model, prompt_schema_version, requested_at, outcome, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)
        ON CONFLICT(job_id, job_attempt, provider) DO NOTHING`).run(randomUUID(), input.billId, input.jobId, input.jobAttempt, input.provider, input.idempotencyKey, input.providerModel ?? null, input.promptSchemaVersion ?? null, input.requestedAt, now, now);
      const row = this.sqlite.query<ExtractionInvocationRow, [string, number, ExtractionProvider]>("SELECT * FROM extraction_invocations WHERE job_id = ? AND job_attempt = ? AND provider = ?").get(input.jobId, input.jobAttempt, input.provider);
      return row ? { invocation: toExtractionInvocation(row), created: inserted.changes === 1 } : null;
    })();
  }

  /** Finishes the durable provider audit record without selecting canonical output. */
  finishExtractionInvocation(input: { invocationId: string; jobId: string; leaseToken: string; outcome: "succeeded" | "failed"; completedAt: string; rawProviderResponse: string | null; errorDetails: string | null }): boolean {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      if (!this.leaseOwned(input.jobId, input.leaseToken, now)) return false;
      const result = this.sqlite.query(`UPDATE extraction_invocations SET outcome = ?, completed_at = ?, raw_provider_response = ?, error_details = ?, updated_at = ?
        WHERE id = ? AND job_id = ? AND outcome = 'requested'`).run(input.outcome, input.completedAt, input.rawProviderResponse, input.errorDetails, now, input.invocationId, input.jobId);
      return result.changes === 1;
    })();
  }

  getAzureExtractionOperation(invocationId: string): AzureExtractionOperation | null {
    const row = this.sqlite.query<AzureExtractionOperationRow, [string]>("SELECT * FROM azure_extraction_operations WHERE invocation_id = ?").get(invocationId);
    return row ? toAzureExtractionOperation(row) : null;
  }

  listResumableAzureExtractionOperations(): AzureExtractionOperation[] {
    return this.sqlite.query<AzureExtractionOperationRow, []>("SELECT * FROM azure_extraction_operations WHERE state IN ('submitted','running') ORDER BY updated_at, rowid").all().map(toAzureExtractionOperation);
  }

  getResumableAzureExtractionOperation(billId: string): AzureExtractionOperation | null {
    const row = this.sqlite.query<AzureExtractionOperationRow, [string]>("SELECT * FROM azure_extraction_operations WHERE bill_id = ? AND state IN ('submitted','running') ORDER BY updated_at, rowid LIMIT 1").get(billId);
    return row ? toAzureExtractionOperation(row) : null;
  }

  getSucceededAzureExtractionOperation(billId: string): AzureExtractionOperation | null {
    const row = this.sqlite.query<AzureExtractionOperationRow, [string]>("SELECT * FROM azure_extraction_operations WHERE bill_id = ? AND state = 'succeeded' ORDER BY completed_at DESC, rowid DESC LIMIT 1").get(billId);
    return row ? toAzureExtractionOperation(row) : null;
  }

  getSubmittingAzureExtractionOperation(billId: string): AzureExtractionOperation | null {
    const row = this.sqlite.query<AzureExtractionOperationRow, [string]>("SELECT * FROM azure_extraction_operations WHERE bill_id = ? AND state = 'submitting' ORDER BY updated_at, rowid LIMIT 1").get(billId);
    return row ? toAzureExtractionOperation(row) : null;
  }

  /** Fences Azure submission before the external request. A replay must not guess whether it reached Azure. */
  beginAzureExtractionSubmission(input: { invocationId: string; billId: string; jobId: string; leaseToken: string }): { operation: AzureExtractionOperation; created: boolean } | null {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      if (!this.leaseOwned(input.jobId, input.leaseToken, now)) return null;
      const invocation = this.sqlite.query<{ value: number }, [string, string, string]>("SELECT 1 AS value FROM extraction_invocations WHERE id = ? AND bill_id = ? AND job_id = ? AND provider = 'azure' AND outcome = 'requested'").get(input.invocationId, input.billId, input.jobId);
      if (!invocation) return null;
      const inserted = this.sqlite.query("INSERT INTO azure_extraction_operations (id, invocation_id, bill_id, job_id, operation_location, state, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 'submitting', ?, ?) ON CONFLICT(invocation_id) DO NOTHING").run(randomUUID(), input.invocationId, input.billId, input.jobId, now, now);
      const operation = this.getAzureExtractionOperation(input.invocationId);
      return operation ? { operation, created: inserted.changes === 1 } : null;
    })();
  }

  /** Stores Azure's operation URL after submission so a later worker can poll it. */
  persistAzureExtractionOperation(input: { invocationId: string; billId: string; jobId: string; leaseToken: string; operationLocation: string; state?: "submitted" | "running" }): AzureExtractionOperation | null {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      if (!this.leaseOwned(input.jobId, input.leaseToken, now)) return null;
      const invocation = this.sqlite.query<{ value: number }, [string, string, string]>("SELECT 1 AS value FROM extraction_invocations WHERE id = ? AND bill_id = ? AND job_id = ? AND provider = 'azure' AND outcome = 'requested'").get(input.invocationId, input.billId, input.jobId);
      if (!invocation) return null;
      const result = this.sqlite.query(`INSERT INTO azure_extraction_operations (id, invocation_id, bill_id, job_id, operation_location, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(invocation_id) DO UPDATE SET operation_location = excluded.operation_location, state = excluded.state, updated_at = excluded.updated_at
        WHERE azure_extraction_operations.operation_location IS NULL AND azure_extraction_operations.state = 'submitting'`).run(randomUUID(), input.invocationId, input.billId, input.jobId, input.operationLocation, input.state ?? "submitted", now, now);
      if (result.changes !== 1) return null;
      return this.getAzureExtractionOperation(input.invocationId);
    })();
  }

  /** Marks one persisted Azure operation terminal, fenced by the worker that polled it. */
  finishAzureExtractionOperation(input: { invocationId: string; jobId: string; leaseToken: string; state: "succeeded" | "failed"; completedAt: string; normalized?: ExtractedBill | null; rawProviderResponse?: string | null; providerModel?: string | null; lastError?: string | null }): boolean {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      if (!this.leaseOwned(input.jobId, input.leaseToken, now)) return false;
      const result = this.sqlite.query("UPDATE azure_extraction_operations SET state = ?, normalized_json = ?, raw_provider_response = ?, provider_model = ?, completed_at = ?, last_error = ?, updated_at = ? WHERE invocation_id = ? AND job_id = ? AND state IN ('submitting','submitted','running')").run(input.state, input.normalized ? JSON.stringify(input.normalized) : null, input.rawProviderResponse ?? null, input.providerModel ?? null, input.completedAt, input.lastError ?? null, now, input.invocationId, input.jobId);
      return result.changes === 1;
    })();
  }

  getValidationIssues(billId: string): ValidationIssue[] {
    return this.sqlite.query<ValidationIssueRow, [string]>("SELECT * FROM validation_issues WHERE bill_id = ? ORDER BY rowid").all(billId).map(toValidationIssue);
  }

  getLatestExtractionAttempt(billId: string): { provider: ExtractionProvider; providerModel: string | null; requestedAt: string; completedAt: string; outcome: "succeeded" | "failed"; errorDetails: string | null } | null {
    const row = this.sqlite.query<{ provider: ExtractionProvider; provider_model: string | null; requested_at: string; completed_at: string; outcome: "succeeded" | "failed"; error_details: string | null }, [string]>("SELECT provider, provider_model, requested_at, completed_at, outcome, error_details FROM extraction_attempts WHERE bill_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(billId);
    return row ? { provider: row.provider, providerModel: row.provider_model, requestedAt: row.requested_at, completedAt: row.completed_at, outcome: row.outcome, errorDetails: row.error_details } : null;
  }

  getEffectiveBillData(billId: string): EffectiveBillData | null {
    const row = this.sqlite.query<{ normalized_json: string; revision: number; updated_at: string }, [string]>("SELECT normalized_json, revision, updated_at FROM effective_bill_data WHERE bill_id = ?").get(billId);
    return row ? { extraction: JSON.parse(row.normalized_json) as ExtractedBill, revision: row.revision, updatedAt: row.updated_at } : null;
  }

  getEffectiveExtraction(billId: string): ExtractedBill | null { return this.getEffectiveBillData(billId)?.extraction ?? this.getExtraction(billId)?.normalized ?? null; }

  /** Approved invoices; admin uploads must also have a terminal complete batch entry. */
  listCompletedInvoiceExports(): CompletedInvoiceExportRecord[] {
    return this.sqlite.query<{ received_at: string; source: BillSource; source_sender_id: string; normalized_json: string }, []>(`SELECT b.received_at, b.source, b.source_sender_id,
      COALESCE(effective.normalized_json, extraction.normalized_json) AS normalized_json
      FROM bills b
      LEFT JOIN admin_upload_batch_items item ON item.id = b.batch_item_id
      LEFT JOIN effective_bill_data effective ON effective.bill_id = b.id
      LEFT JOIN extractions extraction ON extraction.bill_id = b.id
      WHERE b.status = 'approved' AND b.classification = 'invoice'
        AND (b.source != 'admin_upload' OR item.state = 'complete')
        AND COALESCE(effective.normalized_json, extraction.normalized_json) IS NOT NULL
      ORDER BY b.received_at, b.id`).all().map((row) => ({ receivedAt: row.received_at, senderId: row.source === "admin_upload" ? null : row.source_sender_id, extraction: JSON.parse(row.normalized_json) as ExtractedBill }));
  }

  listReviewBills(filters: ReviewQueueFilters = {}): ReviewQueueBill[] {
    const where: string[] = [];
    const values: string[] = [];
    if (filters.source) { where.push("b.source = ?"); values.push(filters.source); }
    if (filters.batchId) { where.push("item.batch_id = ?"); values.push(filters.batchId); }
    if (filters.status === "complete") where.push("b.status = 'approved' AND b.classification != 'not_invoice'");
    else if (filters.status === "not_invoice") where.push("b.classification = 'not_invoice'");
    else if (filters.status) { where.push("b.status = ? AND b.classification != 'not_invoice'"); values.push(filters.status); }
    const rows = this.sqlite.query<BillRow & { batch_id: string | null; normalized_json: string | null }, string[]>(`SELECT b.*, item.batch_id,
      COALESCE(effective.normalized_json, extraction.normalized_json) AS normalized_json FROM bills b
      LEFT JOIN admin_upload_batch_items item ON item.id = b.batch_item_id
      LEFT JOIN effective_bill_data effective ON effective.bill_id = b.id
      LEFT JOIN extractions extraction ON extraction.bill_id = b.id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY b.updated_at DESC`).all(...values);
    return rows.map((row) => ({ ...toBill(row), batchId: row.batch_id, displayStatus: row.classification === "not_invoice" ? "NotInvoice" : row.status === "approved" ? "Complete" : row.status, extraction: row.normalized_json ? JSON.parse(row.normalized_json) as ExtractedBill : null }));
  }

  getReviewEvents(billId: string): ReviewEvent[] {
    return this.sqlite.query<ReviewEventRow, [string]>("SELECT * FROM review_events WHERE bill_id = ? ORDER BY created_at, rowid").all(billId).map((row) => ({ id: row.id, billId: row.bill_id, reviewerId: row.reviewer_id, action: row.action, previousValues: row.previous_values, correctedValues: row.corrected_values, reason: row.reason, note: row.note, createdAt: row.created_at }));
  }

  /** Reviewer mutation is one SQLite transaction. A stale/replayed form changes nothing. */
  submitReview(input: ReviewSubmission, factualIssues: Array<Omit<ValidationIssue, "id" | "billId" | "createdAt">>): boolean {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      const bill = this.sqlite.query<BillRow, [string, number, number]>("SELECT * FROM bills WHERE id = ? AND content_revision = ? AND review_revision = ? AND status IN ('needs_review','failed','approved')").get(input.billId, input.expectedContentRevision, input.expectedReviewRevision);
      if (!bill) return false;
      // Reject a crafted approval before any effective-data, audit, issue, or revision mutation.
      if (input.action === "approve" && bill.classification === "not_invoice") return false;
      const original = this.getEffectiveExtraction(input.billId);
      const nextContent = bill.content_revision + 1;
      const nextReview = bill.review_revision + 1;
      this.sqlite.query(`INSERT INTO effective_bill_data (bill_id, normalized_json, revision, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(bill_id) DO UPDATE SET normalized_json = excluded.normalized_json, revision = excluded.revision, updated_at = excluded.updated_at`).run(input.billId, JSON.stringify(input.corrected), nextContent, now);
      this.sqlite.query("INSERT INTO review_events (id, bill_id, reviewer_id, action, previous_values, corrected_values, reason, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), input.billId, input.reviewerId, input.action, original === null ? null : JSON.stringify(original), JSON.stringify(input.corrected), input.reason, input.note, now);
      this.sqlite.query("DELETE FROM validation_issues WHERE bill_id = ?").run(input.billId);
      const insertIssue = this.sqlite.query("INSERT INTO validation_issues (id, bill_id, field, code, message, severity, observed_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const issue of factualIssues) insertIssue.run(randomUUID(), input.billId, issue.field, issue.code, issue.message, issue.severity, issue.observedValue, now);
       const approved = input.action === "approve";
      this.sqlite.query("UPDATE bills SET status = ?, manual_review_required = 0, content_revision = ?, review_revision = ?, updated_at = ? WHERE id = ?").run(approved ? "approved" : "failed", nextContent, nextReview, now, input.billId);
        this.invalidatePendingProjectJobs(input.billId, now);
        if (bill.batch_item_id) {
          if (approved) this.sqlite.query("UPDATE admin_upload_batch_items SET state = 'complete', updated_at = ? WHERE id = ? AND state IN ('processing','rejected','failed')").run(now, bill.batch_item_id);
          else this.sqlite.query("UPDATE admin_upload_batch_items SET state = 'rejected', updated_at = ? WHERE id = ? AND state IN ('processing','complete')").run(now, bill.batch_item_id);
          this.completeAdminUploadBatchIfTerminal(bill.batch_item_id, now);
        }
      if (approved) {
        this.ensureArchiveJob(input.billId, now);
        this.activateProjectJob(input.billId, nextContent, now);
      } else if (bill.sheet_row_key !== null || this.getProjectionMetadata("sheets", input.billId)) this.activateReviewSyncJob(input.billId, nextReview, now);
      return true;
    })();
  }

  /** Human classification override is revision-fenced and cannot race an active extractor lease. */
  overrideClassification(input: ReviewClassificationOverride): boolean {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      const bill = this.sqlite.query<BillRow, [string, number, number]>("SELECT * FROM bills WHERE id = ? AND content_revision = ? AND review_revision = ?").get(input.billId, input.expectedContentRevision, input.expectedReviewRevision);
      if (!bill || this.sqlite.query<{ value: number }, [string, string]>("SELECT 1 AS value FROM jobs WHERE bill_id = ? AND type = 'extract' AND state = 'running' AND lease_expires_at > ?").get(input.billId, now)?.value) return false;
      const to = input.action === "mark_not_invoice" ? "not_invoice" : "invoice";
      if ((to === "not_invoice" && bill.classification === "not_invoice") || (to === "invoice" && bill.classification !== "not_invoice")) return false;
      const contentRevision = bill.content_revision + 1;
      const reviewRevision = bill.review_revision + 1;
      const status = to === "not_invoice" ? "failed" : "needs_review";
      this.sqlite.query("UPDATE bills SET classification = ?, status = ?, manual_review_required = 1, content_revision = ?, review_revision = ?, updated_at = ? WHERE id = ?").run(to, status, contentRevision, reviewRevision, now, input.billId);
      this.sqlite.query("INSERT INTO bill_classification_events (id, bill_id, from_classification, to_classification, actor, reason, content_revision, review_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), input.billId, bill.classification, to, input.reviewerId, input.action, contentRevision, reviewRevision, now);
      this.sqlite.query("INSERT INTO review_events (id, bill_id, reviewer_id, action, previous_values, corrected_values, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), input.billId, input.reviewerId, input.action, JSON.stringify({ classification: bill.classification, status: bill.status }), JSON.stringify({ classification: to, status }), now);
      this.invalidatePendingProjectJobs(input.billId, now);
      if (bill.batch_item_id) {
        this.sqlite.query("UPDATE admin_upload_batch_items SET state = ?, updated_at = ? WHERE id = ?").run(to === "not_invoice" ? "not_invoice" : "processing", now, bill.batch_item_id);
        if (to === "not_invoice") this.completeAdminUploadBatchIfTerminal(bill.batch_item_id, now);
        if (to === "invoice") this.sqlite.query("UPDATE admin_upload_batches SET state = 'processing', updated_at = ? WHERE id = (SELECT batch_id FROM admin_upload_batch_items WHERE id = ?)").run(now, bill.batch_item_id);
      }
      // A Sheets append can succeed immediately before its SQLite persistence. Always record
      // revision-fenced cleanup so a NotInvoice/reclassification later compensates that crash.
      this.activateReviewSyncJob(input.billId, reviewRevision, now);
      return true;
    })();
  }

  getProjectionMetadata(provider: string, projectionKey: string): ProviderProjectionMetadata | null {
    const row = this.sqlite.query<ProjectionRow, [string, string]>("SELECT * FROM provider_projection_metadata WHERE provider = ? AND projection_key = ?").get(provider, projectionKey);
    return row ? toProjection(row) : null;
  }

  getDriveReservation(key: string): DriveReservationRow | null { return this.sqlite.query<DriveReservationRow, [string]>("SELECT * FROM drive_reservations WHERE reservation_key = ?").get(key) ?? null; }
  /** The generated ID is obtained outside SQLite; this transaction makes concurrent workers converge on one ID. */
  reserveDriveId(input: { key: string; kind: "file" | "folder"; parentId: string | null; logicalPath: string; generatedId: string; billId?: string; contentSha256?: string }): DriveReservationRow {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      this.sqlite.query("INSERT INTO drive_reservations (reservation_key, kind, parent_id, logical_path, drive_id, state, bill_id, content_sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?) ON CONFLICT(reservation_key) DO NOTHING").run(input.key, input.kind, input.parentId, input.logicalPath, input.generatedId, input.billId ?? null, input.contentSha256 ?? null, now, now);
      const value = this.getDriveReservation(input.key); if (!value) throw new Error("Drive reservation was not persisted"); return value;
    })();
  }
  confirmDriveReservation(key: string): void { this.sqlite.query("UPDATE drive_reservations SET state = 'confirmed', updated_at = ? WHERE reservation_key = ?").run(new Date().toISOString(), key); }

  /** Persists only projection state, fenced by the active archive job lease. */
  persistDriveArchive(input: { billId: string; jobId: string; leaseToken: string; contentSha256: string; fileId: string; webLink: string }): boolean {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      if (!this.leaseOwned(input.jobId, input.leaseToken, now)) return false;
      const bill = this.sqlite.query<BillRow, [string, string]>("SELECT * FROM bills WHERE id = ? AND content_sha256 = ?").get(input.billId, input.contentSha256);
      if (!bill) return false;
      const metadata = JSON.stringify({ billId: input.billId, contentSha256: input.contentSha256 });
      this.sqlite.query(`INSERT INTO provider_projection_metadata (id, bill_id, provider, projection_key, external_id, external_url, metadata_json, created_at, updated_at)
        VALUES (?, ?, 'drive', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, projection_key) DO UPDATE SET external_id = excluded.external_id, external_url = excluded.external_url, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`).run(randomUUID(), input.billId, input.billId, input.fileId, input.webLink, metadata, now, now);
      this.sqlite.query("UPDATE bills SET drive_file_id = ?, updated_at = ? WHERE id = ?").run(input.fileId, now, input.billId);
      return true;
    })();
  }

  /** Persists only the Sheet row key and projection metadata after a current approved revision upsert. */
  persistSheetProjection(input: { billId: string; jobId: string; leaseToken: string; expectedRevision: number; rowKey: string }): boolean {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      if (!this.leaseOwned(input.jobId, input.leaseToken, now) || !this.isApprovedAtRevision(input.billId, input.expectedRevision)) return false;
      const metadata = JSON.stringify({ billId: input.billId, revision: input.expectedRevision });
      this.sqlite.query(`INSERT INTO provider_projection_metadata (id, bill_id, provider, projection_key, external_id, metadata_json, created_at, updated_at)
        VALUES (?, ?, 'sheets', ?, ?, ?, ?, ?)
        ON CONFLICT(provider, projection_key) DO UPDATE SET external_id = excluded.external_id, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`).run(randomUUID(), input.billId, input.billId, input.rowKey, metadata, now, now);
      this.sqlite.query("UPDATE bills SET sheet_row_key = ?, updated_at = ? WHERE id = ?").run(input.rowKey, now, input.billId);
      return true;
    })();
  }

  getValidationSnapshot(billId: string): { extraction: Extraction; contentRevision: number; reviewRevision: number } | null {
    const bill = this.getBill(billId);
    const extraction = this.getExtraction(billId);
    return bill && extraction?.normalized ? { extraction, contentRevision: bill.contentRevision, reviewRevision: bill.reviewRevision } : null;
  }

  /** Replaces an authoritative decision only for the exact content/review revision that was read. */
  persistValidationDecision(input: { billId: string; expectedContentRevision: number; expectedReviewRevision: number; decision: "approved" | "needs_review"; issues: Array<Omit<ValidationIssue, "id" | "billId" | "createdAt">> }): boolean {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      const current = this.sqlite.query<BillRow, [string, number, number]>("SELECT * FROM bills WHERE id = ? AND content_revision = ? AND review_revision = ?").get(input.billId, input.expectedContentRevision, input.expectedReviewRevision);
      // A human workflow is sticky: only approveReviewCorrection may approve any review revision.
      if (!current || (current.classification === "not_invoice" && input.decision === "approved") || ((current.review_revision > 0 || current.manual_review_required === 1) && input.decision === "approved")) return false;
      this.sqlite.query("DELETE FROM validation_issues WHERE bill_id = ?").run(input.billId);
      const insertIssue = this.sqlite.query("INSERT INTO validation_issues (id, bill_id, field, code, message, severity, observed_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const item of input.issues) insertIssue.run(randomUUID(), input.billId, item.field, item.code, item.message, item.severity, item.observedValue, now);
      this.sqlite.query("UPDATE bills SET status = ?, updated_at = ? WHERE id = ?").run(input.decision, now, input.billId);
      if (input.decision === "approved" && current.batch_item_id) {
        this.sqlite.query("UPDATE admin_upload_batch_items SET state = 'complete', updated_at = ? WHERE id = ? AND state = 'processing'").run(now, current.batch_item_id);
        this.completeAdminUploadBatchIfTerminal(current.batch_item_id, now);
      }
      this.ensureArchiveJob(input.billId, now);
      if (input.decision === "approved") this.activateProjectJob(input.billId, input.expectedContentRevision, now);
      else this.invalidatePendingProjectJobs(input.billId, now);
      return true;
    })();
  }

  private ensureArchiveJob(billId: string, now: string): void {
    const existing = this.sqlite.query<JobRow, [string, JobType]>("SELECT * FROM jobs WHERE bill_id = ? AND type = ?").get(billId, "archive_to_drive");
    if (existing) return;
    const id = randomUUID();
    this.sqlite.query("INSERT INTO jobs (id, bill_id, type, state, idempotency_key, attempts, available_at, created_at, updated_at) VALUES (?, ?, 'archive_to_drive', 'pending', ?, 0, ?, ?, ?)").run(id, billId, `archive_to_drive:${billId}`, now, now, now);
    recordTransition(this.sqlite, id, null, "pending", "created", now);
  }

  private activateProjectJob(billId: string, revision: number, now: string): void {
    if (!this.isProjectableInvoice(billId)) return;
    const idempotencyKey = `project:${billId}:${revision}`;
    const existing = this.sqlite.query<JobRow, [string]>("SELECT * FROM jobs WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) return;
    const id = randomUUID();
    this.sqlite.query("INSERT INTO jobs (id, bill_id, type, state, idempotency_key, attempts, available_at, expected_revision, created_at, updated_at) VALUES (?, ?, 'project_to_sheet', 'pending', ?, 0, ?, ?, ?, ?)").run(id, billId, idempotencyKey, now, revision, now, now);
    recordTransition(this.sqlite, id, null, "pending", "created", now);
    /* Existing pre-revision jobs are intentionally not rewritten: a running lease belongs to its
       worker. Pending/retryable legacy jobs are invalidated by review routing. */
  }

  private activateReviewSyncJob(billId: string, revision: number, now: string): void {
    const key = `sync_review_correction:${billId}:${revision}`;
    if (this.sqlite.query<JobRow, [string]>("SELECT * FROM jobs WHERE idempotency_key = ?").get(key)) return;
    const id = randomUUID();
    this.sqlite.query("INSERT INTO jobs (id, bill_id, type, state, idempotency_key, attempts, available_at, expected_revision, created_at, updated_at) VALUES (?, ?, 'sync_review_correction', 'pending', ?, 0, ?, ?, ?, ?)").run(id, billId, key, now, revision, now, now);
    recordTransition(this.sqlite, id, null, "pending", "created", now);
  }

  /** Explicit reviewer-only approval boundary for a correction already superseded for review. */
  approveReviewCorrection(input: { billId: string; reviewerId: string; expectedContentRevision: number; expectedReviewRevision: number; action?: string }): boolean {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      const current = this.sqlite.query<BillRow, [string, number, number]>("SELECT * FROM bills WHERE id = ? AND content_revision = ? AND review_revision = ? AND manual_review_required = 1").get(input.billId, input.expectedContentRevision, input.expectedReviewRevision);
      if (!current || current.classification === "not_invoice") return false;
      this.sqlite.query("UPDATE bills SET status = 'approved', manual_review_required = 0, updated_at = ? WHERE id = ?").run(now, input.billId);
      this.sqlite.query("INSERT INTO review_events (id, bill_id, reviewer_id, action, created_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), input.billId, input.reviewerId, input.action ?? "approved", now);
      if (current.batch_item_id) {
        this.sqlite.query("UPDATE admin_upload_batch_items SET state = 'complete', updated_at = ? WHERE id = ? AND state = 'processing'").run(now, current.batch_item_id);
        this.completeAdminUploadBatchIfTerminal(current.batch_item_id, now);
      }
      this.ensureArchiveJob(input.billId, now);
      this.activateProjectJob(input.billId, input.expectedContentRevision, now);
      return true;
    })();
  }

  private invalidatePendingProjectJobs(billId: string, now: string): void {
    const projects = this.sqlite.query<JobRow, [string]>("SELECT * FROM jobs WHERE bill_id = ? AND type = 'project_to_sheet' AND state IN ('pending', 'retryable_failure')").all(billId);
    for (const job of projects) {
      this.sqlite.query("UPDATE jobs SET state = 'permanent_failure', last_error = 'validation_invalidated', updated_at = ? WHERE id = ?").run(now, job.id);
      recordTransition(this.sqlite, job.id, job.state, "permanent_failure", "validation_invalidated", now);
    }
  }

  /** Used by Sheets handlers immediately before their provider effect. */
  isApprovedAtRevision(billId: string, revision: number | null): boolean {
    return revision !== null && Boolean(this.sqlite.query<{ value: number }, [string, number]>("SELECT 1 AS value FROM bills WHERE id = ? AND status = 'approved' AND classification != 'not_invoice' AND content_revision = ?").get(billId, revision)?.value);
  }
  private isProjectableInvoice(billId: string): boolean { return Boolean(this.sqlite.query<{ value: number }, [string]>("SELECT 1 AS value FROM bills WHERE id = ? AND classification != 'not_invoice'").get(billId)?.value); }
  isUnapprovedAtReviewRevision(billId: string, revision: number | null): boolean {
    return revision !== null && Boolean(this.sqlite.query<{ value: number }, [string, number]>("SELECT 1 AS value FROM bills WHERE id = ? AND status != 'approved' AND review_revision = ?").get(billId, revision)?.value);
  }
  ensureCurrentProjectionJob(billId: string): void {
    const bill = this.getBill(billId); if (!bill || bill.status !== "approved" || bill.classification === "not_invoice") return;
    this.sqlite.transaction(() => this.activateProjectJob(billId, bill.contentRevision, new Date().toISOString()))();
  }
  /** Compensation after a stale rejection clear: never touch a running/succeeded job. */
  enqueueProjectionRepair(syncJobId: string, billId: string): void {
    const bill = this.getBill(billId); if (!bill || bill.status !== "approved" || bill.classification === "not_invoice") return;
    const now = new Date().toISOString(); const key = `repair:${syncJobId}:${bill.contentRevision}`;
    this.sqlite.transaction(() => {
      if (this.sqlite.query<JobRow, [string]>("SELECT * FROM jobs WHERE idempotency_key = ?").get(key)) return;
      const id = randomUUID();
      this.sqlite.query("INSERT INTO jobs (id, bill_id, type, state, idempotency_key, attempts, available_at, expected_revision, created_at, updated_at) VALUES (?, ?, 'project_to_sheet', 'pending', ?, 0, ?, ?, ?, ?)").run(id, billId, key, now, bill.contentRevision, now, now);
      recordTransition(this.sqlite, id, null, "pending", "created", now);
    })();
  }

  /** Stable review boundary for Phase 5: automatic approval stays disabled until reviewer approval. */
  supersedeForReview(billId: string, reviewerId: string, action = "correction_started"): boolean {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      const result = this.sqlite.query("UPDATE bills SET status = 'needs_review', manual_review_required = 1, content_revision = content_revision + 1, review_revision = review_revision + 1, updated_at = ? WHERE id = ?").run(now, billId);
      if (result.changes !== 1) return false;
      this.sqlite.query("INSERT INTO review_events (id, bill_id, reviewer_id, action, created_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), billId, reviewerId, action, now);
      this.invalidatePendingProjectJobs(billId, now);
      return true;
    })();
  }

  markBillExtracting(billId: string): void {
    const now = new Date().toISOString();
    this.sqlite.query("UPDATE bills SET status = 'extracting', updated_at = ? WHERE id = ? AND status = 'received'").run(now, billId);
  }

  persistExtractionSuccess(input: { billId: string; jobId: string; leaseToken: string; jobAttempt: number; normalized: ExtractedBill; rawProviderResponse: string; providerModel: string; promptSchemaVersion: string; requestedAt: string; completedAt: string; provider?: ExtractionProvider; fallbackStatus?: ExtractionFallbackStatus }): boolean {
    return this.sqlite.transaction(() => {
      const now = new Date().toISOString();
      const provider = input.provider ?? "mistral";
      const owned = this.leaseOwned(input.jobId, input.leaseToken, now);
      if (!owned) return false;
      this.recordExtractionAttempt({ ...input, provider, outcome: "succeeded", errorDetails: null });
      const result = this.sqlite.query(`INSERT INTO extractions (id, bill_id, schema_version, selected_provider, fallback_status, selected_invocation_id, normalized_json, raw_provider_response, provider_model, prompt_schema_version, requested_at, completed_at, error_details, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(bill_id) DO UPDATE SET schema_version = excluded.schema_version, selected_provider = excluded.selected_provider, fallback_status = excluded.fallback_status, selected_invocation_id = NULL, normalized_json = excluded.normalized_json, raw_provider_response = excluded.raw_provider_response, provider_model = excluded.provider_model, prompt_schema_version = excluded.prompt_schema_version, requested_at = excluded.requested_at, completed_at = excluded.completed_at, error_details = NULL, updated_at = excluded.updated_at WHERE extractions.normalized_json IS NULL`)
        .run(randomUUID(), input.billId, input.normalized.schemaVersion, provider, input.fallbackStatus ?? (provider === "azure" ? "succeeded" : "not_needed"), JSON.stringify(input.normalized), input.rawProviderResponse, input.providerModel, input.promptSchemaVersion, input.requestedAt, input.completedAt, now, now);
       if (result.changes === 1) this.sqlite.query("UPDATE bills SET content_revision = content_revision + 1, updated_at = ? WHERE id = ?").run(now, input.billId);
       return result.changes === 1;
    })();
  }

  /** Selects canonical output only from a successful, identity-matched durable invocation. */
  persistCanonicalExtractionSuccess(input: { invocationId: string; billId: string; jobId: string; leaseToken: string; jobAttempt: number; provider: ExtractionProvider; idempotencyKey: string; normalized: ExtractedBill; rawProviderResponse: string; providerModel: string; promptSchemaVersion: string; requestedAt: string; completedAt: string; fallbackStatus?: ExtractionFallbackStatus }): boolean {
    return this.sqlite.transaction(() => {
      const now = new Date().toISOString();
      if (!this.leaseOwned(input.jobId, input.leaseToken, now)) return false;
      const invocation = this.sqlite.query<{ value: number }, [string, string, string, number, ExtractionProvider, string]>(`SELECT 1 AS value FROM extraction_invocations
        WHERE id = ? AND bill_id = ? AND job_id = ? AND job_attempt = ? AND provider = ? AND idempotency_key = ? AND outcome = 'succeeded'`).get(input.invocationId, input.billId, input.jobId, input.jobAttempt, input.provider, input.idempotencyKey);
      if (!invocation) return false;
      this.recordExtractionAttempt({ ...input, outcome: "succeeded", errorDetails: null });
      const result = this.sqlite.query(`INSERT INTO extractions (id, bill_id, schema_version, selected_provider, fallback_status, selected_invocation_id, normalized_json, raw_provider_response, provider_model, prompt_schema_version, requested_at, completed_at, error_details, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(bill_id) DO UPDATE SET schema_version = excluded.schema_version, selected_provider = excluded.selected_provider, fallback_status = excluded.fallback_status, selected_invocation_id = excluded.selected_invocation_id, normalized_json = excluded.normalized_json, raw_provider_response = excluded.raw_provider_response, provider_model = excluded.provider_model, prompt_schema_version = excluded.prompt_schema_version, requested_at = excluded.requested_at, completed_at = excluded.completed_at, error_details = NULL, updated_at = excluded.updated_at WHERE extractions.normalized_json IS NULL OR (excluded.selected_provider = 'azure' AND extractions.selected_provider = 'mistral' AND extractions.fallback_status = 'pending')`)
        .run(randomUUID(), input.billId, input.normalized.schemaVersion, input.provider, input.fallbackStatus ?? (input.provider === "azure" ? "succeeded" : "not_needed"), input.invocationId, JSON.stringify(input.normalized), input.rawProviderResponse, input.providerModel, input.promptSchemaVersion, input.requestedAt, input.completedAt, now, now);
      if (result.changes === 1) this.sqlite.query("UPDATE bills SET content_revision = content_revision + 1, updated_at = ? WHERE id = ?").run(now, input.billId);
      return result.changes === 1;
    })();
  }

  persistExtractionFailure(input: { billId: string; jobId: string; leaseToken: string; jobAttempt: number; rawProviderResponse: string | null; providerModel: string | null; promptSchemaVersion: string; requestedAt: string; completedAt: string; errorDetails: string; status?: "needs_review" | "failed"; provider?: ExtractionProvider; fallbackStatus?: ExtractionFallbackStatus }): boolean {
    return this.sqlite.transaction(() => {
      const now = new Date().toISOString();
      const provider = input.provider ?? "mistral";
      if (!this.leaseOwned(input.jobId, input.leaseToken, now)) return false;
      this.recordExtractionAttempt({ ...input, provider, outcome: "failed" });
      const result = this.sqlite.query(`INSERT INTO extractions (id, bill_id, schema_version, selected_provider, fallback_status, normalized_json, raw_provider_response, provider_model, prompt_schema_version, requested_at, completed_at, error_details, created_at, updated_at)
        VALUES (?, ?, '1', NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bill_id) DO UPDATE SET fallback_status = excluded.fallback_status, normalized_json = NULL, raw_provider_response = excluded.raw_provider_response, provider_model = excluded.provider_model, prompt_schema_version = excluded.prompt_schema_version, requested_at = excluded.requested_at, completed_at = excluded.completed_at, error_details = excluded.error_details, updated_at = excluded.updated_at WHERE extractions.normalized_json IS NULL`)
        .run(randomUUID(), input.billId, input.fallbackStatus ?? (provider === "azure" ? "failed" : "pending"), input.rawProviderResponse, input.providerModel, input.promptSchemaVersion, input.requestedAt, input.completedAt, input.errorDetails, now, now);
      if (input.status) this.sqlite.query("UPDATE bills SET status = ?, updated_at = ? WHERE id = ? AND status = 'extracting'").run(input.status, now, input.billId);
      if (input.status === "failed") {
        const bill = this.getBill(input.billId);
        if (bill?.batchItemId) {
          this.sqlite.query("UPDATE admin_upload_batch_items SET state = 'failed', updated_at = ? WHERE id = ? AND state = 'processing'").run(now, bill.batchItemId);
          this.completeAdminUploadBatchIfTerminal(bill.batchItemId, now);
        }
      }
      return result.changes === 1;
    })();
  }

  /** Keeps the Mistral result available for review when Azure fallback cannot complete. */
  persistAzureFallbackFailure(input: { billId: string; jobId: string; leaseToken: string; errorDetails: string }): boolean {
    return this.sqlite.transaction(() => {
      const now = new Date().toISOString();
      if (!this.leaseOwned(input.jobId, input.leaseToken, now)) return false;
      const result = this.sqlite.query(`UPDATE extractions SET fallback_status = 'failed', error_details = ?, updated_at = ?
        WHERE bill_id = ? AND selected_provider = 'mistral' AND fallback_status = 'pending' AND normalized_json IS NOT NULL`).run(input.errorDetails, now, input.billId);
      if (result.changes === 1) this.sqlite.query("UPDATE bills SET status = 'needs_review', manual_review_required = 1, updated_at = ? WHERE id = ?").run(now, input.billId);
      return result.changes === 1;
    })();
  }

  private leaseOwned(jobId: string, leaseToken: string, now: string): boolean {
    return Boolean(this.sqlite.query<{ value: number }, [string, string, string]>("SELECT 1 AS value FROM jobs WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_expires_at IS NOT NULL AND lease_expires_at > ?").get(jobId, leaseToken, now)?.value);
  }

  private recordExtractionAttempt(input: { billId: string; jobId: string; jobAttempt: number; provider: ExtractionProvider; providerModel: string | null; requestedAt: string; completedAt: string; outcome: "succeeded" | "failed"; rawProviderResponse: string | null; errorDetails: string | null }): void {
    this.sqlite.query("INSERT INTO extraction_attempts (id, bill_id, job_id, job_attempt, provider, provider_model, requested_at, completed_at, outcome, raw_provider_response, error_details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), input.billId, input.jobId, input.jobAttempt, input.provider, input.providerModel, input.requestedAt, input.completedAt, input.outcome, input.rawProviderResponse, input.errorDetails, new Date().toISOString());
  }

  getJob(id: string): Job | null {
    const row = this.sqlite.query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? toJob(row) : null;
  }

  /** Read-only operational view; SQLite remains the source for all status reporting. */
  listJobs(states?: readonly JobState[]): Job[] {
    if (states?.length === 0) return [];
    if (!states) return this.sqlite.query<JobRow, []>("SELECT * FROM jobs ORDER BY available_at, created_at").all().map(toJob);
    const placeholders = states.map(() => "?").join(",");
    return this.sqlite.query<JobRow, string[]>(`SELECT * FROM jobs WHERE state IN (${placeholders}) ORDER BY available_at, created_at`).all(...states).map(toJob);
  }

  listJobsForBill(billId: string): Job[] {
    return this.sqlite.query<JobRow, [string]>("SELECT * FROM jobs WHERE bill_id = ? ORDER BY created_at").all(billId).map(toJob);
  }

  /** Snapshot-safe canonical original inventory for backup/export tooling. */
  listCanonicalOriginals(): Array<Pick<Bill, "id" | "originalPath" | "contentSha256" | "mimeType">> {
    return this.sqlite.query<Pick<BillRow, "id" | "original_path" | "content_sha256" | "mime_type">, []>("SELECT id, original_path, content_sha256, mime_type FROM bills ORDER BY id").all()
      .map((row) => ({ id: row.id, originalPath: row.original_path, contentSha256: row.content_sha256, mimeType: row.mime_type }));
  }

  /** Matches canonical source IDs plus Drive and Sheets projection identifiers. */
  findBillsByIdentifier(identifier: string): Bill[] {
    return this.sqlite.query<BillRow, [string, string, string, string, string, string, string, string, string]>(`SELECT DISTINCT b.* FROM bills b
      LEFT JOIN provider_projection_metadata p ON p.bill_id = b.id
      WHERE b.id = ? OR b.source_message_id = ? OR b.source_chat_id = ? OR b.source_sender_id = ? OR b.source_identity = ?
          OR b.drive_file_id = ? OR b.sheet_row_key = ? OR p.external_id = ? OR p.projection_key = ? ORDER BY b.created_at`,
    ).all(identifier, identifier, identifier, identifier, identifier, identifier, identifier, identifier, identifier).map(toBill);
  }

  /** Explicit, auditable replay. It never requeues completed work or invalidated projections. */
  requeueJob(id: string, includePermanent = false): boolean {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      const job = this.getJob(id);
      if (!job || (job.state !== "retryable_failure" && (!includePermanent || job.state !== "permanent_failure")) || job.lastError === "validation_invalidated") return false;
      const bill = this.getBill(job.billId);
      if (!bill || (job.type === "project_to_sheet" && !this.isApprovedAtRevision(job.billId, job.expectedRevision)) || (job.type === "sync_review_correction" && bill.status !== "failed" && bill.status !== "needs_review" && bill.status !== "approved")) return false;
      const result = this.sqlite.query("UPDATE jobs SET state = 'pending', available_at = ?, lease_token = NULL, lease_expires_at = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND state IN ('retryable_failure', 'permanent_failure')").run(now, now, id);
      if (result.changes === 1) recordTransition(this.sqlite, id, job.state, "pending", "operator_replay", now);
      return result.changes === 1;
    })();
  }

  countJobsForBill(billId: string): number {
    return this.sqlite.query<{ count: number }, [string]>("SELECT count(*) AS count FROM jobs WHERE bill_id = ?").get(billId)?.count ?? 0;
  }

  getJobTransitions(jobId: string): JobTransition[] {
    return this.sqlite.query<JobTransitionRow, [string]>("SELECT * FROM job_transition_history WHERE job_id = ? ORDER BY rowid").all(jobId).map(toJobTransition);
  }

  /** Atomically transitions exactly one available job to running. No provider code is invoked here. */
  claimNextJob(workerId: string, policy: RetryPolicy, now = new Date(), supportedTypes: readonly JobType[] = jobTypes): ClaimedJob | null {
    if (supportedTypes.length === 0) return null;
    if (supportedTypes.some((type) => !jobTypes.includes(type))) throw new Error("Unsupported job type in claim filter");
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + policy.leaseMs).toISOString();
    const token = randomUUID();
    const expiredLeases = this.sqlite.query<JobRow, [string]>("SELECT * FROM jobs WHERE state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?");
    const expireLease = this.sqlite.query("UPDATE jobs SET state = ?, available_at = ?, last_error = 'lease expired', lease_token = NULL, lease_expires_at = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND state = 'running'");
    const retriesReady = this.sqlite.query<JobRow, [string]>("SELECT * FROM jobs WHERE state = 'retryable_failure' AND available_at <= ?");
    const releaseRetry = this.sqlite.query("UPDATE jobs SET state = 'pending', updated_at = ? WHERE id = ? AND state = 'retryable_failure'");
    const allowedTypes = supportedTypes.map((type) => `'${type}'`).join(",");
    const claim = this.sqlite.query<JobRow, [string, string, string, string, string, string]>(`UPDATE jobs SET state = 'running', attempts = attempts + 1, lease_token = ?, lease_expires_at = ?, claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = (SELECT id FROM jobs WHERE state = 'pending' AND available_at <= ? AND type IN (${allowedTypes}) ORDER BY available_at, created_at LIMIT 1) AND state = 'pending' RETURNING *`);
    return this.sqlite.transaction(() => {
      for (const expired of expiredLeases.all(nowIso)) {
        const transition = retryTransition(expired.attempts, policy, now);
        if (expireLease.run(transition.state, transition.availableAt, nowIso, expired.id).changes === 1) recordTransition(this.sqlite, expired.id, "running", transition.state, "lease_expired", nowIso);
      }
      for (const retry of retriesReady.all(nowIso)) {
        if (releaseRetry.run(nowIso, retry.id).changes === 1) recordTransition(this.sqlite, retry.id, "retryable_failure", "pending", "retry_available", nowIso);
      }
      const row = claim.get(token, leaseExpiresAt, workerId, nowIso, nowIso, nowIso);
      if (!row || !row.lease_token || !row.lease_expires_at || !row.claimed_by || !row.claimed_at) return null;
      recordTransition(this.sqlite, row.id, "pending", "running", "claimed", nowIso);
      return { ...toJob(row), leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at, claimedBy: row.claimed_by, claimedAt: row.claimed_at };
    })();
  }

  completeJob(id: string, leaseToken: string): boolean {
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      const result = this.sqlite.query("UPDATE jobs SET state = 'succeeded', lease_token = NULL, lease_expires_at = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND state = 'running' AND lease_token = ?").run(now, id, leaseToken);
      if (result.changes === 1) recordTransition(this.sqlite, id, "running", "succeeded", "completed", now);
      return result.changes === 1;
    })();
  }

  failJob(id: string, leaseToken: string, error: string, policy: RetryPolicy, now = new Date(), retryable = true): Job | null {
    return this.sqlite.transaction(() => {
      const current = this.getJob(id);
      if (!current || current.state !== "running" || current.leaseToken !== leaseToken) return null;
      const nowIso = now.toISOString();
      const transition = retryable ? retryTransition(current.attempts, policy, now) : { state: "permanent_failure" as const, availableAt: now.toISOString() };
      const result = this.sqlite.query<JobRow, [string, string, string, string, string, string]>(`UPDATE jobs SET state = ?, available_at = ?, last_error = ?, lease_token = NULL, lease_expires_at = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND state = 'running' AND lease_token = ? RETURNING *`).get(transition.state, transition.availableAt, safeJobError(error), nowIso, id, leaseToken);
      if (!result) return null;
      recordTransition(this.sqlite, id, "running", transition.state, "handler_failed", nowIso);
      return toJob(result);
    })();
  }

  /** Fenced lease renewal used only while an external handler is running. */
  renewLease(id: string, leaseToken: string, leaseMs: number, now = new Date()): boolean {
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const result = this.sqlite.query("UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_expires_at > ?").run(expiresAt, nowIso, id, leaseToken, nowIso);
    return result.changes === 1;
  }
}
