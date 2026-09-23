import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config";
import { startService, type RunningService } from "../src/server";
import type { WhatsAppAdminTransport, WhatsAppTransport } from "../src/baileys-transport";
import type { IncomingWhatsAppMessage } from "../src/whatsapp-ingestion";
import type { MistralOcrProvider } from "../src/extraction";
import type { AzureInvoiceProvider } from "../src/azure-invoice";
import type { DriveAdapter, DriveFile, SheetsAdapter } from "../src/google-projections";
import { BillDatabase } from "../src/database";
import { IMAGE_PREPROCESSING_VERSION, type ImagePreprocessor } from "../src/image-preprocessing";
import type { TelegramPollingService } from "../src/telegram-ingestion";
import { DurableAttachmentIngestionService } from "../src/durable-attachment-ingestion";

let directory: string;
let service: RunningService;
function transportConfig(originalsDir: string, maxAttachmentBytes = 1024) {
  return { originals: { dir: originalsDir, maxAttachmentBytes }, telegram: { enabled: false as const, botToken: null, groupIds: [], pollTimeoutSeconds: 30, requestTimeoutMs: 35_000, maxResponseBytes: 1 } };
}
function lifecycleConfig(name: string, options: { whatsapp?: boolean; telegram?: boolean; google?: boolean } = {}): AppConfig {
  const originalsDir = join(directory, `${name}-originals`);
  return {
    ...transportConfig(originalsDir), host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, `${name}.sqlite`), logLevel: "error",
    whatsapp: { enabled: options.whatsapp ?? false, groupId: "group", authPath: join(directory, "auth"), originalsDir, maxAttachmentBytes: 1024 },
    telegram: options.telegram ? { enabled: true, botToken: "token", groupIds: ["telegram-group"], pollTimeoutSeconds: 1, requestTimeoutMs: 2_000, maxResponseBytes: 1024 } : transportConfig(originalsDir).telegram,
    mistral: { apiKey: "secret", model: "model", maxResponseBytes: 1024, requestTimeoutMs: 1_000 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1024, requestTimeoutMs: 1_000, pollIntervalMs: 0, fallbackConfidenceThreshold: .8 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 },
    google: options.google ? { enabled: true, authMode: "user_oauth", credentialJson: join(directory, "unused.json"), driveFolderId: "root", sheetId: "sheet", sheetName: "Ledger", requestTimeoutMs: 1_000, maxResponseBytes: 1_024 } : { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 },
    review: { username: "reviewer", password: "secret" }, validation: { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, jobs: { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 2, leaseMs: 60_000 },
  };
}
async function waitFor(check: () => boolean, attempts = 100): Promise<void> { for (let attempt = 0; attempt < attempts && !check(); attempt += 1) await Bun.sleep(2); }
async function session(): Promise<{ cookie: string }> {
  const response = await fetch(new URL("login", service.url), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=reviewer&password=secret&return=%2Freview", redirect: "manual" });
  const cookie = response.headers.get("set-cookie"); if (!cookie) throw new Error("login failed"); return { cookie };
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "bill-server-")));
  const config: AppConfig = {
    ...transportConfig(join(directory, "originals")),
    host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "ledger.sqlite"), logLevel: "error",
    whatsapp: { enabled: false, groupId: "group", authPath: join(directory, "auth"), originalsDir: join(directory, "originals"), maxAttachmentBytes: 1024 }, mistral: { apiKey: "secret", model: "model", maxResponseBytes: 1024, requestTimeoutMs: 1000 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1024, requestTimeoutMs: 1000, pollIntervalMs: 0, fallbackConfidenceThreshold: .80 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 },
    google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "reviewer", password: "secret" },
    validation: { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 },
    jobs: { maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1_000, leaseMs: 60_000 },
  };
  service = startService(config);
});
afterEach(async () => { await service.shutdown(); rmSync(directory, { recursive: true, force: true }); });

test("health remains responsive while the empty injected worker lifecycle runs", async () => {
  const response = await fetch(new URL("health", service.url));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("a symlinked ORIGINALS_DIR keeps WhatsApp ingestion and review previews on the canonical root", async () => {
  await service.shutdown();
  const canonical = join(directory, "canonical-originals"); const alias = join(directory, "originals-link"); mkdirSync(canonical); symlinkSync(canonical, alias);
  let database: BillDatabase | undefined; let receive: ((message: IncomingWhatsAppMessage) => Promise<void>) | undefined;
  const config: AppConfig = {
    ...transportConfig(alias),
    host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "symlink.sqlite"), logLevel: "error",
    whatsapp: { enabled: true, groupId: "group", authPath: join(directory, "auth"), originalsDir: alias, maxAttachmentBytes: 1024 }, mistral: { apiKey: "secret", model: "model", maxResponseBytes: 1024, requestTimeoutMs: 1000 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1024, requestTimeoutMs: 1000, pollIntervalMs: 0, fallbackConfidenceThreshold: .80 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 },
    google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "reviewer", password: "secret" }, validation: { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, jobs: { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 2, leaseMs: 60_000 },
  };
  service = startService(config, {}, { createDatabase: (path) => (database = new BillDatabase(path)), whatsappTransport: { start: async (handler) => { receive = handler; }, stop: async () => undefined } });
  for (let attempt = 0; !receive && attempt < 20; attempt += 1) await Bun.sleep(1);
  if (!receive || !database) throw new Error("listener did not start");
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  await receive({ id: "symlink-message", groupId: "group", senderId: "sender", timestamp: "2026-09-01T00:00:00.000Z", attachments: [{ kind: "image", mimeType: "image/png", filename: "receipt.png", download: async () => bytes }] });
  const bill = database.findBillsByIdentifier("symlink-message")[0]; if (!bill) throw new Error("bill missing");
  expect(bill.originalPath.startsWith(`${canonical}/`)).toBe(true);
  const preview = await fetch(new URL(`review/bills/${bill.id}/original`, service.url), { headers: await session() });
  expect(preview.status).toBe(200); expect(new Uint8Array(await preview.arrayBuffer())).toEqual(bytes);
});

test("startService preserves an injected Azure provider instead of constructing the production provider", async () => {
  await service.shutdown();
  const azureProvider: AzureInvoiceProvider = { submit: async () => ({ operationLocation: "https://azure.example.test/operation" }), poll: async () => { throw new Error("not called"); } };
  const config: AppConfig = {
    ...transportConfig(join(directory, "originals")),
    host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "azure-injected.sqlite"), logLevel: "error",
    whatsapp: { enabled: false, groupId: "group", authPath: join(directory, "auth"), originalsDir: join(directory, "originals"), maxAttachmentBytes: 1024 }, mistral: { apiKey: "secret", model: "model", maxResponseBytes: 1024, requestTimeoutMs: 1000 },
    azure: { enabled: true, endpoint: "not-a-url", apiKey: "secret", maxResponseBytes: 1024, requestTimeoutMs: 1000, pollIntervalMs: 0, fallbackConfidenceThreshold: .80 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 },
    google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "reviewer", password: "secret" },
    validation: { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 }, jobs: { maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1_000, leaseMs: 60_000 },
  };
  service = startService(config, {}, { azureProvider });
  expect((await fetch(new URL("health", service.url))).status).toBe(200);
});

test("startService exposes authenticated safe ZIP failures and reconciles staged ZIP batches on startup", async () => {
  await service.shutdown();
  const sourceId = "restart-upload"; const staging = join(directory, "admin-zip-staging", createHash("sha256").update(sourceId).digest("hex").slice(0, 32));
  const emptyZip = new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  mkdirSync(staging, { recursive: true }); writeFileSync(join(staging, "upload.zip"), emptyZip);
  writeFileSync(join(staging, "manifest.json"), JSON.stringify({ version: 1, sourceId, originalFilename: "restart.zip", contentSha256: createHash("sha256").update(emptyZip).digest("hex"), zipPath: join(staging, "upload.zip") }));
  const config: AppConfig = {
    ...transportConfig(join(directory, "originals")),
    host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "zip.sqlite"), logLevel: "error",
    whatsapp: { enabled: false, groupId: "group", authPath: join(directory, "auth"), originalsDir: join(directory, "originals"), maxAttachmentBytes: 1024 }, mistral: { apiKey: "secret", model: "model", maxResponseBytes: 1024, requestTimeoutMs: 1000 }, azure: { enabled: true, endpoint: "https://azure.test", apiKey: "secret", maxResponseBytes: 1024, requestTimeoutMs: 1000, pollIntervalMs: 0, fallbackConfidenceThreshold: .8 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 }, google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "reviewer", password: "secret" }, validation: { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, jobs: { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 2, leaseMs: 60_000 },
  };
  service = startService(config, {}, { azureProvider: { submit: async () => ({ operationLocation: "unused" }), poll: async () => { throw new Error("unused"); } } });
  const auth = await session();
  const overview = await (await fetch(new URL("admin/api/overview", service.url), { headers: auth })).json() as { zip: { csrf: string } };
  const upload = await fetch(new URL("admin/api/zip", service.url), { method: "POST", headers: { ...auth, "content-type": "application/zip", "x-upload-id": "corrupt-upload", "x-upload-filename": "corrupt.zip", "x-csrf-token": overview.zip.csrf }, body: new Uint8Array([0x50, 0x4b, 5, 6]) });
  expect(upload.status).toBe(202); const response = await upload.json() as { batch: { id: string } }; expect(response.batch.id).toBeString();
  let failed: unknown;
  for (let attempts = 0; attempts < 40; attempts += 1) {
    failed = await (await fetch(new URL(`admin/api/zip/${response.batch.id}`, service.url), { headers: auth })).json();
    if ((failed as { batch?: { state?: string } }).batch?.state === "failed") break;
    await Bun.sleep(5);
  }
  expect(failed).toMatchObject({ batch: { id: response.batch.id, state: "failed" }, counts: { failed: 1 } });
  let restartBatchId: string | undefined;
  for (let attempts = 0; !restartBatchId && attempts < 20; attempts += 1) { const database = new BillDatabase(config.databasePath); restartBatchId = database.sqlite.query<{ id: string }, [string]>("SELECT id FROM admin_upload_batches WHERE idempotency_key = ?").get(`admin-zip:${sourceId}`)?.id; database.close(); if (!restartBatchId) await Bun.sleep(1); }
  expect(restartBatchId).toBeString();
  expect(await (await fetch(new URL(`admin/api/zip/${restartBatchId!}`, service.url), { headers: auth })).json()).toMatchObject({ batch: { id: restartBatchId, state: "completed" } });
});

test("startup closes its database when HTTP construction fails", async () => {
  await service.shutdown();
  let closes = 0;
  const config: AppConfig = {
    ...transportConfig(join(directory, "originals")),
    host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "failed.sqlite"), logLevel: "error",
    whatsapp: { enabled: false, groupId: "group", authPath: join(directory, "auth"), originalsDir: join(directory, "originals"), maxAttachmentBytes: 1024 }, mistral: { apiKey: "secret", model: "model", maxResponseBytes: 1024, requestTimeoutMs: 1000 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1024, requestTimeoutMs: 1000, pollIntervalMs: 0, fallbackConfidenceThreshold: .80 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 },
    google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "reviewer", password: "secret" },
    validation: { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 },
    jobs: { maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1_000, leaseMs: 60_000 },
  };
  expect(() => startService(config, {}, { createDatabase: () => ({ close: () => { closes += 1; } }) as never, serve: () => { throw new Error("port unavailable"); } })).toThrow("port unavailable");
  expect(closes).toBe(1);
});

test("service starts and stops an injected WhatsApp transport when enabled", async () => {
  await service.shutdown();
  let started = 0;
  let stopped = 0;
  const transport: WhatsAppTransport = { start: async () => { started += 1; }, stop: async () => { stopped += 1; } };
  const config: AppConfig = {
    ...transportConfig(join(directory, "originals")),
    host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "transport.sqlite"), logLevel: "error",
    whatsapp: { enabled: true, groupId: "group", authPath: join(directory, "auth"), originalsDir: join(directory, "originals"), maxAttachmentBytes: 1024 }, mistral: { apiKey: "secret", model: "model", maxResponseBytes: 1024, requestTimeoutMs: 1000 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1024, requestTimeoutMs: 1000, pollIntervalMs: 0, fallbackConfidenceThreshold: .80 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 },
    google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "reviewer", password: "secret" },
    validation: { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 },
    jobs: { maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1_000, leaseMs: 60_000 },
  };
  service = startService(config, {}, { whatsappTransport: transport });
  for (let attempts = 0; started === 0 && attempts < 20; attempts += 1) await Bun.sleep(1);
  expect(started).toBe(1);
  await service.shutdown();
  expect(stopped).toBe(1);
});

test("service exposes a typed unavailable WhatsApp admin capability when WhatsApp is disabled", async () => {
  expect(service.whatsappAdmin.status()).toEqual({ state: "unavailable", canPair: false });
  expect(await service.whatsappAdmin.pairingQr()).toBeNull();
  expect(await service.whatsappAdmin.groups()).toEqual({ available: false, groups: [] });
  await expect(service.whatsappAdmin.startPairing()).rejects.toThrow("unavailable");
  await expect(service.whatsappAdmin.cancelPairing()).rejects.toThrow("unavailable");
});

test("admin preserves connecting during a pairing restart so the client does not request a QR yet", async () => {
  await service.shutdown();
  let qrRequests = 0;
  const transport: WhatsAppAdminTransport = {
    start: async () => undefined, stop: async () => undefined,
    status: () => ({ state: "connecting", canPair: true }),
    pairingQr: async () => { qrRequests += 1; return null; },
    groups: async () => ({ available: false, groups: [] }),
    startPairing: async () => undefined, cancelPairing: async () => undefined,
  };
  const config: AppConfig = {
    ...transportConfig(join(directory, "originals")),
    host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "connecting.sqlite"), logLevel: "error",
    whatsapp: { enabled: true, groupId: "group", authPath: join(directory, "auth"), originalsDir: join(directory, "originals"), maxAttachmentBytes: 1024 }, mistral: { apiKey: "secret", model: "model", maxResponseBytes: 1024, requestTimeoutMs: 1000 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1024, requestTimeoutMs: 1000, pollIntervalMs: 0, fallbackConfidenceThreshold: .80 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 },
    google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "reviewer", password: "secret" }, validation: { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, jobs: { maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1_000, leaseMs: 60_000 },
  };
  service = startService(config, {}, { whatsappTransport: transport });
  const headers = await session();
  const overview = await (await fetch(new URL("admin/api/overview", service.url), { headers })).json();
  expect(overview.whatsapp).toMatchObject({ state: "connecting", canPair: true });
  expect(qrRequests).toBe(0);
  expect((await fetch(new URL("admin/api/whatsapp/qr", service.url), { headers })).status).toBe(404);
  expect(qrRequests).toBe(0);
});

test("shutdown drains an in-flight WhatsApp ingestion before closing the database", async () => {
  await service.shutdown();
  let receive: ((message: IncomingWhatsAppMessage) => Promise<void>) | undefined;
  let releaseDownload: (() => void) | undefined;
  const transport: WhatsAppTransport = { start: async (handler) => { receive = handler; }, stop: async () => undefined };
  const config: AppConfig = {
    ...transportConfig(join(directory, "originals")),
    host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "drain.sqlite"), logLevel: "error",
    whatsapp: { enabled: true, groupId: "group", authPath: join(directory, "auth"), originalsDir: join(directory, "originals"), maxAttachmentBytes: 1024 }, mistral: { apiKey: "secret", model: "model", maxResponseBytes: 1024, requestTimeoutMs: 1000 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1024, requestTimeoutMs: 1000, pollIntervalMs: 0, fallbackConfidenceThreshold: .80 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 },
    google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "reviewer", password: "secret" },
    validation: { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 }, jobs: { maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1_000, leaseMs: 60_000 },
  };
  service = startService(config, {}, { whatsappTransport: transport });
  for (let attempts = 0; !receive && attempts < 20; attempts += 1) await Bun.sleep(1);
  expect(receive).toBeFunction();
  const handling = receive!({ id: "draining-message", groupId: "group", senderId: "sender", timestamp: "2026-08-27T00:00:00.000Z", attachments: [{ kind: "image", mimeType: "image/png", download: () => new Promise<Uint8Array>((resolve) => { releaseDownload = () => resolve(new Uint8Array([1])); }) }] });
  await Bun.sleep(0);
  let stopped = false;
  const shutdown = service.shutdown().then(() => { stopped = true; });
  await Bun.sleep(0);
  expect(stopped).toBe(false);
  releaseDownload?.();
  await Promise.all([handling, shutdown]);
  expect(stopped).toBe(true);
});

test("concurrent shutdown callers await the same in-flight drain", async () => {
  await service.shutdown();
  let receive: ((message: IncomingWhatsAppMessage) => Promise<void>) | undefined; let release: (() => void) | undefined;
  service = startService(lifecycleConfig("concurrent-shutdown", { whatsapp: true }), {}, { whatsappTransport: { start: async (handler) => { receive = handler; }, stop: async () => undefined } });
  await waitFor(() => receive !== undefined);
  const handling = receive!({ id: "concurrent", groupId: "group", senderId: "sender", timestamp: "2026-08-27T00:00:00.000Z", attachments: [{ kind: "image", mimeType: "image/png", download: () => new Promise<Uint8Array>((resolve) => { release = () => resolve(new Uint8Array([1])); }) }] });
  await Bun.sleep(0);
  let firstDone = false; let secondDone = false;
  const first = service.shutdown().then(() => { firstDone = true; }); const second = service.shutdown().then(() => { secondDone = true; });
  await Bun.sleep(0); expect(firstDone).toBe(false); expect(secondDone).toBe(false);
  release?.(); await Promise.all([handling, first, second]); expect(firstDone).toBe(true); expect(secondDone).toBe(true);
});

test("Telegram and WhatsApp reconcile shared staging before independently starting and stopping", async () => {
  await service.shutdown();
  const order: string[] = [];
  const telegram: TelegramPollingService = { reconcilePending: async () => { order.push("telegram-reconcile"); return []; }, pollOnce: async () => undefined, start: async () => { order.push("telegram-start"); }, stop: async () => { order.push("telegram-stop"); } };
  const whatsapp: WhatsAppTransport = { start: async () => { order.push("whatsapp-start"); }, stop: async () => { order.push("whatsapp-stop"); } };
  service = startService(lifecycleConfig("both", { whatsapp: true, telegram: true }), {}, { whatsappTransport: whatsapp, telegramTransport: telegram });
  await waitFor(() => order.includes("whatsapp-start") && order.includes("telegram-start"));
  expect(order.indexOf("whatsapp-start")).toBeGreaterThan(order.indexOf("telegram-reconcile"));
  expect(order.indexOf("telegram-start")).toBeGreaterThan(order.indexOf("telegram-reconcile"));
  await service.shutdown();
  expect(order).toContain("whatsapp-stop"); expect(order).toContain("telegram-stop");
});

test("disabled transports are not started, and one listener startup failure does not block the other", async () => {
  await service.shutdown();
  let whatsappStarts = 0; let telegramStarts = 0;
  const telegram: TelegramPollingService = { reconcilePending: async () => [], pollOnce: async () => undefined, start: () => { telegramStarts += 1; }, stop: () => undefined };
  const whatsapp: WhatsAppTransport = { start: async () => { whatsappStarts += 1; throw new Error("unavailable"); }, stop: async () => undefined };
  service = startService(lifecycleConfig("isolation", { whatsapp: true, telegram: true }), {}, { whatsappTransport: whatsapp, telegramTransport: telegram });
  await waitFor(() => telegramStarts === 1);
  expect(whatsappStarts).toBe(1); expect(telegramStarts).toBe(1);
  await service.shutdown();
  whatsappStarts = 0; telegramStarts = 0;
  service = startService(lifecycleConfig("reverse-isolation", { whatsapp: true, telegram: true }), {}, { whatsappTransport: { start: async () => { whatsappStarts += 1; }, stop: async () => undefined }, telegramTransport: { ...telegram, start: () => { telegramStarts += 1; throw new Error("unavailable"); } } });
  await waitFor(() => whatsappStarts === 1);
  expect(whatsappStarts).toBe(1); expect(telegramStarts).toBe(1);
  await service.shutdown();
  whatsappStarts = 0; telegramStarts = 0;
  service = startService(lifecycleConfig("disabled"), {}, { whatsappTransport: whatsapp, telegramTransport: telegram });
  await Bun.sleep(10);
  expect(whatsappStarts).toBe(0); expect(telegramStarts).toBe(0);
});

test("shutdown waits for an in-flight Telegram path before closing the database", async () => {
  await service.shutdown();
  let release: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;
  const telegram: TelegramPollingService = {
    reconcilePending: async () => [], pollOnce: async () => undefined,
    start: () => { inFlight = new Promise<void>((resolve) => { release = resolve; }); },
    stop: async () => { await inFlight; },
  };
  service = startService(lifecycleConfig("telegram-drain", { telegram: true }), {}, { telegramTransport: telegram });
  await waitFor(() => inFlight !== undefined);
  let stopped = false; const shutdown = service.shutdown().then(() => { stopped = true; });
  await Bun.sleep(0); expect(stopped).toBe(false);
  release?.(); await shutdown; expect(stopped).toBe(true);
});

test("a Telegram attachment reaches extraction, validation, Drive, and Sheets exactly once", async () => {
  await service.shutdown();
  let database: BillDatabase | undefined; const bytes = readFileSync(join(import.meta.dir, "fixtures", "english.png"));
  const config = lifecycleConfig("telegram-e2e", { telegram: true, google: true });
  config.originals.maxAttachmentBytes = 3 * 1024 * 1024; config.whatsapp.maxAttachmentBytes = config.originals.maxAttachmentBytes;
  const files = new Map<string, DriveFile>(); let uploads = 0; let appends = 0;
  const drive: DriveAdapter = { findFolder: async () => ({ id: "folder" }), createFolder: async () => ({ id: "folder" }), findFilesByBillId: async (billId) => [...files.values()].filter((file) => file.appProperties.billId === billId), uploadOriginal: async (input) => { uploads += 1; const file = { id: "drive-file", webLink: "https://drive.test/drive-file", appProperties: { billId: input.billId, contentSha256: input.contentSha256 } }; files.set(file.id, file); return file; } };
  const rows = new Map<number, readonly (string | number | null)[]>();
  const sheets: SheetsAdapter = { initializeLedger: async () => undefined, findRowByBillId: async (billId) => [...rows].find(([, row]) => row[13] === billId)?.[0] ?? null, findLedgerRows: async (billId) => [...rows].flatMap(([row, values]) => values[13] === billId ? [{ row, revision: Number(values[14]) }] : []), appendRow: async (values) => { appends += 1; rows.set(2, values); return 2; }, updateRow: async (row, values) => { rows.set(row, values); }, clearRows: async (targets) => { targets.forEach((row) => rows.delete(row)); } };
  const telegram: TelegramPollingService = {
    reconcilePending: async () => [], pollOnce: async () => undefined, stop: () => undefined,
    start: async () => {
      const intake = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: ["telegram-group"], originalsDir: config.originals.dir, database: database!, logger: { debug() {}, info() {}, warn() {}, error() {} }, maxAttachmentBytes: config.originals.maxAttachmentBytes, logLabel: "Telegram" });
      const message = { id: "telegram-message", chatId: "telegram-group", senderId: "sender", timestamp: "2026-08-27T10:00:00.000Z", attachments: [{ kind: "image" as const, mimeType: "image/png", filename: "english.png", download: async () => bytes }] };
      await intake.ingest(message); await intake.ingest(message);
    },
  };
  const annotation = { schemaVersion: "1" as const, vendorName: "Telegram Store", invoiceNumber: "TG-1", invoiceDate: "2026-08-27", currency: "USD", subtotal: 10, vat: 1, total: 11, description: null, fields: { vendorName: { confidence: 1, sourceText: "Telegram Store" }, invoiceDate: { confidence: 1, sourceText: "2026-08-27" }, total: { confidence: 1, sourceText: "11" } } };
  let extracts = 0;
  service = startService(config, {}, { createDatabase: (path) => (database = new BillDatabase(path)), telegramTransport: telegram, driveAdapter: drive, sheetsAdapter: sheets, mistralProvider: { extract: async () => { extracts += 1; return { annotation, rawResponse: "raw", model: "telegram-mock" }; } } });
  await waitFor(() => { const bill = database?.findBillsByIdentifier("telegram-message")[0]; return bill?.status === "needs_review" && Boolean(bill.driveFileId); }, 500);
  const pending = database!.findBillsByIdentifier("telegram-message")[0]!;
  expect(database!.submitReview({ billId: pending.id, reviewerId: "test", action: "approve", reason: "verified", note: null, expectedContentRevision: pending.contentRevision, expectedReviewRevision: pending.reviewRevision, corrected: annotation }, [])).toBe(true);
  await waitFor(() => rows.size === 1, 500);
  const bill = database!.getBill(pending.id)!;
  expect(bill).toMatchObject({ source: "telegram", status: "approved", driveFileId: "drive-file" });
  expect(database!.getExtraction(bill.id)?.providerModel).toBe("telegram-mock"); expect(database!.getValidationIssues(bill.id)).toHaveLength(0);
  expect(database!.countJobsForBill(bill.id)).toBe(3); expect(extracts).toBe(1); expect(uploads).toBe(1); expect(appends).toBe(1); expect([...rows.values()].filter((row) => row[13] === bill.id)).toHaveLength(1);
});

test("startService wires production ingestion, extraction, validation, and Drive handlers for reviewable Mistral output", async () => {
  await service.shutdown();
  let receive: ((message: IncomingWhatsAppMessage) => Promise<void>) | undefined;
  let stopped = false; let database: BillDatabase | undefined; const fixture = readFileSync(join(import.meta.dir, "fixtures", "english.png"));
  const transport: WhatsAppTransport = { start: async (callback) => { receive = callback; }, stop: async () => { stopped = true; } };
  const files = new Map<string, DriveFile>(); const archived = new Map<string, Uint8Array>();
  const drive: DriveAdapter = {
    findFolder: async () => ({ id: "folder" }), createFolder: async () => ({ id: "folder" }), findFilesByBillId: async (billId) => [...files.values()].filter((file) => file.appProperties.billId === billId),
    uploadOriginal: async (input) => { const file = { id: "drive-file", webLink: "https://drive.test/drive-file", appProperties: { billId: input.billId, contentSha256: input.contentSha256 } }; files.set(file.id, file); archived.set(file.id, input.bytes); return file; },
  };
  const rows = new Map<number, readonly (string | number | null)[]>();
  const sheets: SheetsAdapter = {
    initializeLedger: async () => undefined, findRowByBillId: async (billId) => [...rows].find(([, row]) => row[13] === billId)?.[0] ?? null,
    findLedgerRows: async (billId) => [...rows].flatMap(([row, value]) => value[13] === billId ? [{ row, revision: Number(value[14]) }] : []),
    appendRow: async (values) => { rows.set(2, values); return 2; }, updateRow: async (row, values) => { rows.set(row, values); }, clearRows: async (targets) => { targets.forEach((row) => rows.delete(row)); },
  };
  const provider: MistralOcrProvider = { extract: async (input) => {
    expect(input.bytes).toEqual(fixture);
    const annotation = { schemaVersion: "1" as const, vendorName: "Wired Store", invoiceNumber: "WIRE-1", invoiceDate: "2026-08-27", currency: "USD", subtotal: 10, vat: 1, total: 11, description: "production wiring", fields: { vendorName: { confidence: .99, sourceText: "Wired Store" }, invoiceDate: { confidence: .99, sourceText: "2026-08-27" }, total: { confidence: .99, sourceText: "11" } } };
    return { annotation, rawResponse: JSON.stringify({ document_annotation: annotation }), model: "mistral-test" };
  } };
  const config: AppConfig = {
    ...transportConfig(join(directory, "originals"), 3 * 1024 * 1024),
    host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "wired.sqlite"), logLevel: "error",
    whatsapp: { enabled: true, groupId: "group", authPath: join(directory, "auth"), originalsDir: join(directory, "originals"), maxAttachmentBytes: 3 * 1024 * 1024 }, mistral: { apiKey: "test", model: "test", maxResponseBytes: 1024, requestTimeoutMs: 1_000 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1024, requestTimeoutMs: 1000, pollIntervalMs: 0, fallbackConfidenceThreshold: .80 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 },
    google: { enabled: true, authMode: "user_oauth", credentialJson: join(directory, "unused.json"), driveFolderId: "root", sheetId: "sheet", sheetName: "Ledger", requestTimeoutMs: 1_000, maxResponseBytes: 1_024 }, review: { username: "reviewer", password: "secret" },
    validation: { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, jobs: { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 2, leaseMs: 60_000 },
  };
  service = startService(config, {}, { whatsappTransport: transport, mistralProvider: provider, driveAdapter: drive, sheetsAdapter: sheets, createDatabase: (path) => (database = new BillDatabase(path)) });
  for (let attempts = 0; !receive && attempts < 50; attempts += 1) await Bun.sleep(2);
  expect(receive).toBeFunction(); expect((await fetch(new URL("health", service.url))).status).toBe(200);
  await receive!({ id: "wired-message", groupId: "group", senderId: "sender", timestamp: "2026-08-27T10:00:00.000Z", caption: "fixture", attachments: [{ kind: "image", mimeType: "image/png", filename: "english.png", download: async () => fixture }] });
  let billId: string | undefined;
  for (let attempts = 0; attempts < 200; attempts += 1) {
    const bills = database!.findBillsByIdentifier("wired-message"); billId = bills[0]?.id;
    if (billId && database!.getBill(billId)?.status === "needs_review" && database!.getBill(billId)?.driveFileId) break;
    await Bun.sleep(5);
  }
  const bill = database!.findBillsByIdentifier("wired-message")[0]!;
  expect(bill).toMatchObject({ status: "needs_review", driveFileId: "drive-file", sheetRowKey: null });
  expect(archived.get("drive-file")).toEqual(fixture); expect(database!.getExtraction(bill.id)).toMatchObject({ providerModel: "mistral-test", normalized: expect.objectContaining({ vendorName: "Wired Store" }) });
  expect([...rows.values()].filter((row) => row[13] === bill.id)).toHaveLength(0);
  await service.shutdown(); expect(stopped).toBe(true);
});

test("enabled ingestion tags image jobs and injects preprocessing into extraction", async () => {
  await service.shutdown();
  let receive: ((message: IncomingWhatsAppMessage) => Promise<void>) | undefined;
  const original = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const derivative = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const preprocessor: ImagePreprocessor = { preprocess: async () => ({ bytes: derivative, mimeType: "image/png", mode: "sharp", width: 1, height: 1 }) };
  const received: Uint8Array[] = []; let database: BillDatabase | undefined;
  const config: AppConfig = {
    ...transportConfig(join(directory, "originals")),
    host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "preprocess.sqlite"), logLevel: "error",
    whatsapp: { enabled: true, groupId: "group", authPath: join(directory, "auth"), originalsDir: join(directory, "originals"), maxAttachmentBytes: 1024 }, mistral: { apiKey: "secret", model: "model", maxResponseBytes: 1024, requestTimeoutMs: 1000 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1024, requestTimeoutMs: 1000, pollIntervalMs: 0, fallbackConfidenceThreshold: .80 }, imagePreprocessing: { enabled: true, timeoutMs: 8_000 },
    google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "reviewer", password: "secret" }, validation: { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, jobs: { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 2, leaseMs: 60_000 },
  };
  service = startService(config, {}, { createDatabase: (path) => (database = new BillDatabase(path)), whatsappTransport: { start: async (handler) => { receive = handler; }, stop: async () => undefined }, imagePreprocessor: preprocessor, mistralProvider: { extract: async (input) => { received.push(input.bytes); return { annotation: { schemaVersion: "1", vendorName: "Vendor", invoiceNumber: null, invoiceDate: "2026-08-28", currency: null, subtotal: null, vat: null, total: 1, description: null, fields: { vendorName: { confidence: 1, sourceText: "Vendor" }, invoiceDate: { confidence: 1, sourceText: "2026-08-28" }, total: { confidence: 1, sourceText: "1" } } }, rawResponse: "raw", model: "mock" }; } } });
  for (let attempts = 0; !receive && attempts < 20; attempts += 1) await Bun.sleep(1);
  await receive!({ id: "tagged", groupId: "group", senderId: "sender", timestamp: "2026-08-28T00:00:00.000Z", attachments: [{ kind: "image", mimeType: "image/png", download: async () => original }] });
  for (let attempts = 0; received.length === 0 && attempts < 600; attempts += 1) await Bun.sleep(2);
  const bill = database!.findBillsByIdentifier("tagged")[0]!;
  expect(received).toEqual([derivative]);
  expect(database!.sqlite.query<{ idempotency_key: string }, [string]>("SELECT idempotency_key FROM jobs WHERE bill_id = ? AND type = 'extract'").get(bill.id)?.idempotency_key).toBe(`extract:${bill.id}:${IMAGE_PREPROCESSING_VERSION}`);
});

test("disabled ingestion leaves new jobs original while existing tagged jobs still preprocess", async () => {
  await service.shutdown();
  const original = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const derivative = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 2]);
  const database = new BillDatabase(join(directory, "disabled.sqlite"));
  const taggedPath = join(directory, "originals", "existing.png");
  writeFileSync(taggedPath, original);
  const tagged = database.createBillWithInitialJobs({ whatsappMessageId: "existing", whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: "2026-08-28T00:00:00.000Z", mimeType: "image/png", originalPath: taggedPath, contentSha256: createHash("sha256").update(original).digest("hex") }, [{ type: "extract", idempotencyKey: `extract:existing:${IMAGE_PREPROCESSING_VERSION}` }]).bill;
  let receive: ((message: IncomingWhatsAppMessage) => Promise<void>) | undefined; const received: Uint8Array[] = []; let preprocessCalls = 0;
  const config: AppConfig = {
    ...transportConfig(join(directory, "originals")),
    host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "disabled.sqlite"), logLevel: "error",
    whatsapp: { enabled: true, groupId: "group", authPath: join(directory, "auth"), originalsDir: join(directory, "originals"), maxAttachmentBytes: 1024 }, mistral: { apiKey: "secret", model: "model", maxResponseBytes: 1024, requestTimeoutMs: 1000 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1024, requestTimeoutMs: 1000, pollIntervalMs: 0, fallbackConfidenceThreshold: .80 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 },
    google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "reviewer", password: "secret" }, validation: { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, jobs: { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 2, leaseMs: 60_000 },
  };
  const annotation = { schemaVersion: "1" as const, vendorName: "Vendor", invoiceNumber: null, invoiceDate: "2026-08-28", currency: null, subtotal: null, vat: null, total: 1, description: null, fields: { vendorName: { confidence: 1, sourceText: "Vendor" }, invoiceDate: { confidence: 1, sourceText: "2026-08-28" }, total: { confidence: 1, sourceText: "1" } } };
  service = startService(config, {}, { createDatabase: () => database, whatsappTransport: { start: async (handler) => { receive = handler; }, stop: async () => undefined }, imagePreprocessor: { preprocess: async () => { preprocessCalls += 1; return { bytes: derivative, mimeType: "image/png", mode: "sharp", width: 1, height: 1 }; } }, mistralProvider: { extract: async (input) => { received.push(input.bytes); return { annotation, rawResponse: "raw", model: "mock" }; } } });
  for (let attempts = 0; !receive && attempts < 20; attempts += 1) await Bun.sleep(1);
  const newOriginal = new Uint8Array([...original, 3]);
  await receive!({ id: "new", groupId: "group", senderId: "sender", timestamp: "2026-08-28T00:00:00.000Z", attachments: [{ kind: "image", mimeType: "image/png", download: async () => newOriginal }] });
  for (let attempts = 0; received.length < 2 && attempts < 700; attempts += 1) await Bun.sleep(2);
  expect(preprocessCalls).toBe(1);
  expect(received).toContainEqual(derivative);
  expect(received).toContainEqual(newOriginal);
  const newBill = database.findBillsByIdentifier("new")[0]!;
  expect(database.getBill(tagged.id)?.status).toBe("needs_review");
  expect(database.sqlite.query<{ idempotency_key: string }, [string]>("SELECT idempotency_key FROM jobs WHERE bill_id = ? AND type = 'extract'").get(newBill.id)?.idempotency_key).toBe(`extract:${newBill.id}:original`);
});
