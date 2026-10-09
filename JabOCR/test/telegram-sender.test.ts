import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { BillDatabase } from "../src/db/database";
import { TelegramBotApiIngestionService } from "../src/backend/telegram-ingestion";
import { DurableAttachmentIngestionService } from "../src/backend/durable-attachment-ingestion";
import { transportSourceIdentity } from "../src/backend/contracts";
import { createLogger } from "../src/backend/logger";
import { loadConfig } from "../src/backend/config";
import { createReviewAuth } from "../src/backend/review-auth";
import { handleReviewRequest } from "../src/backend/review-ui";

const logger = createLogger("error", () => {});
const fixtures: { dir: string; database: BillDatabase }[] = [];
afterEach(async () => { for (const { dir, database } of fixtures.splice(0)) { database.close(); await rm(dir, { recursive: true, force: true }); } });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "jabocr-sender-"));
  const database = new BillDatabase(join(dir, "bills.sqlite"));
  fixtures.push({ dir, database });
  return { dir, database };
}
function message(id: number, metadata: Record<string, unknown> = {}) {
  return { message_id: id, date: 1_700_000_000, chat: { id: -100 }, from: { id: 42 }, document: { file_id: String(id), mime_type: "application/pdf" }, ...metadata };
}
function poller(dir: string, database: BillDatabase, updates: unknown[]) {
  return new TelegramBotApiIngestionService({ botToken: "offline", groupIds: ["-100"], pollTimeoutSeconds: 0, requestTimeoutMs: 1000, maxResponseBytes: 100_000, maxAttachmentBytes: 1000, originalsDir: dir, database, logger,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("getUpdates")) return Response.json({ ok: true, result: updates });
      if (url.endsWith("getFile")) return Response.json({ ok: true, result: { file_path: `documents/${JSON.parse(String(init?.body)).file_id}.pdf` } });
      if (url.includes("/file/")) return new Response(`%PDF-${url.split("/").at(-1)}`);
      throw new Error("unexpected offline request");
    },
  });
}

test("mocked Telegram intake persists bounded names and usernames, missing/malformed slots stay null", async () => {
  const { dir, database } = await fixture(); database.setTelegramPollingCursor(0);
  const senders = [
    { id: 42, first_name: " علي ", last_name: " أحمد ", username: "ali_ahmad" },
    { id: 42 },
    { id: 42, first_name: { fake: true }, last_name: 12, username: ["fake"] },
    { id: 42, first_name: "x".repeat(257), last_name: "\u0000bad", username: "@invalid" },
    { id: 42, first_name: "Only", username: "x".repeat(33) },
  ];
  await poller(dir, database, senders.map((from, index) => ({ update_id: index, message: message(index, { from }) }))).pollOnce();
  for (let index = 0; index < senders.length; index++) {
    const bill = database.getBillBySourceIdentity("telegram", transportSourceIdentity("-100", String(index), 0))!;
    expect(bill.sourceSenderId).toBe("42"); expect(bill.sourceSenderPhoneNumber).toBeNull();
    expect(bill.sourceSenderName).toBe(index === 0 ? "علي أحمد" : index === 4 ? "Only" : null);
    expect(bill.sourceSenderUsername).toBe(index === 0 ? "ali_ahmad" : null);
  }
  database.close();
  const reopened = new BillDatabase(join(dir, "bills.sqlite")); fixtures[fixtures.length - 1]!.database = reopened;
  expect(reopened.getBillBySourceIdentity("telegram", transportSourceIdentity("-100", "0", 0))!.sourceSenderName).toBe("علي أحمد");
});

test("anonymous and channel sender_chat identities never borrow compatibility user metadata", async () => {
  const { dir, database } = await fixture(); database.setTelegramPollingCursor(0);
  await poller(dir, database, [
    { update_id: 0, message: message(0, { from: { id: 1087968824, first_name: "Fake", username: "fake" }, sender_chat: { id: -200, title: "Channel", username: "channel" } }) },
    { update_id: 1, channel_post: message(1, { from: undefined, sender_chat: { id: -300 } }) },
    { update_id: 2, message: message(2, { from: { id: 42, first_name: "Fake" }, sender_chat: { id: -400, title: {}, username: 123 } }) },
  ]).pollOnce();
  for (let index = 0; index < 3; index++) {
    const bill = database.getBillBySourceIdentity("telegram", transportSourceIdentity("-100", String(index), 0))!;
    expect(bill.sourceSenderId).toBe(String(-200 - index * 100));
    expect(bill.sourceSenderName).toBe(index === 0 ? "Channel" : null);
    expect(bill.sourceSenderUsername).toBe(index === 0 ? "channel" : null);
    expect(bill.sourceSenderPhoneNumber).toBeNull();
  }
});

test("crash recovery retains metadata, accepts old manifests, rejects malformed optional fields", async () => {
  const { dir, database } = await fixture();
  const options = { source: "telegram" as const, allowedChatIds: ["-100"], originalsDir: dir, database, logger };
  const crashing = new DurableAttachmentIngestionService({ ...options, beforeCommit: async () => { throw new Error("crash"); } });
  for (let index = 0; index < 3; index++) await crashing.ingest({ id: String(index), chatId: "-100", senderId: "42", sourceSenderName: "Name", sourceSenderUsername: "name", sourceSenderPhoneNumber: "+123", timestamp: 1_700_000_000, attachments: [{ kind: "document", mimeType: "application/pdf", download: async () => new TextEncoder().encode(`%PDF-${index}`) }] });
  let malformedPath = "";
  for (const unit of await readdir(join(dir, ".staging"))) {
    const path = join(dir, ".staging", unit, "manifest.json"); const manifest = JSON.parse(await readFile(path, "utf8"));
    if (manifest.sourceMessageId === "1") { delete manifest.sourceSenderName; delete manifest.sourceSenderUsername; delete manifest.sourceSenderPhoneNumber; }
    if (manifest.sourceMessageId === "2") { manifest.sourceSenderName = { bad: true }; malformedPath = path; }
    await writeFile(path, JSON.stringify(manifest));
  }
  const recovery = new DurableAttachmentIngestionService(options);
  expect(await recovery.reconcilePending()).toHaveLength(2);
  const retained = database.getBillBySourceIdentity("telegram", transportSourceIdentity("-100", "0", 0))!;
  expect([retained.sourceSenderName, retained.sourceSenderUsername, retained.sourceSenderPhoneNumber]).toEqual(["Name", "name", "+123"]);
  const old = database.getBillBySourceIdentity("telegram", transportSourceIdentity("-100", "1", 0))!;
  expect([old.sourceSenderName, old.sourceSenderUsername, old.sourceSenderPhoneNumber]).toEqual([null, null, null]);
  expect(await readFile(malformedPath, "utf8")).toContain("bad");
  for (const invalid of ["x".repeat(257), 12, "\u0000bad"]) {
    const manifest = JSON.parse(await readFile(malformedPath, "utf8")); manifest.sourceSenderName = invalid;
    await writeFile(malformedPath, JSON.stringify(manifest)); expect(await recovery.reconcilePending()).toHaveLength(0);
  }
});

test("upgrade of pre-feature database preserves old IDs and sets nullable metadata", async () => {
  const { dir, database } = await fixture();
  const bill = database.createBillWithInitialJobs({ source: "telegram", sourceMessageId: "old", sourceChatId: "-100", sourceSenderId: "42", attachmentIndex: 0, receivedAt: new Date().toISOString(), mimeType: "application/pdf", originalPath: join(dir, "old.pdf"), contentSha256: "a".repeat(64) }, []).bill;
  const version = database.sqlite.query<{ version: number }, []>("SELECT MAX(version) - 1 AS version FROM schema_migrations").get()!.version;
  database.sqlite.exec("ALTER TABLE bills DROP COLUMN source_sender_name; ALTER TABLE bills DROP COLUMN source_sender_username; ALTER TABLE bills DROP COLUMN source_sender_phone_number;");
  database.sqlite.query("DELETE FROM schema_migrations WHERE version = ?").run(version);
  database.close(); const upgraded = new BillDatabase(join(dir, "bills.sqlite")); fixtures[fixtures.length - 1]!.database = upgraded;
  expect(upgraded.getBill(bill.id)!.sourceSenderId).toBe("42");
  expect(upgraded.getBill(bill.id)!.sourceSenderName).toBeNull();
  expect(upgraded.getBill(bill.id)!.sourceSenderUsername).toBeNull();
  expect(upgraded.getBill(bill.id)!.sourceSenderPhoneNumber).toBeNull();
});

test("detail formats and escapes Telegram slots; dedup and raw API sender IDs remain stable", async () => {
  const { dir, database } = await fixture(); database.setTelegramPollingCursor(0);
  const update = { update_id: 0, message: message(0, { from: { id: 42, first_name: '<img "&\' >', last_name: "Name", username: "sender" } }) };
  await poller(dir, database, [update]).pollOnce();
  const bill = database.getBillBySourceIdentity("telegram", transportSourceIdentity("-100", "0", 0))!;
  database.setTelegramPollingCursor(0); await poller(dir, database, [update]).pollOnce();
  await poller(dir, database, [{ update_id: 1, message: message(1, { from: { id: 99, first_name: "Replacement" }, document: { file_id: "0", mime_type: "application/pdf" } }) }]).pollOnce();
  expect(database.listReviewBills()).toHaveLength(1);
  expect(database.getBillBySourceIdentity("telegram", transportSourceIdentity("-100", "1", 0))).toBeNull();
  const duplicate = database.createBillWithInitialJobs({ ...bill, id: "duplicate", sourceMessageId: "other", sourceIdentity: "other", sourceSenderName: "Replacement" }, []);
  expect(duplicate.duplicateContent).toBe(true); expect(duplicate.bill.sourceSenderName).toBe(bill.sourceSenderName);
  const config = loadConfig({ ...parseEnv(readFileSync(join(import.meta.dir, "../.env.example"), "utf8")), APP_DATA_DIR: dir, WHATSAPP_AUTH_PATH: join(dir, "auth"), AZURE_ENABLED: "true", MISTRAL_ENABLED: "false", REVIEW_ORIGIN: "https://bills.example.com", ORIGINALS_DIR: dir });
  const auth = createReviewAuth(config); const request = new Request(`${config.review.origin}/login`);
  const session = auth.login(config.review.username, config.review.password, request)!;
  const headers = { cookie: auth.cookie(session, request).split(";")[0]! };
  const detail = async () => (await handleReviewRequest(new Request(`${config.review.origin}/review/bills/${bill.id}`, { headers }), database, config, undefined, auth)).text();
  expect(await detail()).toContain('<span>مرسل الفاتورة</span><input id="senderId" value="&lt;img &quot;&amp;&#39; &gt; Name | @sender | 42" readonly>');
  const api = await handleReviewRequest(new Request(`${config.review.origin}/review/api/bills`, { headers }), database, config, undefined, auth);
  expect((await api.json())[0].senderId).toBe("42");
  database.sqlite.query("UPDATE bills SET source_sender_name = NULL, source_sender_username = NULL, source_sender_phone_number = ? WHERE id = ?").run("+123", bill.id);
  expect(await detail()).toContain('value="42 | 42 | +123"');
  database.sqlite.query("UPDATE bills SET source_sender_phone_number = NULL WHERE id = ?").run(bill.id);
  expect(await detail()).toContain('value="42 | 42 | 42"');
  database.sqlite.query("UPDATE bills SET source = 'whatsapp' WHERE id = ?").run(bill.id);
  expect(await detail()).toContain('<span>رقم مرسل الفاتورة</span><input id="senderId" value="42"');
  database.sqlite.query("UPDATE bills SET source = 'admin_upload' WHERE id = ?").run(bill.id);
  expect(await detail()).toContain('<span>رقم مرسل الفاتورة</span><input id="senderId" value=""');
});
