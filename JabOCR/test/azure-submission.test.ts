import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AzureDocumentIntelligenceInvoiceProvider, AzureSubmissionRejectedError } from "../src/backend/azure-invoice";
import { createExtractJobHandler } from "../src/backend/extraction";
import { createExtractionValidationCallback } from "../src/backend/validation";
import { JobWorker } from "../src/backend/worker";
import { BillDatabase, type RetryPolicy } from "../src/db/database";

const policy: RetryPolicy = { maxAttempts: 3, retryBaseMs: 0, retryMaxMs: 0, leaseMs: 60_000 };
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const azureResult = JSON.stringify({ status: "succeeded", analyzeResult: { documents: [{ fields: {
  VendorName: { type: "string", valueString: "Acme", content: "Acme", confidence: 0.99 },
  InvoiceDate: { type: "date", valueDate: "2024-01-02", content: "2024-01-02", confidence: 0.99 },
  InvoiceTotal: { type: "currency", valueCurrency: { amount: 12.5, currencyCode: "USD" }, content: "12.50 USD", confidence: 0.99 },
} }] } });

function fixture(maxAttempts = 3) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jabocr-azure-")));
  const original = join(dir, "bill.pdf");
  writeFileSync(original, pdf);
  const database = new BillDatabase(join(dir, "ledger.sqlite"));
  const created = database.createBillWithInitialJobs({
    source: "whatsapp", sourceMessageId: "message", sourceChatId: "chat", sourceSenderId: "sender", attachmentIndex: 0,
    receivedAt: new Date().toISOString(), sourceFilename: "bill.pdf", mimeType: "application/pdf", originalPath: original,
    contentSha256: createHash("sha256").update(pdf).digest("hex"), extractionPolicy: "azure_only",
  }, [{ type: "extract", idempotencyKey: "extract:bill" }]);
  const cleanup = () => { database.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, database, bill: created.bill, cleanup, policy: { ...policy, maxAttempts } };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
function provider(fetchImpl: FetchLike) {
  return new AzureDocumentIntelligenceInvoiceProvider({ endpoint: "https://azure.example", apiKey: "test-key", fetchImpl, pollIntervalMs: 0, sleep: async () => {} });
}

function worker(database: BillDatabase, azure: AzureDocumentIntelligenceInvoiceProvider, retry: RetryPolicy, root: string) {
  const validate = createExtractionValidationCallback(database, { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 365 });
  return new JobWorker(database, { extract: createExtractJobHandler(database, null, retry.maxAttempts, validate, { root, maxBytes: 1024 * 1024 }, undefined, azure) }, retry, "test-worker", logger);
}

function makeRetryReady(database: BillDatabase, billId: string) {
  database.sqlite.query("UPDATE jobs SET available_at = ? WHERE bill_id = ?").run(new Date(Date.now() - 1_000).toISOString(), billId);
}

test("POST 429 is atomically auditable, then a later worker submission succeeds", async () => {
  const f = fixture(); let posts = 0; let gets = 0;
  const azure = provider(async (_url, init) => {
    if (init?.method === "POST") { posts++; return posts === 1 ? new Response("ignored", { status: 429 }) : new Response(null, { status: 202, headers: { "operation-location": "https://azure.example/operations/1" } }); }
    gets++; return new Response(azureResult, { status: 200 });
  });
  try {
    const first = worker(f.database, azure, f.policy, f.dir);
    expect(await first.runOnce()).toBe(true);
    expect(f.database.listJobsForBill(f.bill.id)[0]?.state).toBe("retryable_failure");
    const rejected = f.database.getExtractionInvocations(f.bill.id);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ provider: "azure", outcome: "failed", errorDetails: "Azure Document Intelligence submission failed with HTTP 429" });
    expect(f.database.getAzureExtractionOperation(rejected[0]!.id)).toMatchObject({ state: "failed", operationLocation: null });
    makeRetryReady(f.database, f.bill.id);
    expect(await worker(f.database, azure, f.policy, f.dir).runOnce()).toBe(true);
    expect({ posts, gets }).toEqual({ posts: 2, gets: 1 });
    expect(f.database.listJobsForBill(f.bill.id)[0]?.state).toBe("succeeded");
    expect(f.database.getBill(f.bill.id)?.status).toBe("approved");
    expect(f.database.getExtractionInvocations(f.bill.id).map(({ outcome, jobAttempt }) => ({ outcome, jobAttempt }))).toEqual([{ outcome: "failed", jobAttempt: 1 }, { outcome: "succeeded", jobAttempt: 2 }]);
  } finally { f.cleanup(); }
});

test("repeated POST 429s exhaust the configured retry budget", async () => {
  const f = fixture(3); let posts = 0;
  const azure = provider(async (_url, init) => {
    if (init?.method === "POST") {
      posts++;
      return posts <= 3 ? new Response(null, { status: 429 }) : new Response(null, { status: 202, headers: { "operation-location": "https://azure.example/operations/2" } });
    }
    return new Response(azureResult, { status: 200 });
  });
  try {
    const job = worker(f.database, azure, f.policy, f.dir);
    for (let attempt = 1; attempt <= 3; attempt++) { expect(await job.runOnce()).toBe(true); if (attempt < 3) makeRetryReady(f.database, f.bill.id); }
    expect(posts).toBe(3);
    expect(f.database.listJobsForBill(f.bill.id)[0]).toMatchObject({ state: "permanent_failure", attempts: 3 });
    expect(f.database.getBill(f.bill.id)?.status).toBe("needs_review");
    expect(f.database.getExtractionInvocations(f.bill.id).every((item) => item.outcome === "failed")).toBe(true);
    expect(f.database.requeueJob(f.database.listJobsForBill(f.bill.id)[0]!.id, true)).toBe(true);
    expect(await job.runOnce()).toBe(true);
    expect({ posts, state: f.database.getBill(f.bill.id)?.status }).toEqual({ posts: 4, state: "approved" });
  } finally { f.cleanup(); }
});

test("polling HTTP 429 remains retryable without repeating its POST", async () => {
  const f = fixture(); let posts = 0; let gets = 0;
  const azure = provider(async (_url, init) => {
    if (init?.method === "POST") { posts++; return new Response(null, { status: 202, headers: { "operation-location": "https://azure.example/operations/1" } }); }
    gets++; return gets === 1 ? new Response(null, { status: 429 }) : new Response(azureResult, { status: 200 });
  });
  try {
    const job = worker(f.database, azure, f.policy, f.dir);
    expect(await job.runOnce()).toBe(true);
    expect(f.database.listJobsForBill(f.bill.id)[0]?.state).toBe("retryable_failure");
    expect(f.database.getResumableAzureExtractionOperation(f.bill.id)?.operationLocation).toBe("https://azure.example/operations/1");
    makeRetryReady(f.database, f.bill.id);
    expect(await job.runOnce()).toBe(true);
    expect(f.database.listJobsForBill(f.bill.id)[0]?.state).toBe("succeeded");
    expect({ posts, gets }).toEqual({ posts: 1, gets: 2 });
  } finally { f.cleanup(); }
});

test("POST 429 is known even when its body cannot be read or cancelled", async () => {
  const azure = provider(async () => new Response(new ReadableStream({
    pull() { throw new Error("unreadable body"); },
    cancel() { throw new Error("cancel failed"); },
  }), { status: 429 }));
  await expect(azure.submit({ bytes: pdf, mimeType: "application/pdf" })).rejects.toBeInstanceOf(AzureSubmissionRejectedError);
});

test("accepted submissions with an unpersisted URL are not submitted again", async () => {
  const f = fixture(); let posts = 0;
  const azure = provider(async () => { posts++; return new Response(null, { status: 202, headers: { "operation-location": "https://azure.example/operations/lost" } }); });
  try {
    f.database.persistAzureExtractionOperation = () => null;
    const job = worker(f.database, azure, f.policy, f.dir);
    expect(await job.runOnce()).toBe(true);
    makeRetryReady(f.database, f.bill.id);
    expect(await job.runOnce()).toBe(true);
    expect(posts).toBe(1);
    expect(f.database.listJobsForBill(f.bill.id)[0]).toMatchObject({ state: "permanent_failure", attempts: 2 });
    expect(f.database.getExtraction(f.bill.id)?.errorDetails).toBe("Azure submission outcome is unknown; operation URL was not persisted");
  } finally { f.cleanup(); }
});

test("an ambiguous POST network failure remains permanently fenced and is not resubmitted", async () => {
  const f = fixture(); let posts = 0;
  const azure = provider(async (_url, init) => { if (init?.method === "POST") { posts++; throw new Error("socket reset"); } throw new Error("unexpected poll"); });
  try {
    expect(await worker(f.database, azure, f.policy, f.dir).runOnce()).toBe(true);
    const job = f.database.listJobsForBill(f.bill.id)[0]!;
    expect(job.state).toBe("retryable_failure");
    expect(posts).toBe(1);
    makeRetryReady(f.database, f.bill.id);
    expect(await worker(f.database, azure, f.policy, f.dir).runOnce()).toBe(true);
    expect(f.database.getJob(job.id)?.state).toBe("permanent_failure");
    expect(posts).toBe(1);
  } finally { f.cleanup(); }
});

test("stale leases cannot reject submissions, and a failed second update rolls back both records", () => {
  const f = fixture();
  try {
    const claimed = f.database.claimNextJob("owner", f.policy)!;
    const invocation = f.database.beginExtractionInvocation({ billId: f.bill.id, jobId: claimed.id, leaseToken: claimed.leaseToken, jobAttempt: claimed.attempts, provider: "azure", idempotencyKey: "azure", jobIdempotencyKey: claimed.idempotencyKey, requestedAt: new Date().toISOString() })!.invocation;
    expect(f.database.beginAzureExtractionSubmission({ invocationId: invocation.id, billId: f.bill.id, jobId: claimed.id, leaseToken: claimed.leaseToken })?.created).toBe(true);
    expect(f.database.rejectAzureExtractionSubmission({ invocationId: invocation.id, jobId: claimed.id, leaseToken: "stale", completedAt: new Date().toISOString(), errorDetails: "429" })).toBe(false);
    f.database.sqlite.exec("CREATE TRIGGER reject_rollback BEFORE UPDATE ON extraction_invocations WHEN NEW.outcome = 'failed' BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
    expect(() => f.database.rejectAzureExtractionSubmission({ invocationId: invocation.id, jobId: claimed.id, leaseToken: claimed.leaseToken, completedAt: new Date().toISOString(), errorDetails: "429" })).toThrow("test rollback");
    expect(f.database.getExtractionInvocations(f.bill.id)[0]).toMatchObject({ outcome: "requested", completedAt: null });
    expect(f.database.getAzureExtractionOperation(invocation.id)).toMatchObject({ state: "submitting", completedAt: null, lastError: null });
  } finally { f.cleanup(); }
});
