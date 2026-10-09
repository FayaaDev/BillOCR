import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase } from "../src/db/database";
import { loadConfig } from "../src/backend/config";
import type { ClaimedJob, ExtractedBill, JobHandlerContext } from "../src/backend/contracts";
import { createZohoAdapters, createWorkDriveArchiveHandler, createZohoSheetHandler, encodeRecord, readZohoCredential, zohoLedgerHeaders, type WorkDriveAdapter, type WorkDriveFile, type ZohoRecord, type ZohoSheetAdapter } from "../src/backend/zoho-projections";
import { JobWorker, PermanentJobError } from "../src/backend/worker";
import { createLogger } from "../src/backend/logger";
import { startService } from "../src/backend/server";

const credential = JSON.stringify({ client_id: "client", client_secret: "secret", refresh_token: "refresh", token_uri: "https://accounts.zoho.sa/oauth/v2/token", api_domain: "https://www.zohoapis.sa" });
const config = { region: "sa" as const, workdriveFolderId: "folder", sheetResourceId: "workbook", sheetName: "Ledger" };
const policy = { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 };
const extraction: ExtractedBill = { schemaVersion: "1", vendorName: 'متجر "=SUM(A1)"', invoiceNumber: "000123", invoiceDate: "2026-01-01", currency: "SAR", subtotal: 100, vat: 15, total: 115, description: "=HYPERLINK(\"bad\")", fields: {} };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function context(database: BillDatabase, job: ClaimedJob): JobHandlerContext {
  return { idempotencyKey: job.idempotencyKey, assertLease() { if (!database.renewLease(job.id, job.leaseToken, policy.leaseMs)) throw new Error("lease lost"); }, assertCurrentApprovalRevision() {} };
}
function fixture(enabled = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jabocr-zoho-"))); const database = new BillDatabase(join(dir, "bills.sqlite")); database.zohoEnabled = enabled;
  cleanups.push(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });
  const bytes = Buffer.from("%PDF-1.4\noriginal\n"); const path = join(dir, "original.pdf"); writeFileSync(path, bytes);
  const bill = database.createBillWithInitialJobs({ sourceMessageId: "message", sourceChatId: "chat", sourceSenderId: "sender", attachmentIndex: 0, receivedAt: "2026-01-01T00:00:00Z", mimeType: "application/pdf", originalPath: path, contentSha256: createHash("sha256").update(bytes).digest("hex") }, [{ type: "extract", idempotencyKey: "extract" }]).bill;
  const job = database.claimNextJob("test", policy, new Date(), ["extract"])!;
  expect(database.persistExtractionSuccess({ billId: bill.id, jobId: job.id, leaseToken: job.leaseToken, jobAttempt: 1, normalized: extraction, rawProviderResponse: "{}", providerModel: "offline", promptSchemaVersion: "1", requestedAt: new Date().toISOString(), completedAt: new Date().toISOString() })).toBe(true);
  database.completeJob(job.id, job.leaseToken);
  const approve = () => { const bill = database.getBill(job.billId)!; expect(database.persistValidationDecision({ billId: bill.id, expectedContentRevision: bill.contentRevision, expectedReviewRevision: bill.reviewRevision, decision: "approved", issues: [] })).toBe(true); };
  const review = (action: "approve" | "reject", corrected = extraction) => {
    const current = database.getBill(bill.id)!;
    expect(database.submitReview({ billId: bill.id, reviewerId: "operator", action, corrected, expectedContentRevision: current.contentRevision, expectedReviewRevision: current.reviewRevision, reason: null, note: null }, [])).toBe(true);
  };
  const claim = (type: "archive_to_workdrive" | "sync_to_zoho_sheet") => database.claimNextJob("test", policy, new Date(), [type])!;
  return { database, dir, bytes, billId: bill.id, approve, review, claim };
}
function remote(bytes: Uint8Array) {
  const files: WorkDriveFile[] = []; let uploads = 0; let adds = 0; let updates = 0; const records: ZohoRecord[] = [];
  const workdrive: WorkDriveAdapter = {
    async list(_folder, offset) { return files.slice(offset, offset + 50).map(({ id, name }) => ({ id, name })); },
    async metadata(id) { return files.find((file) => file.id === id)!; }, async download() { return bytes; },
    async uploadOnce(input) { uploads++; files.push({ id: "file", name: input.name, parentId: input.folderId, size: bytes.byteLength, permalink: "https://workdrive.zoho.sa/file/file" }); return "file"; },
  };
  const sheet: ZohoSheetAdapter = { async initializeLedger() {}, async find(id) { return records.filter((row) => row["Bill ID"] === id).map((row) => ({ ...row })); }, async addOnce(record) { adds++; records.push({ ...record }); }, async update(id, revision, record) { updates++; const rows = records.filter((row) => row["Bill ID"] === id && row.Revision === revision); for (const row of rows) Object.assign(row, record); return rows.length; } };
  return { files, records, workdrive, sheet, counts: () => ({ uploads, adds, updates }) };
}
async function archive(f: ReturnType<typeof fixture>, r: ReturnType<typeof remote>) {
  const job = f.claim("archive_to_workdrive"); await createWorkDriveArchiveHandler(f.database, r.workdrive, { ...config, originalsRoot: f.dir })(job, context(f.database, job)); f.database.completeJob(job.id, job.leaseToken); return job;
}
async function project(f: ReturnType<typeof fixture>, r: ReturnType<typeof remote>) {
  const job = f.claim("sync_to_zoho_sheet"); await createZohoSheetHandler(f.database, r.sheet, config)(job, context(f.database, job)); f.database.completeJob(job.id, job.leaseToken); return job;
}

test("fresh approvals alone enroll, independent of Google; historical approved corrections do not backfill", () => {
  const f = fixture(false); f.approve(); expect(f.database.isZohoEnrolled(f.billId)).toBe(false);
  f.database.zohoEnabled = true; f.review("approve"); expect(f.database.isZohoEnrolled(f.billId)).toBe(false);
  f.review("reject"); f.review("approve"); expect(f.database.isZohoEnrolled(f.billId)).toBe(false);
  expect(f.database.listJobsForBill(f.billId).filter((job) => job.type.includes("zoho") || job.type === "archive_to_workdrive")).toHaveLength(0);
  const fresh = fixture(); fresh.approve(); expect(fresh.database.isZohoEnrolled(fresh.billId)).toBe(true);
  expect(fresh.database.getProjectionMetadata("drive", fresh.billId)).toBeNull();
});

test("verified archive precedes Sheet; corrections update same row and rejection retains original and archive", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve();
  const pending = f.claim("sync_to_zoho_sheet");
  await expect(createZohoSheetHandler(f.database, r.sheet, config)(pending, context(f.database, pending))).rejects.toThrow();
  f.database.failJob(pending.id, pending.leaseToken, "archive pending", policy);
  await archive(f, r); await new Promise((resolve) => setTimeout(resolve, 3)); await project(f, r);
  f.review("approve", { ...extraction, total: 230 }); await project(f, r);
  f.review("reject"); await project(f, r);
  expect(r.records).toHaveLength(1); expect(r.records[0]!.Status).toBe("Rejected"); expect(r.records[0]!.Revision).toBe(f.database.getBill(f.billId)!.contentRevision);
  expect(r.counts()).toEqual({ uploads: 1, adds: 1, updates: 2 });
  expect(f.database.getProjectionMetadata("workdrive", f.billId)!.externalUrl).toBe("https://workdrive.zoho.sa/file/file");
  expect(await Bun.file(join(f.dir, "original.pdf")).bytes()).toEqual(f.bytes);
});

test("lost upload response and timestamp rename reconcile bytes; no second upload on replay", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve();
  const upload = r.workdrive.uploadOnce;
  r.workdrive.uploadOnce = async (input) => { await upload(input); r.files[0]!.name = `${input.name}-timestamp`; throw new Error("private raw provider body"); };
  const job = f.claim("archive_to_workdrive"); const handler = createWorkDriveArchiveHandler(f.database, r.workdrive, { ...config, originalsRoot: f.dir });
  await expect(handler(job, context(f.database, job))).rejects.toThrow("Zoho temporary");
  await handler(job, context(f.database, job)); expect(r.counts().uploads).toBe(1);
  expect(f.database.getProjectionMetadata("workdrive", f.billId)!.externalId).toBe("file");
});

test("crash before upload send remains unresolved across reopen and operator retry", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve(); const job = f.claim("archive_to_workdrive");
  const bill = f.database.getBill(f.billId)!;
  expect(f.database.beginZohoMutation(job, "upload", { folderId: "folder", name: `${bill.id}-${bill.contentSha256}.pdf`, hash: bill.contentSha256, size: f.bytes.byteLength }, bill.contentRevision, bill.status)).toBe(true);
  f.database.failJob(job.id, job.leaseToken, "crash", { ...policy, maxAttempts: 1 });
  expect(f.database.requeueJob(job.id, true)).toBe(true);
  const replay = f.claim("archive_to_workdrive");
  await expect(createWorkDriveArchiveHandler(f.database, r.workdrive, { ...config, originalsRoot: f.dir })(replay, context(f.database, replay))).rejects.toThrow();
  const reopened = new BillDatabase(join(f.dir, "bills.sqlite"));
  try { expect(reopened.getZohoIntent(f.billId, "upload")).not.toBeNull(); } finally { reopened.close(); }
  expect(r.counts().uploads).toBe(0);
});

test("checksum conflicts, duplicate candidates and changed destination fail closed", async () => {
  for (const mode of ["hash", "duplicates", "destination"]) {
    const f = fixture(); const r = remote(f.bytes); f.approve(); const job = f.claim("archive_to_workdrive"); const bill = f.database.getBill(f.billId)!;
    r.files.push({ id: "file", name: `${bill.id}-${bill.contentSha256}.pdf`, parentId: "folder", size: f.bytes.byteLength, permalink: "https://workdrive.zoho.sa/file/file" });
    if (mode === "hash") r.workdrive.download = async () => Buffer.alloc(f.bytes.byteLength);
    if (mode === "duplicates") r.files.push({ ...r.files[0]!, id: "other" });
    if (mode === "destination") f.database.beginZohoMutation(job, "upload", { folderId: "old" }, bill.contentRevision, bill.status);
    await expect(createWorkDriveArchiveHandler(f.database, r.workdrive, { ...config, originalsRoot: f.dir })(job, context(f.database, job))).rejects.toBeInstanceOf(PermanentJobError);
    expect(r.counts().uploads).toBe(0); expect(f.database.getProjectionMetadata("workdrive", f.billId)).toBeNull();
  }
});

test("ambiguous append never re-adds when absent, and reconciles visible success", async () => {
  for (const committed of [true, false]) {
    const f = fixture(); const r = remote(f.bytes); f.approve(); await archive(f, r);
    const add = r.sheet.addOnce; let calls = 0;
    r.sheet.addOnce = async (record) => { calls++; if (committed) await add(record); throw new Error("timeout"); };
    const job = f.claim("sync_to_zoho_sheet"); const handler = createZohoSheetHandler(f.database, r.sheet, config);
    await expect(handler(job, context(f.database, job))).rejects.toThrow();
    if (committed) await handler(job, context(f.database, job)); else await expect(handler(job, context(f.database, job))).rejects.toThrow();
    expect(calls).toBe(1); expect(f.database.listJobsForBill(f.billId).filter((job) => job.idempotencyKey.startsWith("zoho-repair"))).toHaveLength(0);
  }
});

test("rejection races an append; old job repairs latest canonical tombstone", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve(); await archive(f, r);
  const add = r.sheet.addOnce;
  r.sheet.addOnce = async (record) => { await add(record); f.review("reject"); };
  const job = f.claim("sync_to_zoho_sheet");
  await expect(createZohoSheetHandler(f.database, r.sheet, config)(job, context(f.database, job))).rejects.toThrow();
  expect(f.database.getProjectionMetadata("zoho_sheet", f.billId)).toBeNull();
  const repair = f.claim("sync_to_zoho_sheet"); await createZohoSheetHandler(f.database, r.sheet, config)(repair, context(f.database, repair));
  expect(r.records[0]!.Status).toBe("Rejected"); expect(r.counts().adds).toBe(1);
  expect(f.database.listJobsForBill(f.billId).some((job) => job.idempotencyKey.startsWith("zoho-repair:"))).toBe(true);
});

test("expired lease after stale update cannot persist and produces repair even if new revision already ran", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve(); await archive(f, r); await project(f, r); f.review("approve", { ...extraction, total: 200 });
  const old = f.claim("sync_to_zoho_sheet"); const update = r.sheet.update;
  r.sheet.update = async (id, revision, record) => {
    const captured = r.records.filter((row) => row["Bill ID"] === id && row.Revision === revision);
    f.database.sqlite.query("UPDATE jobs SET lease_expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00Z", old.id);
    f.review("reject");
    r.sheet.update = update;
    const newer = f.claim("sync_to_zoho_sheet"); await createZohoSheetHandler(f.database, r.sheet, config)(newer, context(f.database, newer)); f.database.completeJob(newer.id, newer.leaseToken);
    // Model a provider evaluating criteria before blocking: no atomic CAS is promised.
    for (const row of captured) Object.assign(row, record);
    return captured.length;
  };
  await expect(createZohoSheetHandler(f.database, r.sheet, config)(old, context(f.database, old))).rejects.toThrow();
  expect(JSON.parse(f.database.getProjectionMetadata("zoho_sheet", f.billId)!.metadata!).revision).toBe(3);
  expect(r.records[0]!.Revision).toBe(2);
  expect(f.database.listJobsForBill(f.billId).some((job) => job.idempotencyKey.startsWith("zoho-repair"))).toBe(true);
  r.sheet.update = update; const repair = f.claim("sync_to_zoho_sheet"); await createZohoSheetHandler(f.database, r.sheet, config)(repair, context(f.database, repair)); expect(r.records[0]!.Status).toBe("Rejected");
});

test("higher remote revision and duplicate Bill ID rows are never overwritten", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve(); await archive(f, r); await project(f, r); f.review("approve");
  const job = f.claim("sync_to_zoho_sheet"); r.records[0]!.Revision = 100;
  await expect(createZohoSheetHandler(f.database, r.sheet, config)(job, context(f.database, job))).rejects.toBeInstanceOf(PermanentJobError);
  r.records.push({ ...r.records[0]! });
  await expect(createZohoSheetHandler(f.database, r.sheet, config)(job, context(f.database, job))).rejects.toBeInstanceOf(PermanentJobError); expect(r.counts().updates).toBe(0);
});

test("Saudi configuration defaults disabled; endpoints and credentials reject foreign regions", () => {
  const env = { APP_DATA_DIR: "/tmp/offline", WHATSAPP_AUTH_PATH: "/tmp/offline/auth", MISTRAL_ENABLED: "false", AZURE_ENABLED: "true", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://offline.example", AZURE_DOCUMENT_INTELLIGENCE_API_KEY: "offline", REVIEW_USERNAME: "offline", REVIEW_PASSWORD: "offline" };
  expect(loadConfig(env).zoho?.enabled).toBe(false);
  expect(() => loadConfig({ ...env, ZOHO_REGION: "com" })).toThrow("sa");
  expect(() => loadConfig({ ...env, ZOHO_ENABLED: "true" })).toThrow("ZOHO_WORKDRIVE_FOLDER_ID");
  const enabled = loadConfig({ ...env, ZOHO_ENABLED: "true", ZOHO_WORKDRIVE_FOLDER_ID: "folder", ZOHO_SHEET_RESOURCE_ID: "book" });
  expect(enabled.zoho?.credentialJson).toBe("/run/secrets/zoho-authorized-user.json"); expect(enabled.google.enabled).toBe(false);
  expect(() => readZohoCredential(credential.replace("accounts.zoho.sa", "evil.example"))).toThrow("Saudi");
});

test("refresh caches tokens, one read auth retry, mutations never transparently retry", async () => {
  let tokens = 0; let lists = 0; let uploads = 0;
  const adapters = createZohoAdapters(credential, config, async (input, init) => {
    const url = String(input); expect(init?.redirect).toBe("error");
    if (url.includes("/oauth/")) { tokens++; return Response.json({ access_token: `token${tokens}`, expires_in: 3600 }); }
    if (url.endsWith("/upload")) { uploads++; return new Response(null, { status: 401 }); }
    lists++; if (lists === 1) return new Response(null, { status: 401 });
    return Response.json({ data: [] });
  });
  await adapters.workdrive.list("folder", 0); await adapters.workdrive.list("folder", 50);
  expect(tokens).toBe(2); expect(lists).toBe(3);
  await expect(adapters.workdrive.uploadOnce({ folderId: "folder", name: "safe.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-") })).rejects.toThrow("401"); expect(uploads).toBe(1);
});

test("bounded malformed responses, stalled body timeout and unexpected permalink are rejected", async () => {
  for (const response of [() => new Response("x".repeat(1000)), () => Response.json({ data: [{ id: {}, attributes: { name: "x" } }] }), () => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("{")); } }))]) {
    const adapters = createZohoAdapters(credential, { ...config, maxResponseBytes: 100, requestTimeoutMs: 15 }, async (input) => String(input).includes("/oauth/") ? Response.json({ access_token: "token", expires_in: 3600 }) : response());
    await expect(adapters.workdrive.list("folder", 0)).rejects.toThrow();
  }
  const adapters = createZohoAdapters(credential, config, async (input) => String(input).includes("/oauth/") ? Response.json({ access_token: "token", expires_in: 3600 }) : Response.json({ data: { id: "file", attributes: { name: "x", parent_id: "folder", is_folder: false, storage_info: { size_in_bytes: 1 }, permalink: "https://evil.example/file" } } }));
  await expect(adapters.workdrive.metadata("file")).rejects.toThrow("permalink");
});

test("Sheet initializes empty headers without destructive changes; existing mismatches fail", async () => {
  let written = false; const methods: string[] = [];
  const adapters = createZohoAdapters(credential, config, async (input, init) => {
    if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
    const form = init!.body as URLSearchParams; const method = form.get("method")!; methods.push(method);
    if (method === "row.content.set") { expect(JSON.parse(form.get("data_array")!)).toEqual(zohoLedgerHeaders); written = true; return Response.json({ status: "success", method }); }
    return Response.json({ status: "success", method, used_row: written ? 1 : 0, used_column: written ? 15 : 0, range_details: written ? [{ row_index: 1, row_details: zohoLedgerHeaders.map((content, index) => ({ content, column_index: index + 1 })) }] : [] });
  });
  await adapters.sheet.initializeLedger(); expect(methods).toEqual(["worksheet.content.get", "row.content.set", "worksheet.content.get"]);
  const mismatch = createZohoAdapters(credential, config, async (input, init) => String(input).includes("/oauth/") ? Response.json({ access_token: "token", expires_in: 3600 }) : Response.json({ status: "success", method: (init!.body as URLSearchParams).get("method"), used_row: 2, used_column: 1, range_details: [{ row_index: 1, row_details: [{ column_index: 1, content: "Customer data" }] }] }));
  await expect(mismatch.sheet.initializeLedger()).rejects.toBeInstanceOf(PermanentJobError);
});

test("Sheet confirms Saudi empty 1x1 sentinel before initializing headers", async () => {
  let written = false; const methods: string[] = [];
  const adapters = createZohoAdapters(credential, config, async (input, init) => {
    if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
    const form = init!.body as URLSearchParams; const method = form.get("method")!; methods.push(method);
    if (method === "cell.content.get") { expect(form.get("row")).toBe("1"); expect(form.get("column")).toBe("1"); return Response.json({ method, status: "success", row_index: 1, columnIndex: 1, content: "" }); }
    if (method === "row.content.set") { expect(JSON.parse(form.get("data_array")!)).toEqual(zohoLedgerHeaders); written = true; return Response.json({ method, status: "success" }); }
    expect(form.get("visible_rows_only")).toBe("false"); expect(form.get("visible_columns_only")).toBe("false");
    return Response.json({ method, status: "success", used_row: 1, used_column: written ? 15 : 1, range_details: written ? [{ row_index: 1, row_details: zohoLedgerHeaders.map((content, index) => ({ column_index: index + 1, content })) }] : [] });
  });
  await adapters.sheet.initializeLedger();
  expect(methods).toEqual(["worksheet.content.get", "cell.content.get", "row.content.set", "worksheet.content.get"]);
});

test("Sheet occupied sentinel and malformed blank evidence preserve existing cells without writes", async () => {
  const empty = { method: "worksheet.content.get", status: "success", used_row: 1, used_column: 1, range_details: [] };
  const cell = { method: "cell.content.get", status: "success", row_index: 1, columnIndex: 1, content: "" };
  const cases = [
    { header: empty, cell: { ...cell, content: "Existing data" } },
    { header: empty, cell: { ...cell, formula: '=IF(TRUE,"","")' } },
    { header: empty, cell: { ...cell, value: "" } },
    { header: empty, cell: { ...cell, content: 0 } },
    { header: empty, cell: { ...cell, content: null } },
    { header: empty, cell: { ...cell, content: undefined } },
    { header: empty, cell: { ...cell, row_index: 2 } },
    { header: empty, cell: { ...cell, columnIndex: "1" } },
    { header: empty, cell: { ...cell, method: "worksheet.content.get" } },
    { header: { ...empty, used_row: 2 }, cell },
    { header: { ...empty, used_column: 2 }, cell },
    { header: { ...empty, used_row: "1" }, cell },
    { header: { ...empty, range_details: null }, cell },
    { header: { ...empty, formula: "" }, cell },
    { header: { ...empty, range_details: [{ row_index: 1, row_details: [{ column_index: 1, content: "" }] }] }, cell },
    { header: { ...empty, range_details: [{ row_index: 1, row_details: [{ column_index: 1, content: "", formula: '=IF(TRUE,"","")' }] }] }, cell },
    { header: { ...empty, range_details: [{ row_index: 1, row_details: [{ column_index: 1, content: "Existing data" }] }] }, cell },
  ];
  for (const evidence of cases) {
    let writes = 0;
    const adapters = createZohoAdapters(credential, config, async (input, init) => {
      if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
      const method = (init!.body as URLSearchParams).get("method");
      if (method === "worksheet.content.get") return Response.json(evidence.header);
      if (method === "cell.content.get") return Response.json(evidence.cell);
      writes++; return Response.json({ method, status: "success" });
    });
    await expect(adapters.sheet.initializeLedger()).rejects.toThrow(); expect(writes).toBe(0);
  }
});

test("Sheet form payloads quote literal OCR strings and update uses Bill ID plus observed revision", async () => {
  const record = Object.fromEntries(zohoLedgerHeaders.map((header) => [header, ""])) as ZohoRecord;
  Object.assign(record, { "Bill ID": "bill-123", Revision: 2, Status: "Approved", Vendor: '=HYPERLINK("evil")', "Invoice number": "000123", Description: "العربية\n'quote", "WorkDrive hyperlink": "https://workdrive.zoho.sa/file/file" });
  const methods: string[] = [];
  const adapters = createZohoAdapters(credential, config, async (input, init) => {
    if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
    const form = init!.body as URLSearchParams; const method = form.get("method")!; methods.push(method);
    if (method === "worksheet.records.fetch") { expect(form.get("criteria")).toBe('"Bill ID"="bill-123"'); expect(form.get("render_option")).toBe("unformatted"); return Response.json({ method, status: "success", records: [record] }); }
    if (method === "worksheet.records.add") expect(JSON.parse(form.get("json_data")!)[0]).toEqual(encodeRecord(record));
    if (method === "worksheet.records.update") { expect(form.get("criteria")).toBe('"Bill ID"="bill-123" and "Revision"=1'); expect(form.has("json_data")).toBe(false); }
    return Response.json({ method, status: "success", no_of_affected_rows: 1 });
  });
  expect(encodeRecord(record).Vendor).toBe('="=HYPERLINK(""evil"")"');
  expect(encodeRecord(record)["Invoice number"]).toBe('="000123"');
  expect(encodeRecord(record)["WorkDrive hyperlink"]).toBe('=HYPERLINK("https://workdrive.zoho.sa/file/file","https://workdrive.zoho.sa/file/file")');
  await adapters.sheet.addOnce(record); expect(await adapters.sheet.update("bill-123", 1, record)).toBe(1); expect(await adapters.sheet.find("bill-123")).toEqual([record]);
  await expect(adapters.sheet.find('bad" or true')).rejects.toThrow(); expect(methods).toHaveLength(3);
});

test("Sheet throttle code 2950 blocks workbook calls for five minutes and redacts provider errors", async () => {
  let calls = 0;
  const adapters = createZohoAdapters(credential, config, async (input) => {
    if (String(input).includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
    calls++; return Response.json({ status: "failure", error_code: "2950", error_message: "private secret" });
  });
  await expect(adapters.sheet.find("bill")).rejects.toThrow("2950"); await expect(adapters.sheet.find("bill")).rejects.toThrow("2950"); expect(calls).toBe(1);
});

test("append intent before send survives rejection and reapproval without blind add", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve(); await archive(f, r); const job = f.claim("sync_to_zoho_sheet"); const bill = f.database.getBill(f.billId)!;
  expect(f.database.beginZohoMutation(job, "append", { resourceId: "workbook", worksheet: "Ledger" }, bill.contentRevision, bill.status)).toBe(true);
  const handler = createZohoSheetHandler(f.database, r.sheet, config);
  await expect(handler(job, context(f.database, job))).rejects.toThrow("unresolved");
  f.review("reject"); const rejected = f.claim("sync_to_zoho_sheet"); await expect(handler(rejected, context(f.database, rejected))).rejects.toThrow("unresolved");
  f.review("approve"); const approved = f.claim("sync_to_zoho_sheet"); await expect(handler(approved, context(f.database, approved))).rejects.toThrow("unresolved");
  expect(r.counts().adds).toBe(0); expect(f.database.getZohoIntent(f.billId, "append")).not.toBeNull();
});

test("upload varied ID schemas and folder full-page pagination are normalized", async () => {
  for (const data of [{ id: "file" }, { attributes: { resource_id: "file" } }, { attributes: { "File INFO": JSON.stringify({ RESOURCE_ID: "file" }) } }]) {
    const offsets: string[] = [];
    const adapters = createZohoAdapters(credential, config, async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/oauth/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (url.pathname.endsWith("/upload")) { const body = init!.body as FormData; expect(body.get("override-name-exist")).toBe("false"); return Response.json({ data: [data] }); }
      offsets.push(url.searchParams.get("page[offset]")!);
      if (offsets.length === 2) return new Response(null, { status: 204 });
      return Response.json({ data: Array.from({ length: 50 }, (_, index) => ({ id: `file${index}`, attributes: { name: `name${index}` } })) });
    });
    expect(await adapters.workdrive.uploadOnce({ folderId: "folder", name: "x.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]) })).toBe("file");
    expect(await adapters.workdrive.list("folder", 0)).toHaveLength(50); expect(await adapters.workdrive.list("folder", 50)).toEqual([]); expect(offsets).toEqual(["0", "50"]);
  }
});

test("expired token refreshes; Sheet auth failure retries reads but never adds", async () => {
  let tokens = 0; let reads = 0; let adds = 0;
  const adapters = createZohoAdapters(credential, config, async (input, init) => {
    if (String(input).includes("/oauth/")) { tokens++; return Response.json({ access_token: "token", expires_in: 1 }); }
    const method = (init!.body as URLSearchParams).get("method");
    if (method === "worksheet.records.add") { adds++; return Response.json({ status: "failure", error_code: 2401 }); }
    reads++; if (reads === 1) return Response.json({ status: "failure", error_code: 2401 });
    return Response.json({ status: "success", method, records: [] });
  });
  expect(await adapters.sheet.find("bill")).toEqual([]); expect(reads).toBe(2); expect(tokens).toBeGreaterThan(1);
  await expect(adapters.sheet.addOnce({ "Bill ID": "bill", Revision: 1 })).rejects.toThrow("2401"); expect(adds).toBe(1);
});

test("Sheet read gets one total auth retry across HTTP and JSON auth failures", async () => {
  let tokens = 0; let calls = 0;
  const adapters = createZohoAdapters(credential, config, async (input) => {
    if (String(input).includes("/oauth/")) { tokens++; return Response.json({ access_token: "token", expires_in: 3600 }); }
    calls++; return calls === 1 ? new Response(null, { status: 401 }) : Response.json({ status: "failure", error_code: 2401 });
  });
  await expect(adapters.sheet.find("bill")).rejects.toThrow("2401"); expect(calls).toBe(2); expect(tokens).toBe(2);
});

test("scope errors are permanent, transient HTTP errors bounded by worker and raw detail never persists", async () => {
  for (const status of [403, 503]) {
    const f = fixture(); f.approve();
    const adapters = createZohoAdapters(credential, config, async (input) => String(input).includes("/oauth/") ? Response.json({ access_token: "token", expires_in: 3600 }) : new Response("private credentials raw provider body", { status }));
    const worker = new JobWorker(f.database, { archive_to_workdrive: createWorkDriveArchiveHandler(f.database, adapters.workdrive, { ...config, originalsRoot: f.dir }) }, policy, "test", createLogger("error", () => {}));
    expect(await worker.runOnce()).toBe(true); const job = f.database.listJobsForBill(f.billId).find((job) => job.type === "archive_to_workdrive")!;
    expect(job.state).toBe(status === 403 ? "permanent_failure" : "retryable_failure"); expect(job.lastError).toBe(`provider_http_${status}`); expect(JSON.stringify(job)).not.toContain("credentials");
  }
});

test("migration rebuild preserves Google jobs, leases, transitions and marks historical approvals", () => {
  const f = fixture(false); f.approve(); const google = f.database.claimNextJob("google", policy, new Date(), ["archive_to_drive"])!;
  const transitions = f.database.getJobTransitions(google.id);
  const version = f.database.sqlite.query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_migrations").get()!.version;
  f.database.sqlite.exec("DROP TABLE zoho_mutation_intents; DROP TABLE zoho_enrollment; DROP TABLE zoho_historical_approvals;");
  f.database.sqlite.query("DELETE FROM schema_migrations WHERE version = ?").run(version);
  const reopened = new BillDatabase(join(f.dir, "bills.sqlite"));
  try {
    expect(reopened.getJob(google.id)).toEqual(google); expect(reopened.getJobTransitions(google.id)).toEqual(transitions);
    expect(reopened.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    reopened.zohoEnabled = true; const bill = reopened.getBill(f.billId)!;
    expect(reopened.submitReview({ billId: bill.id, reviewerId: "operator", action: "reject", reason: null, note: null, expectedContentRevision: bill.contentRevision, expectedReviewRevision: bill.reviewRevision, corrected: extraction }, [])).toBe(true);
    const rejected = reopened.getBill(f.billId)!;
    expect(reopened.submitReview({ billId: bill.id, reviewerId: "operator", action: "approve", reason: null, note: null, expectedContentRevision: rejected.contentRevision, expectedReviewRevision: rejected.reviewRevision, corrected: extraction }, [])).toBe(true);
    expect(reopened.isZohoEnrolled(f.billId)).toBe(false);
  } finally { reopened.close(); }
});

test("disabled jobs are excluded from worker readiness; enabled service accepts both injected adapters", async () => {
  const f = fixture(); const r = remote(f.bytes); f.approve();
  const worker = new JobWorker(f.database, { extract: async () => {} }, policy, "test", createLogger("error", () => {}));
  expect(worker.supportedTypes).toEqual(["extract"]); expect(f.database.getJobHealth(new Date(), worker.supportedTypes).overdueJobs).toBe(0); expect(await worker.runOnce()).toBe(false);
  const serviceDir = mkdtempSync(join(tmpdir(), "jabocr-zoho-service-")); cleanups.push(() => rmSync(serviceDir, { recursive: true, force: true }));
  const app = loadConfig({ APP_DATA_DIR: serviceDir, WHATSAPP_AUTH_PATH: join(serviceDir, "auth"), WHATSAPP_ENABLED: "false", MISTRAL_ENABLED: "false", AZURE_ENABLED: "true", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://offline.example", AZURE_DOCUMENT_INTELLIGENCE_API_KEY: "offline", REVIEW_USERNAME: "offline", REVIEW_PASSWORD: "offline", ZOHO_ENABLED: "true", ZOHO_WORKDRIVE_FOLDER_ID: "folder", ZOHO_SHEET_RESOURCE_ID: "workbook" });
  app.port = 0;
  const service = startService(app, {}, { workdriveAdapter: r.workdrive, zohoSheetAdapter: r.sheet, azureProvider: { async submit() { throw new Error("offline"); }, async poll() { throw new Error("offline"); } } });
  cleanups.push(() => service.shutdown());
  await new Promise((resolve) => setTimeout(resolve, 20)); const response = await fetch(new URL("ready", service.url)); expect(response.status).toBe(200); expect(await response.text()).not.toContain("overdueJobs");
});
