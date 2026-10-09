import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { Bill, JobHandler } from "./contracts";
import type { BillDatabase } from "../db/database";
import type { ZohoCredential } from "./zoho-oauth";
import { ledgerHeaders, ledgerValues } from "./google-projections";
import { readVerifiedOriginal } from "./originals";
import { PermanentJobError } from "./worker";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ObjectValue = Record<string, unknown>;
export interface WorkDriveFile { id: string; name: string; parentId: string; size: number; permalink: string; }
export interface WorkDriveAdapter {
  list(folderId: string, offset: number): Promise<Array<{ id: string; name: string }>>;
  metadata(id: string): Promise<WorkDriveFile>;
  download(id: string, maxBytes: number): Promise<Uint8Array>;
  uploadOnce(input: { folderId: string; name: string; mimeType: string; bytes: Uint8Array }): Promise<string | null>;
}
export type ZohoRecord = Record<string, string | number>;
export interface ZohoSheetAdapter {
  initializeLedger(): Promise<void>;
  find(billId: string): Promise<ZohoRecord[]>;
  addOnce(record: ZohoRecord): Promise<void>;
  update(billId: string, observedRevision: number, record: ZohoRecord): Promise<number>;
}
export interface ZohoProjectionConfig { region: "sa"; workdriveFolderId: string; sheetResourceId: string; sheetName: string; requestTimeoutMs?: number; maxResponseBytes?: number; }
export const zohoLedgerHeaders = ledgerHeaders.map((header) => header === "Drive hyperlink" ? "WorkDrive hyperlink" : header);
function object(value: unknown): ObjectValue { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Zoho malformed provider output"); return value as ObjectValue; }
function jsonObject(bytes: Uint8Array): ObjectValue { try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch { throw new Error("Zoho malformed provider output"); } }
function string(value: unknown): string { if (typeof value !== "string" || !value || value.length > 8192) throw new Error("Zoho malformed provider output"); return value; }
function resourceId(value: unknown): string { const id = string(value); if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new Error("Zoho malformed resource ID"); return id; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Zoho malformed provider output"); return value; }
function permalink(value: unknown): string {
  const text = string(value); let url: URL;
  try { url = new URL(text); } catch { throw new Error("Zoho malformed permalink"); }
  if (url.protocol !== "https:" || url.hostname !== "workdrive.zoho.sa" || url.port || url.username || url.password || url.pathname === "/") throw new PermanentJobError("Zoho unexpected private permalink");
  return text;
}
export function readZohoCredential(json: string): ZohoCredential {
  try {
    const value = object(JSON.parse(json));
    if (value.token_uri !== "https://accounts.zoho.sa/oauth/v2/token" || value.api_domain !== "https://www.zohoapis.sa") throw new Error();
    const credentials = [value.client_id, value.client_secret, value.refresh_token].map(string);
    if (credentials.some((item) => /\s/.test(item))) throw new Error();
    return { client_id: credentials[0]!, client_secret: credentials[1]!, refresh_token: credentials[2]!, token_uri: value.token_uri, api_domain: value.api_domain };
  } catch { throw new PermanentJobError("Zoho invalid Saudi OAuth credential"); }
}
class ZohoHttpError extends Error {
  constructor(readonly status: number, readonly code: number = 0) { super(`Zoho HTTP ${status} code ${code}`); }
}
class ZohoUnresolvedMutationError extends Error { constructor() { super("Zoho mutation unresolved; reconcile only"); } }
function failure(error: unknown): Error {
  if (error instanceof PermanentJobError) return error;
  if (error instanceof ZohoUnresolvedMutationError) return error;
  if (error instanceof ZohoHttpError) {
    const temporary = error.status === 408 || error.status === 429 || error.status >= 500 || [2950, 2873, 2866, 2401].includes(error.code);
    return temporary ? new Error(error.message) : new PermanentJobError(error.message);
  }
  return new Error("Zoho temporary failure");
}
class ZohoClient {
  private token: { value: string; expiresAt: number } | null = null;
  private sheetCooldownUntil = 0;
  constructor(private readonly credential: ZohoCredential, private readonly fetcher: Fetcher, private readonly timeoutMs: number, private readonly maxResponseBytes: number) {}
  private async request(url: string, init: RequestInit, maxBytes: number): Promise<{ bytes: Uint8Array; status: number }> {
    const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let abort!: () => void;
    const timeout = new Promise<never>((_, reject) => { abort = () => { controller.abort(); reject(new Error("Zoho timeout")); }; });
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const response = await Promise.race([this.fetcher(url, { ...init, redirect: "error", signal: controller.signal }), timeout]);
      if (Number(response.headers.get("content-length")) > maxBytes) { void response.body?.cancel(); throw new Error("Zoho response too large"); }
      reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) for (;;) {
        const next = await Promise.race([reader.read(), timeout]); if (next.done) break;
        size += next.value.byteLength; if (size > maxBytes) throw new Error("Zoho response too large"); chunks.push(next.value);
      }
      return { bytes: Buffer.concat(chunks), status: response.status };
    } catch { throw new Error("Zoho bounded request failed"); }
    finally { clearTimeout(timer); controller.abort(); if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
  }
  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    this.token = null;
    const response = await this.request(this.credential.token_uri, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.credential.client_id, client_secret: this.credential.client_secret, refresh_token: this.credential.refresh_token }) }, this.maxResponseBytes);
    if (response.status !== 200) throw new ZohoHttpError(response.status);
    const value = jsonObject(response.bytes);
    if (value.error !== undefined || (value.api_domain !== undefined && value.api_domain !== this.credential.api_domain)) throw new PermanentJobError("Zoho OAuth refresh rejected");
    const token = string(value.access_token); const expires = integer(value.expires_in);
    if (!expires || expires > 86400 || /\s/.test(token)) throw new Error("Zoho malformed token response");
    this.token = { value: token, expiresAt: Date.now() + expires * 1000 }; return token;
  }
  async bytes(url: string, init: RequestInit = {}, read = true, maxBytes = this.maxResponseBytes): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const result = await this.request(url, { ...init, headers: { ...init.headers, Authorization: `Zoho-oauthtoken ${token}` } }, maxBytes);
      if (result.status === 401) { this.token = null; if (read && attempt === 0) { await this.accessToken(true); continue; } }
      if (result.status < 200 || result.status >= 300) throw new ZohoHttpError(result.status);
      return result.bytes;
    }
  }
  async json(url: string, init: RequestInit = {}, read = true): Promise<ObjectValue> {
    const bytes = await this.bytes(url, init, read); return bytes.length ? jsonObject(bytes) : {};
  }
  async sheet(resource: string, worksheet: string, method: string, params: Record<string, string> = {}, read = false): Promise<ObjectValue> {
    if (Date.now() < this.sheetCooldownUntil) throw new ZohoHttpError(429, 2950);
    for (let attempt = 0; ; attempt++) {
      let result: ObjectValue;
      try {
        result = await this.json(`https://sheet.zoho.sa/api/v2/${resourceId(resource)}`, { method: "POST", body: new URLSearchParams({ method, worksheet_name: worksheet, ...params }) }, false);
      } catch (error) {
        if (error instanceof ZohoHttpError && error.status === 429) this.sheetCooldownUntil = Date.now() + 300_000;
        if (error instanceof ZohoHttpError && error.status === 401 && read && attempt === 0) { await this.accessToken(true); continue; }
        throw error;
      }
      if (result.status === "success" && result.method === method) return result;
      const code = Number(result.error_code);
      if (!Number.isSafeInteger(code)) throw new Error("Zoho malformed Sheet result");
      if (code === 2950) this.sheetCooldownUntil = Date.now() + 300_000;
      if (code === 2401) { this.token = null; if (read && attempt === 0) { await this.accessToken(true); continue; } }
      throw new ZohoHttpError(200, code);
    }
  }
}
function normalizeFile(value: unknown): WorkDriveFile {
  const data = object(value); const attributes = object(data.attributes); const storage = object(attributes.storage_info);
  if (attributes.is_folder !== false) throw new Error("Zoho candidate is not a file");
  return { id: resourceId(data.id), name: string(attributes.name), parentId: resourceId(attributes.parent_id), size: integer(storage.size_in_bytes), permalink: permalink(attributes.permalink) };
}
/** Only regional allowlisted URLs are constructed; provider download URLs are never followed. */
export function createZohoAdapters(credentialJson: string, config: ZohoProjectionConfig, fetcher: Fetcher = fetch): { workdrive: WorkDriveAdapter; sheet: ZohoSheetAdapter } {
  if (config.region !== "sa") throw new PermanentJobError("Zoho unsupported region");
  const client = new ZohoClient(readZohoCredential(credentialJson), fetcher, config.requestTimeoutMs ?? 60_000, config.maxResponseBytes ?? 2 * 1024 * 1024);
  resourceId(config.workdriveFolderId); resourceId(config.sheetResourceId);
  const api = "https://www.zohoapis.sa/workdrive/api/v1";
  const workdrive: WorkDriveAdapter = {
    async list(folderId, offset) {
      const query = new URLSearchParams({ "filter[type]": "allfiles", "page[offset]": String(offset), "page[limit]": "50", sort: "name" });
      const result = await client.json(`${api}/files/${resourceId(folderId)}/files?${query}`);
      if (!Object.keys(result).length) return [];
      if (!Array.isArray(result.data) || result.data.length > 50) throw new Error("Zoho malformed folder page");
      return result.data.map((entry: unknown) => { const data = object(entry); const attributes = object(data.attributes); return { id: resourceId(data.id), name: string(attributes.name) }; });
    },
    async metadata(id) { return normalizeFile((await client.json(`${api}/files/${resourceId(id)}`)).data); },
    async download(id, maxBytes) { return client.bytes(`https://files.zoho.sa/v1/workdrive/download/${resourceId(id)}`, {}, true, maxBytes); },
    async uploadOnce(input) {
      const form = new FormData(); form.set("parent_id", resourceId(input.folderId)); form.set("filename", encodeURIComponent(input.name)); form.set("override-name-exist", "false");
      form.set("content", new Blob([new Uint8Array(input.bytes).buffer], { type: input.mimeType }), input.name);
      const result = await client.json(`${api}/upload`, { method: "POST", body: form }, false);
      const entry = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!entry || typeof entry !== "object") return null;
      const data = object(entry); const attributes = data.attributes && typeof data.attributes === "object" ? object(data.attributes) : {};
      const id = data.id ?? attributes.resource_id;
      if (id !== undefined) return resourceId(id);
      if (typeof attributes["File INFO"] === "string" && attributes["File INFO"].length <= 8192) {
        try { return resourceId(object(JSON.parse(attributes["File INFO"])).RESOURCE_ID); } catch { return null; }
      }
      return null;
    },
  };
  const call = (method: string, params: Record<string, string> = {}, read = false) => client.sheet(config.sheetResourceId, config.sheetName, method, params, read);
  const criteria = (billId: string) => `"Bill ID"="${resourceId(billId)}"`;
  const sheet: ZohoSheetAdapter = {
    async initializeLedger() {
      // Require a precreated worksheet: no ambiguous non-idempotent worksheet creation.
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await call("worksheet.content.get", { start_row: "1", end_row: "1", start_column: "1", end_column: "15", visible_rows_only: "false", visible_columns_only: "false" }, true);
        if (!Array.isArray(result.range_details)) throw new Error("Zoho malformed header response");
        const headers: unknown[] = Array(15).fill("");
        for (const entry of result.range_details) {
          const row = object(entry); if (row.row_index !== 1 || !Array.isArray(row.row_details)) throw new Error("Zoho malformed header response");
          for (const entry of row.row_details) { const cell = object(entry); const column = integer(cell.column_index); if (column < 1 || column > 15 || typeof cell.content !== "string" || Object.keys(cell).some((key) => !["column_index", "content"].includes(key))) throw new Error("Zoho malformed header response"); headers[column - 1] = cell.content; }
        }
        if (headers.every((value) => value === "")) {
          if (attempt > 0) throw new Error("Zoho header initialization not confirmed");
          const usedRow = integer(result.used_row); const usedColumn = integer(result.used_column);
          if (usedRow > 0 || usedColumn > 0) {
            if (usedRow !== 1 || usedColumn !== 1 || result.range_details.length !== 0 || Object.keys(result).some((key) => !["method", "status", "range_details", "used_row", "used_column"].includes(key))) throw new PermanentJobError("Zoho nonempty worksheet has no ledger headers");
            // Saudi blank worksheets report a 1x1 used range; verify A1 before writing.
            const cell = await call("cell.content.get", { row: "1", column: "1" }, true);
            if (cell.row_index !== 1 || cell.columnIndex !== 1 || cell.content !== "" || Object.keys(cell).some((key) => !["method", "status", "row_index", "columnIndex", "content"].includes(key))) throw new PermanentJobError("Zoho blank worksheet evidence not confirmed; existing cells preserved");
          }
          await call("row.content.set", { row: "1", column_array: JSON.stringify(zohoLedgerHeaders.map((_, index) => index + 1)), data_array: JSON.stringify(zohoLedgerHeaders) });
          continue;
        }
        if (zohoLedgerHeaders.some((header, index) => headers[index] !== header) || integer(result.used_column) > 15) throw new PermanentJobError("Zoho ledger headers do not match; existing cells preserved");
        return;
      }
    },
    async find(billId) {
      const records: ZohoRecord[] = [];
      for (let start = 1; start <= 100_000; start += 1000) {
        const result = await call("worksheet.records.fetch", { header_row: "1", criteria: criteria(billId), is_case_sensitive: "true", render_option: "unformatted", records_start_index: String(start), count: "1000" }, true);
        if (!Array.isArray(result.records) || result.records.length > 1000) throw new Error("Zoho malformed records response");
        for (const entry of result.records) {
          const record = object(entry); if (record["Bill ID"] !== billId) throw new Error("Zoho mismatched Bill ID"); integer(record.Revision);
          if (zohoLedgerHeaders.some((key) => typeof record[key] !== "string" && typeof record[key] !== "number")) throw new Error("Zoho malformed ledger record");
          records.push(Object.fromEntries(zohoLedgerHeaders.map((key) => [key, record[key]])) as ZohoRecord);
        }
        if (result.records.length < 1000) return records;
      }
      throw new Error("Zoho record pagination bound exceeded");
    },
    async addOnce(record) { await call("worksheet.records.add", { header_row: "1", json_data: JSON.stringify([encodeRecord(record)]) }); },
    async update(billId, revision, record) {
      const result = await call("worksheet.records.update", { header_row: "1", criteria: `${criteria(billId)} and "Revision"=${integer(revision)}`, is_case_sensitive: "true", first_match_only: "false", data: JSON.stringify(encodeRecord(record)) });
      return integer(result.no_of_affected_rows);
    },
  };
  return { workdrive, sheet };
}
/** Generated constant-string formulas quote all text; OCR text never becomes executable formula syntax. */
export function encodeRecord(record: ZohoRecord): ZohoRecord {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => {
    if (typeof value !== "string") return [key, value];
    const literal = value.replace(/"/g, '""');
    if (key === "WorkDrive hyperlink" && value) { permalink(value); return [key, `=HYPERLINK("${literal}","${literal}")`]; }
    return [key, `="${literal}"`];
  }));
}
function sameRecord(actual: ZohoRecord, expected: ZohoRecord): boolean { return zohoLedgerHeaders.every((key) => actual[key] === expected[key]); }
function current(database: BillDatabase, bill: Bill): boolean { const latest = database.getBill(bill.id); return latest?.contentRevision === bill.contentRevision && latest.status === bill.status; }
function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

export function createWorkDriveArchiveHandler(database: BillDatabase, adapter: WorkDriveAdapter, config: ZohoProjectionConfig & { originalsRoot?: string; maxOriginalBytes?: number }): JobHandler {
  return async (job, context) => {
    try {
      const bill = database.getBill(job.billId);
      if (!bill || !database.isZohoEnrolled(bill.id) || !database.isDriveArchiveAllowed(bill.id)) throw new PermanentJobError("Zoho archival not enrolled or suppressed");
      context.assertLease();
      const persisted = database.getProjectionMetadata("workdrive", bill.id);
      if (persisted?.externalUrl) {
        if (!persisted.metadata || object(JSON.parse(persisted.metadata)).folderId !== config.workdriveFolderId) throw new PermanentJobError("Zoho archive destination changed");
        return;
      }
      const bytes = (await readVerifiedOriginal({ path: bill.originalPath, root: config.originalsRoot ?? dirname(bill.originalPath), maxBytes: config.maxOriginalBytes ?? 20 * 1024 * 1024, sha256: bill.contentSha256, mimeType: bill.mimeType, requireMagic: true })).bytes;
      const extension = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[bill.mimeType];
      if (!extension) throw new PermanentJobError("Zoho unsupported original type");
      const identity = { folderId: config.workdriveFolderId, name: `${bill.id}-${bill.contentSha256}.${extension}`, hash: bill.contentSha256, size: bytes.byteLength };
      const intent = database.getZohoIntent(bill.id, "upload");
      if (intent && intent.identity_json !== JSON.stringify(identity)) throw new PermanentJobError("Zoho upload destination or identity changed");
      const verify = async (id: string): Promise<WorkDriveFile> => {
        const file = await adapter.metadata(id); context.assertLease();
        if (file.id !== id || file.parentId !== identity.folderId || !file.name.includes(`${bill.id}-${bill.contentSha256}`) || file.size !== bytes.byteLength) throw new PermanentJobError("Zoho archive identity conflict");
        permalink(file.permalink);
        const remote = await adapter.download(id, bytes.byteLength); context.assertLease();
        if (remote.byteLength !== bytes.byteLength || hash(remote) !== bill.contentSha256) throw new PermanentJobError("Zoho archive checksum conflict");
        return file;
      };
      const discover = async (): Promise<WorkDriveFile | null> => {
        const matches: WorkDriveFile[] = []; const seen = new Set<string>();
        for (let offset = 0; offset <= 100_000; offset += 50) {
          const page = await adapter.list(identity.folderId, offset); context.assertLease();
          if (page.length > 50) throw new Error("Zoho malformed folder page");
          for (const candidate of page) if (candidate.name.includes(`${bill.id}-${bill.contentSha256}`)) {
            if (seen.has(candidate.id)) throw new Error("Zoho inconsistent folder pagination"); seen.add(candidate.id); matches.push(await verify(candidate.id));
          }
          if (page.length < 50) { if (matches.length > 1) throw new PermanentJobError("Zoho duplicate archive candidates require operator reconciliation"); return matches[0] ?? null; }
        }
        throw new Error("Zoho folder pagination bound exceeded");
      };
      let archived = await discover();
      if (!archived) {
        context.assertLease();
        if (intent || !database.beginZohoMutation(job, "upload", identity, bill.contentRevision, bill.status)) throw new ZohoUnresolvedMutationError();
        context.assertLease();
        const id = await adapter.uploadOnce({ folderId: identity.folderId, name: identity.name, mimeType: bill.mimeType, bytes });
        context.assertLease();
        archived = id ? await verify(id) : await discover();
        if (!archived) throw new ZohoUnresolvedMutationError();
      }
      if (!database.persistZohoProjection(job, "workdrive", bill.contentRevision, bill.status, archived.id, archived.permalink, identity)) throw new Error("Zoho archive lease lost");
    } catch (error) { throw failure(error); }
  };
}

/** Every replay reads current canonical state, including rejection tombstones. No append replay. */
export function createZohoSheetHandler(database: BillDatabase, adapter: ZohoSheetAdapter, config: ZohoProjectionConfig): JobHandler {
  return async (job, context) => {
    let mutated = false; let snapshot: Bill | null = null;
    try {
      const bill = database.getBill(job.billId); snapshot = bill;
      if (!bill || !database.isZohoEnrolled(bill.id)) throw new PermanentJobError("Zoho bill not enrolled");
      context.assertLease();
      const assertCurrent = () => { context.assertLease(); if (!current(database, bill)) throw new Error("Zoho canonical revision changed"); };
      const extraction = database.getEffectiveExtraction(bill.id); const archive = database.getProjectionMetadata("workdrive", bill.id);
      if (!extraction || !archive?.externalUrl) throw new Error("Zoho verified archive pending");
      const values = ledgerValues(bill, extraction, permalink(archive.externalUrl)).map((value) => value ?? "");
      values[11] = bill.status === "approved" ? "Approved" : "Rejected";
      const record = Object.fromEntries(zohoLedgerHeaders.map((key, index) => [key, values[index]!])) as ZohoRecord;
      const destination = { resourceId: config.sheetResourceId, worksheet: config.sheetName };
      const persisted = database.getProjectionMetadata("zoho_sheet", bill.id);
      if (persisted?.metadata) { const previous = object(JSON.parse(persisted.metadata)); if (previous.resourceId !== destination.resourceId || previous.worksheet !== destination.worksheet) throw new PermanentJobError("Zoho Sheet destination changed"); }
      const intent = database.getZohoIntent(bill.id, "append");
      if (intent && intent.identity_json !== JSON.stringify(destination)) throw new PermanentJobError("Zoho Sheet destination changed");
      await adapter.initializeLedger(); assertCurrent();
      let rows = await adapter.find(bill.id); assertCurrent();
      if (rows.length > 1) throw new PermanentJobError("Zoho duplicate Bill ID rows require operator reconciliation");
      const row = rows[0];
      if (!row) {
        if (intent) throw new ZohoUnresolvedMutationError();
        if (bill.status !== "approved") return;
        if (!database.beginZohoMutation(job, "append", destination, bill.contentRevision, bill.status)) throw new ZohoUnresolvedMutationError();
        assertCurrent(); mutated = true; await adapter.addOnce(record);
      } else {
        const remoteRevision = integer(row.Revision);
        if (remoteRevision > bill.contentRevision) throw new PermanentJobError("Zoho remote revision ahead of canonical state");
        if (!sameRecord(row, record)) { assertCurrent(); mutated = true; if (await adapter.update(bill.id, remoteRevision, record) !== 1) throw new Error("Zoho revision update not confirmed"); }
      }
      assertCurrent(); rows = await adapter.find(bill.id); assertCurrent();
      if (rows.length !== 1 || !sameRecord(rows[0]!, record)) throw new Error("Zoho projection not confirmed");
      if (!database.persistZohoProjection(job, "zoho_sheet", bill.contentRevision, bill.status, bill.id, null, { ...destination, revision: bill.contentRevision, status: record.Status })) throw new Error("Zoho projection lease or revision lost");
    } catch (error) {
      // A slow mutation can finish after a newer job. Repair even when this claim has expired.
      const claim = database.getJob(job.id);
      const leaseLost = claim?.leaseToken !== job.leaseToken || !claim.leaseExpiresAt || Date.parse(claim.leaseExpiresAt) <= Date.now();
      if (snapshot && (!current(database, snapshot) || (mutated && leaseLost))) database.enqueueZohoRepair(job);
      throw failure(error);
    }
  };
}
