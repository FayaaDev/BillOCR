import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase } from "../src/db/database";
import type { Logger } from "../src/backend/logger";
import { WhatsAppIngestionService, type IncomingAttachment, type IncomingWhatsAppMessage } from "../src/backend/whatsapp-ingestion";
import { IMAGE_PREPROCESSING_VERSION } from "../src/backend/image-preprocessing";

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
let directory: string;
let database: BillDatabase;
let service: WhatsAppIngestionService;

function attachment(kind: IncomingAttachment["kind"], mimeType: string, bytes: Uint8Array, filename?: string, caption?: string): IncomingAttachment {
  return { kind, mimeType, filename, caption, download: async () => bytes };
}
function message(attachments: IncomingAttachment[], overrides: Partial<IncomingWhatsAppMessage> = {}): IncomingWhatsAppMessage {
  return { id: "message-1", groupId: "bill-group", senderId: "sender-1", timestamp: "2026-08-27T01:02:03.000Z", caption: null, attachments, ...overrides };
}
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async () => { arrived += 1; if (arrived === parties) release!(); await gate; };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bill-whatsapp-"));
  database = new BillDatabase(join(directory, "ledger.sqlite"));
  service = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir: join(directory, "originals"), database, logger: silentLogger });
});
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

describe("WhatsApp ingestion", () => {
  test("persists exact image bytes, caption, metadata, and the two initial jobs", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const result = await service.ingest(message([attachment("image", "image/jpeg", bytes, "receipt.jpg")], { caption: "lunch" }));
    const bill = result.bills[0]!;
    expect(result.bills).toHaveLength(1);
    expect(bill).toMatchObject({ source: "whatsapp", sourceIdentity: '["bill-group","message-1",0]', sourceMessageId: "message-1", sourceChatId: "bill-group", sourceSenderId: "sender-1", attachmentIndex: 0, caption: "lunch", originalFilename: "receipt.jpg", mimeType: "image/jpeg", contentSha256: "3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56" });
    expect(readFileSync(bill.originalPath)).toEqual(Buffer.from(bytes));
    expect(database.countJobsForBill(bill.id)).toBe(2);
    expect(database.sqlite.query<{ idempotency_key: string }, [string]>("SELECT idempotency_key FROM jobs WHERE bill_id = ? AND type = 'extract'").get(bill.id)?.idempotency_key).toBe(`extract:${bill.id}:original`);
  });

  test("uses the configured extraction input version for new jobs and never changes it during replay", async () => {
    const enabled = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir: join(directory, "enabled-originals"), database, logger: silentLogger, extractionInputVersion: IMAGE_PREPROCESSING_VERSION });
    const incoming = message([attachment("image", "image/png", new Uint8Array([7]), "versioned.png")], { id: "versioned-message" });
    const created = (await enabled.ingest(incoming)).bills[0]!;
    const key = () => database.sqlite.query<{ idempotency_key: string }, [string]>("SELECT idempotency_key FROM jobs WHERE bill_id = ? AND type = 'extract'").get(created.id)?.idempotency_key;
    expect(key()).toBe(`extract:${created.id}:${IMAGE_PREPROCESSING_VERSION}`);
    const disabled = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir: join(directory, "enabled-originals"), database, logger: silentLogger, extractionInputVersion: "original" });
    expect((await disabled.ingest(incoming)).bills[0]?.id).toBe(created.id);
    await disabled.reconcilePending();
    expect(key()).toBe(`extract:${created.id}:${IMAGE_PREPROCESSING_VERSION}`);
  });

  test("accepts PDF documents and uses the document caption", async () => {
    const result = await service.ingest(message([attachment("document", "application/pdf", new Uint8Array([37, 80, 68, 70]), "bill.pdf", "PDF caption")]));
    expect(result.bills[0]).toMatchObject({ mimeType: "application/pdf", originalFilename: "bill.pdf", caption: "PDF caption" });
  });

  test("accepts JPEG, PNG, and WebP documents with canonical safe filenames and extensions", async () => {
    const result = await service.ingest(message([
      attachment("document", "image/jpeg", new Uint8Array([1]), "../handwritten-jpeg.pdf"),
      attachment("document", "IMAGE/PNG", new Uint8Array([2]), "handwritten-png.PDF"),
      attachment("document", "image/webp", new Uint8Array([3]), "handwritten-webp.jpg"),
    ]));
    expect(result.bills).toMatchObject([
      { attachmentIndex: 0, mimeType: "image/jpeg", originalFilename: "handwritten-jpeg.jpg", originalPath: expect.stringMatching(/\.jpg$/) },
      { attachmentIndex: 1, mimeType: "image/png", originalFilename: "handwritten-png.png", originalPath: expect.stringMatching(/\.png$/) },
      { attachmentIndex: 2, mimeType: "image/webp", originalFilename: "handwritten-webp.webp", originalPath: expect.stringMatching(/\.webp$/) },
    ]);
  });

  test("rejects unsupported image and document types", async () => {
    const result = await service.ingest(message([
      attachment("image", "image/gif", new Uint8Array([0]), "bill.gif"),
      attachment("document", "image/gif", new Uint8Array([1]), "bill.gif"),
      attachment("document", "image/*", new Uint8Array([2]), "bill.img"),
      attachment("document", "application/msword", new Uint8Array([3]), "bill.doc"),
      attachment("document", "__proto__", new Uint8Array([4]), "bill.proto"),
      attachment("document", "constructor", new Uint8Array([5]), "bill.constructor"),
    ]));
    expect(result.bills).toEqual([]);
  });

  test("stops consuming streamed attachments at the configured byte cap", async () => {
    const capped = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir: join(directory, "capped-originals"), maxAttachmentBytes: 3, database, logger: silentLogger });
    let chunksRead = 0;
    const streamed: IncomingAttachment = { kind: "image", mimeType: "image/png", download: async function* () { chunksRead += 1; yield new Uint8Array([1, 2]); chunksRead += 1; yield new Uint8Array([3, 4]); chunksRead += 1; yield new Uint8Array([5]); } };
    expect(await capped.ingest(message([streamed]))).toEqual({ bills: [] });
    expect(chunksRead).toBe(2);
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(0);
  });

  test("uses original attachment indexes when a message contains several attachments", async () => {
    const result = await service.ingest(message([
      attachment("document", "text/plain", new Uint8Array([1]), "ignore.txt"),
      attachment("image", "image/png", new Uint8Array([2]), "accepted.png"),
      attachment("document", "application/pdf", new Uint8Array([3]), "accepted-document.pdf"),
    ]));
    expect(result.bills.map((bill) => bill.attachmentIndex)).toEqual([1, 2]);
  });

  test("ignores other groups and text-only messages", async () => {
    expect((await service.ingest(message([attachment("image", "image/png", new Uint8Array([1]))], { groupId: "other-group" }))).bills).toEqual([]);
    expect((await service.ingest(message([]))).bills).toEqual([]);
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(0);
  });

  test("ignores every group when no ingestion group is configured", async () => {
    const unconfigured = new WhatsAppIngestionService({ groupId: null, originalsDir: join(directory, "unconfigured-originals"), database, logger: silentLogger });
    expect((await unconfigured.ingest(message([attachment("image", "image/png", new Uint8Array([1]))]))).bills).toEqual([]);
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(0);
  });

  test("returns the existing bill without another download or jobs on redelivery", async () => {
    let downloads = 0;
    const image = { ...attachment("image", "image/png", new Uint8Array([7]), "once.png"), download: async () => { downloads += 1; return new Uint8Array([7]); } };
    const first = await service.ingest(message([image]));
    const replay = await service.ingest(message([image]));
    expect(replay.bills[0]?.id).toBe(first.bills[0]?.id);
    expect(downloads).toBe(1);
    expect(database.countJobsForBill(first.bills[0]!.id)).toBe(2);
  });

  test("logs malformed messages and download failures without crashing or exception contents", async () => {
    const warnings: Array<{ message: string; fields: Record<string, unknown> | undefined }> = [];
    const loggingService = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir: join(directory, "originals"), database, logger: { ...silentLogger, warn: (message, fields) => warnings.push({ message, fields }) } });
    await expect(loggingService.ingest(message([attachment("image", "image/png", new Uint8Array([1]))], { id: null }))).resolves.toEqual({ bills: [] });
    await expect(loggingService.ingest(message([{ kind: "image", mimeType: "image/png", download: async () => { throw new Error("token=never-log-this"); } }]))).resolves.toEqual({ bills: [] });
    expect(warnings.map((warning) => warning.message)).toEqual(["ignored malformed WhatsApp message", "WhatsApp attachment ingestion failed"]);
    expect(JSON.stringify(warnings)).not.toContain("never-log-this");
  });

  test("reconciles a staged original after a process restart without WhatsApp redelivery", async () => {
    let interrupted = true;
    const originalsDir = join(directory, "originals");
    const recovering = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir, database, logger: silentLogger, beforeCommit: async () => { if (interrupted) { interrupted = false; throw new Error("process interrupted"); } } });
    const incoming = message([attachment("image", "image/png", new Uint8Array([9, 8, 7]), "recover.png")]);
    expect((await recovering.ingest(incoming)).bills).toEqual([]);
    expect(readdirSync(join(originalsDir, ".staging"))).toHaveLength(1);
    database.close();
    database = new BillDatabase(join(directory, "ledger.sqlite"));
    const restarted = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir, database, logger: silentLogger });
    const recovered = await restarted.reconcilePending();
    expect(recovered).toHaveLength(1);
    expect(readFileSync(recovered[0]!.originalPath)).toEqual(Buffer.from([9, 8, 7]));
    expect(readdirSync(join(originalsDir, ".staging"))).toEqual([]);
    expect(database.countJobsForBill(recovered[0]!.id)).toBe(2);
  });

  test("recovers when it crashes after non-replacing publication but before the bill transaction", async () => {
    let interrupted = true;
    const originalsDir = join(directory, "originals");
    const incoming = message([attachment("image", "image/png", new Uint8Array([9, 8, 7]), "recover.png")]);
    const publishing = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir, database, logger: silentLogger, afterOriginalPublished: async () => {
      if (interrupted) { interrupted = false; throw new Error("process interrupted"); }
    } });
    expect((await publishing.ingest(incoming)).bills).toEqual([]);
    expect(database.getBillBySourceIdentity("whatsapp", '["bill-group","message-1",0]')).toBeNull();
    const restarted = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir, database, logger: silentLogger });
    const recovered = await restarted.reconcilePending();
    expect(recovered).toHaveLength(1);
    expect(readFileSync(recovered[0]!.originalPath)).toEqual(Buffer.from([9, 8, 7]));
    expect(database.countJobsForBill(recovered[0]!.id)).toBe(2);
  });

  test("keeps the existing bill and original when staged redelivery has different content", async () => {
    const originalsDir = join(directory, "originals");
    const created = (await service.ingest(message([attachment("image", "image/png", new Uint8Array([1, 2, 3]), "first.png")]))).bills[0]!;
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const stagedBytes = new Uint8Array([4, 5, 6]);
    const sourceKey = createHash("sha256").update('["bill-group","message-1",0]').digest("hex").slice(0, 32);
    const unit = join(originalsDir, ".staging", `${sourceKey}-0`);
    mkdirSync(unit, { recursive: true });
    writeFileSync(join(unit, "original"), stagedBytes);
    writeFileSync(join(unit, "manifest.json"), JSON.stringify({ version: 1, id: "staged-conflict", source: "whatsapp", sourceIdentity: '["bill-group","message-1",0]', sourceMessageId: "message-1", sourceChatId: "bill-group", sourceSenderId: "sender-1", attachmentIndex: 0, receivedAt: "2026-08-27T01:02:03.000Z", caption: null, originalFilename: "changed.png", mimeType: "image/png", originalPath: created.originalPath, contentSha256: createHash("sha256").update(stagedBytes).digest("hex") }));
    const conflicting = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir, database, logger: { ...silentLogger, warn: (_message, fields) => warnings.push(fields) } });
    expect(await conflicting.reconcilePending()).toEqual([]);
    expect(database.getBillBySourceIdentity("whatsapp", '["bill-group","message-1",0]')).toMatchObject({ id: created.id, contentSha256: created.contentSha256 });
    expect(readFileSync(created.originalPath)).toEqual(Buffer.from([1, 2, 3]));
    expect(readdirSync(join(originalsDir, ".staging"))).toEqual([]);
    expect(warnings).toContainEqual(expect.objectContaining({ code: "whatsapp_attachment_content_conflict" }));
  });

  test("never creates a bill over a pre-existing canonical original with different bytes", async () => {
    const originalsDir = join(directory, "originals");
    const sourceKey = createHash("sha256").update('["bill-group","message-1",0]').digest("hex").slice(0, 32);
    const canonicalPath = join(originalsDir, `${sourceKey}-0.png`);
    mkdirSync(originalsDir, { recursive: true });
    writeFileSync(canonicalPath, new Uint8Array([71, 72, 73]));
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const guarded = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir, database, logger: { ...silentLogger, warn: (_message, fields) => warnings.push(fields) } });
    expect((await guarded.ingest(message([attachment("image", "image/png", new Uint8Array([81, 82, 83]))]))).bills).toEqual([]);
    expect(database.getBillBySourceIdentity("whatsapp", '["bill-group","message-1",0]')).toBeNull();
    expect(readFileSync(canonicalPath)).toEqual(Buffer.from([71, 72, 73]));
    expect(warnings).toContainEqual(expect.objectContaining({ code: "whatsapp_attachment_content_conflict" }));
  });

  test("two services racing the same bytes converge on one bill and its exact original", async () => {
    const originalsDir = join(directory, "racing-originals");
    const secondDatabase = new BillDatabase(join(directory, "ledger.sqlite"));
    const publishBarrier = barrier(2);
    const one = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir, database, logger: silentLogger, afterOriginalPublished: publishBarrier });
    const two = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir, database: secondDatabase, logger: silentLogger, afterOriginalPublished: publishBarrier });
    const bytes = new Uint8Array([11, 12, 13]);
    const [first, second] = await Promise.all([one.ingest(message([attachment("image", "image/png", bytes, "same.png")])), two.ingest(message([attachment("image", "image/png", bytes, "same.png")] ))]);
    const bill = first.bills[0] ?? second.bills[0];
    expect(bill).toBeDefined();
    expect(first.bills[0]?.id).toBe(second.bills[0]?.id);
    expect(readFileSync(bill!.originalPath)).toEqual(Buffer.from(bytes));
    expect(database.getBill(bill!.id)?.contentSha256).toBe(bill!.contentSha256);
    expect(database.countJobsForBill(bill!.id)).toBe(2);
    secondDatabase.close();
  });

  test("two services racing different bytes leave one consistent canonical bill without overwrite", async () => {
    const originalsDir = join(directory, "racing-originals");
    const secondDatabase = new BillDatabase(join(directory, "ledger.sqlite"));
    const stagingBarrier = barrier(2);
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const one = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir, database, logger: { ...silentLogger, warn: (_message, fields) => warnings.push(fields) }, beforeStagingPublish: stagingBarrier });
    const two = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir, database: secondDatabase, logger: { ...silentLogger, warn: (_message, fields) => warnings.push(fields) }, beforeStagingPublish: stagingBarrier });
    const firstBytes = new Uint8Array([21, 22, 23]);
    const secondBytes = new Uint8Array([31, 32, 33]);
    const [first, second] = await Promise.all([one.ingest(message([attachment("image", "image/png", firstBytes, "first.png")])), two.ingest(message([attachment("image", "image/png", secondBytes, "second.png")] ))]);
    const bill = first.bills[0] ?? second.bills[0];
    expect(bill).toBeDefined();
    const canonical = readFileSync(bill!.originalPath);
    expect([Buffer.from(firstBytes), Buffer.from(secondBytes)]).toContainEqual(canonical);
    expect(database.getBill(bill!.id)?.contentSha256).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(database.countJobsForBill(bill!.id)).toBe(2);
    expect(warnings).toContainEqual(expect.objectContaining({ code: "whatsapp_attachment_content_conflict" }));
    secondDatabase.close();
  });

  test("rejects staging manifests with traversal or absolute original paths", async () => {
    const originalsDir = join(directory, "originals");
    const interrupted = new WhatsAppIngestionService({ groupId: "bill-group", originalsDir, database, logger: silentLogger, beforeCommit: async () => { throw new Error("interrupt"); } });
    await interrupted.ingest(message([attachment("image", "image/png", new Uint8Array([4]), "safe.png")]));
    const unit = join(originalsDir, ".staging", readdirSync(join(originalsDir, ".staging"))[0]!);
    const manifestPath = join(unit, "manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    for (const unsafePath of ["../outside.png", join(directory, "outside.png")]) {
      const manifest = JSON.parse(original) as { originalPath: string };
      manifest.originalPath = unsafePath;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(await service.reconcilePending()).toEqual([]);
      expect(existsSync(join(directory, "outside.png"))).toBe(false);
    }
  });

  test("rejects a symlinked staging unit without following it", async () => {
    const originalsDir = join(directory, "originals");
    const staging = join(originalsDir, ".staging");
    const external = join(directory, "external-unit");
    mkdirSync(staging, { recursive: true });
    mkdirSync(external);
    // A directory symlink must not be traversed while recovering staged work.
    symlinkSync(external, join(staging, "escape"), "dir");
    expect(await service.reconcilePending()).toEqual([]);
    expect(existsSync(join(directory, "originals", "safe.png"))).toBe(false);
  });
});
