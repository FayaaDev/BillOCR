import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase, type RetryPolicy } from "../src/database";
import { createDriveArchiveHandler, createGoogleAdapters, createSheetsProjectionHandler, ledgerHeaders, ledgerValues, readGoogleCredential, type DriveAdapter, type DriveFile, type SheetsAdapter } from "../src/google-projections";
import { JobWorker } from "../src/worker";
import { createLogger } from "../src/logger";

const policy: RetryPolicy = { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 10, leaseMs: 60_000 };
let directory: string;
let database: BillDatabase;
let original: Uint8Array;

beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), "bill-google-"))); database = new BillDatabase(join(directory, "ledger.sqlite")); original = new TextEncoder().encode("%PDF-1.7\nfixture"); writeFileSync(join(directory, "source.pdf"), original); });
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

async function serviceAccountJson(): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const der = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString("base64")}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ client_email: "service@example.test", private_key: pem });
}

function bill(jobType: "archive_to_drive" | "project_to_sheet" = "archive_to_drive") {
  return database.createBillWithInitialJobs({ id: "bill-immutable", whatsappMessageId: "message", whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: "2026-08-15T12:00:00.000Z", originalFilename: "../evil:=invoice?.pdf", mimeType: "application/pdf", originalPath: join(directory, "source.pdf"), contentSha256: createHash("sha256").update(original).digest("hex") }, [{ type: jobType, idempotencyKey: `${jobType}:bill-immutable` }]).bill;
}
function approvedBill() {
  const item = bill("project_to_sheet");
  database.sqlite.query("UPDATE bills SET status = 'approved', content_revision = 1 WHERE id = ?").run(item.id);
  database.sqlite.query("UPDATE jobs SET expected_revision = 1 WHERE bill_id = ?").run(item.id);
  database.sqlite.query("INSERT INTO extractions (id, bill_id, schema_version, normalized_json, created_at, updated_at) VALUES ('extraction', ?, '1', ?, ?, ?)").run(item.id, JSON.stringify({ schemaVersion: "1", vendorName: "=DANGEROUS()", invoiceNumber: "+123", invoiceDate: "2026-08-01", currency: "USD", subtotal: 1, vat: 2, total: 3, description: "@formula", fields: { vendorName: { confidence: 0.9, sourceText: null }, invoiceDate: { confidence: 0.9, sourceText: null }, total: { confidence: 0.9, sourceText: null } } }), new Date().toISOString(), new Date().toISOString());
  database.sqlite.query("INSERT INTO provider_projection_metadata (id, bill_id, provider, projection_key, external_id, external_url, created_at, updated_at) VALUES ('drive', ?, 'drive', ?, 'drive-file', 'https://drive.example/file', ?, ?)").run(item.id, item.id, new Date().toISOString(), new Date().toISOString());
  return item;
}

test("archives byte-identical original under the required idempotent folder path", async () => {
  const item = bill(); const paths: string[] = []; let uploaded: Uint8Array | undefined;
  const folders = new Map<string, string>();
  const drive: DriveAdapter = {
    findFolder: async (parent, name) => folders.has(`${parent}/${name}`) ? { id: folders.get(`${parent}/${name}`)! } : null,
    createFolder: async (parent, name) => { const id = `${parent}/${name}`; folders.set(id, id); paths.push(id); return { id }; },
    findFilesByBillId: async () => [],
    uploadOriginal: async (input) => { uploaded = input.bytes; expect(input.parentId).toBe("root/Bills/2026/08"); expect(input.name).toBe("bill-immutable-evil_=invoice_.pdf"); return { id: "drive-file", webLink: "https://drive.example/file", appProperties: { billId: input.billId, contentSha256: input.contentSha256 } }; },
  };
  await new JobWorker(database, { archive_to_drive: createDriveArchiveHandler(database, drive, { driveRootId: "root" }) }, policy, "worker", createLogger("error")).runOnce();
  expect(paths).toEqual(["root/Bills", "root/Bills/2026", "root/Bills/2026/08"]);
  expect(uploaded).toEqual(original);
  expect(database.getBill(item.id)?.driveFileId).toBe("drive-file");
});

test("Drive v3 webViewLink responses map to persisted adapter web links", async () => {
  const requests: URL[] = [];
  const adapters = createGoogleAdapters(await serviceAccountJson(), { driveRootId: "root", sheetId: "sheet", sheetName: "Ledger" }, async (input) => {
    const url = new URL(String(input)); requests.push(url);
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "token", expires_in: 3600 });
    return Response.json({ files: [{ id: "drive-file", webViewLink: "https://drive.google.test/file", appProperties: { billId: "bill", contentSha256: "hash" } }] });
  });
  const [file] = await adapters.drive.findFilesByBillId("bill");
  expect(requests[1]?.pathname).toBe("/drive/v3/files");
  expect(file).toEqual({ id: "drive-file", webLink: "https://drive.google.test/file", appProperties: { billId: "bill", contentSha256: "hash" } });
});

test("authorized-user credentials refresh with a form grant, cache the token, and do not expose secrets", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const credential = JSON.stringify({ type: "authorized_user", client_id: "client-id", client_secret: "client-secret", refresh_token: "refresh-secret" });
  const adapters = createGoogleAdapters(credential, { driveRootId: "root", sheetId: "sheet", sheetName: "Ledger" }, async (input, init) => {
    const url = new URL(String(input)); requests.push({ url, init });
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "short-lived-token", expires_in: 3600 });
    return Response.json({ files: [] });
  });
  await adapters.drive.findFilesByBillId("first");
  await adapters.drive.findFilesByBillId("second");
  expect(requests.filter((request) => request.url.hostname === "oauth2.googleapis.com")).toHaveLength(1);
  const tokenRequest = requests[0]!;
  expect(tokenRequest.init?.method).toBe("POST");
  expect(tokenRequest.init?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
  expect(new URLSearchParams(String(tokenRequest.init?.body))).toEqual(new URLSearchParams({ grant_type: "refresh_token", client_id: "client-id", client_secret: "client-secret", refresh_token: "refresh-secret" }));
  expect(requests[1]?.init?.headers).toMatchObject({ Authorization: "Bearer short-lived-token" });
  expect(() => readGoogleCredential('{"type":"authorized_user","client_id":"client-id"}')).toThrow("requires client_id, client_secret, and refresh_token");
  expect(() => readGoogleCredential("not json")).toThrow("Invalid Google credential JSON");
});

test("Google credential parsing rejects whitespace-only required values without exposing them", () => {
  for (const credential of [
    { client_email: "   ", private_key: "key" },
    { client_email: "email", private_key: " \t " },
    { client_email: "email", private_key: "key", token_uri: "\n" },
    { type: "authorized_user", client_id: " ", client_secret: "secret", refresh_token: "refresh" },
    { type: "authorized_user", client_id: "client", client_secret: "\t", refresh_token: "refresh" },
    { type: "authorized_user", client_id: "client", client_secret: "secret", refresh_token: " ", token_uri: "https://token" },
    { type: "authorized_user", client_id: "client", client_secret: "secret", refresh_token: "refresh", token_uri: "  " },
  ]) expect(() => readGoogleCredential(JSON.stringify(credential))).toThrow(/requires/);
  expect(readGoogleCredential(JSON.stringify({ client_email: " service@example.test ", private_key: " key ", token_uri: " https://token " }))).toEqual({ client_email: " service@example.test ", private_key: " key ", token_uri: " https://token " });
  expect(readGoogleCredential(JSON.stringify({ type: "authorized_user", client_id: " client ", client_secret: " secret ", refresh_token: " refresh ", token_uri: " https://token " }))).toEqual({ type: "authorized_user", client_id: " client ", client_secret: " secret ", refresh_token: " refresh ", token_uri: " https://token " });
});

test("Google auth and Drive/Sheets bodies use the capped reader without exposing response bodies", async () => {
  const adapters = createGoogleAdapters(await serviceAccountJson(), { driveRootId: "root", sheetId: "sheet", sheetName: "Ledger", maxResponseBytes: 100, requestTimeoutMs: 1_000 }, async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "token", expires_in: 3600 });
    return new Response('{"secret":"this response is intentionally too large"}', { headers: { "content-length": "1000" } });
  });
  await expect(adapters.drive.findFilesByBillId("bill")).rejects.toThrow("Google response too large");
});

test("Drive v3 webViewLink search replay persists the canonical Drive link", async () => {
  const item = bill();
  const adapters = createGoogleAdapters(await serviceAccountJson(), { driveRootId: "root", sheetId: "sheet", sheetName: "Ledger" }, async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "token", expires_in: 3600 });
    return Response.json({ files: [{ id: "drive-file", webViewLink: "https://drive.google.test/file", appProperties: { billId: item.id, contentSha256: item.contentSha256 } }] });
  });
  await new JobWorker(database, { archive_to_drive: createDriveArchiveHandler(database, adapters.drive, { driveRootId: "root" }) }, policy, "worker", createLogger("error")).runOnce();
  expect(database.getBill(item.id)?.driveFileId).toBe("drive-file");
  expect(database.getProjectionMetadata("drive", item.id)?.externalUrl).toBe("https://drive.google.test/file");
});

test("Sheets initializes the configured tab, exact headers, and hidden immutable key columns without wiping retries", async () => {
  const calls: Array<{ url: URL; method: string; body: string | undefined }> = []; let created = false; let headersWritten = false;
  const adapters = createGoogleAdapters(await serviceAccountJson(), { driveRootId: "root", sheetId: "sheet-id", sheetName: "Configured O'Brien [Ledger]" }, async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET"; const body = init?.body === undefined ? undefined : String(init.body); calls.push({ url, method, body });
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "token", expires_in: 3600 });
    if (url.pathname === "/v4/spreadsheets/sheet-id" && method === "GET") return Response.json({ sheets: created ? [{ properties: { sheetId: 7, title: "Configured O'Brien [Ledger]" } }] : [] });
    if (url.pathname === "/v4/spreadsheets/sheet-id:batchUpdate" && method === "POST" && body?.includes("addSheet")) { created = true; return Response.json({ replies: [{ addSheet: { properties: { sheetId: 7 } } }] }); }
    if (url.pathname.includes("/values/") && method === "GET") return Response.json(headersWritten ? { values: [ledgerHeaders] } : {});
    if (url.pathname.includes("/values/") && method === "PUT") { headersWritten = true; return Response.json({}); }
    if (url.pathname === "/v4/spreadsheets/sheet-id:batchUpdate" && method === "POST") return Response.json({});
    throw new Error(`unexpected ${method} ${url}`);
  });
  await adapters.sheets.initializeLedger();
  await adapters.sheets.initializeLedger();
  const adds = calls.filter((call) => call.body?.includes("addSheet"));
  const headerWrites = calls.filter((call) => call.method === "PUT" && call.url.pathname.includes("/values/"));
  const hides = calls.filter((call) => call.body?.includes("updateDimensionProperties"));
  expect(adds).toHaveLength(1); expect(headerWrites).toHaveLength(1); expect(hides).toHaveLength(2);
  expect(headerWrites[0]?.url.pathname).toContain("'Configured%20O''Brien%20%5BLedger%5D'!A1%3AO1");
  expect(JSON.parse(headerWrites[0]!.body!).values[0]).toEqual(ledgerHeaders);
  expect(JSON.parse(hides[0]!.body!).requests[0].updateDimensionProperties).toEqual({ range: { sheetId: 7, dimension: "COLUMNS", startIndex: 13, endIndex: 15 }, properties: { hiddenByUser: true }, fields: "hiddenByUser" });
});

test("concurrent Sheet initialization recovers when a competing addSheet wins", async () => {
  let metadataReads = 0; let addCalls = 0; let headersWritten = false;
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input)); const method = init?.method ?? "GET"; const body = init?.body === undefined ? "" : String(init.body);
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "token", expires_in: 3600 });
    if (url.pathname === "/v4/spreadsheets/sheet-id" && method === "GET") {
      metadataReads += 1;
      return Response.json({ sheets: metadataReads <= 2 ? [] : [{ properties: { sheetId: 9, title: "Ledger" } }] });
    }
    if (url.pathname === "/v4/spreadsheets/sheet-id:batchUpdate" && body.includes("addSheet")) {
      addCalls += 1;
      return addCalls === 1 ? Response.json({ replies: [{ addSheet: { properties: { sheetId: 9 } } }] }) : Response.json({ error: { message: "A sheet with the name Ledger already exists" } }, { status: 400 });
    }
    if (url.pathname.includes("/values/") && method === "GET") return Response.json(headersWritten ? { values: [ledgerHeaders] } : {});
    if (url.pathname.includes("/values/") && method === "PUT") { headersWritten = true; return Response.json({}); }
    if (url.pathname === "/v4/spreadsheets/sheet-id:batchUpdate") return Response.json({});
    throw new Error(`unexpected ${method} ${url}`);
  };
  const serviceAccount = await serviceAccountJson();
  const first = createGoogleAdapters(serviceAccount, { driveRootId: "root", sheetId: "sheet-id", sheetName: "Ledger" }, fetcher);
  const second = createGoogleAdapters(serviceAccount, { driveRootId: "root", sheetId: "sheet-id", sheetName: "Ledger" }, fetcher);
  await Promise.all([first.sheets.initializeLedger(), second.sheets.initializeLedger()]);
  expect(addCalls).toBe(2); expect(metadataReads).toBe(3); expect(headersWritten).toBe(true);
});

test("Drive crash replay searches app properties and never uploads a second file", async () => {
  const item = bill(); let uploads = 0; let remote: DriveFile | undefined;
  const drive: DriveAdapter = {
    findFolder: async () => ({ id: "folder" }), createFolder: async () => ({ id: "folder" }),
    findFilesByBillId: async () => remote ? [remote] : [],
    uploadOriginal: async (input) => { uploads += 1; remote = { id: "remote", webLink: "https://drive.example/remote", appProperties: { billId: input.billId, contentSha256: input.contentSha256 } }; return remote; },
  };
  const originalPersist = database.persistDriveArchive.bind(database); let crash = true;
  database.persistDriveArchive = (input) => crash ? false : originalPersist(input);
  const worker = new JobWorker(database, { archive_to_drive: createDriveArchiveHandler(database, drive, { driveRootId: "root" }) }, policy, "worker", createLogger("error"));
  await worker.runOnce(); crash = false;
  database.sqlite.query("UPDATE jobs SET state = 'pending', available_at = ? WHERE bill_id = ?").run(new Date().toISOString(), item.id);
  await worker.runOnce();
  expect(uploads).toBe(1); expect(database.getBill(item.id)?.driveFileId).toBe("remote");
});

test("reserved Drive ID survives a lost upload response and visibility lag without a second identity", async () => {
  const item = bill(); const generated: string[] = []; const uploads: string[] = []; let remote: DriveFile | null = null; let first = true;
  const drive: DriveAdapter = {
    findFolder: async () => ({ id: "folder" }), createFolder: async () => ({ id: "folder" }), findFilesByBillId: async () => [],
    uploadOriginal: async () => { throw new Error("legacy path must not run"); }, generateId: async () => { const id = `id-${generated.length}`; generated.push(id); return id; },
    getFile: async (id) => remote?.id === id ? remote : null,
    createFolderWithId: async ({ id }) => ({ id }),
    uploadOriginalWithId: async (input) => { uploads.push(input.id); remote = { id: input.id, webLink: "https://drive.example/reserved", appProperties: { billId: input.billId, contentSha256: input.contentSha256 } }; if (first) { first = false; throw new Error("network lost response"); } return remote; },
  };
  const worker = new JobWorker(database, { archive_to_drive: createDriveArchiveHandler(database, drive, { driveRootId: "root" }) }, policy, "worker", createLogger("error"));
  await worker.runOnce(); database.sqlite.query("UPDATE jobs SET state = 'pending', available_at = ? WHERE bill_id = ?").run(new Date().toISOString(), item.id); await worker.runOnce();
  expect(uploads).toEqual(["id-3"]); expect(database.getBill(item.id)?.driveFileId).toBe("id-3");
});

test("Drive root changes do not reuse folder reservations from the previous destination", async () => {
  const item = bill(); const created: Array<{ id: string; parentId: string; name: string }> = []; let nextId = 0;
  database.reserveDriveId({ key: "folder:Bills", kind: "folder", parentId: "old-root", logicalPath: "Bills", generatedId: "old-folder" });
  database.confirmDriveReservation("folder:Bills");
  const drive: DriveAdapter = {
    findFolder: async () => null, createFolder: async () => { throw new Error("legacy path must not run"); },
    findFilesByBillId: async () => [], uploadOriginal: async () => { throw new Error("legacy path must not run"); },
    generateId: async () => `new-id-${++nextId}`,
    getFile: async (id) => { if (id === "old-folder") throw new Error("stale destination reused"); return null; },
    createFolderWithId: async (input) => { created.push(input); return { id: input.id }; },
    uploadOriginalWithId: async (input) => {
      expect(input.parentId).toBe("new-id-3");
      return { id: input.id, webLink: "https://drive.example/new-file", appProperties: { billId: input.billId, contentSha256: input.contentSha256 } };
    },
  };
  await new JobWorker(database, { archive_to_drive: createDriveArchiveHandler(database, drive, { driveRootId: "new-root" }) }, policy, "worker", createLogger("error")).runOnce();
  expect(created).toEqual([
    { id: "new-id-1", parentId: "new-root", name: "Bills" },
    { id: "new-id-2", parentId: "new-id-1", name: "2026" },
    { id: "new-id-3", parentId: "new-id-2", name: "08" },
  ]);
  expect(database.getDriveReservation("folder:Bills")?.drive_id).toBe("old-folder");
  expect(database.getBill(item.id)?.driveFileId).toBe("new-id-4");
});

test("same-root replay preserves a legacy reserved folder ID", async () => {
  const item = bill(); let generated = 0; const created: string[] = [];
  database.reserveDriveId({ key: "folder:Bills", kind: "folder", parentId: "root", logicalPath: "Bills", generatedId: "reserved-bills" });
  const drive: DriveAdapter = {
    findFolder: async () => null, createFolder: async () => { throw new Error("legacy path must not run"); },
    findFilesByBillId: async () => [], uploadOriginal: async () => { throw new Error("legacy path must not run"); },
    generateId: async () => `new-${++generated}`, getFile: async () => null,
    createFolderWithId: async ({ id }) => { created.push(id); return { id }; },
    uploadOriginalWithId: async (input) => ({ id: input.id, webLink: "https://drive.example/file", appProperties: { billId: input.billId, contentSha256: input.contentSha256 } }),
  };
  await new JobWorker(database, { archive_to_drive: createDriveArchiveHandler(database, drive, { driveRootId: "root" }) }, policy, "worker", createLogger("error")).runOnce();
  expect(created).toEqual(["reserved-bills", "new-1", "new-2"]);
  expect(database.getDriveReservation("folder:Bills")?.state).toBe("confirmed");
  expect(database.getBill(item.id)?.driveFileId).toBe("new-3");
});

test("Sheets uses the immutable hidden ID to append once then update correction values with RAW-safe strings", async () => {
  const item = approvedBill(); const rows = new Map<number, (string | number | null)[]>(); let next = 2; let appends = 0; let updates = 0;
  const sheets: SheetsAdapter = {
    initializeLedger: async () => undefined,
    findRowByBillId: async (id) => [...rows.entries()].find(([, values]) => values[13] === id)?.[0] ?? null,
    appendRow: async (values) => { appends += 1; const row = next++; rows.set(row, [...values]); return row; },
    updateRow: async (row, values) => { updates += 1; rows.set(row, [...values]); },
  };
  const handler = createSheetsProjectionHandler(database, sheets); const worker = new JobWorker(database, { project_to_sheet: handler }, policy, "worker", createLogger("error"));
  await worker.runOnce();
  database.sqlite.query("UPDATE bills SET content_revision = 2 WHERE id = ?").run(item.id);
  database.sqlite.query("INSERT INTO jobs (id, bill_id, type, state, idempotency_key, attempts, available_at, expected_revision, created_at, updated_at) VALUES ('new-project', ?, 'project_to_sheet', 'pending', 'project:bill-immutable:2', 0, ?, 2, ?, ?)").run(item.id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  await worker.runOnce();
  expect(appends).toBe(1); expect(updates).toBe(1); expect(rows.get(2)?.[0]).toBe("2026-08-15"); expect(rows.get(2)?.[1]).toBe("=DANGEROUS()"); expect(rows.get(2)?.[12]).toBe("https://drive.example/file"); expect(rows.get(2)?.[13]).toBe(item.id);
});

test("Sheet waits for Drive and temporary Google failures remain retryable without modifying bills", async () => {
  const item = approvedBill(); database.sqlite.query("DELETE FROM provider_projection_metadata WHERE provider = 'drive'").run();
  const sheets: SheetsAdapter = { initializeLedger: async () => undefined, findRowByBillId: async () => { throw new Error("should not call"); }, appendRow: async () => 1, updateRow: async () => undefined };
  const worker = new JobWorker(database, { project_to_sheet: createSheetsProjectionHandler(database, sheets) }, policy, "worker", createLogger("error"));
  await worker.runOnce();
  expect(database.getJob(database.sqlite.query<{ id: string }, [string]>("SELECT id FROM jobs WHERE bill_id = ?").get(item.id)!.id)?.state).toBe("retryable_failure");
  expect(database.getBill(item.id)?.status).toBe("approved");
});

test("stale revisions are fenced before Sheets side effects and ledger values retain untrusted input as data", async () => {
  const item = approvedBill(); let calls = 0;
  const sheets: SheetsAdapter = { initializeLedger: async () => { calls += 1; }, findRowByBillId: async () => { calls += 1; return null; }, appendRow: async () => { calls += 1; return 1; }, updateRow: async () => undefined };
  database.sqlite.query("UPDATE bills SET content_revision = 2 WHERE id = ?").run(item.id);
  await new JobWorker(database, { project_to_sheet: createSheetsProjectionHandler(database, sheets) }, policy, "worker", createLogger("error")).runOnce();
  expect(calls).toBe(0);
  const values = ledgerValues(database.getBill(item.id)!, database.getExtraction(item.id)!.normalized!, "https://drive.example/file");
  expect(values[1]).toBe("=DANGEROUS()"); expect(values[13]).toBe(item.id);
});

test("Sheet confidence summary displays unknown when native confidences are null", () => {
  const item = approvedBill();
  const extraction = database.getExtraction(item.id)!.normalized!;
  extraction.fields = { vendorName: { confidence: null, sourceText: "Vendor" }, invoiceDate: { confidence: null, sourceText: "2026-08-15" }, total: { confidence: null, sourceText: "11" } };
  expect(ledgerValues(database.getBill(item.id)!, extraction, "https://drive.example/file")[10]).toBe("unknown");
});

test("Sheet sender column uses generic transport sender metadata", () => {
  const item = approvedBill(); const telegram = { ...database.getBill(item.id)!, source: "telegram" as const, sourceSenderId: "telegram-sender" };
  expect(ledgerValues(telegram, database.getExtraction(item.id)!.normalized!, "https://drive.example/file")[9]).toBe("telegram-sender");
});

test("concurrent Sheet append misses reconcile to one immutable bill row", async () => {
  const item = approvedBill();
  database.sqlite.query("INSERT INTO jobs (id, bill_id, type, state, idempotency_key, attempts, available_at, expected_revision, created_at, updated_at) VALUES ('second-project', ?, 'project_to_sheet', 'pending', 'project:bill-immutable:1:second', 0, ?, 1, ?, ?)").run(item.id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  const rows = new Map<number, (string | number | null)[]>(); let next = 2; let reads = 0;
  const sheets: SheetsAdapter = {
    initializeLedger: async () => undefined, findRowByBillId: async () => null,
    findLedgerRows: async (id) => { reads += 1; if (reads <= 2) return []; return [...rows.entries()].flatMap(([row, values]) => values[13] === id ? [{ row, revision: Number(values[14]) }] : []); },
    appendRow: async (values) => { const row = next++; rows.set(row, [...values]); return row; }, updateRow: async (row, values) => { rows.set(row, [...values]); },
    clearRows: async (targets) => { for (const row of targets) rows.delete(row); },
  };
  const handlers = { project_to_sheet: createSheetsProjectionHandler(database, sheets) };
  await Promise.all([new JobWorker(database, handlers, policy, "a", createLogger("error")).runOnce(), new JobWorker(database, handlers, policy, "b", createLogger("error")).runOnce()]);
  expect([...rows.values()].filter((values) => values[13] === item.id)).toHaveLength(1);
});

test("current correction projection collapses hidden-ID duplicates across old revisions", async () => {
  const item = approvedBill(); database.sqlite.query("UPDATE bills SET content_revision = 2 WHERE id = ?").run(item.id);
  database.sqlite.query("UPDATE jobs SET state = 'permanent_failure' WHERE bill_id = ?").run(item.id);
  database.sqlite.query("INSERT INTO jobs (id,bill_id,type,state,idempotency_key,attempts,available_at,expected_revision,created_at,updated_at) VALUES ('revision-two',?,'project_to_sheet','pending','project:bill-immutable:2',0,?,2,?,?)").run(item.id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  const rows = new Map<number, (string | number | null)[]>([[2, [null,null,null,null,null,null,null,null,null,null,null,null,null,item.id,1]], [4, [null,null,null,null,null,null,null,null,null,null,null,null,null,item.id,2]], [6, [null,null,null,null,null,null,null,null,null,null,null,null,null,item.id,1]]]);
  const cleared: number[][] = []; const sheets: SheetsAdapter = { initializeLedger: async () => undefined, findRowByBillId: async () => 2, findLedgerRows: async (id) => [...rows.entries()].flatMap(([row, values]) => values[13] === id ? [{ row, revision: Number(values[14]) }] : []), appendRow: async () => 8, updateRow: async (row, values) => { rows.set(row, [...values]); }, clearRows: async (targets) => { cleared.push([...targets]); for (const row of targets) rows.delete(row); } };
  await new JobWorker(database, { project_to_sheet: createSheetsProjectionHandler(database, sheets) }, policy, "worker", createLogger("error")).runOnce();
  expect([...rows.keys()]).toEqual([4]); expect(rows.get(4)?.[14]).toBe(2); expect(cleared).toEqual([[6, 2]]);
});

test("supersession after final pre-check compensates only the stale revision row", async () => {
  const item = approvedBill(); const rows = new Map<number, (string | number | null)[]>();
  const sheets: SheetsAdapter = {
    initializeLedger: async () => undefined, findRowByBillId: async () => null,
    findLedgerRows: async (id) => [...rows.entries()].flatMap(([row, values]) => values[13] === id ? [{ row, revision: Number(values[14]) }] : []),
    appendRow: async (values) => { rows.set(2, [...values]); database.supersedeForReview(item.id, "reviewer"); return 2; }, updateRow: async () => undefined,
    clearRows: async (targets) => { for (const row of targets) rows.delete(row); },
  };
  await new JobWorker(database, { project_to_sheet: createSheetsProjectionHandler(database, sheets) }, policy, "worker", createLogger("error")).runOnce();
  expect(rows.size).toBe(0);
});

test("stale projection cleanup repairs a newer approved correction", async () => {
  const item = approvedBill();
  const staleJobId = database.listJobsForBill(item.id)[0]!.id;
  const rows = new Map<number, (string | number | null)[]>([[2, [null,null,null,null,null,null,null,null,null,null,null,null,null,item.id,1]]]);
  let superseded = false;
  const sheets: SheetsAdapter = {
    initializeLedger: async () => undefined,
    findRowByBillId: async () => 2,
    findLedgerRows: async (id) => [...rows.entries()].flatMap(([row, values]) => values[13] === id ? [{ row, revision: Number(values[14]) }] : []),
    appendRow: async (values) => { rows.set(2, [...values]); return 2; },
    updateRow: async (row, values) => {
      rows.set(row, [...values]);
      if (superseded) return;
      superseded = true;
      const current = database.getBill(item.id)!;
      expect(database.submitReview({ billId: item.id, reviewerId: "reviewer", action: "approve", reason: null, note: null, expectedContentRevision: current.contentRevision, expectedReviewRevision: current.reviewRevision, corrected: { ...database.getEffectiveExtraction(item.id)!, vendorName: "Corrected" } }, [])).toBe(true);
      database.sqlite.query("UPDATE jobs SET state = 'succeeded' WHERE idempotency_key = ?").run(`project:${item.id}:2`);
    },
    clearRows: async (targets) => { for (const row of targets) rows.delete(row); },
  };
  const worker = new JobWorker(database, { project_to_sheet: createSheetsProjectionHandler(database, sheets) }, policy, "worker", createLogger("error"));
  await worker.runOnce();
  expect(rows.size).toBe(0);
  expect(database.listJobsForBill(item.id)).toContainEqual(expect.objectContaining({ type: "project_to_sheet", state: "pending", expectedRevision: 2, idempotencyKey: `repair:${staleJobId}:2` }));
  await worker.runOnce();
  expect([...rows.values()]).toContainEqual(expect.arrayContaining(["Corrected"]));
  expect([...rows.values()][0]?.[14]).toBe(2);
});
