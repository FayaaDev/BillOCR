import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase, type RetryPolicy } from "../src/database";

const policy: RetryPolicy = { maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1_000, leaseMs: 60_000 };
let directory: string;
let path: string;
let database: BillDatabase;
const input = () => ({ whatsappMessageId: "message-1", whatsappGroupId: "group-1", whatsappSenderId: "sender-1", attachmentIndex: 0, receivedAt: "2026-08-27T00:00:00.000Z", caption: "receipt", originalFilename: "receipt.png", mimeType: "image/png", originalPath: "/durable/receipt.png", contentSha256: "a".repeat(64) });
const jobs = () => [{ type: "extract" as const, idempotencyKey: "extract:message-1:0" }, { type: "archive_to_drive" as const, idempotencyKey: "archive:message-1:0" }];

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "bill-ledger-")); path = join(directory, "ledger.sqlite"); database = new BillDatabase(path); });
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

describe("migrations", () => {
  test("apply on a fresh database and safely reapply", () => {
    database.close();
    const reopened = new BillDatabase(path);
    expect(reopened.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM schema_migrations").get()?.count).toBe(9);
    expect(reopened.sqlite.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'validation_issues'").get()?.name).toBe("validation_issues");
    reopened.close();
    database = new BillDatabase(path);
  });

  test("independent connections safely apply migrations to the same fresh database", async () => {
    database.close();
    const source = `import { BillDatabase } from ${JSON.stringify(new URL("../src/database.ts", import.meta.url).pathname)}; new BillDatabase(Bun.argv[1]).close();`;
    const first = Bun.spawn(["bun", "-e", source, path], { cwd: process.cwd(), stdout: "ignore", stderr: "pipe" });
    const second = Bun.spawn(["bun", "-e", source, path], { cwd: process.cwd(), stdout: "ignore", stderr: "pipe" });
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    database = new BillDatabase(path);
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM schema_migrations").get()?.count).toBe(9);
  });
});

test("Drive folder reservations converge concurrent logical paths on one generated identity", () => {
  const first = database.reserveDriveId({ key: "folder:Bills/2026", kind: "folder", parentId: "root", logicalPath: "Bills/2026", generatedId: "folder-a" });
  const second = database.reserveDriveId({ key: "folder:Bills/2026", kind: "folder", parentId: "root", logicalPath: "Bills/2026", generatedId: "folder-b" });
  expect(first.drive_id).toBe("folder-a"); expect(second.drive_id).toBe("folder-a");
});

test("operator inspection and explicit replay expose only eligible failed jobs", () => {
  const bill = database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "operator-job" }]).bill;
  const job = database.claimNextJob("worker", policy)!;
  database.failJob(job.id, job.leaseToken, "timeout", policy);
  expect(database.findBillsByIdentifier("message-1").map((item) => item.id)).toEqual([bill.id]);
  expect(database.listJobs(["retryable_failure"]).map((item) => item.id)).toEqual([job.id]);
  expect(database.requeueJob(job.id)).toBe(true);
  expect(database.getJobTransitions(job.id).at(-1)).toMatchObject({ fromState: "retryable_failure", toState: "pending", reason: "operator_replay" });
  const claim = database.claimNextJob("worker", policy)!;
  database.failJob(claim.id, claim.leaseToken, "malformed schema", { ...policy, maxAttempts: 1 });
  expect(database.requeueJob(job.id)).toBe(false);
  expect(database.requeueJob(job.id, true)).toBe(true);
  database.sqlite.query("UPDATE jobs SET last_error = 'validation_invalidated', state = 'permanent_failure' WHERE id = ?").run(job.id);
  expect(database.requeueJob(job.id, true)).toBe(false);
});

describe("canonical bill and jobs", () => {
  test("creates a bill and its initial jobs exactly once for a repeated provider event", () => {
    const first = database.createBillWithInitialJobs(input(), jobs());
    const repeated = database.createBillWithInitialJobs(input(), jobs());
    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.bill.id).toBe(first.bill.id);
    expect(database.countJobsForBill(first.bill.id)).toBe(2);
  });

  test("rolls back a new bill when a required job idempotency key belongs to another bill", () => {
    database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "shared-key" }]);
    expect(() => database.createBillWithInitialJobs({ ...input(), whatsappMessageId: "message-2", attachmentIndex: 1 }, [{ type: "extract", idempotencyKey: "shared-key" }])).toThrow("idempotency key");
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(1);
  });

  test("competing workers cannot claim the same job", () => {
    database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "only-job" }]);
    const secondConnection = new BillDatabase(path);
    const firstClaim = database.claimNextJob("worker-a", policy);
    const secondClaim = secondConnection.claimNextJob("worker-b", policy);
    expect(firstClaim).not.toBeNull();
    expect(secondClaim).toBeNull();
    secondConnection.close();
  });

  test("records retryable failure with bounded exponential availability and then reclaims it", () => {
    const start = new Date("2026-08-27T00:00:00.000Z");
    database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "retry-job", availableAt: start.toISOString() }]);
    const claim = database.claimNextJob("worker-a", policy, start);
    if (!claim) throw new Error("expected claim");
    const failed = database.failJob(claim.id, claim.leaseToken, "temporary outage", policy, start);
    expect(failed?.state).toBe("retryable_failure");
    expect(failed?.availableAt).toBe("2026-08-27T00:00:00.100Z");
    expect(database.claimNextJob("worker-b", policy, new Date("2026-08-27T00:00:00.099Z"))).toBeNull();
    const retried = database.claimNextJob("worker-b", policy, new Date("2026-08-27T00:00:00.100Z"));
    expect(retried?.state).toBe("running");
    expect(retried?.attempts).toBe(2);
  });

  test("expires a lease into a delayed, observable retryable failure", () => {
    const start = new Date("2026-08-27T00:00:00.000Z");
    database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "leased-job", availableAt: start.toISOString() }]);
    const claim = database.claimNextJob("worker-a", policy, start);
    if (!claim) throw new Error("expected claim");
    const expires = new Date("2026-08-27T00:01:00.000Z");
    expect(database.claimNextJob("worker-b", policy, expires)).toBeNull();
    expect(database.getJob(claim.id)).toMatchObject({ state: "retryable_failure", attempts: 1, availableAt: "2026-08-27T00:01:00.100Z", lastError: "lease expired" });
    expect(database.getJobTransitions(claim.id).map((transition) => transition.reason)).toEqual(["created", "claimed", "lease_expired"]);
    expect(database.claimNextJob("worker-b", policy, new Date("2026-08-27T00:01:00.099Z"))).toBeNull();
    expect(database.claimNextJob("worker-b", policy, new Date("2026-08-27T00:01:00.100Z"))?.attempts).toBe(2);
  });

  test("records every durable job state transition in history", () => {
    const start = new Date("2026-08-27T00:00:00.000Z");
    const bill = database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "audit-job", availableAt: start.toISOString() }]);
    const first = database.claimNextJob("worker-a", policy, start);
    if (!first) throw new Error("expected first claim");
    database.failJob(first.id, first.leaseToken, "temporary", policy, start);
    const second = database.claimNextJob("worker-b", policy, new Date("2026-08-27T00:00:00.100Z"));
    if (!second) throw new Error("expected retry claim");
    database.completeJob(second.id, second.leaseToken);
    expect(database.getJobTransitions(second.id).map((transition) => `${transition.fromState ?? "none"}->${transition.toState}:${transition.reason}`)).toEqual([
      "none->pending:created", "pending->running:claimed", "running->retryable_failure:handler_failed", "retryable_failure->pending:retry_available", "pending->running:claimed", "running->succeeded:completed",
    ]);
    expect(database.countJobsForBill(bill.bill.id)).toBe(1);
  });

  test("records permanent failure in transition history after the retry limit", () => {
    const start = new Date("2026-08-27T00:00:00.000Z");
    database.createBillWithInitialJobs(input(), [{ type: "extract", idempotencyKey: "permanent-job", availableAt: start.toISOString() }]);
    const claim = database.claimNextJob("worker", { ...policy, maxAttempts: 1 }, start);
    if (!claim) throw new Error("expected claim");
    expect(database.failJob(claim.id, claim.leaseToken, "fatal", { ...policy, maxAttempts: 1 }, start)?.state).toBe("permanent_failure");
    expect(database.getJobTransitions(claim.id).map((transition) => transition.toState)).toEqual(["pending", "running", "permanent_failure"]);
  });
});
