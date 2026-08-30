import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { canonicalOriginalsDir, loadConfig, type AppConfig } from "./config";
import { BillDatabase } from "./database";
import { handleRequest } from "./http";
import { createLogger } from "./logger";
import type { JobHandlers } from "./contracts";
import { BackgroundWorkerLoop, JobWorker } from "./worker";
import { BaileysTransport, type WhatsAppTransport } from "./baileys-transport";
import { WhatsAppIngestionService } from "./whatsapp-ingestion";
import { createExtractJobHandler, MistralHttpOcrProvider, type MistralOcrProvider } from "./extraction";
import { IMAGE_PREPROCESSING_VERSION, WorkerImagePreprocessor, type ImagePreprocessor } from "./image-preprocessing";
import { createExtractionValidationCallback } from "./validation";
import { createDriveArchiveHandler, createGoogleAdapters, createReviewCorrectionSyncHandler, createSheetsProjectionHandler, type DriveAdapter, type SheetsAdapter } from "./google-projections";
import { AzureDocumentIntelligenceInvoiceProvider, type AzureInvoiceProvider } from "./azure-invoice";

export interface RunningService { url: string; shutdown(): Promise<void>; }
export interface ServiceDependencies {
  createDatabase?: (path: string) => BillDatabase;
  serve?: typeof Bun.serve;
  whatsappTransport?: WhatsAppTransport;
  enableWhatsApp?: boolean;
  mistralProvider?: MistralOcrProvider;
  azureProvider?: AzureInvoiceProvider;
  imagePreprocessor?: ImagePreprocessor;
  onExtractionPersisted?: (billId: string) => Promise<void> | void;
  driveAdapter?: DriveAdapter;
  sheetsAdapter?: SheetsAdapter;
}

/** Starts HTTP and the non-blocking durable worker. Provider phases inject handlers here. */
export function startService(config: AppConfig = loadConfig(), jobHandlers: JobHandlers = {}, dependencies: ServiceDependencies = {}): RunningService {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.whatsapp.originalsDir, { recursive: true });
  config = { ...config, whatsapp: { ...config.whatsapp, originalsDir: canonicalOriginalsDir(config.whatsapp.originalsDir) } };
  const database = (dependencies.createDatabase ?? ((path: string) => new BillDatabase(path)))(config.databasePath);
  const logger = createLogger(config.logLevel);
  const validatePersistedExtraction = createExtractionValidationCallback(database, config.validation);
  const onExtracted = async (billId: string): Promise<void> => {
    validatePersistedExtraction(billId);
    await dependencies.onExtractionPersisted?.(billId);
  };
  const imagePreprocessor = dependencies.imagePreprocessor ?? new WorkerImagePreprocessor({ timeoutMs: config.imagePreprocessing.timeoutMs });
  const azureProvider = dependencies.azureProvider ?? (config.azure.enabled ? new AzureDocumentIntelligenceInvoiceProvider({ endpoint: config.azure.endpoint, apiKey: config.azure.apiKey, maxResponseBytes: config.azure.maxResponseBytes, timeoutMs: config.azure.requestTimeoutMs, pollIntervalMs: config.azure.pollIntervalMs }) : undefined);
  const extractHandler = jobHandlers.extract ?? createExtractJobHandler(database, dependencies.mistralProvider ?? new MistralHttpOcrProvider(config.mistral.apiKey, config.mistral.model, config.mistral.maxResponseBytes, config.mistral.requestTimeoutMs), config.jobs.maxAttempts, onExtracted, { root: config.whatsapp.originalsDir, maxBytes: config.whatsapp.maxAttachmentBytes }, imagePreprocessor, azureProvider, config.azure.fallbackConfidenceThreshold);
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
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = (dependencies.serve ?? Bun.serve)({ hostname: config.host, port: config.port, fetch: (request) => handleRequest(request, database, config) });
  } catch (error) {
    database.close();
    throw error;
  }
  logger.info("service started", { host: config.host, port: server.port });
  workerLoop.start();
  const whatsappEnabled = dependencies.enableWhatsApp ?? config.whatsapp.enabled;
  let acceptingIngestion = true;
  const inFlightIngestion = new Set<Promise<void>>();
  const receiveMessage = async (message: Parameters<WhatsAppTransport["start"]>[0] extends (message: infer Message) => Promise<void> ? Message : never): Promise<void> => {
    if (!acceptingIngestion) return;
    let task: Promise<void>;
    task = ingestion.ingest(message).then(() => undefined).finally(() => inFlightIngestion.delete(task));
    inFlightIngestion.add(task);
    await task;
  };
  const listenerStartup = whatsappEnabled ? (async () => {
    await ingestion.reconcilePending();
    if (acceptingIngestion) await transport.start(receiveMessage);
  })().catch(() => logger.error("WhatsApp listener failed to start", { code: "whatsapp_listener_start_failed" })) : Promise.resolve();

  let shuttingDown = false;
  return {
    url: server.url.toString(),
    async shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      acceptingIngestion = false;
      logger.info("service stopping");
      if (whatsappEnabled) await transport.stop();
      await listenerStartup;
      await Promise.all(inFlightIngestion);
      await workerLoop.stop();
      server.stop();
      database.close();
    },
  };
}

if (import.meta.main) {
  const service = startService();
  process.once("SIGTERM", () => { void service.shutdown(); });
  process.once("SIGINT", () => { void service.shutdown(); });
}
