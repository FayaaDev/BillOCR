import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AzureDocumentIntelligenceInvoiceProvider, AzureSubmissionRejectedError, type AzureInvoiceProvider } from "../src/backend/azure-invoice";
import { createExtractJobHandler } from "../src/backend/extraction";
import { createExtractionValidationCallback } from "../src/backend/validation";
import { JobWorker } from "../src/backend/worker";
import { BillDatabase, type RetryPolicy } from "../src/db/database";

const pdf = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const policy: RetryPolicy = { maxAttempts: 3, retryBaseMs: 0, retryMaxMs: 0, leaseMs: 60_000 };
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const azureResult = JSON.stringify({ status: "succeeded", analyzeResult: { documents: [{ fields: {
  VendorName: { type: "string", valueString: "Acme", content: "Acme", confidence: 1 },
  InvoiceDate: { type: "date", valueDate: "2024-01-02", content: "2024-01-02", confidence: 1 },
  InvoiceTotal: { type: "currency", valueCurrency: { amount: 12, currencyCode: "USD" }, content: "12 USD", confidence: 1 },
} }] } });

class FakeClock {
  now: number;
  private waits: { at: number; resolve: () => void }[] = [];
  constructor(now = Date.now()) { this.now = now; }
  sleep = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const wait = { at: this.now + milliseconds, resolve };
    this.waits.push(wait);
    signal.addEventListener("abort", () => { this.waits = this.waits.filter((item) => item !== wait); reject(new Error("aborted")); }, { once: true });
  });
  async drain(): Promise<void> {
    while (this.waits.length) {
      const at = Math.min(...this.waits.map((wait) => wait.at));
      this.now = at;
      const due = this.waits.filter((wait) => wait.at === at);
      this.waits = this.waits.filter((wait) => wait.at !== at);
      for (const wait of due) wait.resolve();
      await Promise.resolve();
    }
  }
}

function provider(clock: FakeClock, fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, timeoutMs = 60_000) {
  return new AzureDocumentIntelligenceInvoiceProvider({ endpoint: "https://azure.example", apiKey: "test", fetchImpl, now: () => clock.now, sleep: clock.sleep, pollIntervalMs: 0, timeoutMs });
}

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jabocr-throttle-")));
  const original = join(dir, "bill.pdf");
  writeFileSync(original, pdf);
  const database = new BillDatabase(join(dir, "ledger.sqlite"));
  const bill = database.createBillWithInitialJobs({ source: "whatsapp", sourceMessageId: "message", sourceChatId: "chat", sourceSenderId: "sender", attachmentIndex: 0, receivedAt: new Date().toISOString(), sourceFilename: "bill.pdf", mimeType: "application/pdf", originalPath: original, contentSha256: createHash("sha256").update(pdf).digest("hex"), extractionPolicy: "azure_only" }, [{ type: "extract", idempotencyKey: "extract:bill" }]).bill;
  return { dir, database, bill, close: () => { database.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function extractionWorker(database: BillDatabase, azure: AzureInvoiceProvider, root: string, clock: FakeClock) {
  const validate = createExtractionValidationCallback(database, { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 365 });
  return new JobWorker(database, { extract: createExtractJobHandler(database, null, policy.maxAttempts, validate, { root, maxBytes: 1024 * 1024 }, undefined, azure) }, policy, "test", logger, { now: () => clock.now, random: () => 0 });
}

test("paces a 100-bill worker queue one second apart while GET polling uses its own lane", async () => {
  const clock = new FakeClock(1_000_000); const starts: { method: string; at: number }[] = [];
  const azure = provider(clock, async (_url, init) => { starts.push({ method: init?.method ?? "GET", at: clock.now }); return init?.method === "POST" ? new Response(null, { status: 202, headers: { "operation-location": "https://azure.example/op" } }) : new Response(azureResult); });
  for (let index = 0; index < 100; index++) {
    let settled = false;
    const submission = azure.submit({ bytes: pdf, mimeType: "application/pdf" }).finally(() => { settled = true; });
    while (!settled) { await Promise.resolve(); await clock.drain(); }
    await submission;
  }
  const postStarts = starts.filter(({ method }) => method === "POST").map(({ at }) => at);
  expect(postStarts).toHaveLength(100);
  expect(postStarts.slice(1).every((at, index) => at - postStarts[index]! >= 1_000)).toBe(true);
  const submitted = azure.submit({ bytes: pdf, mimeType: "application/pdf" });
  await Promise.resolve(); await clock.drain();
  const operation = await submitted;
  const polling = azure.poll(operation);
  await Promise.resolve(); await clock.drain(); await polling;
  const lastPost = starts.filter(({ method }) => method === "POST").at(-1)!;
  const get = starts.filter(({ method }) => method === "GET").at(-1)!;
  expect(get.at).toBeLessThan(lastPost.at + 1_000);
});

test("uses valid Azure retry headers, ignores invalid ones, and never reads a GET 429 body", async () => {
  const cases: [HeadersInit, number | undefined][] = [
    [{ "x-ms-retry-after-ms": "1234", "retry-after": "999" }, 1234],
    [{ "retry-after": "2" }, 2000],
    [{ "retry-after": new Date(1_005_000).toUTCString() }, 5000],
    [{ "x-ms-retry-after-ms": "nope", "retry-after": "3" }, 3000],
    [{ "x-ms-retry-after-ms": "-1", "retry-after": "wat" }, undefined],
  ];
  for (const [headers, expected] of cases) {
    const clock = new FakeClock(1_000_000);
    const azure = provider(clock, async () => new Response(null, { status: 429, headers }));
    await expect(azure.submit({ bytes: pdf, mimeType: "application/pdf" })).rejects.toMatchObject({ retryAfterMs: expected, addJitter: true });
  }
  const clock = new FakeClock();
  const azure = provider(clock, async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { status: 429, headers: { "retry-after": "4" } }));
  await expect(azure.poll({ operationLocation: "https://azure.example/op" })).rejects.toMatchObject({ retryAfterMs: 4000 });
});

test("a POST 429 cools down a different bill without delaying its durable retry decision", async () => {
  const clock = new FakeClock(); let posts = 0;
  const azure = provider(clock, async (_url, init) => {
    if (init?.method === "POST") { posts++; return posts === 1 ? new Response(null, { status: 429, headers: { "retry-after": "2" } }) : new Response(null, { status: 202, headers: { "operation-location": "https://azure.example/op" } }); }
    return new Response(azureResult);
  });
  await expect(azure.submit({ bytes: pdf, mimeType: "application/pdf" })).rejects.toBeInstanceOf(AzureSubmissionRejectedError);
  const next = azure.submit({ bytes: pdf, mimeType: "application/pdf" });
  await Promise.resolve(); expect(posts).toBe(1);
  await clock.drain(); await next;
  expect(posts).toBe(2);
});

test("long Azure cooldown defers before a submission marker and persists the retry across reopen", async () => {
  const f = fixture(); const clock = new FakeClock(); let posts = 0;
  const azure = provider(clock, async (_url, init) => {
    if (init?.method === "POST") { posts++; return posts === 1 ? new Response(null, { status: 429, headers: { "retry-after": "31" } }) : new Response(null, { status: 202, headers: { "operation-location": "https://azure.example/op" } }); }
    return new Response(azureResult);
  });
  try {
    await expect(azure.submit({ bytes: pdf, mimeType: "application/pdf" })).rejects.toBeInstanceOf(AzureSubmissionRejectedError);
    expect(await extractionWorker(f.database, azure, f.dir, clock).runOnce()).toBe(true);
    const job = f.database.listJobsForBill(f.bill.id)[0]!;
    expect(f.database.getExtractionInvocations(f.bill.id)).toHaveLength(0);
    expect(new Date(job.availableAt).getTime()).toBe(clock.now + 31_001);
    f.database.close();
    const reopened = new BillDatabase(join(f.dir, "ledger.sqlite"));
    try {
      expect(new Date(reopened.getJob(job.id)!.availableAt).getTime()).toBe(clock.now + 31_001);
      reopened.sqlite.query("UPDATE jobs SET available_at = ? WHERE id = ?").run(new Date(Date.now() - 1).toISOString(), job.id);
      clock.now += 31_000;
      expect(await extractionWorker(reopened, azure, f.dir, clock).runOnce()).toBe(true);
      expect(posts).toBe(2);
      expect(reopened.getBill(f.bill.id)?.status).toBe("approved");
    } finally { reopened.close(); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("lease loss while waiting for a submission permit never creates a marker or calls Azure", async () => {
  const f = fixture(); const clock = new FakeClock(); let submits = 0;
  const azure: AzureInvoiceProvider = {
    async prepareSubmission() { f.database.sqlite.exec("UPDATE jobs SET lease_token = NULL WHERE bill_id = '" + f.bill.id + "'"); return {}; },
    async submit() { submits++; return { operationLocation: "https://azure.example/op" }; },
    async poll() { throw new Error("unexpected"); },
  };
  try {
    expect(await extractionWorker(f.database, azure, f.dir, clock).runOnce()).toBe(true);
    expect(submits).toBe(0);
    expect(f.database.getExtractionInvocations(f.bill.id)).toHaveLength(0);
  } finally { f.close(); }
});

test("an abort interrupts a queued request before it reaches fetch", async () => {
  const clock = new FakeClock(); let starts = 0;
  const azure = provider(clock, async () => { starts++; return new Response(null, { status: 202, headers: { "operation-location": "https://azure.example/op" } }); }, 1);
  await azure.submit({ bytes: pdf, mimeType: "application/pdf" });
  await expect(azure.submit({ bytes: pdf, mimeType: "application/pdf" })).rejects.toMatchObject({ message: "Azure Document Intelligence request timeout" });
  expect(starts).toBe(1);
});

test("extreme retry headers and jitter stay within lexically sortable SQLite timestamps", async () => {
  const f = fixture();
  try {
    const now = new Date();
    const job = f.database.claimNextJob("boundary", policy, now)!;
    const maximumDelay = 253_402_300_799_999 - now.getTime();
    const failed = f.database.failJob(job.id, job.leaseToken, "HTTP 429", policy, now, true, maximumDelay, 1000)!;
    expect(failed.availableAt).toBe("9999-12-31T23:59:59.999Z");
    expect(f.database.claimNextJob("next", policy, now)).toBeNull();
  } finally { f.close(); }
});
