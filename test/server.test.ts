import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config";
import { startService, type RunningService } from "../src/server";
import type { WhatsAppTransport } from "../src/baileys-transport";
import type { IncomingWhatsAppMessage } from "../src/whatsapp-ingestion";
import type { MistralOcrProvider } from "../src/extraction";
import type { AzureInvoiceProvider } from "../src/azure-invoice";
import type { DriveAdapter, DriveFile, SheetsAdapter } from "../src/google-projections";
import { BillDatabase } from "../src/database";
import { IMAGE_PREPROCESSING_VERSION, type ImagePreprocessor } from "../src/image-preprocessing";

let directory: string;
let service: RunningService;

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "bill-server-")));
  const config: AppConfig = {
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

test("startService preserves an injected Azure provider instead of constructing the production provider", async () => {
  await service.shutdown();
  const azureProvider: AzureInvoiceProvider = { submit: async () => ({ operationLocation: "https://azure.example.test/operation" }), poll: async () => { throw new Error("not called"); } };
  const config: AppConfig = {
    host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "azure-injected.sqlite"), logLevel: "error",
    whatsapp: { enabled: false, groupId: "group", authPath: join(directory, "auth"), originalsDir: join(directory, "originals"), maxAttachmentBytes: 1024 }, mistral: { apiKey: "secret", model: "model", maxResponseBytes: 1024, requestTimeoutMs: 1000 },
    azure: { enabled: true, endpoint: "not-a-url", apiKey: "secret", maxResponseBytes: 1024, requestTimeoutMs: 1000, pollIntervalMs: 0, fallbackConfidenceThreshold: .80 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 },
    google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "reviewer", password: "secret" },
    validation: { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 }, jobs: { maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1_000, leaseMs: 60_000 },
  };
  service = startService(config, {}, { azureProvider });
  expect((await fetch(new URL("health", service.url))).status).toBe(200);
});

test("startup closes its database when HTTP construction fails", async () => {
  await service.shutdown();
  let closes = 0;
  const config: AppConfig = {
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

test("shutdown drains an in-flight WhatsApp ingestion before closing the database", async () => {
  await service.shutdown();
  let receive: ((message: IncomingWhatsAppMessage) => Promise<void>) | undefined;
  let releaseDownload: (() => void) | undefined;
  const transport: WhatsAppTransport = { start: async (handler) => { receive = handler; }, stop: async () => undefined };
  const config: AppConfig = {
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
    host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "disabled.sqlite"), logLevel: "error",
    whatsapp: { enabled: true, groupId: "group", authPath: join(directory, "auth"), originalsDir: join(directory, "originals"), maxAttachmentBytes: 1024 }, mistral: { apiKey: "secret", model: "model", maxResponseBytes: 1024, requestTimeoutMs: 1000 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1024, requestTimeoutMs: 1000, pollIntervalMs: 0, fallbackConfidenceThreshold: .80 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 },
    google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "reviewer", password: "secret" }, validation: { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, jobs: { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 2, leaseMs: 60_000 },
  };
  const annotation = { schemaVersion: "1" as const, vendorName: "Vendor", invoiceNumber: null, invoiceDate: "2026-08-28", currency: null, subtotal: null, vat: null, total: 1, description: null, fields: { vendorName: { confidence: 1, sourceText: "Vendor" }, invoiceDate: { confidence: 1, sourceText: "2026-08-28" }, total: { confidence: 1, sourceText: "1" } } };
  service = startService(config, {}, { createDatabase: () => database, whatsappTransport: { start: async (handler) => { receive = handler; }, stop: async () => undefined }, imagePreprocessor: { preprocess: async () => { preprocessCalls += 1; return { bytes: derivative, mimeType: "image/png", mode: "sharp", width: 1, height: 1 }; } }, mistralProvider: { extract: async (input) => { received.push(input.bytes); return { annotation, rawResponse: "raw", model: "mock" }; } } });
  for (let attempts = 0; !receive && attempts < 20; attempts += 1) await Bun.sleep(1);
  await receive!({ id: "new", groupId: "group", senderId: "sender", timestamp: "2026-08-28T00:00:00.000Z", attachments: [{ kind: "image", mimeType: "image/png", download: async () => original }] });
  for (let attempts = 0; received.length < 2 && attempts < 700; attempts += 1) await Bun.sleep(2);
  expect(preprocessCalls).toBe(1);
  expect(received).toContainEqual(derivative);
  expect(received).toContainEqual(original);
  const newBill = database.findBillsByIdentifier("new")[0]!;
  expect(database.getBill(tagged.id)?.status).toBe("needs_review");
  expect(database.sqlite.query<{ idempotency_key: string }, [string]>("SELECT idempotency_key FROM jobs WHERE bill_id = ? AND type = 'extract'").get(newBill.id)?.idempotency_key).toBe(`extract:${newBill.id}:original`);
});
