import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { canonicalOriginalsDir, loadConfig, type AppConfig } from "./config";
import { BillDatabase } from "./database";
import { handleRequest } from "./http";
import { createLogger } from "./logger";
import type { JobHandlers } from "./contracts";
import { BackgroundWorkerLoop, JobWorker } from "./worker";
import { BaileysTransport, type WhatsAppAdminOperations, type WhatsAppTransport } from "./baileys-transport";
import { WhatsAppIngestionService } from "./whatsapp-ingestion";
import { TelegramBotApiIngestionService, type TelegramPollingService } from "./telegram-ingestion";
import { createExtractJobHandler, MistralHttpOcrProvider, type MistralOcrProvider } from "./extraction";
import { IMAGE_PREPROCESSING_VERSION, WorkerImagePreprocessor, type ImagePreprocessor } from "./image-preprocessing";
import { createExtractionValidationCallback } from "./validation";
import { createDriveArchiveHandler, createGoogleAdapters, createReviewCorrectionSyncHandler, createSheetsProjectionHandler, type DriveAdapter, type SheetsAdapter } from "./google-projections";
import { AzureDocumentIntelligenceInvoiceProvider, type AzureInvoiceProvider } from "./azure-invoice";
import { AdminZipIngestionService } from "./admin-zip-ingestion";
import { createReviewAuth } from "./review-auth";

export interface RunningService { url: string; whatsappAdmin: WhatsAppAdminOperations; shutdown(): Promise<void>; }
export interface ServiceDependencies {
  createDatabase?: (path: string) => BillDatabase;
  serve?: typeof Bun.serve;
  whatsappTransport?: WhatsAppTransport;
  enableWhatsApp?: boolean;
  telegramTransport?: TelegramPollingService;
  enableTelegram?: boolean;
  mistralProvider?: MistralOcrProvider;
  azureProvider?: AzureInvoiceProvider;
  imagePreprocessor?: ImagePreprocessor;
  onExtractionPersisted?: (billId: string) => Promise<void> | void;
  driveAdapter?: DriveAdapter;
  sheetsAdapter?: SheetsAdapter;
}

function unavailableWhatsAppAdmin(): WhatsAppAdminOperations {
  return {
    status: () => ({ state: "unavailable", canPair: false }),
    pairingQr: async () => null,
    groups: async () => ({ available: false, groups: [] }),
    startPairing: async () => { throw new Error("WhatsApp pairing unavailable"); },
    cancelPairing: async () => { throw new Error("WhatsApp pairing unavailable"); },
  };
}

function isWhatsAppAdminOperations(transport: WhatsAppTransport): transport is WhatsAppTransport & WhatsAppAdminOperations {
  return "status" in transport && "pairingQr" in transport && "groups" in transport && "startPairing" in transport && "cancelPairing" in transport;
}

/** Starts HTTP and the non-blocking durable worker. Provider phases inject handlers here. */
export function startService(config: AppConfig = loadConfig(), jobHandlers: JobHandlers = {}, dependencies: ServiceDependencies = {}): RunningService {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.originals.dir, { recursive: true });
  const originalsDir = canonicalOriginalsDir(config.originals.dir);
  config = { ...config, originals: { ...config.originals, dir: originalsDir }, whatsapp: { ...config.whatsapp, originalsDir, maxAttachmentBytes: config.originals.maxAttachmentBytes } };
  const database = (dependencies.createDatabase ?? ((path: string) => new BillDatabase(path)))(config.databasePath);
  const logger = createLogger(config.logLevel);
  const auth = createReviewAuth(config);
  const validatePersistedExtraction = createExtractionValidationCallback(database, config.validation);
  const onExtracted = async (billId: string): Promise<void> => {
    validatePersistedExtraction(billId);
    await dependencies.onExtractionPersisted?.(billId);
  };
  const imagePreprocessor = dependencies.imagePreprocessor ?? new WorkerImagePreprocessor({ timeoutMs: config.imagePreprocessing.timeoutMs });
  const azureProvider = dependencies.azureProvider ?? (config.azure.enabled ? new AzureDocumentIntelligenceInvoiceProvider({ endpoint: config.azure.endpoint, apiKey: config.azure.apiKey, maxResponseBytes: config.azure.maxResponseBytes, timeoutMs: config.azure.requestTimeoutMs, pollIntervalMs: config.azure.pollIntervalMs }) : undefined);
  const mistralProvider = dependencies.mistralProvider ?? (config.mistral.apiKey && config.mistral.model ? new MistralHttpOcrProvider(config.mistral.apiKey, config.mistral.model, config.mistral.maxResponseBytes, config.mistral.requestTimeoutMs) : null);
  const extractHandler = jobHandlers.extract ?? createExtractJobHandler(database, mistralProvider, config.jobs.maxAttempts, onExtracted, { root: config.whatsapp.originalsDir, maxBytes: config.whatsapp.maxAttachmentBytes }, imagePreprocessor, azureProvider, config.azure.fallbackConfidenceThreshold);
  let googleHandlers: JobHandlers = {};
  if (config.google.enabled) {
    const adapters = dependencies.driveAdapter && dependencies.sheetsAdapter ? { drive: dependencies.driveAdapter, sheets: dependencies.sheetsAdapter } : createGoogleAdapters(readFileSync(config.google.credentialJson, "utf8"), { driveRootId: config.google.driveFolderId, sheetId: config.google.sheetId, sheetName: config.google.sheetName, requestTimeoutMs: config.google.requestTimeoutMs, maxResponseBytes: config.google.maxResponseBytes });
    googleHandlers = {
       archive_to_drive: createDriveArchiveHandler(database, adapters.drive, { driveRootId: config.google.driveFolderId, originalsRoot: config.whatsapp.originalsDir, maxOriginalBytes: config.whatsapp.maxAttachmentBytes }),
       project_to_sheet: createSheetsProjectionHandler(database, adapters.sheets),
       sync_review_correction: createReviewCorrectionSyncHandler(database, adapters.sheets),
    };
  }
  const worker = new JobWorker(database, { ...googleHandlers, ...jobHandlers, extract: extractHandler }, config.jobs, `service-${process.pid}`, logger);
  const workerLoop = new BackgroundWorkerLoop(worker, logger);
  const transport = dependencies.whatsappTransport ?? new BaileysTransport(config.whatsapp.authPath, logger);
  const ingestion = new WhatsAppIngestionService({ groupId: config.whatsapp.groupId, originalsDir: config.whatsapp.originalsDir, maxAttachmentBytes: config.whatsapp.maxAttachmentBytes, extractionInputVersion: config.imagePreprocessing.enabled ? IMAGE_PREPROCESSING_VERSION : "original", database, logger });
  const whatsappEnabled = dependencies.enableWhatsApp ?? config.whatsapp.enabled;
  const telegramEnabled = dependencies.enableTelegram ?? config.telegram.enabled;
  const telegram = dependencies.telegramTransport ?? (telegramEnabled ? new TelegramBotApiIngestionService({
    botToken: config.telegram.botToken!, groupIds: config.telegram.groupIds, pollTimeoutSeconds: config.telegram.pollTimeoutSeconds,
    requestTimeoutMs: config.telegram.requestTimeoutMs, maxResponseBytes: config.telegram.maxResponseBytes,
    originalsDir: config.originals.dir, maxAttachmentBytes: config.originals.maxAttachmentBytes, database, logger,
  }) : undefined);
  const whatsappAdmin = whatsappEnabled && isWhatsAppAdminOperations(transport) ? transport : unavailableWhatsAppAdmin();
  const admin = {
    metrics: () => database.getDashboardMetrics(),
    whatsapp: {
      status: () => {
        return whatsappAdmin.status();
      },
      pairingQr: () => whatsappAdmin.pairingQr(),
      groups: async () => (await whatsappAdmin.groups()).groups.map(({ id, subject }) => ({ id, name: subject || null })),
      startPairing: () => whatsappAdmin.startPairing(),
      cancelPairing: () => whatsappAdmin.cancelPairing(),
    },
    zip: (() => {
      const maxCompressedBytes = 50 * 1024 * 1024;
      const ingestion = new AdminZipIngestionService({ database, logger, originalsDir: config.whatsapp.originalsDir, stagingDir: `${config.dataDir}/admin-zip-staging`, limits: { maxCompressedBytes } });
      return { available: () => config.azure.enabled, maxCompressedBytes, ingest: (input: { sourceId: string; originalFilename: string; bytes: AsyncIterable<Uint8Array> }) => ingestion.ingest(input), status: (batchId: string) => database.getAdminUploadBatchStatus(batchId), reconcilePending: () => ingestion.reconcilePending() };
    })(),
  };
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = (dependencies.serve ?? Bun.serve)({ hostname: config.host, port: config.port, fetch: (request) => handleRequest(request, database, config, admin, auth) });
  } catch (error) {
    database.close();
    throw error;
  }
  logger.info("service started", { host: config.host, port: server.port });
  workerLoop.start();
  let acceptingIngestion = true;
  const inFlightIngestion = new Set<Promise<void>>();
  const receiveMessage = async (message: Parameters<WhatsAppTransport["start"]>[0] extends (message: infer Message) => Promise<void> ? Message : never): Promise<void> => {
    if (!acceptingIngestion) return;
    let task: Promise<void>;
    task = ingestion.ingest(message).then(() => undefined).finally(() => inFlightIngestion.delete(task));
    inFlightIngestion.add(task);
    await task;
  };
  const startListener = (source: "whatsapp" | "telegram", start: () => void | Promise<void>): Promise<void> =>
    Promise.resolve().then(start).catch(() => logger.error(`${source} listener failed to start`, { code: `${source}_listener_start_failed` }));
  const listenerStartup = (async () => {
    await admin.zip.reconcilePending();
    const reconciliations = await Promise.allSettled([
      whatsappEnabled ? ingestion.reconcilePending() : Promise.resolve(),
      telegramEnabled ? telegram!.reconcilePending() : Promise.resolve(),
    ]);
    for (const [index, result] of reconciliations.entries()) {
      if (result.status === "rejected") logger.error(index === 0 ? "whatsapp staging reconciliation failed" : "telegram staging reconciliation failed", { code: index === 0 ? "whatsapp_staging_reconciliation_failed" : "telegram_staging_reconciliation_failed" });
    }
    await Promise.all([
      whatsappEnabled && acceptingIngestion ? startListener("whatsapp", () => transport.start(receiveMessage)) : Promise.resolve(),
      telegramEnabled && acceptingIngestion ? startListener("telegram", () => telegram!.start()) : Promise.resolve(),
    ]);
  })().catch(() => logger.error("ingestion staging reconciliation failed", { code: "ingestion_staging_reconciliation_failed" }));

  let shutdownPromise: Promise<void> | null = null;
  return {
    url: server.url.toString(),
    whatsappAdmin,
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        acceptingIngestion = false;
        logger.info("service stopping");
        await Promise.allSettled([
          whatsappEnabled ? transport.stop() : Promise.resolve(),
          telegramEnabled ? telegram!.stop() : Promise.resolve(),
        ]);
        await listenerStartup;
        await Promise.all(inFlightIngestion);
        await workerLoop.stop();
        server.stop();
        database.close();
      })();
      return shutdownPromise;
    },
  };
}

if (import.meta.main) {
  const service = startService();
  process.once("SIGTERM", () => { void service.shutdown(); });
  process.once("SIGINT", () => { void service.shutdown(); });
}
