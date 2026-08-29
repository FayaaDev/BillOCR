import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Bill, CreateBillInput } from "./contracts";
import type { BillDatabase } from "./database";
import type { Logger } from "./logger";
import { canonicalOriginalsDir } from "./config";
import { canonicalAttachmentExtension, isSupportedDocumentMimeType, isSupportedImageMimeType } from "./attachment-mime";
import { IMAGE_PREPROCESSING_VERSION } from "./image-preprocessing";

export type AttachmentKind = "image" | "document";
export interface IncomingAttachment { kind: AttachmentKind; mimeType: string | null | undefined; filename?: string | null; caption?: string | null; download(): Promise<Uint8Array | AsyncIterable<Uint8Array>> | AsyncIterable<Uint8Array>; }
export interface IncomingWhatsAppMessage { id: string | null | undefined; groupId: string | null | undefined; senderId: string | null | undefined; timestamp: Date | string | number | null | undefined; caption?: string | null; attachments?: IncomingAttachment[] | null; }
export interface WhatsAppIngestionOptions { groupId: string; originalsDir: string; database: BillDatabase; logger: Logger; extractionInputVersion?: "original" | typeof IMAGE_PREPROCESSING_VERSION; maxAttachmentBytes?: number; beforeCommit?: () => Promise<void>; beforeStagingPublish?: () => Promise<void>; afterOriginalPublished?: () => Promise<void>; }
export interface IngestionResult { bills: Bill[]; }

type StagedAttachment = CreateBillInput & { version: 1; };
const stagingName = ".staging";

/** The configured source identity already has different canonical content. */
export class WhatsAppContentConflictError extends Error {}
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function alreadyExists(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY"; }

function accepted(attachment: IncomingAttachment): boolean {
  return attachment.kind === "image" ? isSupportedImageMimeType(attachment.mimeType) : isSupportedDocumentMimeType(attachment.mimeType);
}
function receivedAt(timestamp: IncomingWhatsAppMessage["timestamp"]): string | null {
  const date = timestamp instanceof Date ? timestamp : new Date(typeof timestamp === "number" ? timestamp * 1000 : timestamp ?? "");
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function safeFilename(filename: string | null | undefined, mimeType: string): string | null {
  if (!filename) return null;
  const name = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  const base = name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name;
  return `${base || "attachment"}${canonicalAttachmentExtension(mimeType)!}`;
}

/** Converts normalized WhatsApp events into canonical records through a crash-recoverable staging manifest. */
export class WhatsAppIngestionService {
  private readonly options: WhatsAppIngestionOptions;
  constructor(options: WhatsAppIngestionOptions) {
    mkdirSync(options.originalsDir, { recursive: true });
    this.options = { ...options, extractionInputVersion: options.extractionInputVersion ?? "original", originalsDir: canonicalOriginalsDir(options.originalsDir) };
  }

  async ingest(message: IncomingWhatsAppMessage): Promise<IngestionResult> {
    if (message.groupId !== this.options.groupId) return { bills: [] };
    const attachments = message.attachments ?? [];
    if (!attachments.some(accepted)) return { bills: [] };
    const timestamp = receivedAt(message.timestamp);
    if (!message.id || !message.senderId || !timestamp) {
      this.options.logger.warn("ignored malformed WhatsApp message", { code: "whatsapp_malformed_message", hasId: Boolean(message.id), hasSender: Boolean(message.senderId) });
      return { bills: [] };
    }
    const bills: Bill[] = [];
    for (const [attachmentIndex, attachment] of attachments.entries()) {
      if (!accepted(attachment)) continue;
      const existing = this.options.database.getBillByWhatsAppAttachment(message.id, attachmentIndex);
      if (existing) { bills.push(existing); continue; }
      try {
        const bytes = await readLimitedAttachment(attachment, this.options.maxAttachmentBytes ?? 20 * 1024 * 1024);
        const manifest = this.createManifest(message, attachment, attachmentIndex, timestamp, bytes);
        await this.stage(manifest, bytes);
        await this.options.beforeCommit?.();
        const bill = await this.reconcileOne(this.unitDirectory(manifest));
        if (bill) bills.push(bill);
      } catch (error) {
        this.options.logger.warn(error instanceof WhatsAppContentConflictError ? "WhatsApp attachment content conflict" : "WhatsApp attachment ingestion failed", { code: error instanceof WhatsAppContentConflictError ? "whatsapp_attachment_content_conflict" : "whatsapp_attachment_ingestion_failed", messageId: message.id, attachmentIndex });
      }
    }
    return { bills };
  }

  /** Replays committed staging units after a process crash without needing a WhatsApp redelivery. */
  async reconcilePending(): Promise<Bill[]> {
    const directory = this.stagingDirectory();
    let entries: string[];
    try { entries = await readdir(directory); } catch { return []; }
    const bills: Bill[] = [];
    for (const entry of entries) {
      if (entry.endsWith(".tmp")) continue;
      try {
        const unit = join(directory, entry);
        const info = await lstat(unit);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe staging unit");
        const bill = await this.reconcileOne(unit);
        if (bill) bills.push(bill);
      } catch (error) {
        this.options.logger.warn(error instanceof WhatsAppContentConflictError ? "WhatsApp staging content conflict" : "WhatsApp staging reconciliation failed", { code: error instanceof WhatsAppContentConflictError ? "whatsapp_attachment_content_conflict" : "whatsapp_staging_reconciliation_failed" });
      }
    }
    return bills;
  }

  private createManifest(message: IncomingWhatsAppMessage, attachment: IncomingAttachment, attachmentIndex: number, timestamp: string, bytes: Uint8Array): StagedAttachment {
    const mimeType = attachment.mimeType!.toLowerCase();
    const filename = safeFilename(attachment.filename, mimeType);
    return {
      version: 1, id: randomUUID(), whatsappMessageId: message.id!, whatsappGroupId: message.groupId!, whatsappSenderId: message.senderId!, attachmentIndex,
      receivedAt: timestamp, caption: attachment.caption ?? message.caption ?? null, originalFilename: filename, mimeType,
      originalPath: this.canonicalOriginalPath(message.id!, attachmentIndex, mimeType), contentSha256: sha256(bytes),
    };
  }

  private stagingDirectory(): string { return join(this.options.originalsDir, stagingName); }
  private originalsRoot(): string { return resolve(this.options.originalsDir); }
  private canonicalOriginalPath(messageId: string, attachmentIndex: number, mimeType: string): string {
    const extension = canonicalAttachmentExtension(mimeType);
    if (!extension) throw new Error("unsupported WhatsApp attachment MIME type");
    const sourceKey = createHash("sha256").update(messageId).digest("hex").slice(0, 32);
    return join(this.originalsRoot(), `${sourceKey}-${attachmentIndex}${extension}`);
  }
  private unitDirectory(manifest: StagedAttachment): string {
    const sourceKey = createHash("sha256").update(manifest.whatsappMessageId).digest("hex").slice(0, 32);
    return join(this.stagingDirectory(), `${sourceKey}-${manifest.attachmentIndex}`);
  }

  private async stage(manifest: StagedAttachment, bytes: Uint8Array): Promise<void> {
    const unit = this.unitDirectory(manifest);
    try {
      const existing = await readFile(join(unit, "original"));
      if (sha256(existing) !== manifest.contentSha256) throw new WhatsAppContentConflictError("staged attachment content differs");
      return;
    } catch (error) {
      if (error instanceof WhatsAppContentConflictError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(this.stagingDirectory(), { recursive: true });
    const temporary = `${unit}.${randomUUID()}.tmp`;
    try {
      await mkdir(temporary);
      await writeFile(join(temporary, "original"), bytes);
      await writeFile(join(temporary, "manifest.json"), JSON.stringify(manifest));
      await this.options.beforeStagingPublish?.();
      try { await rename(temporary, unit); } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        if (!alreadyExists(error)) throw error;
        const existing = await readFile(join(unit, "original"));
        if (sha256(existing) !== manifest.contentSha256) throw new WhatsAppContentConflictError("staged attachment content differs");
      }
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async reconcileOne(unit: string): Promise<Bill | null> {
    const manifestInfo = await lstat(join(unit, "manifest.json"));
    const originalInfo = await lstat(join(unit, "original"));
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || !originalInfo.isFile() || originalInfo.isSymbolicLink()) throw new Error("unsafe staging file");
    const manifest = JSON.parse(await readFile(join(unit, "manifest.json"), "utf8")) as StagedAttachment;
    if (!this.validManifest(manifest)) throw new Error("invalid staging manifest");
    const bytes = await readFile(join(unit, "original"));
    if (sha256(bytes) !== manifest.contentSha256) throw new Error("staged content hash mismatch");
    const existing = this.options.database.getBillByWhatsAppAttachment(manifest.whatsappMessageId, manifest.attachmentIndex);
    if (existing) {
      if (manifest.contentSha256 !== existing.contentSha256) {
        await rm(unit, { recursive: true, force: true });
        throw new WhatsAppContentConflictError("existing bill content differs");
      }
      await rm(unit, { recursive: true, force: true });
      return existing;
    }
    const originalPath = this.canonicalOriginalPath(manifest.whatsappMessageId, manifest.attachmentIndex, manifest.mimeType);
    try {
      await persistOriginal(originalPath, bytes);
    } catch (error) {
      // A conflict has no recoverable work: canonical bytes win and this staged candidate is removed.
      if (error instanceof WhatsAppContentConflictError) await rm(unit, { recursive: true, force: true });
      throw error;
    }
    await this.options.afterOriginalPublished?.();
    let result;
    try {
      result = this.options.database.createBillWithInitialJobs({ ...manifest, originalPath }, [
        { type: "extract", idempotencyKey: `extract:${manifest.id}:${this.options.extractionInputVersion}` },
        { type: "archive_to_drive", idempotencyKey: `archive_to_drive:${manifest.id}` },
      ]);
    } catch (error) {
      const raced = this.options.database.getBillByWhatsAppAttachment(manifest.whatsappMessageId, manifest.attachmentIndex);
      if (!raced) throw error;
      if (raced.contentSha256 !== manifest.contentSha256) {
        await rm(unit, { recursive: true, force: true });
        throw new WhatsAppContentConflictError("racing bill content differs");
      }
      result = { bill: raced, created: false };
    }
    await rm(unit, { recursive: true, force: true });
    return result.bill;
  }

  private validManifest(value: StagedAttachment): boolean {
    if (!(value.version === 1 && typeof value.id === "string" && typeof value.whatsappMessageId === "string" && typeof value.whatsappGroupId === "string" && typeof value.whatsappSenderId === "string" && Number.isInteger(value.attachmentIndex) && value.attachmentIndex >= 0 && typeof value.receivedAt === "string" && typeof value.mimeType === "string" && typeof value.originalPath === "string" && /^[a-f0-9]{64}$/.test(value.contentSha256))) return false;
    if (!isSupportedDocumentMimeType(value.mimeType)) return false;
    return value.originalPath === this.canonicalOriginalPath(value.whatsappMessageId, value.attachmentIndex, value.mimeType);
  }
}

async function readLimitedAttachment(attachment: IncomingAttachment, maxBytes: number): Promise<Uint8Array> {
  const downloaded = await attachment.download();
  if (downloaded instanceof Uint8Array) {
    if (downloaded.byteLength > maxBytes) throw new Error("attachment exceeds configured size limit");
    return downloaded;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of downloaded) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error("attachment exceeds configured size limit");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * Atomically publishes a completed original without replacement. If another process already
 * published this path, its bytes must be identical; conflicting staging is never canonicalized.
 */
export async function persistOriginal(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, bytes);
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (!alreadyExists(error)) throw error;
      const existing = await readFile(path);
      if (sha256(existing) !== sha256(bytes)) throw new WhatsAppContentConflictError("canonical original content differs");
    }
    await rm(temporaryPath, { force: true });
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
