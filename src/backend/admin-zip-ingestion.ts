import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { canonicalAttachmentExtension, sniffSupportedDocumentMimeType } from "./attachment-mime";
import type { AdminUploadBatch, Bill } from "./contracts";
import type { BillDatabase } from "../db/database";
import type { Logger } from "./logger";
import { AttachmentContentConflictError, persistOriginal, removeVerifiedUnreferencedOriginal, safeAttachmentFilename, sourceBasename } from "./durable-attachment-ingestion";

export interface ZipIngestionLimits { maxCompressedBytes: number; maxExpandedBytes: number; maxEntryBytes: number; maxEntries: number; }
export interface AdminZipUpload { sourceId: string; originalFilename: string; bytes: Uint8Array | AsyncIterable<Uint8Array>; }
export interface AdminZipIngestionOptions { database: BillDatabase; logger: Logger; originalsDir: string; stagingDir: string; limits?: Partial<ZipIngestionLimits>; afterOriginalPublished?: () => Promise<void>; }
export interface AdminZipIngestionResult { batch: AdminUploadBatch; counts: { accepted: number; rejected: number; ignored: number }; }

type StagedZip = { version: 1; sourceId: string; originalFilename: string; contentSha256: string; zipPath: string };
const defaultLimits: ZipIngestionLimits = { maxCompressedBytes: 50 * 1024 * 1024, maxExpandedBytes: 200 * 1024 * 1024, maxEntryBytes: 20 * 1024 * 1024, maxEntries: 500 };

export class AdminZipContentConflictError extends Error {}

function sha256(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }
function sourceKey(sourceId: string): string { return sha256(sourceId).slice(0, 32); }
function safeEntryPath(value: string): string { return value.replace(/\0/g, "�").slice(0, 1_000) || "[empty entry name]"; }
function validSourceId(value: string): boolean { return value.length > 0 && value.length <= 512 && !value.includes("\0"); }
function unsafePath(value: string): boolean {
  return value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some((part) => part === "" || part === "." || part === "..");
}
function specialEntry(entry: Entry): boolean {
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  return type !== 0 && type !== 0o100000 && type !== 0o040000;
}
function directoryEntry(entry: Entry, name: string): boolean { return name.endsWith("/") || (entry.externalFileAttributes & 0x10) !== 0; }
function encryptedEntry(entry: Entry): boolean { return (entry.generalPurposeBitFlag & 1) !== 0; }
function isExisting(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY"; }

function entryName(entry: Entry): string {
  const value = entry.fileName as unknown;
  return typeof value === "string" ? value : Buffer.from(value as Uint8Array).toString("utf8");
}
function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolvePromise, reject) => yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, decodeStrings: false }, (error, zip) => error || !zip ? reject(error ?? new Error("ZIP unavailable")) : resolvePromise(zip)));
}
function readEntry(zip: ZipFile, entry: Entry, limit: number): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error || !stream) { reject(error ?? new Error("ZIP entry unavailable")); return; }
    const chunks: Uint8Array[] = []; let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) { stream.destroy(new Error("ZIP entry size limit exceeded")); return; }
      chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice());
    });
    stream.once("error", reject);
    stream.once("end", () => {
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      resolvePromise(bytes);
    });
  }));
}

/** Bounded, filesystem-staged ZIP intake. SQLite calls are short transactions; archive work is always outside them. */
export class AdminZipIngestionService {
  private readonly options: AdminZipIngestionOptions & { limits: ZipIngestionLimits; originalsDir: string; stagingDir: string };
  // ponytail: process-local in-flight map; reconcilePending recovers after crash
  private readonly inFlight = new Map<string, Promise<AdminZipIngestionResult>>();

  constructor(options: AdminZipIngestionOptions) {
    const limits = { ...defaultLimits, ...options.limits };
    if (Object.values(limits).some((value) => !Number.isInteger(value) || value < 1)) throw new Error("ZIP ingestion limits must be positive integers");
    this.options = { ...options, limits, originalsDir: resolve(options.originalsDir), stagingDir: resolve(options.stagingDir) };
  }

  async ingest(upload: AdminZipUpload, options?: { wait?: boolean }): Promise<AdminZipIngestionResult> {
    if (!validSourceId(upload.sourceId)) throw new Error("ZIP source ID is invalid");
    const staged = await this.stage(upload);
    const work = this.process(staged);
    if (options?.wait === false) {
      const batch = this.options.database.createAdminUploadBatch({ idempotencyKey: `admin-zip:${staged.sourceId}`, originalFilename: staged.originalFilename }).batch;
      void work.catch(() => this.options.logger.warn("admin ZIP processing failed", { code: "admin_zip_processing_failed" }));
      return { batch, counts: { accepted: 0, rejected: 0, ignored: 0 } };
    }
    return work;
  }

  /** Restarts processing from durable local manifests left by a process crash. */
  async reconcilePending(): Promise<AdminZipIngestionResult[]> {
    let entries: string[];
    try { entries = await readdir(this.options.stagingDir); } catch { return []; }
    const results: AdminZipIngestionResult[] = [];
    for (const entry of entries) {
      const unit = join(this.options.stagingDir, entry);
      try {
        const info = await lstat(unit);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        const manifestFile = join(unit, "manifest.json");
        const manifestInfo = await lstat(manifestFile);
        if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) continue;
        const staged = JSON.parse(await readFile(manifestFile, "utf8")) as StagedZip;
        if (!this.validManifest(staged, unit)) continue;
        results.push(await this.process(staged));
      } catch {
        this.options.logger.warn("admin ZIP staging reconciliation failed", { code: "admin_zip_staging_reconciliation_failed" });
      }
    }
    return results;
  }

  private async stage(upload: AdminZipUpload): Promise<StagedZip> {
    await mkdir(this.options.stagingDir, { recursive: true });
    const unit = join(this.options.stagingDir, sourceKey(upload.sourceId));
    const temporary = `${unit}.${randomUUID()}.tmp`;
    await mkdir(temporary);
    try {
      const zipPath = join(temporary, "upload.zip");
      const contentSha256 = await this.writeBounded(zipPath, upload.bytes);
      const staged: StagedZip = { version: 1, sourceId: upload.sourceId, originalFilename: basename(upload.originalFilename).slice(0, 512) || "upload.zip", contentSha256, zipPath: join(unit, "upload.zip") };
      await writeFile(join(temporary, "manifest.json"), JSON.stringify(staged));
      try { await rename(temporary, unit); }
      catch (error) {
        if (!isExisting(error)) throw error;
        const prior = JSON.parse(await readFile(join(unit, "manifest.json"), "utf8")) as StagedZip;
        if (!this.validManifest(prior, unit) || prior.contentSha256 !== contentSha256) throw new AdminZipContentConflictError("ZIP source content differs");
        await rm(temporary, { recursive: true, force: true });
        return prior;
      }
      return staged;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async writeBounded(path: string, input: Uint8Array | AsyncIterable<Uint8Array>): Promise<string> {
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 }); const hash = createHash("sha256"); let size = 0;
    try {
      const chunks = input instanceof Uint8Array ? [input] : input;
      for await (const chunk of chunks) {
        size += chunk.byteLength;
        if (size > this.options.limits.maxCompressedBytes) throw new Error("ZIP compressed size limit exceeded");
        hash.update(chunk);
        if (!output.write(chunk)) await new Promise<void>((resolvePromise, reject) => { output.once("drain", resolvePromise); output.once("error", reject); });
      }
      output.end(); await finished(output); return hash.digest("hex");
    } catch (error) { output.destroy(); await rm(path, { force: true }).catch(() => undefined); throw error; }
  }

  private process(staged: StagedZip): Promise<AdminZipIngestionResult> {
    const key = sourceKey(staged.sourceId);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    let work: Promise<AdminZipIngestionResult>;
    work = this.reconcileStaged(staged).finally(() => { if (this.inFlight.get(key) === work) this.inFlight.delete(key); });
    this.inFlight.set(key, work);
    return work;
  }

  private async reconcileStaged(staged: StagedZip): Promise<AdminZipIngestionResult> {
    const stagedInfo = await lstat(staged.zipPath);
    if (!stagedInfo.isFile() || stagedInfo.isSymbolicLink() || stagedInfo.size > this.options.limits.maxCompressedBytes || sha256(await readFile(staged.zipPath)) !== staged.contentSha256) throw new Error("staged ZIP is unavailable or changed");
    const batch = this.options.database.createAdminUploadBatch({ idempotencyKey: `admin-zip:${staged.sourceId}`, originalFilename: staged.originalFilename }).batch;
    const existing = this.options.database.getAdminUploadBatchStatus(batch.id);
    if (existing?.batch.state === "failed") return { batch: existing.batch, counts: { accepted: existing.counts.complete + existing.counts.notInvoice, rejected: existing.counts.rejected, ignored: 0 } };
    const counts = { accepted: 0, rejected: 0, ignored: 0 };
    let activeItemId: string | null = null;
    let zip: ZipFile | null = null;
    let index = 0; let expanded = 0;
    try {
      const opened = await openZip(staged.zipPath);
      zip = opened;
      await new Promise<void>((resolvePromise, reject) => {
        opened.on("error", reject);
        opened.on("end", resolvePromise);
        opened.on("entry", async (entry: Entry) => {
          try {
            const name = entryName(entry);
            const itemIndex = index;
            index += 1;
            const rejectNew = (errorCode: string) => {
              const created = this.options.database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex, entryPath: safeEntryPath(name) }).item;
              this.reject(created.id, errorCode);
              counts.rejected += 1;
            };
            if (itemIndex >= this.options.limits.maxEntries) { rejectNew("entry_count_limit"); opened.close(); resolvePromise(); return; }
            if (directoryEntry(entry, name)) { counts.ignored += 1; opened.readEntry(); return; }
            if (unsafePath(name)) { rejectNew("unsafe_entry_path"); opened.readEntry(); return; }
            if (encryptedEntry(entry)) { rejectNew("encrypted_entry"); opened.readEntry(); return; }
            if (specialEntry(entry)) { rejectNew("special_entry"); opened.readEntry(); return; }
            if (entry.uncompressedSize > this.options.limits.maxEntryBytes) { rejectNew("entry_size_limit"); opened.readEntry(); return; }
            if (expanded + entry.uncompressedSize > this.options.limits.maxExpandedBytes) { rejectNew("expanded_size_limit"); opened.readEntry(); return; }
            const readLimit = Math.min(this.options.limits.maxEntryBytes, this.options.limits.maxExpandedBytes - expanded);
            let bytes: Uint8Array;
            try { bytes = await readEntry(opened, entry, readLimit); }
            catch {
              rejectNew(readLimit === this.options.limits.maxEntryBytes ? "entry_size_limit" : "expanded_size_limit");
              opened.readEntry();
              return;
            }
            expanded += bytes.byteLength;
            const mimeType = sniffSupportedDocumentMimeType(bytes);
            if (!mimeType) { counts.ignored += 1; opened.readEntry(); return; }
            const item = this.options.database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex, entryPath: safeEntryPath(name) }).item;
            activeItemId = item.id;
            const bill = await this.publishItem(batch, item.id, itemIndex, sourceBasename(name), mimeType, bytes);
            if (bill) counts.accepted += 1; else counts.rejected += 1;
            activeItemId = null;
            opened.readEntry();
          } catch (error) { reject(error); }
        });
        opened.readEntry();
      });
    } catch {
      zip?.close();
      const item = activeItemId
        ? { id: activeItemId }
        : this.options.database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex: index, entryPath: "[ZIP archive]" }).item;
      this.options.database.transitionAdminUploadBatchItemState({ itemId: item.id, state: "failed", errorCode: "zip_processing_failed", expectedStates: ["queued", "processing"] });
      this.options.database.setAdminUploadBatchState(batch.id, "failed");
      const failed = this.options.database.getAdminUploadBatchStatus(batch.id);
      if (!failed) throw new Error("admin ZIP batch disappeared");
      return { batch: failed.batch, counts: { accepted: counts.accepted, rejected: counts.rejected, ignored: counts.ignored } };
    } finally { zip?.close(); }
    this.options.database.finalizeAdminUploadBatch(batch.id);
    return { batch, counts };
  }

  private reject(itemId: string, errorCode: string): void {
    this.options.database.transitionAdminUploadBatchItemState({ itemId, state: "rejected", errorCode, expectedStates: ["queued", "processing"] });
  }

  private async publishItem(batch: AdminUploadBatch, itemId: string, itemIndex: number, sourceFilename: string | null, mimeType: NonNullable<ReturnType<typeof sniffSupportedDocumentMimeType>>, bytes: Uint8Array): Promise<Bill | null> {
    const contentSha256 = sha256(bytes); const extension = canonicalAttachmentExtension(mimeType);
    if (!extension) throw new Error("sniffed unsupported ZIP entry");
    const sourceIdentity = `admin-zip:${batch.id}:${itemIndex}`;
    const originalPath = join(this.options.originalsDir, `admin-${batch.id}-${itemIndex}-${contentSha256.slice(0, 16)}${extension}`);
    const existing = this.options.database.getBillBySourceIdentity("admin_upload", sourceIdentity);
    if (existing) { if (existing.contentSha256 !== contentSha256) throw new AdminZipContentConflictError("ZIP source content differs"); return existing; }
    if (this.options.database.getBillByContentSha256(contentSha256)) {
      await removeVerifiedUnreferencedOriginal(this.options.database, originalPath, contentSha256);
      this.options.database.transitionAdminUploadBatchItemState({ itemId, state: "rejected", errorCode: "duplicate_content", expectedStates: ["queued"] });
      return null;
    }
    try { await persistOriginal(originalPath, bytes); }
    catch (error) { if (error instanceof AttachmentContentConflictError) throw new AdminZipContentConflictError("canonical ZIP original conflicts"); throw error; }
    await this.options.afterOriginalPublished?.();
    const result = this.options.database.createBillWithInitialJobs({
      sourceMessageId: sourceIdentity, sourceChatId: "admin-upload", sourceSenderId: "admin-upload", attachmentIndex: 0,
      receivedAt: batch.createdAt, originalFilename: safeAttachmentFilename(sourceFilename, mimeType), sourceFilename, mimeType, originalPath, contentSha256, source: "admin_upload", sourceIdentity,
      extractionPolicy: "azure_only", batchItemId: itemId,
    }, [
      { type: "extract", idempotencyKey: `extract:${sourceIdentity}:azure_only` },
      // A zero-document result is terminal but its immutable intake original is still archival work.
      { type: "archive_to_drive", idempotencyKey: `archive_to_drive:${sourceIdentity}` },
    ]);
    if (result.duplicateContent) {
      await removeVerifiedUnreferencedOriginal(this.options.database, originalPath, contentSha256);
      this.options.database.transitionAdminUploadBatchItemState({ itemId, state: "rejected", errorCode: "duplicate_content", expectedStates: ["queued"] });
      return null;
    }
    return result.bill;
  }

  private validManifest(value: StagedZip, unit: string): boolean {
    return value.version === 1 && validSourceId(value.sourceId) && typeof value.originalFilename === "string" && /^[a-f0-9]{64}$/.test(value.contentSha256) && value.zipPath === join(unit, "upload.zip");
  }
}
