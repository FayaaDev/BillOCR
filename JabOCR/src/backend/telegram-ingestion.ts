import { isSupportedDocumentMimeType } from "./attachment-mime";
import type { BillDatabase } from "../db/database";
import { sourceSenderText, type Bill } from "./contracts";
import { DurableAttachmentIngestionService, type IncomingAttachment, type IncomingSourceMessage } from "./durable-attachment-ingestion";
import type { Logger } from "./logger";

type TelegramPhoto = { file_id?: unknown; file_size?: unknown };
type TelegramDocument = { file_id?: unknown; file_name?: unknown; mime_type?: unknown; file_size?: unknown };
type TelegramMessage = { message_id?: unknown; date?: unknown; caption?: unknown; chat?: { id?: unknown }; from?: { id?: unknown; first_name?: unknown; last_name?: unknown; username?: unknown }; sender_chat?: { id?: unknown; title?: unknown; username?: unknown }; photo?: TelegramPhoto[]; document?: TelegramDocument };
type TelegramUpdate = { update_id?: unknown; message?: TelegramMessage; edited_message?: TelegramMessage; channel_post?: TelegramMessage; edited_channel_post?: TelegramMessage };
type TelegramFile = { file_path?: unknown; file_size?: unknown };
type TelegramResponse<T> = { ok?: unknown; result?: T };
export type TelegramFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TelegramIngestionOptions {
  botToken: string;
  groupIds: readonly string[];
  pollTimeoutSeconds: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  originalsDir: string;
  maxAttachmentBytes: number;
  database: BillDatabase;
  logger: Logger;
  fetch?: TelegramFetch;
  retryDelayMs?: number;
}

/** Lifecycle boundary used by the composition root; stop resolves after the active poll drains. */
export interface TelegramPollingService { start(): void | Promise<void>; stop(): void | Promise<void>; pollOnce(): Promise<void>; reconcilePending(): Promise<Bill[]>; status?(): { state: "starting" | "connected" | "failed" | "stopped" }; }

class TelegramTransientError extends Error {}
class TelegramPermanentError extends Error {}
const asString = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const asId = (value: unknown): string | null => (typeof value === "string" || typeof value === "number") && String(value).length > 0 ? String(value) : null;
const asSize = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> { try { await body?.cancel(); } catch {} }

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) { await cancelBody(response.body); throw new TelegramTransientError("response exceeds configured size limit"); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > maxBytes) { try { await reader.cancel(); } catch {} throw new TelegramTransientError("response exceeds configured size limit"); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result;
}

function responseError(status: number, permanent: boolean): Error {
  return permanent && status >= 400 && status < 500 && status !== 408 && status !== 429 ? new TelegramPermanentError(`telegram HTTP ${status}`) : new TelegramTransientError(`telegram HTTP ${status}`);
}

async function readTelegramJson<T>(response: Response, maxBytes: number, permanent = false): Promise<T> {
  if (!response.ok) { await cancelBody(response.body); throw responseError(response.status, permanent); }
  let value: TelegramResponse<T>;
  try { value = JSON.parse(new TextDecoder().decode(await readBounded(response, maxBytes))) as TelegramResponse<T>; } catch (error) { if (error instanceof TelegramTransientError) throw error; throw permanent ? new TelegramPermanentError("malformed telegram response") : new TelegramTransientError("malformed telegram response"); }
  if (value.ok !== true) throw permanent ? new TelegramPermanentError("telegram API rejected request") : new TelegramTransientError("telegram API rejected request");
  return value.result as T;
}

function responseStream(response: Response, maxBytes: number): AsyncIterable<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) { void cancelBody(response.body); throw new TelegramPermanentError("attachment exceeds configured size limit"); }
  if (!response.body) throw new TelegramTransientError("empty telegram file response");
  return { async *[Symbol.asyncIterator]() { const reader = response.body!.getReader(); let total = 0; try { while (true) { const next = await reader.read(); if (next.done) return; total += next.value.byteLength; if (total > maxBytes) { try { await reader.cancel(); } catch {} throw new TelegramPermanentError("attachment exceeds configured size limit"); } yield next.value; } } finally { reader.releaseLock(); } } };
}

/** Native-fetch Telegram Bot API long poller. Its cursor is advanced only after durable intake. */
export class TelegramBotApiIngestionService implements TelegramPollingService {
  private readonly fetcher: TelegramFetch;
  private readonly ingestion: DurableAttachmentIngestionService;
  private readonly controller = new AbortController();
  private running = false;
  private loop: Promise<void> | null = null;
  private pollState: "starting" | "connected" | "failed" = "starting";
  private lastPollAt = Date.now();

  constructor(private readonly options: TelegramIngestionOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.ingestion = new DurableAttachmentIngestionService({ source: "telegram", allowedChatIds: options.groupIds, originalsDir: options.originalsDir, database: options.database, logger: options.logger, maxAttachmentBytes: options.maxAttachmentBytes, logLabel: "Telegram", propagateAttachmentErrors: true });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollState = "starting";
    this.lastPollAt = Date.now();
    this.loop = this.run().catch(() => { this.pollState = "failed"; }).finally(() => { this.running = false; });
  }
  async stop(): Promise<void> { this.running = false; this.controller.abort(); await this.loop; }

  status(now = Date.now()): { state: "starting" | "connected" | "failed" | "stopped" } {
    return { state: !this.running ? "stopped" : now - this.lastPollAt > Math.max(15 * 60_000, this.options.requestTimeoutMs * 3) ? "failed" : this.pollState };
  }

  reconcilePending(): Promise<Bill[]> { return this.ingestion.reconcilePending(); }

  async pollOnce(): Promise<void> {
    const cursor = this.options.database.getTelegramPollingCursor();
    if (cursor === null) {
      await this.captureInitialBoundary();
      return;
    }
    const updates = await this.getUpdates(cursor);
    for (const update of updates.sort((a, b) => (typeof a.update_id === "number" ? a.update_id : -1) - (typeof b.update_id === "number" ? b.update_id : -1))) {
      const updateId = update.update_id;
      if (typeof updateId !== "number" || !Number.isInteger(updateId) || updateId < cursor) continue;
      const message = update.message ?? update.channel_post;
      if (message) {
        try { await this.ingestion.ingest(this.normalizeMessage(message)); }
        catch (error) { if (!(error instanceof TelegramPermanentError)) throw error; }
      }
      this.options.database.setTelegramPollingCursor(updateId + 1);
    }
  }

  private async run(): Promise<void> {
    while (this.running && !this.controller.signal.aborted) {
      try { await this.pollOnce(); this.pollState = "connected"; this.lastPollAt = Date.now(); }
      catch (error) { if (this.controller.signal.aborted) return; this.pollState = "failed"; this.options.logger.warn("Telegram polling failed", { code: "telegram_poll_failed", transient: true }); await this.delay(); }
    }
  }

  private async delay(): Promise<void> {
    if (this.controller.signal.aborted) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => { clearTimeout(timer); this.controller.signal.removeEventListener("abort", finish); resolve(); };
      timer = setTimeout(finish, this.options.retryDelayMs ?? 1_000);
      this.controller.signal.addEventListener("abort", finish, { once: true });
      if (this.controller.signal.aborted) finish();
    });
  }
  /** Telegram's offset=-1 atomically confirms older pending updates and returns the snapshot tail. */
  private async captureInitialBoundary(): Promise<void> {
    const [tail] = await this.getUpdates(-1, 0, 1);
    const updateId = tail?.update_id;
    this.options.database.setTelegramPollingCursor(typeof updateId === "number" && Number.isInteger(updateId) && updateId >= 0 ? updateId + 1 : 0);
  }
  private apiUrl(method: string): string { return `https://api.telegram.org/bot${this.options.botToken}/${method}`; }
  private fileUrl(path: string): string { return `https://api.telegram.org/file/bot${this.options.botToken}/${path}`; }
  private async getUpdates(offset: number | null, timeout = this.options.pollTimeoutSeconds, limit?: number): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = { timeout, allowed_updates: ["message", "channel_post"] };
    if (offset !== null) body.offset = offset;
    if (limit !== undefined) body.limit = limit;
    const response = await this.request(this.apiUrl("getUpdates"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await readTelegramJson<unknown>(response, this.options.maxResponseBytes);
    return Array.isArray(result) ? result as TelegramUpdate[] : [];
  }
  private async request(url: string, init: RequestInit): Promise<Response> {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.options.requestTimeoutMs)]);
    try { return await this.fetcher(url, { ...init, signal }); } catch { throw new TelegramTransientError("telegram request failed"); }
  }
  private normalizeMessage(message: TelegramMessage): IncomingSourceMessage {
    const caption = asString(message.caption); const attachments: IncomingAttachment[] = [];
    const photo = (message.photo ?? []).findLast((item) => asString(item.file_id));
    if (photo) attachments.push(this.attachment("image", "image/jpeg", null, caption, asString(photo.file_id)!));
    const document = message.document; const mime = asString(document?.mime_type)?.toLowerCase();
    if (document && mime && isSupportedDocumentMimeType(mime) && asString(document.file_id)) attachments.push(this.attachment("document", mime, asString(document.file_name), caption, asString(document.file_id)!));
    const senderName = message.sender_chat ? sourceSenderText(message.sender_chat.title) : sourceSenderText([sourceSenderText(message.from?.first_name), sourceSenderText(message.from?.last_name)].filter(Boolean).join(" "));
    const username = sourceSenderText(message.sender_chat ? message.sender_chat.username : message.from?.username);
    return { id: asId(message.message_id), chatId: asId(message.chat?.id), senderId: message.sender_chat ? asId(message.sender_chat.id) : asId(message.from?.id), sourceSenderName: senderName, sourceSenderUsername: username && /^[A-Za-z0-9_]{1,32}$/.test(username) ? username : null, sourceSenderPhoneNumber: null, timestamp: typeof message.date === "number" ? message.date : null, caption, attachments };
  }
  private attachment(kind: "image" | "document", mimeType: string, filename: string | null, caption: string | null, fileId: string): IncomingAttachment {
    return { kind, mimeType, filename, caption, download: async () => {
      const metadata = await readTelegramJson<TelegramFile>(await this.request(this.apiUrl("getFile"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file_id: fileId }) }), this.options.maxResponseBytes, true);
      if (asSize(metadata.file_size) !== null && asSize(metadata.file_size)! > this.options.maxAttachmentBytes) throw new TelegramPermanentError("attachment exceeds configured size limit");
      const path = asString(metadata.file_path); if (!path || path.includes("..") || path.startsWith("/")) throw new TelegramPermanentError("invalid telegram file path");
      const response = await this.request(this.fileUrl(path), { method: "GET" });
      if (!response.ok) { await cancelBody(response.body); throw responseError(response.status, true); }
      return responseStream(response, this.options.maxAttachmentBytes);
    } };
  }
}
