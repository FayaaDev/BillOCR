import { basename, dirname } from "node:path";
import type { Bill, ClaimedJob, ExtractedBill, JobHandler, JobHandlerContext } from "./contracts";
import type { BillDatabase } from "./database";
import { PermanentJobError } from "./worker";
import { readVerifiedOriginal } from "./originals";

export interface DriveFile { id: string; webLink: string; appProperties: Record<string, string>; }
export interface DriveAdapter {
  findFolder(parentId: string, name: string): Promise<{ id: string } | null>;
  createFolder(parentId: string, name: string): Promise<{ id: string }>;
  findFilesByBillId(billId: string): Promise<DriveFile[]>;
  uploadOriginal(input: { parentId: string; name: string; mimeType: string; bytes: Uint8Array; billId: string; contentSha256: string }): Promise<DriveFile>;
  generateId?(): Promise<string>;
  getFile?(id: string): Promise<DriveFile | null>;
  createFolderWithId?(input: { id: string; parentId: string; name: string }): Promise<{ id: string }>;
  uploadOriginalWithId?(input: { id: string; parentId: string; name: string; mimeType: string; bytes: Uint8Array; billId: string; contentSha256: string }): Promise<DriveFile>;
}
export interface SheetsAdapter {
  initializeLedger(): Promise<void>;
  findRowByBillId(billId: string): Promise<number | null>;
  appendRow(values: readonly (string | number | null)[]): Promise<number>;
  updateRow(row: number, values: readonly (string | number | null)[]): Promise<void>;
  findRowsByBillId?(billId: string): Promise<number[]>;
  findLedgerRows?(billId: string): Promise<Array<{ row: number; revision: number | null }>>;
  clearRows?(rows: number[]): Promise<void>;
}
export interface GoogleProjectionConfig { driveRootId: string; sheetId: string; sheetName: string; requestTimeoutMs?: number; maxResponseBytes?: number; }
export const ledgerHeaders = ["Received date", "Vendor", "Invoice number", "Invoice date", "Subtotal", "VAT", "Total", "Currency", "Description", "Sender", "Confidence summary", "Status", "Drive hyperlink", "Bill ID", "Revision"] as const;

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };
export type AuthorizedUser = { type: "authorized_user"; client_id: string; client_secret: string; refresh_token: string; token_uri?: string };
export type GoogleCredential = ServiceAccount | AuthorizedUser;
function isAuthorizedUser(credential: GoogleCredential): credential is AuthorizedUser { return "type" in credential && credential.type === "authorized_user"; }
function nonBlank(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
function base64Url(value: string | Uint8Array): string { return Buffer.from(value).toString("base64url"); }
/** Validates only the minimum service-account shape; neither credential values nor tokens are logged. */
export function readServiceAccountCredential(json: string): ServiceAccount {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error("Invalid Google service-account JSON"); }
  const value = parsed as Partial<ServiceAccount & { type?: unknown }>;
  if (!parsed || typeof parsed !== "object" || (value.type !== undefined && value.type !== "service_account") || !nonBlank(value.client_email) || !nonBlank(value.private_key) || (value.token_uri !== undefined && !nonBlank(value.token_uri))) throw new Error("Google service-account JSON requires client_email and private_key");
  return parsed as ServiceAccount;
}
/** Parses only supported Google credential documents; errors never include credential material. */
export function readGoogleCredential(json: string): GoogleCredential {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error("Invalid Google credential JSON"); }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid Google credential JSON");
  const value = parsed as Partial<ServiceAccount & AuthorizedUser>;
  if (value.type === "authorized_user") {
    if (!nonBlank(value.client_id) || !nonBlank(value.client_secret) || !nonBlank(value.refresh_token) || (value.token_uri !== undefined && !nonBlank(value.token_uri))) throw new Error("Google authorized-user JSON requires client_id, client_secret, and refresh_token");
    return { type: "authorized_user", client_id: value.client_id, client_secret: value.client_secret, refresh_token: value.refresh_token, ...(value.token_uri ? { token_uri: value.token_uri } : {}) };
  }
  return readServiceAccountCredential(json);
}
class GoogleHttpError extends Error {
  constructor(readonly status: number, readonly detail: string) { super(`HTTP ${status}${detail ? `: ${detail.slice(0, 300)}` : ""}`); }
}
class GoogleRestClient {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(private readonly account: GoogleCredential, private readonly fetcher: Fetcher = fetch, private readonly timeoutMs = 60_000, private readonly maxResponseBytes = 2 * 1024 * 1024) {}
  private async text(response: Response): Promise<string> { const length = Number(response.headers.get("content-length") ?? 0); if (length > this.maxResponseBytes) { await response.body?.cancel(); throw new Error("Google response too large"); } const reader = response.body?.getReader(); if (!reader) return ""; const chunks: Uint8Array[] = []; let size = 0; try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > this.maxResponseBytes) { await reader.cancel(); throw new Error("Google response too large"); } chunks.push(next.value); } } finally { reader.releaseLock(); } return new TextDecoder().decode(Buffer.concat(chunks)); }
  private async consume<T>(url: string, init: RequestInit, parse: (text: string) => T): Promise<T> { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs); try { const token = await this.accessToken(); const response = await this.fetcher(url, { ...init, signal: controller.signal, headers: { Authorization: `Bearer ${token}`, ...init.headers } }); const text = await this.text(response); if (!response.ok) throw new GoogleHttpError(response.status, text); return parse(text); } catch (error) { if (controller.signal.aborted) throw new Error("Google timeout"); throw error; } finally { clearTimeout(timer); } }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response; let text: string;
    try {
      if (isAuthorizedUser(this.account)) {
        response = await this.fetcher(this.account.token_uri ?? "https://oauth2.googleapis.com/token", { method: "POST", signal: controller.signal, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.account.client_id, client_secret: this.account.client_secret, refresh_token: this.account.refresh_token }) });
      } else {
        const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = base64Url(JSON.stringify({ iss: this.account.client_email, scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets", aud: this.account.token_uri ?? "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
    const keyData = Buffer.from(this.account.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s/g, ""), "base64");
    const key = await crypto.subtle.importKey("pkcs8", keyData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`));
        response = await this.fetcher(this.account.token_uri ?? "https://oauth2.googleapis.com/token", { method: "POST", signal: controller.signal, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claim}.${base64Url(new Uint8Array(signature))}` }) });
      }
      text = await this.text(response);
    } catch (error) { if (controller.signal.aborted) throw new Error("Google timeout"); throw error; } finally { clearTimeout(timer); }
    if (!response!.ok) throw new GoogleHttpError(response!.status, text!);
    const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Google authentication response missing token");
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }
  async json<T>(url: string, init: RequestInit = {}): Promise<T> { return this.consume(url, init, (text) => text ? JSON.parse(text) as T : {} as T); }
  async empty(url: string, init: RequestInit = {}): Promise<void> { await this.consume(url, init, () => undefined); }
}

/** Thin REST adapters: external calls are isolated here so all behavior can be mock-tested. */
export function createGoogleAdapters(credentialJson: string, config: GoogleProjectionConfig, fetcher: Fetcher = fetch): { drive: DriveAdapter; sheets: SheetsAdapter } {
  const client = new GoogleRestClient(readGoogleCredential(credentialJson), fetcher, config.requestTimeoutMs ?? 60_000, config.maxResponseBytes ?? 2 * 1024 * 1024);
  const q = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const sheetRange = (suffix: string) => encodeURIComponent(`'${config.sheetName.replace(/'/g, "''")}'!${suffix}`);
  const spreadsheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheetId)}?fields=sheets.properties(sheetId,title)`;
  const findConfiguredSheet = async (): Promise<{ sheetId?: number; title?: string } | undefined> => {
    const spreadsheet = await client.json<{ sheets?: Array<{ properties?: { sheetId?: number; title?: string } }> }>(spreadsheetUrl);
    return spreadsheet.sheets?.find((candidate) => candidate.properties?.title === config.sheetName)?.properties;
  };
  const isConcurrentAddConflict = (error: unknown): boolean => error instanceof GoogleHttpError && error.status === 400 && /already\s+exists|duplicate|already.*exist/i.test(error.detail);
  const drive: DriveAdapter = {
    async generateId() { const result = await client.json<{ ids?: string[] }>("https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive"); if (!result.ids?.[0]) throw new Error("Google Drive generateIds response missing ID"); return result.ids[0]; },
    async getFile(id) { try { const result = await client.json<{ id: string; webViewLink?: string; appProperties?: Record<string, string> }>(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,webViewLink,appProperties`); return result.webViewLink ? { id: result.id, webLink: result.webViewLink, appProperties: result.appProperties ?? {} } : null; } catch (error) { if (error instanceof GoogleHttpError && error.status === 404) return null; throw error; } },
    async findFolder(parentId, name) {
      const query = encodeURIComponent(`'${q(parentId)}' in parents and name = '${q(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
      const result = await client.json<{ files?: Array<{ id: string }> }>(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)&pageSize=1`);
      return result.files?.[0] ?? null;
    },
    async createFolder(parentId, name) {
      return await client.json<{ id: string }>("https://www.googleapis.com/drive/v3/files?fields=id", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }) });
    },
    async createFolderWithId(input) { return await client.json<{ id: string }>("https://www.googleapis.com/drive/v3/files?fields=id", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: input.id, name: input.name, mimeType: "application/vnd.google-apps.folder", parents: [input.parentId] }) }); },
    async findFilesByBillId(billId) {
      const query = encodeURIComponent(`appProperties has { key='billId' and value='${q(billId)}' } and trashed = false`);
      const result = await client.json<{ files?: Array<{ id: string; webViewLink?: string; appProperties?: Record<string, string> }> }>(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,webViewLink,appProperties)&pageSize=100`);
      return (result.files ?? []).map((file) => {
        if (!file.webViewLink) throw new Error("Google Drive response missing webViewLink");
        return { id: file.id, webLink: file.webViewLink, appProperties: file.appProperties ?? {} };
      });
    },
    async uploadOriginal(input: { id?: string; parentId: string; name: string; mimeType: string; bytes: Uint8Array; billId: string; contentSha256: string }) {
      const boundary = `bill-${crypto.randomUUID()}`;
      const metadata = JSON.stringify({ ...(input.id ? { id: input.id } : {}), name: input.name, parents: [input.parentId], appProperties: { billId: input.billId, contentSha256: input.contentSha256 } });
      if (!/^(application\/pdf|image\/(jpeg|png|webp))$/.test(input.mimeType)) throw new Error("Google input failure: unsupported MIME type");
      const prefix = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`;
      const suffix = `\r\n--${boundary}--`;
      const body = new Blob([prefix, new Uint8Array(input.bytes).buffer, suffix], { type: `multipart/related; boundary=${boundary}` });
      const result = await client.json<{ id: string; webViewLink?: string; appProperties?: Record<string, string> }>("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,appProperties", { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body });
      if (!result.webViewLink) throw new Error("Google Drive response missing webViewLink");
      return { id: result.id, webLink: result.webViewLink, appProperties: result.appProperties ?? {} };
    },
    async uploadOriginalWithId(input) { return drive.uploadOriginal({ ...input }); },
  };
  const sheets: SheetsAdapter = {
    async initializeLedger() {
      let sheet = await findConfiguredSheet();
      if (sheet?.sheetId === undefined) {
        try {
          const created = await client.json<{ replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }> }>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheetId)}:batchUpdate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: config.sheetName } } }] }) });
          sheet = { sheetId: created.replies?.[0]?.addSheet?.properties?.sheetId };
        } catch (error) {
          if (!isConcurrentAddConflict(error)) throw error;
          sheet = await findConfiguredSheet();
          if (sheet?.sheetId === undefined) throw error;
        }
      }
      if (sheet.sheetId === undefined) throw new Error("Google Sheets initialization response missing sheet ID");
      const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheetId)}/values/${sheetRange("A1:O1")}`;
      const current = await client.json<{ values?: string[][] }>(headerUrl);
      const existing = current.values?.[0] ?? [];
      if (existing.length === 0) {
        await client.empty(`${headerUrl}?valueInputOption=RAW`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: [ledgerHeaders] }) });
      } else if (ledgerHeaders.some((header, index) => existing[index] !== header)) {
        throw new Error("Google Sheets ledger headers do not match required columns");
      }
      await client.empty(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheetId)}:batchUpdate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests: [{ updateDimensionProperties: { range: { sheetId: sheet.sheetId, dimension: "COLUMNS", startIndex: 13, endIndex: 15 }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } }] }) });
    },
    async findRowByBillId(billId) {
      const result = await client.json<{ values?: string[][] }>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheetId)}/values/${sheetRange("N:N")}`);
      const index = result.values?.findIndex((row) => row[0] === billId) ?? -1;
      return index < 0 ? null : index + 1;
    },
    async findRowsByBillId(billId) {
      const result = await client.json<{ values?: string[][] }>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheetId)}/values/${sheetRange("N:N")}`);
      return (result.values ?? []).flatMap((row, index) => row[0] === billId ? [index + 1] : []);
    },
    async findLedgerRows(billId) {
      const result = await client.json<{ values?: string[][] }>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheetId)}/values/${sheetRange("N:O")}`);
      return (result.values ?? []).flatMap((value, index) => value[0] === billId ? [{ row: index + 1, revision: Number.isInteger(Number(value[1])) ? Number(value[1]) : null }] : []);
    },
    async clearRows(rows) {
      for (const row of [...rows].sort((a, b) => b - a)) await client.empty(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheetId)}/values/${sheetRange(`A${row}:O${row}`)}:clear`, { method: "POST" });
    },
    async appendRow(values) {
      const result = await client.json<{ updates?: { updatedRange?: string } }>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheetId)}/values/${sheetRange("A:O")}:append?valueInputOption=RAW`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: [values] }) });
      const row = /!(?:[A-Z]+)(\d+):/.exec(result.updates?.updatedRange ?? "")?.[1];
      if (!row) throw new Error("Google Sheets append response missing row");
      return Number(row);
    },
    async updateRow(row, values) {
      await client.empty(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheetId)}/values/${sheetRange(`A${row}:O${row}`)}?valueInputOption=RAW`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: [values] }) });
    },
  };
  return { drive, sheets };
}

export class GooglePermanentError extends PermanentJobError {}

function sanitizeFilename(filename: string | null): string {
  const raw = basename(filename ?? "original").replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").trim();
  return raw || "original";
}
function monthPath(receivedAt: string): [string, string] {
  const date = new Date(receivedAt);
  if (Number.isNaN(date.getTime())) throw new GooglePermanentError("Google input failure: invalid received date");
  return [String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0")];
}
async function ensureFolder(database: BillDatabase, drive: DriveAdapter, parentId: string, logicalPath: string, name: string): Promise<string> {
  if (drive.generateId && drive.getFile && drive.createFolderWithId) {
    let reservation = database.getDriveReservation(`folder:${logicalPath}`);
    if (!reservation) reservation = database.reserveDriveId({ key: `folder:${logicalPath}`, kind: "folder", parentId, logicalPath, generatedId: await drive.generateId() });
    const existingById = await drive.getFile(reservation.drive_id);
    if (existingById) { database.confirmDriveReservation(reservation.reservation_key); return reservation.drive_id; }
    const created = await drive.createFolderWithId({ id: reservation.drive_id, parentId, name });
    database.confirmDriveReservation(reservation.reservation_key);
    return created.id;
  }
  const found = await drive.findFolder(parentId, name);
  return found ? found.id : (await drive.createFolder(parentId, name)).id;
}
function googleFailure(error: unknown): Error {
  if (error instanceof GooglePermanentError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Google temporary failure")) return new Error("Google temporary failure");
  const code = /(?:HTTP\s*)?(408|409|429|5\d\d)\b/.exec(message)?.[1];
  if (code || /timeout|response too large|network|fetch failed|ECONN|ETIMEDOUT/i.test(message)) return new Error(`Google temporary failure${code ? ` HTTP ${code}` : ""}`);
  const permanent = /(?:HTTP\s*)?(400|401|403|404|422)\b/.exec(message)?.[1];
  return new GooglePermanentError(`Google permanent failure${permanent ? ` HTTP ${permanent}` : ""}`);
}
function confidenceSummary(extraction: ExtractedBill): string {
  const values = Object.values(extraction.fields).map((field) => field.confidence).filter(Number.isFinite);
  if (!values.length) return "unknown";
  return `${(values.reduce((sum, value) => sum + value, 0) / values.length * 100).toFixed(0)}%`;
}
/** Plain strings are intentionally sent with Sheets RAW semantics by the production adapter. */
export function ledgerValues(bill: Bill, extraction: ExtractedBill, driveUrl: string): (string | number | null)[] {
  return [
    bill.receivedAt.slice(0, 10), extraction.vendorName, extraction.invoiceNumber, extraction.invoiceDate,
    extraction.subtotal, extraction.vat, extraction.total, extraction.currency, extraction.description,
    bill.whatsappSenderId, confidenceSummary(extraction), bill.status, driveUrl, bill.id, bill.contentRevision,
  ];
}

export function createDriveArchiveHandler(database: BillDatabase, drive: DriveAdapter, config: Pick<GoogleProjectionConfig, "driveRootId"> & { originalsRoot?: string; maxOriginalBytes?: number }): JobHandler {
  return async (job: ClaimedJob, context: JobHandlerContext): Promise<void> => {
    try {
      const bill = database.getBill(job.billId);
      if (!bill) throw new GooglePermanentError("Google input failure: bill missing");
      context.assertLease();
      const persisted = database.getProjectionMetadata("drive", bill.id);
      if (persisted?.externalId && persisted.externalUrl) return;
      const existing = await drive.findFilesByBillId(bill.id);
      const match = existing.find((file) => file.appProperties.contentSha256 === bill.contentSha256);
      if (existing.some((file) => file.appProperties.contentSha256 !== bill.contentSha256)) throw new GooglePermanentError("Google conflict: bill ID belongs to a different content hash");
      let archived = match;
      if (!archived) {
        const [year, month] = monthPath(bill.receivedAt);
        const bills = await ensureFolder(database, drive, config.driveRootId, "Bills", "Bills");
        const yearFolder = await ensureFolder(database, drive, bills, `Bills/${year}`, year);
        const monthFolder = await ensureFolder(database, drive, yearFolder, `Bills/${year}/${month}`, month);
        context.assertLease();
         const bytes = (await readVerifiedOriginal({ path: bill.originalPath, root: config.originalsRoot ?? dirname(bill.originalPath), maxBytes: config.maxOriginalBytes ?? 20 * 1024 * 1024, sha256: bill.contentSha256, mimeType: bill.mimeType, requireMagic: true })).bytes;
        if (drive.generateId && drive.getFile && drive.uploadOriginalWithId) {
          let reservation = database.getDriveReservation(`file:${bill.id}`);
          if (!reservation) reservation = database.reserveDriveId({ key: `file:${bill.id}`, kind: "file", parentId: monthFolder, logicalPath: `file:${bill.id}`, generatedId: await drive.generateId(), billId: bill.id, contentSha256: bill.contentSha256 });
          archived = (await drive.getFile(reservation.drive_id)) ?? undefined;
          if (!archived) archived = await drive.uploadOriginalWithId({ id: reservation.drive_id, parentId: monthFolder, name: `${bill.id}-${sanitizeFilename(bill.originalFilename)}`, mimeType: bill.mimeType, bytes, billId: bill.id, contentSha256: bill.contentSha256 });
          database.confirmDriveReservation(reservation.reservation_key);
        } else archived = await drive.uploadOriginal({ parentId: monthFolder, name: `${bill.id}-${sanitizeFilename(bill.originalFilename)}`, mimeType: bill.mimeType, bytes, billId: bill.id, contentSha256: bill.contentSha256 });
      }
      context.assertLease();
      if (!database.persistDriveArchive({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, contentSha256: bill.contentSha256, fileId: archived.id, webLink: archived.webLink })) throw new Error("Job lease is no longer owned");
    } catch (error) { throw googleFailure(error); }
  };
}

export function createSheetsProjectionHandler(database: BillDatabase, sheets: SheetsAdapter): JobHandler {
  // A process may die after a Sheets mutation and before SQLite persistence; retries re-find bill.id
  // and collapse duplicate rows. A revision change after the provider mutation is still reconciled by
  // the newer revision job; no cross-system transaction can eliminate that crash window.
  return async (job: ClaimedJob, context: JobHandlerContext): Promise<void> => {
    try {
      if (job.expectedRevision === null) throw new GooglePermanentError("Google input failure: missing projection revision");
      const bill = database.getBill(job.billId);
       const extraction = database.getEffectiveExtraction(job.billId);
      const drive = database.getProjectionMetadata("drive", job.billId);
       if (!bill || !extraction) throw new GooglePermanentError("Google input failure: bill projection data missing");
      if (!drive?.externalUrl) throw new Error("Google temporary failure: Drive archive pending");
      context.assertLease(); context.assertCurrentApprovalRevision();
       const values = ledgerValues(bill, extraction, drive.externalUrl);
      await sheets.initializeLedger();
      context.assertLease(); context.assertCurrentApprovalRevision();
      const matched = sheets.findLedgerRows ? await sheets.findLedgerRows(bill.id) : (sheets.findRowsByBillId ? (await sheets.findRowsByBillId(bill.id)).map((row) => ({ row, revision: null })) : []);
       const rows = matched.map((item) => item.row);
       // Prefer an existing current-revision row; otherwise deterministically update the first row.
       const row = matched.filter((item) => item.revision === job.expectedRevision).sort((a, b) => a.row - b.row)[0]?.row ?? rows.sort((a, b) => a - b)[0] ?? await sheets.findRowByBillId(bill.id);
      const reconcileStale = async (): Promise<void> => {
        if (!sheets.findLedgerRows || !sheets.clearRows) return;
        const current = await sheets.findLedgerRows(bill.id);
        await sheets.clearRows(current.filter((item) => item.revision === job.expectedRevision).map((item) => item.row));
      };
      context.assertLease(); context.assertCurrentApprovalRevision();
      if (row === null) {
        const appended = await sheets.appendRow(values);
        const reconciled = sheets.findLedgerRows ? await sheets.findLedgerRows(bill.id) : (sheets.findRowsByBillId ? (await sheets.findRowsByBillId(bill.id)).map((row) => ({ row, revision: null })) : [{ row: appended, revision: job.expectedRevision }]);
        const canonical = reconciled[0]?.row ?? appended;
         if (sheets.clearRows && reconciled.length > 1) await sheets.clearRows(reconciled.filter((item) => item.row !== canonical).map((item) => item.row).sort((a, b) => b - a));
        try { context.assertLease(); context.assertCurrentApprovalRevision(); } catch (error) { await reconcileStale(); throw error; }
        if (!database.persistSheetProjection({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, expectedRevision: job.expectedRevision, rowKey: String(canonical) })) { await reconcileStale(); throw new Error("Job lease is no longer owned or projection revision changed"); }
      } else {
        await sheets.updateRow(row, values);
         if (sheets.clearRows && matched.length > 1) await sheets.clearRows(matched.filter((item) => item.row !== row).map((item) => item.row).sort((a, b) => b - a));
        try { context.assertLease(); context.assertCurrentApprovalRevision(); } catch (error) { await reconcileStale(); throw error; }
        if (!database.persistSheetProjection({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, expectedRevision: job.expectedRevision, rowKey: String(row) })) { await reconcileStale(); throw new Error("Job lease is no longer owned or projection revision changed"); }
      }
    } catch (error) { throw googleFailure(error); }
  };
}

/** Rejection reconciliation has no ledger row; it only removes all rows carrying the immutable bill ID. */
export function createReviewCorrectionSyncHandler(database: BillDatabase, sheets: SheetsAdapter): JobHandler {
  return async (job, context) => {
    try {
      const bill = database.getBill(job.billId);
      if (!bill) throw new GooglePermanentError("Google input failure: bill missing");
      context.assertLease();
      if (bill.status === "approved") {
        // A replayed correction-sync job converges on the same revision-specific hidden-ID upsert.
        return createSheetsProjectionHandler(database, sheets)({ ...job, expectedRevision: bill.contentRevision }, context);
      }
      if (!database.isFailedAtReviewRevision(bill.id, job.expectedRevision)) return;
      await sheets.initializeLedger();
      context.assertLease(); if (!database.isFailedAtReviewRevision(bill.id, job.expectedRevision)) return;
      const found = sheets.findRowsByBillId ? await sheets.findRowsByBillId(bill.id) : await sheets.findRowByBillId(bill.id);
      const rows: number[] = Array.isArray(found) ? found : found === null ? [] : [found];
      if (rows.length && sheets.clearRows) await sheets.clearRows([...rows].sort((a, b) => b - a));
      // Legacy adapters lacking clearRows cannot safely delete rows; fail visibly rather than append.
      else if (rows.length) throw new GooglePermanentError("Google input failure: Sheets adapter cannot remove review row");
      // The clear cannot be transactional with SQLite. If reapproval raced it, durably restore
      // the approved revision; its hidden-ID upsert is idempotent.
      if (!database.isFailedAtReviewRevision(bill.id, job.expectedRevision)) database.enqueueProjectionRepair(job.id, bill.id);
    } catch (error) { throw googleFailure(error); }
  };
}
