import type { Bill } from "./contracts";
import type { Logger } from "./logger";
import { AttachmentContentConflictError, DurableAttachmentIngestionService, type IncomingAttachment, type IncomingSourceMessage, type IngestionResult } from "./durable-attachment-ingestion";
import type { BillDatabase } from "../db/database";
import { IMAGE_PREPROCESSING_VERSION } from "./image-preprocessing";

export type { AttachmentKind, IncomingAttachment, IngestionResult } from "./durable-attachment-ingestion";
export interface IncomingWhatsAppMessage { id: string | null | undefined; groupId: string | null | undefined; senderId: string | null | undefined; timestamp: Date | string | number | null | undefined; caption?: string | null; attachments?: IncomingAttachment[] | null; }
export interface WhatsAppIngestionOptions { groupId: string | null; originalsDir: string; database: BillDatabase; logger: Logger; extractionInputVersion?: "original" | typeof IMAGE_PREPROCESSING_VERSION; maxAttachmentBytes?: number; beforeCommit?: () => Promise<void>; beforeStagingPublish?: () => Promise<void>; afterOriginalPublished?: () => Promise<void>; }
/** @deprecated Use AttachmentContentConflictError from durable-attachment-ingestion. */
export class WhatsAppContentConflictError extends AttachmentContentConflictError {}

/** WhatsApp adapter retained for Baileys staging compatibility. */
export class WhatsAppIngestionService {
  private readonly durable: DurableAttachmentIngestionService;
  constructor(options: WhatsAppIngestionOptions) { this.durable = new DurableAttachmentIngestionService({ ...options, source: "whatsapp", allowedChatIds: options.groupId ? [options.groupId] : [], logLabel: "WhatsApp" }); }
  ingest(message: IncomingWhatsAppMessage): Promise<IngestionResult> { const normalized: IncomingSourceMessage = { ...message, chatId: message.groupId }; return this.durable.ingest(normalized); }
  reconcilePending(): Promise<Bill[]> { return this.durable.reconcilePending(); }
}
export { persistOriginal } from "./durable-attachment-ingestion";
