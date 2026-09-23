import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableAttachmentIngestionService, type IncomingAttachment } from "../src/durable-attachment-ingestion";
import { transportSourceIdentity } from "../src/contracts";
import { BillDatabase } from "../src/database";
import type { Logger } from "../src/logger";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
let directory: string;
let database: BillDatabase;
const pdf = new Uint8Array([37, 80, 68, 70, 45]);
const attachment = (bytes = pdf): IncomingAttachment => ({ kind: "document", mimeType: "application/pdf", filename: "../receipt.png", caption: "document caption", download: async () => bytes });
function barrier(parties: number): () => Promise<void> { let arrived = 0; let release: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); return async () => { arrived += 1; if (arrived === parties) release!(); await gate; }; }

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "bill-durable-")); database = new BillDatabase(join(directory, "ledger.sqlite")); });
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

test("ingests allowed Telegram PDFs with immutable source-qualified paths and replays without redownloading", async () => {
  const originalsDir = join(directory, "originals"); let downloads = 0;
  const service = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["-100"], originalsDir, database, logger });
  const document = { ...attachment(), download: async () => { downloads += 1; return pdf; } };
  const message = { id: "7", chatId: "-100", senderId: "42", timestamp: "2026-09-01T00:00:00.000Z", attachments: [document] };
  expect((await service.ingest({ ...message, chatId: "other" })).bills).toEqual([]);
  const first = (await service.ingest(message)).bills[0]!;
  const replay = (await service.ingest(message)).bills[0]!;
  expect(first).toMatchObject({ source: "telegram", sourceIdentity: transportSourceIdentity("-100", "7", 0), caption: "document caption", originalFilename: "receipt.pdf", mimeType: "application/pdf" });
  expect(replay.id).toBe(first.id); expect(downloads).toBe(1); expect(database.countJobsForBill(first.id)).toBe(2);
  expect(readFileSync(first.originalPath)).toEqual(Buffer.from(pdf));
  expect(first.originalPath).toContain(createHash("sha256").update(`telegram:${first.sourceIdentity}`).digest("hex").slice(0, 32));
});

test("deduplicates identical bytes across channels regardless of filename, retaining different bytes", async () => {
  const originalsDir = join(directory, "originals");
  const telegram = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["tg"], originalsDir, database, logger });
  const whatsapp = new DurableAttachmentIngestionService({ source: "whatsapp", allowedChatIds: ["wa"], originalsDir, database, logger });
  const first = (await telegram.ingest({ id: "tg-1", chatId: "tg", senderId: "sender", timestamp: "2026-09-01T00:00:00.000Z", attachments: [{ ...attachment(pdf), filename: "nested/Receipt.pdf" }] })).bills[0]!;
  const duplicate = (await whatsapp.ingest({ id: "wa-1", chatId: "wa", senderId: "sender", timestamp: "2026-09-01T00:00:00.000Z", attachments: [{ ...attachment(pdf), filename: "C:\\incoming\\Other.PDF" }] })).bills[0]!;
  const sameNameDifferentBytes = (await whatsapp.ingest({ id: "wa-5", chatId: "wa", senderId: "sender", timestamp: "2026-09-01T00:00:00.000Z", attachments: [{ ...attachment(new Uint8Array([...pdf, 4])), filename: "Receipt.PDF" }] })).bills[0]!;
  const distinctCase = (await whatsapp.ingest({ id: "wa-2", chatId: "wa", senderId: "sender", timestamp: "2026-09-01T00:00:00.000Z", attachments: [{ ...attachment(new Uint8Array([...pdf, 2])), filename: "receipt.pdf" }] })).bills[0]!;
  const sameBytesDifferentName = (await whatsapp.ingest({ id: "wa-3", chatId: "wa", senderId: "sender", timestamp: "2026-09-01T00:00:00.000Z", attachments: [{ ...attachment(pdf), filename: "other.pdf" }] })).bills[0]!;
  const unnamed = (await whatsapp.ingest({ id: "wa-4", chatId: "wa", senderId: "sender", timestamp: "2026-09-01T00:00:00.000Z", attachments: [{ ...attachment(new Uint8Array([...pdf, 3])), filename: null }] })).bills[0]!;
  expect(duplicate.id).toBe(first.id);
  expect(sameNameDifferentBytes.id).not.toBe(first.id);
  expect(distinctCase.id).not.toBe(first.id);
  expect(sameBytesDifferentName.id).toBe(first.id);
  expect(unnamed.id).not.toBe(first.id);
  expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(4);
  expect(first).toMatchObject({ sourceFilename: "Receipt.pdf", filenameKey: "Receipt", originalFilename: "Receipt.pdf" });
  expect(database.countJobsForBill(first.id)).toBe(2);
});

test("excludes overlong source names from filename deduplication while retaining a safe display name", async () => {
  const originalsDir = join(directory, "originals");
  const service = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["tg"], originalsDir, database, logger });
  const filename = `${"x".repeat(513)}.pdf`;
  const first = (await service.ingest({ id: "long-1", chatId: "tg", senderId: "sender", timestamp: "2026-09-01T00:00:00.000Z", attachments: [{ ...attachment(pdf), filename }] })).bills[0]!;
  const second = (await service.ingest({ id: "long-2", chatId: "tg", senderId: "sender", timestamp: "2026-09-01T00:00:00.000Z", attachments: [{ ...attachment(new Uint8Array([...pdf, 1])), filename }] })).bills[0]!;
  expect(first.id).not.toBe(second.id);
  expect(first).toMatchObject({ sourceFilename: null, filenameKey: null, originalFilename: `${"x".repeat(512)}.pdf` });
});

test("recovers a post-publication pre-source WhatsApp manifest through its existing immutable original", async () => {
  const originalsDir = join(directory, "originals"); const unit = join(originalsDir, ".staging", "legacy"); mkdirSync(unit, { recursive: true }); writeFileSync(join(unit, "original"), pdf);
  const legacyOriginal = join(realpathSync(originalsDir), `${createHash("sha256").update("old-message").digest("hex").slice(0, 32)}-0.pdf`); writeFileSync(legacyOriginal, pdf);
  writeFileSync(join(unit, "manifest.json"), JSON.stringify({ version: 1, id: "legacy-id", whatsappMessageId: "old-message", whatsappGroupId: "old-chat", whatsappSenderId: "old-sender", attachmentIndex: 0, receivedAt: "2026-09-01T00:00:00.000Z", caption: "old caption", originalFilename: "old.pdf", mimeType: "application/pdf", originalPath: legacyOriginal, contentSha256: createHash("sha256").update(pdf).digest("hex") }));
  const service = new DurableAttachmentIngestionService({ source: "whatsapp", allowedChatIds: ["old-chat"], originalsDir, database, logger, logLabel: "WhatsApp" });
  const [bill] = await service.reconcilePending();
  expect(bill).toMatchObject({ source: "whatsapp", sourceIdentity: transportSourceIdentity("old-chat", "old-message", 0), caption: "old caption" });
  expect(bill!.originalPath).toBe(legacyOriginal); expect(readFileSync(legacyOriginal)).toEqual(Buffer.from(pdf)); expect(readdirSync(join(originalsDir, ".staging"))).toEqual([]);
});

test("Telegram races with conflicting bytes without replacing the canonical original", async () => {
  const originalsDir = join(directory, "originals"); const secondDatabase = new BillDatabase(join(directory, "ledger.sqlite")); const publish = barrier(2);
  const one = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["-100"], originalsDir, database, logger, beforeStagingPublish: publish });
  const two = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["-100"], originalsDir, database: secondDatabase, logger, beforeStagingPublish: publish });
  const metadata = { id: "9", chatId: "-100", senderId: "42", timestamp: "2026-09-01T00:00:00.000Z" };
  const firstBytes = new Uint8Array([...pdf, 1]); const secondBytes = new Uint8Array([...pdf, 2]);
  const [first, second] = await Promise.all([one.ingest({ ...metadata, attachments: [attachment(firstBytes)] }), two.ingest({ ...metadata, attachments: [attachment(secondBytes)] })]);
  const bill = first.bills[0] ?? second.bills[0];
  expect(bill).toBeDefined(); expect(database.countJobsForBill(bill!.id)).toBe(2);
  expect([Buffer.from(firstBytes), Buffer.from(secondBytes)]).toContainEqual(readFileSync(bill!.originalPath));
  expect(database.getBill(bill!.id)?.contentSha256).toBe(createHash("sha256").update(readFileSync(bill!.originalPath)).digest("hex"));
  secondDatabase.close();
});

test("simultaneous identical Telegram and WhatsApp attachments create one bill and no orphan", async () => {
  const originalsDir = join(directory, "originals"); const otherDatabase = new BillDatabase(join(directory, "ledger.sqlite")); const commit = barrier(2);
  try {
    const telegram = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["tg"], originalsDir, database, logger, beforeCommit: commit });
    const whatsapp = new DurableAttachmentIngestionService({ source: "whatsapp", allowedChatIds: ["wa"], originalsDir, database: otherDatabase, logger, beforeCommit: commit });
    const [first, second] = await Promise.all([
      telegram.ingest({ id: "tg-1", chatId: "tg", senderId: "sender", timestamp: "2026-09-01T00:00:00.000Z", attachments: [{ ...attachment(), filename: null }] }),
      whatsapp.ingest({ id: "wa-1", chatId: "wa", senderId: "sender", timestamp: "2026-09-01T00:00:00.000Z", attachments: [{ ...attachment(), filename: "other.pdf" }] }),
    ]);
    expect(first.bills[0]?.id).toBe(second.bills[0]?.id);
    expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(1);
    expect(database.countJobsForBill(first.bills[0]!.id)).toBe(2);
    expect(readdirSync(originalsDir).filter((entry) => entry.endsWith(".pdf"))).toHaveLength(1);
  } finally { otherDatabase.close(); }
});

test("Telegram rejects a staged traversal manifest without writing outside originals", async () => {
  const originalsDir = join(directory, "originals");
  const interrupted = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["-100"], originalsDir, database, logger, beforeCommit: async () => { throw new Error("interrupt"); } });
  await interrupted.ingest({ id: "8", chatId: "-100", senderId: "42", timestamp: "2026-09-01T00:00:00.000Z", attachments: [attachment()] });
  const unit = join(originalsDir, ".staging", readdirSync(join(originalsDir, ".staging"))[0]!); const manifestPath = join(unit, "manifest.json"); const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { originalPath: string }; manifest.originalPath = join(directory, "outside.pdf"); writeFileSync(manifestPath, JSON.stringify(manifest));
  const service = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["-100"], originalsDir, database, logger });
  expect(await service.reconcilePending()).toEqual([]); expect(existsSync(join(directory, "outside.pdf"))).toBe(false);
});

test("Telegram rejects a staged manifest whose source identity names another message", async () => {
  const originalsDir = join(directory, "originals");
  const interrupted = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["-100"], originalsDir, database, logger, beforeCommit: async () => { throw new Error("interrupt"); } });
  await interrupted.ingest({ id: "identity-1", chatId: "-100", senderId: "42", timestamp: "2026-09-01T00:00:00.000Z", attachments: [attachment()] });
  const unit = join(originalsDir, ".staging", readdirSync(join(originalsDir, ".staging"))[0]!); const manifestPath = join(unit, "manifest.json"); const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sourceIdentity: string }; manifest.sourceIdentity = transportSourceIdentity("-100", "identity-2", 0); writeFileSync(manifestPath, JSON.stringify(manifest));
  const service = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["-100"], originalsDir, database, logger });
  expect(await service.reconcilePending()).toEqual([]); expect(database.getBillBySourceIdentity("telegram", transportSourceIdentity("-100", "identity-2", 0))).toBeNull();
});

test("Telegram rejects a recovered manifest with a Windows path separator in its source filename", async () => {
  const originalsDir = join(directory, "originals");
  const interrupted = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["-100"], originalsDir, database, logger, beforeCommit: async () => { throw new Error("interrupt"); } });
  await interrupted.ingest({ id: "windows-name", chatId: "-100", senderId: "42", timestamp: "2026-09-01T00:00:00.000Z", attachments: [attachment()] });
  const unit = join(originalsDir, ".staging", readdirSync(join(originalsDir, ".staging"))[0]!); const manifestPath = join(unit, "manifest.json"); const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sourceFilename: string | null }; manifest.sourceFilename = "nested\\receipt.pdf"; writeFileSync(manifestPath, JSON.stringify(manifest));
  const service = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["-100"], originalsDir, database, logger });
  expect(await service.reconcilePending()).toEqual([]); expect(database.getBillBySourceIdentity("telegram", transportSourceIdentity("-100", "windows-name", 0))).toBeNull();
});

test("recovery removes a matching unreferenced original when another source won its content hash", async () => {
  const originalsDir = join(directory, "originals");
  const winner = new DurableAttachmentIngestionService({ source: "whatsapp", allowedChatIds: ["wa"], originalsDir, database, logger });
  const interrupted = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["tg"], originalsDir, database, logger, afterOriginalPublished: async () => {
    await winner.ingest({ id: "winner", chatId: "wa", senderId: "sender", timestamp: "2026-09-01T00:00:00.000Z", attachments: [{ ...attachment(pdf), filename: "other.PDF" }] });
    throw new Error("crash after publish");
  } });
  await interrupted.ingest({ id: "loser", chatId: "tg", senderId: "sender", timestamp: "2026-09-01T00:00:00.000Z", attachments: [{ ...attachment(pdf), filename: "shared.pdf" }] });
  const unit = join(originalsDir, ".staging", readdirSync(join(originalsDir, ".staging"))[0]!); const manifest = JSON.parse(readFileSync(join(unit, "manifest.json"), "utf8")) as { originalPath: string };
  expect(existsSync(manifest.originalPath)).toBe(true);
  const recovery = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["tg"], originalsDir, database, logger });
  expect((await recovery.reconcilePending()).map((bill) => bill.source)).toEqual(["whatsapp"]);
  expect(existsSync(manifest.originalPath)).toBe(false);
  expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(1);
});

test("mixed source staging reconciles only each source without false warnings", async () => {
  const originalsDir = join(directory, "mixed-originals"); const warnings: string[] = [];
  const testLogger: Logger = { debug() {}, info() {}, error() {}, warn(message) { warnings.push(message); } };
  const whatsapp = new DurableAttachmentIngestionService({ source: "whatsapp", allowedChatIds: ["wa"], originalsDir, database, logger: testLogger });
  const telegram = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["tg"], originalsDir, database, logger: testLogger });
  const interrupt = async () => { throw new Error("interrupt"); };
  const stagedWhatsapp = new DurableAttachmentIngestionService({ source: "whatsapp", allowedChatIds: ["wa"], originalsDir, database, logger: testLogger, beforeCommit: interrupt });
  const stagedTelegram = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["tg"], originalsDir, database, logger: testLogger, beforeCommit: interrupt });
  await stagedWhatsapp.ingest({ id: "wa-message", chatId: "wa", senderId: "sender", timestamp: "2026-08-27T00:00:00.000Z", attachments: [{ ...attachment(), filename: "whatsapp.pdf" }] });
  await stagedTelegram.ingest({ id: "tg-message", chatId: "tg", senderId: "sender", timestamp: "2026-08-27T00:00:00.000Z", attachments: [{ ...attachment(new Uint8Array([...pdf, 1])), filename: "telegram.pdf" }] });
  warnings.length = 0;
  expect((await whatsapp.reconcilePending()).map((bill) => bill.source)).toEqual(["whatsapp"]);
  expect((await telegram.reconcilePending()).map((bill) => bill.source)).toEqual(["telegram"]);
  expect(warnings).toEqual([]);
});

test("Telegram rejects an existing canonical symlink even when its target bytes match", async () => {
  const originalsDir = join(directory, "originals"); const sourceIdentity = transportSourceIdentity("-100", "symlink", 0); const originalPath = join(originalsDir, `${createHash("sha256").update(`telegram:${sourceIdentity}`).digest("hex").slice(0, 32)}-0.pdf`);
  const external = join(directory, "external.pdf"); writeFileSync(external, pdf); mkdirSync(originalsDir, { recursive: true }); symlinkSync(external, originalPath);
  const service = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["-100"], originalsDir, database, logger });
  expect((await service.ingest({ id: "symlink", chatId: "-100", senderId: "42", timestamp: "2026-09-01T00:00:00.000Z", attachments: [attachment()] })).bills).toEqual([]);
  expect(lstatSync(originalPath).isSymbolicLink()).toBe(true); expect(database.getBillBySourceIdentity("telegram", sourceIdentity)).toBeNull();
});
