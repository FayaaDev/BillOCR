import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobHandlers } from "../src/contracts";
import { BillDatabase, type RetryPolicy } from "../src/database";
import { createLogger } from "../src/logger";
import { BackgroundWorkerLoop, JobWorker } from "../src/worker";

const policy: RetryPolicy = { maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1_000, leaseMs: 60_000 };
let directory: string;
let database: BillDatabase;

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "bill-worker-")); database = new BillDatabase(join(directory, "ledger.sqlite")); });
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

function enqueue(type: "extract" | "archive_to_drive" | "project_to_sheet" = "extract") {
  return database.createBillWithInitialJobs({ whatsappMessageId: "message", whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: new Date().toISOString(), mimeType: "image/png", originalPath: "/file", contentSha256: "b".repeat(64) }, [{ type, idempotencyKey: `key:${type}` }]);
}

test("a running projection cannot complete after its revision is superseded", async () => {
  const bill = enqueue("project_to_sheet");
  database.sqlite.query("UPDATE bills SET status = 'approved', content_revision = 1 WHERE id = ?").run(bill.bill.id);
  database.sqlite.query("UPDATE jobs SET expected_revision = 1 WHERE bill_id = ?").run(bill.bill.id);
  const worker = new JobWorker(database, { project_to_sheet: async () => { database.supersedeForReview(bill.bill.id, "reviewer"); } }, policy, "project-worker", createLogger("error"));
  expect(await worker.runOnce()).toBe(true);
  expect(database.sqlite.query<{ state: string; lease_token: string | null }, [string]>("SELECT state, lease_token FROM jobs WHERE bill_id = ?").get(bill.bill.id)).toMatchObject({ state: "permanent_failure", lease_token: null });
});

test("an unsupported job remains pending for a later injected handler", async () => {
  const bill = enqueue();
  const worker = new JobWorker(database, {}, policy, "worker", createLogger("error"));
  expect(await worker.runOnce()).toBe(false);
  const job = database.sqlite.query<{ state: string }, [string]>("SELECT state FROM jobs WHERE bill_id = ?").get(bill.bill.id);
  expect(job?.state).toBe("pending");
  expect(database.getJobHealth(new Date(), worker.supportedTypes)).toEqual({ overdueJobs: 0, oldestDueAt: null });
  const enabled = new JobWorker(database, { extract: async () => undefined }, policy, "enabled", createLogger("error"));
  expect(database.getJobHealth(new Date(), enabled.supportedTypes).overdueJobs).toBe(1);
});

test("provider error content is sanitized from durable diagnostics and never logged", async () => {
  const bill = enqueue();
  const lines: string[] = [];
  const handlers: JobHandlers = { extract: async () => { throw new Error("Authorization: Bearer provider-secret-value"); } };
  const worker = new JobWorker(database, handlers, policy, "worker", createLogger("debug", (line) => lines.push(line)));
  expect(await worker.runOnce()).toBe(true);
  expect(lines.join("\n")).not.toContain("provider-secret-value");
  expect(database.sqlite.query<{ last_error: string }, [string]>("SELECT last_error FROM jobs WHERE bill_id = ?").get(bill.bill.id)?.last_error).toBe("job_handler_failed");
});

test("background worker loop yields to the event loop and stops cleanly", async () => {
  let calls = 0;
  const loop = new BackgroundWorkerLoop({ runOnce: async () => { calls += 1; return false; } }, createLogger("error"), 1_000);
  loop.start();
  await Bun.sleep(20);
  await loop.stop();
  expect(calls).toBe(1);
  await Bun.sleep(20);
  expect(calls).toBe(1);
});

test("worker health distinguishes idle, long active work, stalled work, and shutdown", async () => {
  const pending = Promise.withResolvers<boolean>();
  const loop = new BackgroundWorkerLoop({ runOnce: () => pending.promise }, createLogger("error"));
  loop.start(); await Bun.sleep(5);
  const activeSince = loop.health().activeSince!;
  expect(loop.health(activeSince + 60_000).reasons).toEqual([]);
  expect(loop.health(activeSince + 16 * 60_000).reasons).toContain("worker_stalled");
  pending.resolve(false); await Bun.sleep(5);
  expect(loop.health().activeSince).toBeNull(); expect(loop.health().reasons).toEqual([]);
  expect(loop.health(loop.health().lastProgressAt + 31_000).reasons).toContain("worker_stalled");
  await loop.stop(); expect(loop.health().reasons).toContain("worker_stopped");
});

test("worker health reports iteration failure and recovers on a successful idle poll", async () => {
  let fail = true;
  const loop = new BackgroundWorkerLoop({ runOnce: async () => { if (fail) throw new Error("secret"); return false; } }, createLogger("error"), 5);
  loop.start(); await Bun.sleep(3);
  expect(loop.health().reasons).toContain("worker_failed");
  fail = false; await Bun.sleep(20);
  expect(loop.health().reasons).toEqual([]); await loop.stop();
});

test("backlog health excludes future retries and valid leases, includes expired leases", () => {
  enqueue();
  const now = new Date();
  expect(database.getJobHealth(now).overdueJobs).toBe(1);
  database.sqlite.query("UPDATE jobs SET state = 'retryable_failure', available_at = ?").run(new Date(now.getTime() + 60_000).toISOString());
  expect(database.getJobHealth(now).overdueJobs).toBe(0);
  database.sqlite.query("UPDATE jobs SET state = 'running', lease_expires_at = ?").run(new Date(now.getTime() + 60_000).toISOString());
  database.sqlite.query("UPDATE jobs SET available_at = ?").run(new Date(now.getTime() - 3_600_000).toISOString());
  expect(database.getJobHealth(now)).toEqual({ overdueJobs: 0, oldestDueAt: null });
  expect(database.getJobHealth(new Date(now.getTime() + 61_000))).toEqual({ overdueJobs: 1, oldestDueAt: new Date(now.getTime() + 60_000).toISOString() });
});

test("lease heartbeat prevents a second worker from duplicating a long provider call", async () => {
  const bill = enqueue();
  const shortLease: RetryPolicy = { ...policy, leaseMs: 30 };
  let providerCalls = 0;
  const handlers: JobHandlers = { extract: async () => { providerCalls += 1; await Bun.sleep(100); } };
  const firstWorker = new JobWorker(database, handlers, shortLease, "worker-a", createLogger("error"));
  const secondDatabase = new BillDatabase(join(directory, "ledger.sqlite"));
  const secondWorker = new JobWorker(secondDatabase, handlers, shortLease, "worker-b", createLogger("error"));
  const firstRun = firstWorker.runOnce();
  await Bun.sleep(60);
  expect(await secondWorker.runOnce()).toBe(false);
  await firstRun;
  expect(providerCalls).toBe(1);
  expect(database.sqlite.query<{ state: string }, [string]>("SELECT state FROM jobs WHERE bill_id = ?").get(bill.bill.id)?.state).toBe("succeeded");
  secondDatabase.close();
});

test("handler receives a stable idempotency key and cannot fence an expired claim", async () => {
  const bill = enqueue();
  const shortLease: RetryPolicy = { ...policy, leaseMs: 30 };
  const secondDatabase = new BillDatabase(join(directory, "ledger.sqlite"));
  let key = "";
  let assertionFailed = false;
  const handlers: JobHandlers = {
    extract: async (_job, context) => {
      key = context.idempotencyKey;
      secondDatabase.claimNextJob("worker-b", shortLease, new Date(Date.now() + 1_000));
      try { context.assertLease(); } catch { assertionFailed = true; }
    },
  };
  await new JobWorker(database, handlers, shortLease, "worker-a", createLogger("error")).runOnce();
  expect(key).toBe("key:extract");
  expect(assertionFailed).toBe(true);
  expect(database.sqlite.query<{ state: string }, [string]>("SELECT state FROM jobs WHERE bill_id = ?").get(bill.bill.id)?.state).toBe("retryable_failure");
  secondDatabase.close();
});

test("heartbeat database errors are contained and logged without error content", async () => {
  enqueue();
  const lines: string[] = [];
  const originalRenewLease = database.renewLease.bind(database);
  database.renewLease = () => { throw new Error("heartbeat-provider-secret"); };
  const handlers: JobHandlers = { extract: async () => { await Bun.sleep(30); } };
  await new JobWorker(database, handlers, { ...policy, leaseMs: 10 }, "worker", createLogger("debug", (line) => lines.push(line))).runOnce();
  database.renewLease = originalRenewLease;
  expect(lines.join("\n")).toContain("job lease heartbeat failed");
  expect(lines.join("\n")).not.toContain("heartbeat-provider-secret");
});

test("normal worker validation completion atomically completes its terminal admin batch", async () => {
  const batch = database.createAdminUploadBatch({ idempotencyKey: "worker-batch", originalFilename: "invoices.zip" }).batch;
  const item = database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex: 0, entryPath: "invoice.png" }).item;
  expect(database.setAdminUploadBatchState(batch.id, "processing")).toBe(true);
  const bill = database.createBillWithInitialJobs({ whatsappMessageId: "admin-worker", whatsappGroupId: "admin-upload", whatsappSenderId: "admin-upload", attachmentIndex: 0, receivedAt: new Date().toISOString(), mimeType: "image/png", originalPath: "/file", contentSha256: "c".repeat(64), source: "admin_upload", sourceIdentity: "admin-worker", extractionPolicy: "azure_only", classification: "invoice", batchItemId: item.id }, [{ type: "extract", idempotencyKey: "extract:admin-worker" }]).bill;
  database.sqlite.query("UPDATE bills SET invoice_dedup_required = 0 WHERE id = ?").run(bill.id);
  const worker = new JobWorker(database, { extract: async () => { expect(database.persistValidationDecision({ billId: bill.id, expectedContentRevision: 0, expectedReviewRevision: 0, decision: "approved", issues: [] })).toBe(true); } }, policy, "worker", createLogger("error"));
  expect(await worker.runOnce()).toBe(true);
  expect(database.getBill(bill.id)?.status).toBe("approved");
  expect(database.getAdminUploadBatchStatus(batch.id)?.batch.state).toBe("completed");
  expect(database.getAdminUploadBatchStatusCounts(batch.id)).toMatchObject({ processing: 0, complete: 1 });
});
