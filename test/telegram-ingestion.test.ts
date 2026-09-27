import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BillDatabase } from "../src/database";
import type { Logger } from "../src/logger";
import { TelegramBotApiIngestionService, type TelegramFetch } from "../src/telegram-ingestion";

let directory: string;
let database: BillDatabase;
const pdf = new Uint8Array([37, 80, 68, 70, 45]);
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const json = (result: unknown, status = 200) => new Response(JSON.stringify({ ok: status < 300, result }), { status, headers: { "content-type": "application/json" } });
const update = (id: number, chat = "-100", extras: Record<string, unknown> = {}) => ({ update_id: id, message: { message_id: id + 100, date: 1_725_148_800, chat: { id: chat }, from: { id: 42 }, ...extras } });

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "bill-telegram-")); database = new BillDatabase(join(directory, "ledger.sqlite")); });
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

function service(responses: Response[], overrides: Partial<ConstructorParameters<typeof TelegramBotApiIngestionService>[0]> = {}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: TelegramFetch = async (url, init) => { requests.push({ url: String(url), init }); const response = responses.shift(); if (!response) throw new Error("unexpected request"); return response; };
  return { requests, service: new TelegramBotApiIngestionService({ botToken: "bot-secret", groupIds: ["-100", "-200"], pollTimeoutSeconds: 1, requestTimeoutMs: 2_000, maxResponseBytes: 1_024, originalsDir: join(directory, "originals"), maxAttachmentBytes: 10, database, logger, fetch: fetcher, retryDelayMs: 1, ...overrides }) };
}

test("discards the startup snapshot, then normalizes ordered photos, documents, and anonymous senders", async () => {
  const { service: poller, requests } = service([
    json([update(4)]),
    json([update(5, "-100", { caption: "receipt", from: undefined, sender_chat: { id: "-101" }, photo: [{ file_id: "small", file_size: 99 }, { file_id: "large" }], document: { file_id: "pdf", file_name: "bill.pdf", mime_type: "application/pdf" } })]),
    json({ file_path: "photos/large.jpg", file_size: 3 }), new Response(new Uint8Array([255, 216, 255])),
    json({ file_path: "docs/bill.pdf", file_size: 5 }), new Response(pdf),
  ]);
  await poller.pollOnce();
  expect(database.getTelegramPollingCursor()).toBe(5);
  expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ offset: -1, limit: 1, timeout: 0 });
  await poller.pollOnce();
  expect(database.getTelegramPollingCursor()).toBe(6);
  const bills = database.listReviewBills({ source: "telegram" });
  expect(bills).toHaveLength(2);
  expect(bills.map((bill) => ({ mimeType: bill.mimeType, caption: bill.caption, filename: bill.originalFilename, chat: bill.sourceChatId, sender: bill.sourceSenderId })).sort((a, b) => a.mimeType.localeCompare(b.mimeType))).toEqual([
    { mimeType: "application/pdf", caption: "receipt", filename: "bill.pdf", chat: "-100", sender: "-101" },
    { mimeType: "image/jpeg", caption: "receipt", filename: null, chat: "-100", sender: "-101" },
  ]);
  expect(requests.filter((request) => request.url.includes("getFile")).map((request) => request.init?.body)).toEqual([JSON.stringify({ file_id: "large" }), JSON.stringify({ file_id: "pdf" })]);
});

test("retains an update that arrives after the atomic startup boundary", async () => {
  const old = update(3, "-100", { document: { file_id: "old", file_name: "old.pdf", mime_type: "application/pdf" } });
  const later = update(4, "-100", { document: { file_id: "later", file_name: "later.pdf", mime_type: "application/pdf" } });
  const { service: poller, requests } = service([json([old]), json([later]), json({ file_path: "docs/later.pdf", file_size: 5 }), new Response(pdf)]);
  await poller.pollOnce();
  expect(database.getTelegramPollingCursor()).toBe(4);
  await poller.pollOnce();
  expect(database.getTelegramPollingCursor()).toBe(5);
  expect(database.listReviewBills({ source: "telegram" }).map((bill) => bill.originalFilename)).toEqual(["later.pdf"]);
  expect(requests.slice(0, 2).map((request) => JSON.parse(String(request.init?.body)))).toEqual([
    expect.objectContaining({ offset: -1, limit: 1, timeout: 0 }), expect.objectContaining({ offset: 4, timeout: 1 }),
  ]);
});

test("deduplicates Telegram photos with identical downloaded bytes before OCR", async () => {
  database.setTelegramPollingCursor(70);
  const first = update(70, "-100", { photo: [{ file_id: "first" }] });
  const second = update(71, "-100", { photo: [{ file_id: "second" }] });
  const { service: poller } = service([
    json([first, second]),
    json({ file_path: "photos/first.jpg" }), new Response(new Uint8Array([255, 216, 255])),
    json({ file_path: "photos/second.jpg" }), new Response(new Uint8Array([255, 216, 255])),
  ]);
  await poller.pollOnce();
  const bills = database.listReviewBills({ source: "telegram" });
  expect(bills).toHaveLength(1);
  for (const bill of bills) expect(database.countJobsForBill(bill.id)).toBe(2);
  expect(database.getTelegramPollingCursor()).toBe(72);
});

test("filters all disallowed chats while safely advancing its serial cursor", async () => {
  database.setTelegramPollingCursor(10);
  const { service: poller } = service([json([update(10, "-999"), { update_id: 11, callback_query: { id: "irrelevant" } }])]);
  await poller.pollOnce();
  expect(database.getTelegramPollingCursor()).toBe(12);
  expect(database.listReviewBills({ source: "telegram" })).toEqual([]);
});

test("ignores edited messages while safely advancing its serial cursor", async () => {
  database.setTelegramPollingCursor(12);
  const edited = update(12, "-100", { document: { file_id: "edited", file_name: "bill.pdf", mime_type: "application/pdf" } });
  const { service: poller, requests } = service([json([{ update_id: 12, edited_message: edited.message }])]);
  await poller.pollOnce();
  expect(database.getTelegramPollingCursor()).toBe(13);
  expect(database.listReviewBills({ source: "telegram" })).toEqual([]);
  expect(requests).toHaveLength(1);
});

test("safely ignores rejected document MIME types without downloading them", async () => {
  database.setTelegramPollingCursor(12);
  const { service: poller, requests } = service([json([update(12, "-100", { document: { file_id: "archive", file_name: "bill.zip", mime_type: "application/zip" } })])]);
  await poller.pollOnce();
  expect(database.getTelegramPollingCursor()).toBe(13);
  expect(requests).toHaveLength(1);
});

test("does not acknowledge a transient download failure and replays the update durably", async () => {
  database.setTelegramPollingCursor(20);
  const message = update(20, "-100", { document: { file_id: "file", file_name: "bill.pdf", mime_type: "application/pdf" } });
  const { service: poller } = service([json([message]), new Response("unavailable", { status: 503 }), json([message]), json({ file_path: "docs/bill.pdf" }), new Response(pdf)]);
  await expect(poller.pollOnce()).rejects.toThrow();
  expect(database.getTelegramPollingCursor()).toBe(20);
  await poller.pollOnce();
  expect(database.getTelegramPollingCursor()).toBe(21);
  expect(database.listReviewBills({ source: "telegram" })).toHaveLength(1);
});

test("bounds long-poll bodies without acknowledging and cancels the oversized response reader", async () => {
  database.setTelegramPollingCursor(30);
  let cancelled = false;
  const oversized = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(11)); }, cancel() { cancelled = true; } }));
  const first = service([oversized], { maxResponseBytes: 10 });
  await expect(first.service.pollOnce()).rejects.toThrow("size limit");
  expect(database.getTelegramPollingCursor()).toBe(30);
  expect(cancelled).toBe(true);
});

test("acknowledges permanent poison files, cancels their stream, and continues serially to later updates", async () => {
  database.setTelegramPollingCursor(30);
  const poison = update(30, "-100", { document: { file_id: "poison", file_name: "poison.pdf", mime_type: "application/pdf" } });
  const oversized = update(31, "-100", { document: { file_id: "oversized", file_name: "large.pdf", mime_type: "application/pdf" } });
  const rejected = update(32, "-100", { document: { file_id: "rejected", file_name: "gone.pdf", mime_type: "application/pdf" } });
  const good = update(33, "-100", { document: { file_id: "good", file_name: "good.pdf", mime_type: "application/pdf" } });
  let cancelled = false;
  const stream = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(pdf); controller.enqueue(new Uint8Array(6)); }, cancel() { cancelled = true; } }));
  const { service: poller } = service([json([poison, oversized, rejected, good]), json({ file_path: "docs/poison.pdf" }), stream, json({ file_path: "docs/large.pdf", file_size: 11 }), new Response("not found", { status: 404 }), json({ file_path: "docs/good.pdf", file_size: 5 }), new Response(pdf)]);
  await poller.pollOnce();
  expect(cancelled).toBe(true);
  expect(database.getTelegramPollingCursor()).toBe(34);
  expect(database.listReviewBills({ source: "telegram" }).map((bill) => bill.originalFilename)).toEqual(["good.pdf"]);
});

test("acknowledges a streaming oversize file when reader cancellation rejects", async () => {
  database.setTelegramPollingCursor(35);
  const oversized = update(35, "-100", { document: { file_id: "oversized", file_name: "large.pdf", mime_type: "application/pdf" } });
  const stream = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(11)); }, cancel() { return Promise.reject(new Error("cancel failed")); } }));
  const { service: poller } = service([json([oversized]), json({ file_path: "docs/large.pdf" }), stream], { maxAttachmentBytes: 10 });
  let unhandled: unknown; const onUnhandled = (reason: unknown) => { unhandled = reason; };
  process.once("unhandledRejection", onUnhandled);
  try { await poller.pollOnce(); await Bun.sleep(0); } finally { process.off("unhandledRejection", onUnhandled); }
  expect(database.getTelegramPollingCursor()).toBe(36); expect(unhandled).toBeUndefined();
});

test("stop aborts an in-flight poll and logs neither bot token nor API body", async () => {
  let signal: AbortSignal | undefined; const lines: string[] = [];
  const secretBody = "body-secret";
  const fetcher: TelegramFetch = async (_url, init) => new Promise<Response>((_resolve, reject) => { signal = init?.signal ?? undefined; signal?.addEventListener("abort", () => reject(new Error(`https://api.telegram.org/botbot-secret/getUpdates ${secretBody}`))); });
  const safeLogger: Logger = { debug() {}, info() {}, error() {}, warn(message, fields) { lines.push(`${message} ${JSON.stringify(fields)}`); } };
  const poller = new TelegramBotApiIngestionService({ botToken: "bot-secret", groupIds: [], pollTimeoutSeconds: 1, requestTimeoutMs: 2_000, maxResponseBytes: 1_024, originalsDir: join(directory, "originals"), maxAttachmentBytes: 10, database, logger: safeLogger, fetch: fetcher, retryDelayMs: 1 });
  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  poller.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(signal?.aborted).toBe(true);
  expect(lines.join(" ")).not.toContain("bot-secret");
  expect(lines.join(" ")).not.toContain(secretBody);
});

test("stop aborts an in-flight lazy file download without acknowledging its update", async () => {
  database.setTelegramPollingCursor(40);
  const message = update(40, "-100", { document: { file_id: "file", file_name: "bill.pdf", mime_type: "application/pdf" } });
  let fileSignal: AbortSignal | undefined;
  const fetcher: TelegramFetch = async (url, init) => {
    if (String(url).includes("getUpdates")) return json([message]);
    if (String(url).includes("getFile")) return json({ file_path: "docs/bill.pdf" });
    return new Promise<Response>((_resolve, reject) => { fileSignal = init?.signal ?? undefined; fileSignal?.addEventListener("abort", () => reject(new Error("aborted"))); });
  };
  const poller = new TelegramBotApiIngestionService({ botToken: "bot-secret", groupIds: ["-100"], pollTimeoutSeconds: 1, requestTimeoutMs: 2_000, maxResponseBytes: 1_024, originalsDir: join(directory, "originals"), maxAttachmentBytes: 10, database, logger, fetch: fetcher });
  const polling = poller.pollOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  poller.stop();
  await expect(polling).rejects.toThrow();
  expect(fileSignal?.aborted).toBe(true);
  expect(database.getTelegramPollingCursor()).toBe(40);
});

test("completed retry delays remove their abort listeners", async () => {
  const poller = service([]).service as unknown as { delay(): Promise<void> };
  const originalAdd = AbortSignal.prototype.addEventListener; const originalRemove = AbortSignal.prototype.removeEventListener;
  let adds = 0; let removes = 0;
  AbortSignal.prototype.addEventListener = function(this: AbortSignal, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) { if (type === "abort") adds += 1; return originalAdd.call(this, type, listener, options); };
  AbortSignal.prototype.removeEventListener = function(this: AbortSignal, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) { if (type === "abort") removes += 1; return originalRemove.call(this, type, listener, options); };
  try { await poller.delay(); await poller.delay(); await poller.delay(); } finally { AbortSignal.prototype.addEventListener = originalAdd; AbortSignal.prototype.removeEventListener = originalRemove; }
  expect(adds).toBe(3); expect(removes).toBe(3);
});

test("rejected response cancellation preserves the bounded-response failure", async () => {
  database.setTelegramPollingCursor(50);
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { return Promise.reject(new Error("cancel failed")); } }), { headers: { "content-length": "11" } });
  const { service: poller } = service([response], { maxResponseBytes: 10 });
  await expect(poller.pollOnce()).rejects.toThrow("size limit");
  expect(database.getTelegramPollingCursor()).toBe(50);
});

test("cancels non-OK Telegram response bodies without exposing their contents", async () => {
  database.setTelegramPollingCursor(60);
  const secret = "telegram-api-body-secret";
  let pollCancelled = false;
  const pollBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(secret)); }, cancel() { pollCancelled = true; return Promise.reject(new Error("cleanup failed")); } });
  const first = service([new Response(pollBody, { status: 500 })]);
  let failure = "";
  try { await first.service.pollOnce(); } catch (error) { failure = String(error); }
  expect(pollCancelled).toBe(true); expect(failure).toContain("HTTP 500"); expect(failure).not.toContain(secret); expect(failure).not.toContain("bot-secret");

  const updateWithFile = update(60, "-100", { document: { file_id: "file", file_name: "bill.pdf", mime_type: "application/pdf" } });
  let getFileCancelled = false;
  const getFileBody = new ReadableStream<Uint8Array>({ cancel() { getFileCancelled = true; } });
  const second = service([json([updateWithFile]), new Response(getFileBody, { status: 404 })]);
  await second.service.pollOnce();
  expect(getFileCancelled).toBe(true); expect(database.getTelegramPollingCursor()).toBe(61);

  const download = update(61, "-100", { document: { file_id: "download", file_name: "download.pdf", mime_type: "application/pdf" } });
  let downloadCancelled = false;
  const downloadBody = new ReadableStream<Uint8Array>({ cancel() { downloadCancelled = true; } });
  const third = service([json([download]), json({ file_path: "docs/download.pdf" }), new Response(downloadBody, { status: 404 })]);
  await third.service.pollOnce();
  expect(downloadCancelled).toBe(true); expect(database.getTelegramPollingCursor()).toBe(62);
});
