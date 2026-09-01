import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { transportSourceIdentity, type Bill, type BillSource, type CreateBillInput } from "./contracts";
import type { BillDatabase } from "./database";
import type { Logger } from "./logger";
import { canonicalOriginalsDir } from "./config";
import { canonicalAttachmentExtension, isSupportedDocumentMimeType, isSupportedImageMimeType } from "./attachment-mime";
import { IMAGE_PREPROCESSING_VERSION } from "./image-preprocessing";

export type AttachmentKind = "image" | "document";
export interface IncomingAttachment { kind: AttachmentKind; mimeType: string | null | undefined; filename?: string | null; caption?: string | null; download(): Promise<Uint8Array | AsyncIterable<Uint8Array>> | AsyncIterable<Uint8Array>; }
export interface IncomingSourceMessage { id: string | null | undefined; chatId: string | null | undefined; senderId: string | null | undefined; timestamp: Date | string | number | null | undefined; caption?: string | null; attachments?: IncomingAttachment[] | null; }
export interface DurableAttachmentIngestionOptions { source: Exclude<BillSource, "admin_upload">; allowedChatIds: readonly string[]; originalsDir: string; database: BillDatabase; logger: Logger; extractionInputVersion?: "original" | typeof IMAGE_PREPROCESSING_VERSION; maxAttachmentBytes?: number; beforeCommit?: () => Promise<void>; beforeStagingPublish?: () => Promise<void>; afterOriginalPublished?: () => Promise<void>; logLabel?: string; propagateAttachmentErrors?: boolean; }
export interface IngestionResult { bills: Bill[]; }

type StagedAttachment = CreateBillInput & { version: 1; source: Exclude<BillSource, "admin_upload">; sourceIdentity: string; sourceMessageId: string; sourceChatId: string; sourceSenderId: string; };
type LegacyWhatsAppStagedAttachment = CreateBillInput & { version: 1; whatsappMessageId: string; whatsappGroupId: string; whatsappSenderId: string; };
const stagingName = ".staging";

/** The configured source identity already has different canonical content. */
export class AttachmentContentConflictError extends Error {}
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function alreadyExists(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY"; }
function accepted(attachment: IncomingAttachment): boolean { return attachment.kind === "image" ? isSupportedImageMimeType(attachment.mimeType) : isSupportedDocumentMimeType(attachment.mimeType); }
function receivedAt(timestamp: IncomingSourceMessage["timestamp"]): string | null { const date = timestamp instanceof Date ? timestamp : new Date(typeof timestamp === "number" ? timestamp * 1000 : timestamp ?? ""); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function safeFilename(filename: string | null | undefined, mimeType: string): string | null { if (!filename) return null; const name = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_"); const base = name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name; return `${base || "attachment"}${canonicalAttachmentExtension(mimeType)!}`; }

/** Crash-recoverable source-neutral intake. It persists immutable bytes before its short SQLite transaction. */
export class DurableAttachmentIngestionService {
  private readonly options: DurableAttachmentIngestionOptions & { originalsDir: string; extractionInputVersion: "original" | typeof IMAGE_PREPROCESSING_VERSION; logLabel: string; };
  constructor(options: DurableAttachmentIngestionOptions) {
    mkdirSync(options.originalsDir, { recursive: true });
    this.options = { ...options, extractionInputVersion: options.extractionInputVersion ?? "original", originalsDir: canonicalOriginalsDir(options.originalsDir), logLabel: options.logLabel ?? options.source };
  }

  async ingest(message: IncomingSourceMessage): Promise<IngestionResult> {
    if (!message.chatId || !this.options.allowedChatIds.includes(message.chatId)) return { bills: [] };
    const attachments = message.attachments ?? [];
    if (!attachments.some(accepted)) return { bills: [] };
    const timestamp = receivedAt(message.timestamp);
    if (!message.id || !message.senderId || !timestamp) { this.options.logger.warn(`ignored malformed ${this.options.logLabel} message`, { code: `${this.options.source}_malformed_message`, hasId: Boolean(message.id), hasSender: Boolean(message.senderId) }); return { bills: [] }; }
    const bills: Bill[] = [];
    for (const [attachmentIndex, attachment] of attachments.entries()) {
      if (!accepted(attachment)) continue;
      const sourceIdentity = this.sourceIdentity(message.id, message.chatId, attachmentIndex);
      const existing = this.options.database.getBillBySourceIdentity(this.options.source, sourceIdentity);
      if (existing) { bills.push(existing); continue; }
      try {
        const bytes = await readLimitedAttachment(attachment, this.options.maxAttachmentBytes ?? 20 * 1024 * 1024);
        const manifest = this.createManifest(message, attachment, attachmentIndex, timestamp, bytes);
        await this.stage(manifest, bytes); await this.options.beforeCommit?.();
        const bill = await this.reconcileOne(this.unitDirectory(manifest)); if (bill) bills.push(bill);
      } catch (error) { this.options.logger.warn(error instanceof AttachmentContentConflictError ? `${this.options.logLabel} attachment content conflict` : `${this.options.logLabel} attachment ingestion failed`, { code: error instanceof AttachmentContentConflictError ? `${this.options.source}_attachment_content_conflict` : `${this.options.source}_attachment_ingestion_failed`, messageId: message.id, attachmentIndex }); if (this.options.propagateAttachmentErrors) throw error; }
    }
    return { bills };
  }

  async reconcilePending(): Promise<Bill[]> {
    let entries: string[]; try { entries = await readdir(this.stagingDirectory()); } catch { return []; }
    const bills: Bill[] = [];
    for (const entry of entries) {
      if (entry.endsWith(".tmp")) continue;
      try { const unit = join(this.stagingDirectory(), entry); const info = await lstat(unit); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe staging unit"); if (!await this.belongsToSource(unit)) continue; const bill = await this.reconcileOne(unit); if (bill) bills.push(bill); }
      catch (error) { this.options.logger.warn(error instanceof AttachmentContentConflictError ? `${this.options.logLabel} staging content conflict` : `${this.options.logLabel} staging reconciliation failed`, { code: error instanceof AttachmentContentConflictError ? `${this.options.source}_attachment_content_conflict` : `${this.options.source}_staging_reconciliation_failed` }); }
    }
    return bills;
  }

  private createManifest(message: IncomingSourceMessage, attachment: IncomingAttachment, attachmentIndex: number, timestamp: string, bytes: Uint8Array): StagedAttachment {
    const mimeType = attachment.mimeType!.toLowerCase(); const sourceIdentity = this.sourceIdentity(message.id!, message.chatId!, attachmentIndex);
    return { version: 1, id: randomUUID(), source: this.options.source, sourceIdentity, sourceMessageId: message.id!, sourceChatId: message.chatId!, sourceSenderId: message.senderId!, attachmentIndex, receivedAt: timestamp, caption: attachment.caption ?? message.caption ?? null, originalFilename: safeFilename(attachment.filename, mimeType), mimeType, originalPath: this.canonicalOriginalPath(sourceIdentity, attachmentIndex, mimeType), contentSha256: sha256(bytes) };
  }
  private stagingDirectory(): string { return join(this.options.originalsDir, stagingName); }
  private canonicalOriginalPath(sourceIdentity: string, attachmentIndex: number, mimeType: string): string { const extension = canonicalAttachmentExtension(mimeType); if (!extension) throw new Error("unsupported attachment MIME type"); const key = this.options.source === "whatsapp" ? sourceIdentity : `${this.options.source}:${sourceIdentity}`; return join(resolve(this.options.originalsDir), `${createHash("sha256").update(key).digest("hex").slice(0, 32)}-${attachmentIndex}${extension}`); }
  private legacyWhatsAppOriginalPath(messageId: string, attachmentIndex: number, mimeType: string): string { const extension = canonicalAttachmentExtension(mimeType); if (!extension) throw new Error("unsupported attachment MIME type"); return join(resolve(this.options.originalsDir), `${createHash("sha256").update(messageId).digest("hex").slice(0, 32)}-${attachmentIndex}${extension}`); }
  private unitDirectory(manifest: StagedAttachment): string { const key = manifest.source === "whatsapp" ? manifest.sourceIdentity : `${manifest.source}:${manifest.sourceIdentity}`; return join(this.stagingDirectory(), `${createHash("sha256").update(key).digest("hex").slice(0, 32)}-${manifest.attachmentIndex}`); }
  private sourceIdentity(messageId: string, chatId: string, attachmentIndex: number): string { return transportSourceIdentity(chatId, messageId, attachmentIndex); }
  private async belongsToSource(unit: string): Promise<boolean> {
    const value = JSON.parse(await readFile(join(unit, "manifest.json"), "utf8")) as { source?: unknown };
    if (value.source === "whatsapp" || value.source === "telegram") return value.source === this.options.source;
    return this.options.source === "whatsapp";
  }

  private async stage(manifest: StagedAttachment, bytes: Uint8Array): Promise<void> {
    const unit = this.unitDirectory(manifest);
    try { const existing = await readFile(join(unit, "original")); if (sha256(existing) !== manifest.contentSha256) throw new AttachmentContentConflictError("staged attachment content differs"); return; } catch (error) { if (error instanceof AttachmentContentConflictError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(this.stagingDirectory(), { recursive: true }); const temporary = `${unit}.${randomUUID()}.tmp`;
    try { await mkdir(temporary); await writeFile(join(temporary, "original"), bytes); await writeFile(join(temporary, "manifest.json"), JSON.stringify(manifest)); await this.options.beforeStagingPublish?.(); try { await rename(temporary, unit); } catch (error) { await rm(temporary, { recursive: true, force: true }); if (!alreadyExists(error)) throw error; const existing = await readFile(join(unit, "original")); if (sha256(existing) !== manifest.contentSha256) throw new AttachmentContentConflictError("staged attachment content differs"); } } catch (error) { await rm(temporary, { recursive: true, force: true }).catch(() => undefined); throw error; }
  }
  private normalizeManifest(value: StagedAttachment | LegacyWhatsAppStagedAttachment): StagedAttachment | null {
    if ("source" in value) return value as StagedAttachment;
    if (this.options.source !== "whatsapp" || typeof value.whatsappMessageId !== "string" || typeof value.whatsappGroupId !== "string" || typeof value.whatsappSenderId !== "string") return null;
    const sourceIdentity = transportSourceIdentity(value.whatsappGroupId, value.whatsappMessageId, value.attachmentIndex);
    const originalPath = this.legacyWhatsAppOriginalPath(value.whatsappMessageId, value.attachmentIndex, value.mimeType);
    if (value.originalPath !== originalPath) return null;
    return { ...value, source: "whatsapp", sourceIdentity, sourceMessageId: value.whatsappMessageId, sourceChatId: value.whatsappGroupId, sourceSenderId: value.whatsappSenderId, originalPath };
  }
  private async reconcileOne(unit: string): Promise<Bill | null> {
    const manifestInfo = await lstat(join(unit, "manifest.json")); const originalInfo = await lstat(join(unit, "original"));
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || !originalInfo.isFile() || originalInfo.isSymbolicLink()) throw new Error("unsafe staging file");
    const parsed = JSON.parse(await readFile(join(unit, "manifest.json"), "utf8")) as StagedAttachment | LegacyWhatsAppStagedAttachment; const manifest = this.normalizeManifest(parsed);
    if (!manifest || !this.validManifest(manifest)) throw new Error("invalid staging manifest"); const bytes = await readFile(join(unit, "original")); if (sha256(bytes) !== manifest.contentSha256) throw new Error("staged content hash mismatch");
    const existing = this.options.database.getBillBySourceIdentity(manifest.source, manifest.sourceIdentity);
    if (existing) { if (manifest.contentSha256 !== existing.contentSha256) { await rm(unit, { recursive: true, force: true }); throw new AttachmentContentConflictError("existing bill content differs"); } await rm(unit, { recursive: true, force: true }); return existing; }
    const originalPath = manifest.originalPath;
    try { await persistOriginal(originalPath, bytes); } catch (error) { if (error instanceof AttachmentContentConflictError) await rm(unit, { recursive: true, force: true }); throw error; }
    await this.options.afterOriginalPublished?.();
    let result; try { result = this.options.database.createBillWithInitialJobs({ ...manifest, originalPath }, [{ type: "extract", idempotencyKey: `extract:${manifest.id}:${this.options.extractionInputVersion}` }, { type: "archive_to_drive", idempotencyKey: `archive_to_drive:${manifest.id}` }]); }
    catch (error) { const raced = this.options.database.getBillBySourceIdentity(manifest.source, manifest.sourceIdentity); if (!raced) throw error; if (raced.contentSha256 !== manifest.contentSha256) { await rm(unit, { recursive: true, force: true }); throw new AttachmentContentConflictError("racing bill content differs"); } result = { bill: raced, created: false }; }
    await rm(unit, { recursive: true, force: true }); return result.bill;
  }
  private validManifest(value: StagedAttachment): boolean { return value.version === 1 && value.source === this.options.source && typeof value.sourceIdentity === "string" && typeof value.id === "string" && typeof value.sourceMessageId === "string" && typeof value.sourceChatId === "string" && typeof value.sourceSenderId === "string" && Number.isInteger(value.attachmentIndex) && value.attachmentIndex >= 0 && typeof value.receivedAt === "string" && typeof value.mimeType === "string" && typeof value.originalPath === "string" && /^[a-f0-9]{64}$/.test(value.contentSha256) && isSupportedDocumentMimeType(value.mimeType) && value.sourceIdentity === this.sourceIdentity(value.sourceMessageId, value.sourceChatId, value.attachmentIndex) && (value.originalPath === this.canonicalOriginalPath(value.sourceIdentity, value.attachmentIndex, value.mimeType) || (value.source === "whatsapp" && value.originalPath === this.legacyWhatsAppOriginalPath(value.sourceMessageId, value.attachmentIndex, value.mimeType))); }
}

export async function readLimitedAttachment(attachment: IncomingAttachment, maxBytes: number): Promise<Uint8Array> { const downloaded = await attachment.download(); if (downloaded instanceof Uint8Array) { if (downloaded.byteLength > maxBytes) throw new Error("attachment exceeds configured size limit"); return downloaded; } const chunks: Uint8Array[] = []; let size = 0; for await (const chunk of downloaded) { size += chunk.byteLength; if (size > maxBytes) throw new Error("attachment exceeds configured size limit"); chunks.push(chunk); } const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes; }
/** Atomically publishes a completed original without replacement. */
export async function persistOriginal(path: string, bytes: Uint8Array): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporaryPath = `${path}.${randomUUID()}.tmp`; try { await writeFile(temporaryPath, bytes); try { await link(temporaryPath, path); } catch (error) { if (!alreadyExists(error)) throw error; const existingInfo = await lstat(path); if (existingInfo.isSymbolicLink()) throw new Error("canonical original is symlink"); const existing = await readFile(path); if (sha256(existing) !== sha256(bytes)) throw new AttachmentContentConflictError("canonical original content differs"); } await rm(temporaryPath, { force: true }); } catch (error) { await rm(temporaryPath, { force: true }).catch(() => undefined); throw error; } }
