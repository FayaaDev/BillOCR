import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase } from "../src/database";
import { completedInvoiceCsvHeaders, handleReviewRequest } from "../src/review-ui";
import type { AppConfig } from "../src/config";
import { createReviewCorrectionSyncHandler, createSheetsProjectionHandler, type SheetsAdapter } from "../src/google-projections";
import { JobWorker } from "../src/worker";
import { createLogger } from "../src/logger";
import { handleRequest } from "../src/http";
import * as XLSX from "xlsx";

let dir: string; let assetDir: string; let database: BillDatabase; let config: AppConfig; let id: string;
const basic = (user = "alice", password = "password") => ({ authorization: `Basic ${btoa(`${user}:${password}`)}` });
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "review-ui-"))); const originals = join(dir, "originals");
  assetDir = join(dir, "review-assets"); mkdirSync(originals); mkdirSync(assetDir); mkdirSync(join(assetDir, "files")); writeFileSync(join(originals, "bill.png"), "original"); writeFileSync(join(assetDir, "client.js"), 'window.reviewQueue = "/review/api/bills";'); writeFileSync(join(assetDir, "theme.js"), 'window.reviewTheme = true;'); writeFileSync(join(assetDir, "client.css"), ".review-page{}"); writeFileSync(join(assetDir, "files", "noto-sans-arabic-arabic-400-normal.woff2"), "font"); database = new BillDatabase(join(dir, "db.sqlite"));
  config = { host: "127.0.0.1", port: 0, dataDir: dir, databasePath: join(dir, "db.sqlite"), logLevel: "error", originals: { dir: originals, maxAttachmentBytes: 1 }, telegram: { enabled: false, botToken: null, groupIds: [], pollTimeoutSeconds: 30, requestTimeoutMs: 35_000, maxResponseBytes: 1 }, whatsapp: { enabled: false, groupId: "g", authPath: dir, originalsDir: originals, maxAttachmentBytes: 1 }, mistral: { apiKey: "x", model: "x", maxResponseBytes: 1, requestTimeoutMs: 1 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1, requestTimeoutMs: 1, pollIntervalMs: 0, fallbackConfidenceThreshold: .80 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 }, google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "alice", password: "password" }, validation: { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, jobs: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 1 } };
  id = database.createBillWithInitialJobs({ id: "review-bill", whatsappMessageId: "m", whatsappGroupId: "g", whatsappSenderId: "s", attachmentIndex: 0, receivedAt: "2026-08-01T00:00:00.000Z", mimeType: "image/png", originalPath: join(originals, "bill.png"), contentSha256: "a".repeat(64) }, [{ type: "extract", idempotencyKey: "extract:review" }]).bill.id;
  database.sqlite.query("UPDATE bills SET status = 'needs_review', content_revision = 1 WHERE id = ?").run(id);
  database.sqlite.query("INSERT INTO extractions (id,bill_id,schema_version,normalized_json,raw_provider_response,provider_model,prompt_schema_version,requested_at,completed_at,created_at,updated_at) VALUES ('e',?,'1',?,'<unsafe>','model','schema','2026-08-01','2026-08-01','2026-08-01','2026-08-01')").run(id, JSON.stringify({ schemaVersion: "1", vendorName: "<img src=x>", invoiceNumber: null, invoiceDate: "2026-08-01", currency: "USD", subtotal: 9, vat: 1, total: 10, description: "فلتر زيت\nزيت محرك", fields: { total: { confidence: .1, sourceText: "x" } } }));
});
afterEach(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });

test("review requires Basic auth, escapes model output, and protects originals", async () => {
  expect((await handleReviewRequest(new Request("http://x/review"), database, config)).status).toBe(401);
  const detail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  expect(detail.headers.get("cache-control")).toBe("no-store"); expect(await detail.text()).not.toContain("<img src=x>");
  database.sqlite.query("UPDATE bills SET original_path = ? WHERE id = ?").run(join(dir, "outside"), id);
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/original`, { headers: basic() }), database, config)).status).toBe(404);
});

test("review detail renders an accessible image-original preview while PDFs retain the original link", async () => {
  const detail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const html = await detail.text();
  expect(html).toContain('<html lang="ar" dir="rtl">');
  expect(html).toContain('src="/review/assets/theme.js"');
  expect(html).toContain('<main class="review-page review-detail">'); expect(html).toContain('class="queue-back" href="/review"'); expect(html).toContain('class="status-badge">تحتاج إلى مراجعة</span>');
   expect(html).toContain('class="review-tabs" aria-label="التنقل الإداري"'); expect(html).toContain('href="/admin">لوحة الإدارة</a>'); expect(html).toContain('href="/review" aria-current="page">مراجعة الفواتير</a>'); expect(html).toContain('class="original-actions"'); expect(html).toContain('id="original-preview-trigger" href="/review/bills/review-bill/original"'); expect(html).toContain('<dialog id="original-preview-dialog" aria-labelledby="original-preview-title">'); expect(html).toContain('id="original-preview-close"'); expect(html).toContain('إغلاق عرض الأصل'); expect(html).toContain('id="original-preview-image"'); expect(html).toContain('src="/review/assets/client.js" defer'); expect(html).toContain('href="/review/bills/review-bill/original?download=1"'); expect(html).not.toContain('بيانات النموذج الأصلية'); expect(html).not.toContain('>Evidence</h2>'); expect(html).not.toContain('Immutable extraction data and review history.'); expect(html).not.toContain('Immutable model output'); expect(html).not.toContain('Confidence'); expect(html).not.toContain('Validation issues'); expect(html).not.toContain('Provenance'); expect(html).not.toContain('Audit events');
  database.sqlite.query("UPDATE bills SET mime_type = 'application/pdf' WHERE id = ?").run(id);
  const pdf = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const pdfHtml = await pdf.text();
  expect(pdfHtml).toContain('href="/review/bills/review-bill/original">عرض الأصل</a>'); expect(pdfHtml).not.toContain('original-preview-dialog');
  expect(html).toContain('class="correction-form"'); expect(html).toContain('<label class="review-field" for="vendorName"><span>اسم المورد</span>'); expect(html).toContain('<textarea id="description" name="description" rows="4">فلتر زيت\nزيت محرك</textarea>'); expect(html).not.toContain('name="handwritten"'); expect(html).not.toContain('name="reason"'); expect(html).not.toContain('name="note"'); expect(html).not.toContain('Reason for decision'); expect(html).not.toContain('Review note'); expect(html).toContain('class="review-action approve-action"'); expect(html).toContain('>اعتماد الفاتورة</button>'); expect(html).toContain('class="review-action reject-action"'); expect(html).toContain('>رفض الفاتورة</button>');
  expect(html).toContain('name="truckNumber" value=""'); expect(html).toContain('name="vendorTaxNumber" value=""'); expect(html).toContain('<span>رقم مرسل الفاتورة</span><input id="senderId" value="s" readonly>');
  const orderedLabels = ["تاريخ الفاتورة", "مبلغ اجمالي بعد الضريبة", "قيمة الضريبة", "مبلغ قبل الضريبة", "وصف القطع وبيانها", "رقم الشاحنة ( المسؤليه )", "الرقم الضريبي للمورد", "اسم المورد", "رقم الفاتورة", "رقم مرسل الفاتورة", "تاريخ وتوقيت الارسال"];
  const labelOffsets = orderedLabels.map((label) => html.indexOf(`<span>${label}</span>`));
  expect(labelOffsets.every((offset, index) => offset >= 0 && (index === 0 || offset > labelOffsets[index - 1]!))).toBe(true);
});

test("review queue shell, API, and fixed assets are authenticated", async () => {
  expect((await handleReviewRequest(new Request("http://x/review/api/bills"), database, config)).status).toBe(401);
  expect((await handleReviewRequest(new Request("http://x/review/assets/client.js"), database, config)).status).toBe(401);
  const shell = await handleReviewRequest(new Request("http://x/review", { headers: basic() }), database, config);
  const html = await shell.text();
  expect(html).toContain('<html lang="ar" dir="rtl">'); expect(html).toContain('<title>ماسح الفواتير</title>');
  expect(shell.headers.get("content-security-policy")).toContain("script-src 'self'"); expect(shell.headers.get("content-security-policy")).toContain("style-src 'self'"); expect(shell.headers.get("content-security-policy")).toContain("connect-src 'self'");
  expect(html).not.toContain('href="/review/export.csv"'); expect(html).toMatch(/<div id="root" data-csrf="[^"]+"><\/div>/); expect(html).toContain('<div id="review-actions"></div>'); expect(html).toContain('src="/review/assets/theme.js"'); expect(html).toContain('src="/review/assets/client.js"'); expect(html).toContain('href="/review/assets/client.css"'); expect(html).not.toContain("review-bill"); expect(html).not.toContain("<unsafe>");
  const clientSource = readFileSync(join(import.meta.dir, "..", "src", "review-client.tsx"), "utf8");
   expect(clientSource).toContain('href="/admin"'); expect(clientSource).toContain('aria-current="page"'); expect(clientSource).toContain('<Button variant="outline" render={<a href="/review/export.csv" />}'); expect(clientSource).toContain('<Button variant="outline" render={<a href="/review/export.xlsx" />}'); expect(clientSource).toContain('<Button variant="destructive"'); expect(clientSource).toContain('"x-csrf-token": csrf');
  for (const label of ["تاريخ الفاتورة", "الإجمالي بعد الضريبة", "قيمة الضريبة", "المبلغ قبل الضريبة", "الوصف", "رقم الشاحنة", "الرقم الضريبي للمورد", "اسم المورد", "رقم الفاتورة", "معرف المرسل", "تاريخ ووقت الاستلام", "معرف الدفعة"]) expect(clientSource).toContain(label);
  expect(clientSource).toContain('<ul className="ticket-list"');
  expect(clientSource).toContain('href={`/review/bills/${encodeURIComponent(bill.id)}`}');
  expect(clientSource).toContain('aria-current={number === pagination.page ? "page" : undefined}');
  expect(clientSource).toContain('<bdi dir="ltr"');
  expect(clientSource).not.toContain("@tanstack/react-table");
  const api = await handleReviewRequest(new Request("http://x/review/api/bills", { headers: basic() }), database, config);
   expect(api.headers.get("content-type")).toContain("application/json"); expect(api.headers.get("cache-control")).toBe("no-store"); expect(await api.json()).toEqual([{ id, source: "whatsapp", status: "needs_review", displayStatus: "needs_review", batchId: null, invoiceDate: "2026-08-01", total: 10, currency: "USD", vat: 1, subtotal: 9, description: "فلتر زيت\nزيت محرك", truckNumber: null, vendorTaxNumber: null, vendorName: "<img src=x>", invoiceNumber: null, senderId: "s", receivedAt: "2026-08-01T00:00:00.000Z", updatedAt: database.getBill(id)!.updatedAt }]);
  const apiPost = await handleReviewRequest(new Request("http://x/review/api/bills", { method: "POST", headers: basic() }), database, config);
  expect(apiPost.status).toBe(405); expect(apiPost.headers.get("allow")).toBe("GET");
  const script = await handleReviewRequest(new Request("http://x/review/assets/client.js", { headers: basic() }), database, config, assetDir);
  expect(script.status).toBe(200); expect(script.headers.get("content-type")).toContain("text/javascript"); expect(await script.text()).toContain("/review/api/bills");
  const theme = await handleReviewRequest(new Request("http://x/review/assets/theme.js", { headers: basic() }), database, config, assetDir);
  expect(theme.status).toBe(200); expect(theme.headers.get("content-type")).toContain("text/javascript"); expect(await theme.text()).toContain("reviewTheme");
  const font = await handleReviewRequest(new Request("http://x/review/assets/files/noto-sans-arabic-arabic-400-normal.woff2", { headers: basic() }), database, config, assetDir);
  expect(font.status).toBe(200); expect(font.headers.get("content-type")).toBe("font/woff2"); expect(await font.text()).toBe("font");
  const stylesheet = await handleReviewRequest(new Request("http://x/review/assets/client.css", { headers: basic() }), database, config, assetDir);
  expect(stylesheet.status).toBe(200); expect(stylesheet.headers.get("content-type")).toContain("text/css"); expect(await stylesheet.text()).toContain(".review-page");
  expect((await handleReviewRequest(new Request("http://x/review/assets/other.js", { headers: basic() }), database, config)).status).toBe(404);
  expect((await handleReviewRequest(new Request("http://x/review/assets/client.css", { method: "POST", headers: basic() }), database, config)).status).toBe(405);
});

test("review clear endpoint is authenticated, CSRF-protected, and leaves originals and non-bill state intact", async () => {
  const batch = database.createAdminUploadBatch({ idempotencyKey: "clear-batch", originalFilename: "bills.zip" }).batch;
  const item = database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex: 0, entryPath: "bill.pdf" }).item;
  const uploaded = database.createBillWithInitialJobs({ id: "clear-upload", whatsappMessageId: "clear-upload", whatsappGroupId: "admin-upload", whatsappSenderId: "admin-upload", attachmentIndex: 0, receivedAt: "2026-08-02T00:00:00.000Z", mimeType: "application/pdf", originalPath: join(config.originals.dir, "bill.png"), contentSha256: "b".repeat(64), source: "admin_upload", sourceIdentity: "clear-upload", extractionPolicy: "azure_only", batchItemId: item.id }, [{ type: "extract", idempotencyKey: "extract:clear-upload" }]).bill;
  database.setTelegramPollingCursor(99);
  database.reserveDriveId({ key: "folder", kind: "folder", parentId: null, logicalPath: "folder", generatedId: "folder-id" });
  database.reserveDriveId({ key: "bill", kind: "file", parentId: null, logicalPath: "bill", generatedId: "bill-id", billId: uploaded.id });
  expect((await handleReviewRequest(new Request("http://x/review/api/bills/clear", { headers: basic() }), database, config)).status).toBe(405);
  expect((await handleReviewRequest(new Request("http://x/review/api/bills/clear", { method: "POST", headers: basic() }), database, config)).status).toBe(400);
  const shell = await handleReviewRequest(new Request("http://x/review", { headers: basic() }), database, config);
  const csrf = /data-csrf="([^"]+)"/.exec(await shell.text())?.[1]; if (!csrf) throw new Error("missing CSRF");
  const now = new Date().toISOString(); const jobId = database.listJobsForBill(id)[0]!.id;
  database.sqlite.query("INSERT INTO extraction_attempts (id,bill_id,job_id,job_attempt,provider,requested_at,completed_at,outcome,created_at) VALUES ('clear-attempt',?,?,1,'azure',?,'now','succeeded',?)").run(id, jobId, now, now);
  database.sqlite.query("INSERT INTO extraction_invocations (id,bill_id,job_id,job_attempt,provider,idempotency_key,requested_at,completed_at,outcome,created_at,updated_at) VALUES ('clear-invocation',?,?,1,'azure','clear-invocation',?,'now','succeeded',?,?)").run(id, jobId, now, now, now);
  database.sqlite.query("INSERT INTO azure_extraction_operations (id,invocation_id,bill_id,job_id,operation_location,state,completed_at,created_at,updated_at) VALUES ('clear-operation','clear-invocation',?,?,'https://operation.example','succeeded','now',?,?)").run(id, jobId, now, now);
  database.sqlite.query("UPDATE extractions SET selected_invocation_id = 'clear-invocation' WHERE bill_id = ?").run(id);
  database.sqlite.query("INSERT INTO validation_issues (id,bill_id,field,code,message,severity,created_at) VALUES ('clear-issue',?,'total','missing_total','missing','blocking',?)").run(id, now);
  database.sqlite.query("INSERT INTO review_events (id,bill_id,reviewer_id,action,created_at) VALUES ('clear-review',?,'alice','approve',?)").run(id, now);
  database.sqlite.query("INSERT INTO bill_classification_events (id,bill_id,from_classification,to_classification,actor,content_revision,review_revision,created_at) VALUES ('clear-classification',?,'unclassified','invoice','alice',1,1,?)").run(id, now);
  database.sqlite.query("INSERT INTO provider_projection_metadata (id,bill_id,provider,projection_key,created_at,updated_at) VALUES ('clear-projection',?,'drive','clear-projection',?,?)").run(id, now, now);
  database.sqlite.query("INSERT INTO effective_bill_data (bill_id,normalized_json,revision,updated_at) VALUES (?, '{}', 1, ?)").run(id, now);
  database.sqlite.query("UPDATE jobs SET state = 'running' WHERE id = ?").run(jobId);
  const busy = await handleReviewRequest(new Request("http://x/review/api/bills/clear", { method: "POST", headers: { ...basic(), "x-csrf-token": csrf } }), database, config);
  expect(busy.status).toBe(409); expect(await busy.text()).toBe("تعذر حذف الفواتير أثناء معالجة نشطة. حاول مرة أخرى بعد اكتمال المعالجة."); expect(database.getBill(id)).not.toBeNull(); expect(database.getBill(uploaded.id)).not.toBeNull(); expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM extraction_invocations").get()?.count).toBe(1);
  database.sqlite.query("UPDATE jobs SET state = 'pending' WHERE id = ?").run(jobId);
  const cleared = await handleReviewRequest(new Request("http://x/review/api/bills/clear", { method: "POST", headers: { ...basic(), "x-csrf-token": csrf } }), database, config);
  expect(await cleared.json()).toEqual({ deleted: 2 });
  expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM bills").get()?.count).toBe(0);
  expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM admin_upload_batches").get()?.count).toBe(0);
  for (const table of ["admin_upload_batch_items", "jobs", "job_transition_history", "extractions", "extraction_attempts", "extraction_invocations", "azure_extraction_operations", "validation_issues", "review_events", "bill_classification_events", "provider_projection_metadata", "effective_bill_data"]) expect(database.sqlite.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(0);
  expect(database.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(database.getTelegramPollingCursor()).toBe(99); expect(database.getDriveReservation("folder")).not.toBeNull(); expect(database.getDriveReservation("bill")).toBeNull(); expect(readFileSync(join(config.originals.dir, "bill.png"))).toEqual(Buffer.from("original"));
  const second = await handleReviewRequest(new Request("http://x/review/api/bills/clear", { method: "POST", headers: { ...basic(), "x-csrf-token": csrf } }), database, config);
  expect(await second.json()).toEqual({ deleted: 0 });
});

test("review lists and serves a verified Telegram original from shared storage", async () => {
  const bytes = new TextEncoder().encode("telegram-original"); const path = join(config.originals.dir, "telegram.png"); writeFileSync(path, bytes);
  const telegram = database.createBillWithInitialJobs({ id: "telegram-review", source: "telegram", sourceMessageId: "tg-message", sourceChatId: "tg-chat", sourceSenderId: "tg-sender", attachmentIndex: 0, receivedAt: "2026-08-03T00:00:00.000Z", mimeType: "image/png", originalPath: path, contentSha256: createHash("sha256").update(bytes).digest("hex") }, []).bill;
  database.sqlite.query("UPDATE bills SET status = 'needs_review' WHERE id = ?").run(telegram.id);
  config.originals.maxAttachmentBytes = bytes.byteLength;
  config.whatsapp.originalsDir = join(dir, "whatsapp-only");
  const queue = await handleReviewRequest(new Request("http://x/review/api/bills?source=telegram", { headers: basic() }), database, config);
  expect(await queue.json()).toMatchObject([{ id: telegram.id, senderId: "tg-sender" }]);
  const original = await handleReviewRequest(new Request(`http://x/review/bills/${telegram.id}/original`, { headers: basic() }), database, config);
  expect(original.status).toBe(200); expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes);
});

test("completed-invoice exports are authenticated, use reviewed data, and exclude incomplete records", async () => {
  const batch = database.createAdminUploadBatch({ idempotencyKey: "csv-batch", originalFilename: "invoices.zip" }).batch;
  const create = (index: number, state: "complete" | "not_invoice" | "failed", status: "approved" | "failed" = "approved") => {
    const item = database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex: index, entryPath: `invoice-${index}.pdf` }).item;
    const bill = database.createBillWithInitialJobs({ id: `csv-${index}`, whatsappMessageId: `admin-upload:${batch.id}:${index}`, whatsappGroupId: "admin-upload", whatsappSenderId: "csv-sender", attachmentIndex: 0, receivedAt: "2026-08-02T00:00:00.000Z", mimeType: "application/pdf", originalPath: join(dir, "originals", "bill.png"), contentSha256: "b".repeat(64), source: "admin_upload", sourceIdentity: `admin-upload:${batch.id}:${index}`, extractionPolicy: "azure_only", classification: state === "not_invoice" ? "not_invoice" : "invoice", batchItemId: item.id }, [{ type: "extract", idempotencyKey: `extract:csv-${index}` }]).bill;
    database.sqlite.query("UPDATE bills SET status = ? WHERE id = ?").run(status, bill.id);
    database.sqlite.query("UPDATE admin_upload_batch_items SET state = ? WHERE id = ?").run(state, item.id);
    database.sqlite.query("INSERT INTO extractions (id,bill_id,schema_version,normalized_json,raw_provider_response,created_at,updated_at) VALUES (?,?, '1', ?, 'provider raw data must not export', 'now', 'now')").run(`csv-extraction-${index}`, bill.id, JSON.stringify({ schemaVersion: "1", vendorName: "=Raw vendor", invoiceNumber: "RAW", invoiceDate: "2026-08-02", currency: "USD", subtotal: 9, vat: 1, total: 10, description: "raw", fields: {} }));
    return bill;
  };
  const complete = create(0, "complete");
   database.sqlite.query("INSERT INTO effective_bill_data (bill_id,normalized_json,revision,updated_at) VALUES (?, ?, 1, 'now')").run(complete.id, JSON.stringify({ schemaVersion: "1", vendorName: "=Reviewed, Inc.", vendorTaxNumber: "310123456700003", invoiceNumber: "\"INV\"\n1", invoiceDate: "2026-08-03", currency: "USD", subtotal: 9, vat: 1, total: 10, description: "@reviewed\nsecond item", truckNumber: "+TRK-7", fields: {} }));
  const telegram = database.createBillWithInitialJobs({ id: "csv-telegram", source: "telegram", sourceMessageId: "csv-telegram-message", sourceChatId: "csv-telegram-chat", sourceSenderId: "csv-telegram-sender", attachmentIndex: 0, receivedAt: "2026-08-04T00:00:00.000Z", mimeType: "image/png", originalPath: join(dir, "originals", "telegram.png"), contentSha256: "c".repeat(64), classification: "invoice" }, []).bill;
  database.sqlite.query("UPDATE bills SET status = 'approved' WHERE id = ?").run(telegram.id);
  database.sqlite.query("INSERT INTO extractions (id,bill_id,schema_version,normalized_json,created_at,updated_at) VALUES ('csv-telegram-extraction',?, '1', ?, 'now', 'now')").run(telegram.id, JSON.stringify({ schemaVersion: "1", vendorName: "Telegram vendor", invoiceNumber: "TG-1", invoiceDate: "2026-08-04", currency: "SAR", subtotal: 18, vat: 2, total: 20, description: "telegram", fields: {} }));
  create(1, "not_invoice");
  create(2, "failed");
  create(3, "complete", "failed");

  expect((await handleReviewRequest(new Request("http://x/review/export.csv"), database, config)).status).toBe(401);
  const response = await handleReviewRequest(new Request("http://x/review/export.csv", { headers: basic() }), database, config);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("content-disposition")).toBe('attachment; filename="completed-invoices.csv"');
   expect(await response.text()).toBe("\uFEFFتاريخ الفاتورة,مبلغ اجمالي بعد الضريبة,قيمة الضريبة,مبلغ قبل الضريبة,وصف القطع وبيانها,رقم الشاحنة ( المسؤليه ),الرقم الضريبي للمورد,اسم المورد,رقم الفاتورة,رقم مرسل الفاتورة,تاريخ وتوقيت الارسال\r\n2026-08-03,10,1,9,\"'@reviewed\nsecond item\",'+TRK-7,310123456700003,\"'=Reviewed, Inc.\",\"\"\"INV\"\"\n1\",,2026-08-02T00:00:00.000Z\r\n2026-08-04,20,2,18,telegram,,,Telegram vendor,TG-1,csv-telegram-sender,2026-08-04T00:00:00.000Z\r\n");
   const post = await handleReviewRequest(new Request("http://x/review/export.csv", { method: "POST", headers: basic() }), database, config);
   expect(post.status).toBe(405); expect(post.headers.get("allow")).toBe("GET");
   expect((await handleReviewRequest(new Request("http://x/review/export.xlsx"), database, config)).status).toBe(401);
   const xlsx = await handleReviewRequest(new Request("http://x/review/export.xlsx", { headers: basic() }), database, config);
   expect(xlsx.status).toBe(200);
   expect(xlsx.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
   expect(xlsx.headers.get("content-disposition")).toBe('attachment; filename="completed-invoices.xlsx"');
   const workbook = XLSX.read(await xlsx.arrayBuffer(), { type: "array" });
   expect(workbook.SheetNames).toEqual(["الفواتير المكتملة"]);
   expect(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]!]!, { header: 1, raw: true, defval: null })).toEqual([
     [...completedInvoiceCsvHeaders],
     ["2026-08-03", 10, 1, 9, "@reviewed\nsecond item", "+TRK-7", "310123456700003", "=Reviewed, Inc.", '"INV"\n1', null, "2026-08-02T00:00:00.000Z"],
     ["2026-08-04", 20, 2, 18, "telegram", null, null, "Telegram vendor", "TG-1", "csv-telegram-sender", "2026-08-04T00:00:00.000Z"],
   ]);
   const xlsxPost = await handleReviewRequest(new Request("http://x/review/export.xlsx", { method: "POST", headers: basic() }), database, config);
   expect(xlsxPost.status).toBe(405); expect(xlsxPost.headers.get("allow")).toBe("GET");
});

test("CSRF-protected corrected approval preserves model output and is exactly once", async () => {
  const detail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await detail.text())?.[1]; if (!csrf) throw new Error("missing csrf");
  const form = new URLSearchParams({ csrf, contentRevision: "1", reviewRevision: "0", action: "approve", vendorName: "Vendor", vendorTaxNumber: "310123456700003", invoiceNumber: "N", invoiceDate: "2026-08-01", subtotal: "9", vat: "1", total: "10", description: "ok", truckNumber: "TRK-7" });
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: { ...basic(), "content-type": "application/x-www-form-urlencoded" }, body: form }), database, config)).status).toBe(303);
  expect(database.getBill(id)).toMatchObject({ status: "approved", contentRevision: 2, reviewRevision: 1 }); expect(database.getExtraction(id)?.normalized?.vendorName).toBe("<img src=x>");
  expect(database.getReviewEvents(id)).toMatchObject([{ reason: null, note: null }]); expect(database.getEffectiveExtraction(id)).toMatchObject({ vendorName: "Vendor", vendorTaxNumber: "310123456700003", truckNumber: "TRK-7", currency: "USD" });
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: { ...basic(), "content-type": "application/x-www-form-urlencoded" }, body: form }), database, config)).status).toBe(409);
  expect(database.getReviewEvents(id)).toHaveLength(1); expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) count FROM jobs WHERE type = 'project_to_sheet'").get()?.count).toBe(1);
});

test("crafted NotInvoice approval POST makes no canonical or audit mutation", async () => {
  database.sqlite.query("UPDATE bills SET classification = 'not_invoice', status = 'failed', manual_review_required = 1 WHERE id = ?").run(id);
  database.sqlite.query("INSERT INTO validation_issues (id,bill_id,field,code,message,severity,observed_value,created_at) VALUES ('issue',?,'total','total_mismatch','mismatch','blocking','null','now')").run(id);
  const detail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await detail.text())?.[1]; if (!csrf) throw new Error("missing csrf");
  const before = database.getBill(id); const events = database.getReviewEvents(id); const issues = database.getValidationIssues(id); const effective = database.getEffectiveExtraction(id);
  const form = new URLSearchParams({ csrf, contentRevision: "1", reviewRevision: "0", action: "approve", vendorName: "crafted", invoiceDate: "2026-08-01", total: "10" });
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: { ...basic(), "content-type": "application/x-www-form-urlencoded" }, body: form }), database, config)).status).toBe(409);
  expect(database.getBill(id)).toEqual(before); expect(database.getReviewEvents(id)).toEqual(events); expect(database.getValidationIssues(id)).toEqual(issues); expect(database.getEffectiveExtraction(id)).toEqual(effective);
});

test("review approval accepts an extraction-length description", async () => {
  const description = "d".repeat(2_000);
  database.sqlite.query("UPDATE extractions SET normalized_json = ? WHERE bill_id = ?").run(JSON.stringify({ schemaVersion: "1", vendorName: "Vendor", invoiceNumber: "N", invoiceDate: "2026-08-01", currency: "USD", subtotal: 9, vat: 1, total: 10, description, fields: { total: { confidence: .1, sourceText: "x" } } }), id);
  const detail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await detail.text())?.[1]; if (!csrf) throw new Error("missing csrf");
  const form = new URLSearchParams({ csrf, contentRevision: "1", reviewRevision: "0", action: "approve", vendorName: "Vendor", invoiceNumber: "N", invoiceDate: "2026-08-01", currency: "USD", subtotal: "9", vat: "1", total: "10", description });
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: { ...basic(), "content-type": "application/x-www-form-urlencoded" }, body: form }), database, config)).status).toBe(303);
});

test("review mutations require bounded urlencoded forms and exact routes", async () => {
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: basic(), body: "x=y" }), database, config)).status).toBe(415);
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: { ...basic(), "content-type": "application/x-www-form-urlencoded" }, body: "csrf=%ZZ" }), database, config)).status).toBe(400);
  expect((await handleRequest(new Request("http://x/reviewevil", { headers: basic() }), database, config)).status).toBe(404);
  const method = await handleReviewRequest(new Request(`http://x/review/bills/${id}/original`, { method: "POST", headers: basic() }), database, config); expect(method.status).toBe(405); expect(method.headers.get("allow")).toBe("GET");
});

test("rejection creates no ledger projection and reconciles a stale hidden-ID row", async () => {
  const original = database.getExtraction(id)?.normalized; if (!original) throw new Error("missing extraction");
  database.sqlite.query("INSERT INTO provider_projection_metadata (id,bill_id,provider,projection_key,external_id,created_at,updated_at) VALUES ('sheet',?,'sheets',?,'3','now','now')").run(id, id);
  expect(database.submitReview({ billId: id, reviewerId: "alice", action: "reject", reason: "not a bill", note: "discard", expectedContentRevision: 1, expectedReviewRevision: 0, corrected: original }, [])).toBe(true);
  expect(database.getBill(id)?.status).toBe("failed"); expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) count FROM jobs WHERE type = 'project_to_sheet' AND state IN ('pending','retryable_failure')").get()?.count).toBe(0);
  const rows = [3]; const sheets: SheetsAdapter = { initializeLedger: async () => undefined, findRowByBillId: async () => rows[0] ?? null, findRowsByBillId: async () => [...rows], clearRows: async () => { rows.length = 0; }, appendRow: async () => 4, updateRow: async () => undefined };
  await new JobWorker(database, { sync_review_correction: createReviewCorrectionSyncHandler(database, sheets) }, { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 }, "test", createLogger("error")).runOnce();
  expect(rows).toEqual([]);
});

test("stale rejection sync repairs a reapproved current projection after clearing its row", async () => {
  const original = database.getExtraction(id)?.normalized; if (!original) throw new Error("missing extraction");
  database.sqlite.query("UPDATE bills SET status = 'failed', manual_review_required = 1, content_revision = 2, review_revision = 1 WHERE id = ?").run(id);
  database.sqlite.query("INSERT INTO provider_projection_metadata (id,bill_id,provider,projection_key,external_id,external_url,created_at,updated_at) VALUES ('drive',?,'drive',?,'drive-file','https://drive.example/file','now','now')").run(id, id);
  database.sqlite.query("INSERT INTO jobs (id,bill_id,type,state,idempotency_key,attempts,available_at,expected_revision,created_at,updated_at) VALUES ('sync',?,'sync_review_correction','pending','sync_review_correction:review-bill:1',0,?,1,?,?)").run(id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  const rows = new Map<number, (string | number | null)[]>([[3, [null, null, null, null, null, null, null, null, null, null, null, "failed", null, id, 2]]]);
  let found!: () => void; let resume!: () => void; const paused = new Promise<void>((resolve) => { found = resolve; }); const release = new Promise<void>((resolve) => { resume = resolve; });
  const sheets: SheetsAdapter = {
    initializeLedger: async () => undefined,
    findRowByBillId: async (billId) => [...rows.entries()].find(([, values]) => values[13] === billId)?.[0] ?? null,
    findRowsByBillId: async (billId) => { const matched = [...rows.entries()].filter(([, values]) => values[13] === billId).map(([row]) => row); found(); await release; return matched; },
    findLedgerRows: async (billId) => [...rows.entries()].filter(([, values]) => values[13] === billId).map(([row, values]) => ({ row, revision: Number(values[14]) })),
    clearRows: async (targets) => { for (const row of targets) rows.delete(row); },
    appendRow: async (values) => { rows.set(4, [...values]); return 4; }, updateRow: async (row, values) => { rows.set(row, [...values]); },
  };
  const policy = { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 };
  const sync = new JobWorker(database, { sync_review_correction: createReviewCorrectionSyncHandler(database, sheets) }, policy, "sync", createLogger("error"));
  const syncing = sync.runOnce(); await paused;
  expect(database.approveReviewCorrection({ billId: id, reviewerId: "alice", expectedContentRevision: 2, expectedReviewRevision: 1 })).toBe(true);
  await new JobWorker(database, { project_to_sheet: createSheetsProjectionHandler(database, sheets) }, policy, "current", createLogger("error")).runOnce();
  expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) count FROM jobs WHERE type = 'project_to_sheet' AND state = 'succeeded'").get()?.count).toBe(1);
  resume(); await syncing;
  const repair = database.sqlite.query<{ id: string }, []>("SELECT id FROM jobs WHERE idempotency_key = 'repair:sync:2'").get(); expect(repair).not.toBeNull();
  await new JobWorker(database, { project_to_sheet: createSheetsProjectionHandler(database, sheets) }, policy, "repair", createLogger("error")).runOnce();
  expect(database.getJob(repair!.id)?.state).toBe("succeeded"); expect([...rows.values()].filter((values) => values[13] === id && values[14] === 2)).toHaveLength(1); expect(database.getBill(id)?.status).toBe("approved");
});

test("reclassification schedules revision-current cleanup when NotInvoice cleanup is still pending", async () => {
  database.sqlite.query("UPDATE bills SET status = 'approved', classification = 'invoice', content_revision = 1 WHERE id = ?").run(id);
  database.sqlite.query("INSERT INTO provider_projection_metadata (id,bill_id,provider,projection_key,external_id,created_at,updated_at) VALUES ('reclassify-sheet',?,'sheets',?,'3','now','now')").run(id, id);
  expect(database.overrideClassification({ billId: id, reviewerId: "alice", action: "mark_not_invoice", expectedContentRevision: 1, expectedReviewRevision: 0 })).toBe(true);
  expect(database.overrideClassification({ billId: id, reviewerId: "alice", action: "reclassify_invoice", expectedContentRevision: 2, expectedReviewRevision: 1 })).toBe(true);
  const rows = [3];
  const sheets: SheetsAdapter = { initializeLedger: async () => undefined, findRowByBillId: async () => rows[0] ?? null, findRowsByBillId: async () => [...rows], clearRows: async () => { rows.length = 0; }, appendRow: async () => 4, updateRow: async () => undefined };
  const worker = new JobWorker(database, { sync_review_correction: createReviewCorrectionSyncHandler(database, sheets) }, { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 }, "reclassify", createLogger("error"));
  expect(await worker.runOnce()).toBe(true); // stale NotInvoice revision cannot clear the newer review state.
  expect(rows).toEqual([3]);
  expect(await worker.runOnce()).toBe(true); // current reclassification revision removes the old projection.
  expect(rows).toEqual([]);
  expect(database.getBill(id)).toMatchObject({ classification: "invoice", status: "needs_review" });
});

test("NotInvoice cleanup removes a Sheets row appended before projection persistence, then reclassification remains revision-safe", async () => {
  database.sqlite.query("UPDATE bills SET status = 'approved', classification = 'invoice', content_revision = 1 WHERE id = ?").run(id);
  database.sqlite.query("INSERT INTO provider_projection_metadata (id,bill_id,provider,projection_key,external_id,external_url,created_at,updated_at) VALUES ('drive',?,'drive',?,'drive-file','https://drive.example/file','now','now')").run(id, id);
  database.ensureCurrentProjectionJob(id);
  const rows = new Map<number, (string | number | null)[]>();
  const sheets: SheetsAdapter = { initializeLedger: async () => undefined, findRowByBillId: async () => null, findRowsByBillId: async (billId) => [...rows.entries()].filter(([, values]) => values[13] === billId).map(([row]) => row), appendRow: async (values) => { rows.set(3, [...values]); throw new Error("process died after append"); }, updateRow: async () => undefined, clearRows: async (targets) => { for (const row of targets) rows.delete(row); } };
  const policy = { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 };
  await new JobWorker(database, { project_to_sheet: createSheetsProjectionHandler(database, sheets) }, policy, "crashed", createLogger("error")).runOnce();
  expect(rows.size).toBe(1); expect(database.getProjectionMetadata("sheets", id)).toBeNull();
  expect(database.overrideClassification({ billId: id, reviewerId: "alice", action: "mark_not_invoice", expectedContentRevision: 1, expectedReviewRevision: 0 })).toBe(true);
  expect(database.overrideClassification({ billId: id, reviewerId: "alice", action: "reclassify_invoice", expectedContentRevision: 2, expectedReviewRevision: 1 })).toBe(true);
  const sync = new JobWorker(database, { sync_review_correction: createReviewCorrectionSyncHandler(database, sheets) }, policy, "cleanup", createLogger("error"));
  await sync.runOnce(); // stale NotInvoice revision cannot clear the newer reclassification state.
  expect(rows.size).toBe(1);
  await sync.runOnce();
  expect(rows.size).toBe(0); expect(database.getBill(id)).toMatchObject({ classification: "invoice", status: "needs_review" });
});

test("permanent extraction failure renders a corrective form and can be approved", async () => {
  database.sqlite.query("DELETE FROM extractions WHERE bill_id = ?").run(id);
  database.sqlite.query("INSERT INTO extractions (id,bill_id,schema_version,normalized_json,provider_model,prompt_schema_version,requested_at,completed_at,error_details,created_at,updated_at) VALUES ('failed',?,'1',NULL,'model','schema','2026-08-01','2026-08-02','malformed provider output','now','now')").run(id);
  database.sqlite.query("UPDATE jobs SET state = 'permanent_failure' WHERE bill_id = ?").run(id);
  const detail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const html = await detail.text(); expect(detail.status).toBe(200); expect(html).toContain("تعذر استخراج بيانات الفاتورة. أدخل البيانات المصححة أدناه."); expect(html).not.toContain('>Evidence</h2>'); expect(html).toContain('name="vendorName"'); expect(html).toContain('class="correction-form"');
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]; if (!csrf) throw new Error("missing csrf");
  const form = new URLSearchParams({ csrf, contentRevision: "1", reviewRevision: "0", action: "approve", vendorName: "Vendor", invoiceNumber: "N", invoiceDate: "2026-08-01", currency: "USD", subtotal: "9", vat: "1", total: "10", description: "ok" });
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: { ...basic(), "content-type": "application/x-www-form-urlencoded" }, body: form }), database, config)).status).toBe(303);
  expect(database.getBill(id)?.status).toBe("approved"); expect(database.getEffectiveExtraction(id)?.vendorName).toBe("Vendor");
});

test("manual approval bypasses automated factual validation", async () => {
  const detail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await detail.text())?.[1]; if (!csrf) throw new Error("missing csrf");
  const form = new URLSearchParams({ csrf, contentRevision: "1", reviewRevision: "0", action: "approve", vendorName: "Vendor", invoiceNumber: "N", invoiceDate: "2026-08-01", currency: "NOT", subtotal: "9", vat: "1", total: "20", description: "ok" });
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: { ...basic(), "content-type": "application/x-www-form-urlencoded" }, body: form }), database, config)).status).toBe(303);
  expect(database.getBill(id)?.status).toBe("approved");
});

test("unified queue filters sources, batches, Complete, and NotInvoice", async () => {
  const batch = database.createAdminUploadBatch({ idempotencyKey: "review-filter-batch", originalFilename: "upload.zip" }).batch;
  const item = database.createAdminUploadBatchItem({ batchId: batch.id, itemIndex: 0, entryPath: "not-invoice.pdf" }).item;
  const uploaded = database.createBillWithInitialJobs({ id: "not-invoice", whatsappMessageId: "admin-review", whatsappGroupId: "admin-upload", whatsappSenderId: "admin-upload", attachmentIndex: 0, receivedAt: "2026-08-03T00:00:00.000Z", mimeType: "application/pdf", originalPath: join(dir, "originals", "bill.png"), contentSha256: "c".repeat(64), source: "admin_upload", sourceIdentity: "admin-review", extractionPolicy: "azure_only", classification: "not_invoice", batchItemId: item.id }, [{ type: "extract", idempotencyKey: "extract:admin-review" }]).bill;
  database.sqlite.query("UPDATE bills SET status = 'failed' WHERE id = ?").run(uploaded.id);
  const all = await handleReviewRequest(new Request("http://x/review/api/bills?source=admin_upload&batch=" + batch.id + "&status=not_invoice", { headers: basic() }), database, config);
  expect(await all.json()).toMatchObject([{ id: uploaded.id, senderId: null }]);
  database.sqlite.query("UPDATE bills SET status = 'approved', classification = 'invoice' WHERE id = ?").run(id);
  const complete = await handleReviewRequest(new Request("http://x/review/api/bills?source=whatsapp&status=complete", { headers: basic() }), database, config);
  expect(await complete.json()).toMatchObject([{ id }]);
  expect((await handleReviewRequest(new Request("http://x/review/api/bills?source=telegram", { headers: basic() }), database, config)).status).toBe(200);
  expect((await handleReviewRequest(new Request("http://x/review/api/bills?source=wrong", { headers: basic() }), database, config)).status).toBe(400);
});

test("classification overrides are CSRF and revision guarded, audited, and remove stale Sheets work", async () => {
  database.sqlite.query("UPDATE bills SET status = 'approved', classification = 'invoice', content_revision = 1 WHERE id = ?").run(id);
  database.sqlite.query("INSERT INTO provider_projection_metadata (id,bill_id,provider,projection_key,external_id,created_at,updated_at) VALUES ('override-sheet',?,'sheets',?,'4','now','now')").run(id, id);
  const detail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await detail.text())?.[1]; if (!csrf) throw new Error("missing csrf");
  const post = (body: URLSearchParams) => handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: { ...basic(), "content-type": "application/x-www-form-urlencoded" }, body }), database, config);
  expect((await post(new URLSearchParams({ csrf: "bad", contentRevision: "1", reviewRevision: "0", action: "mark_not_invoice" }))).status).toBe(400);
  expect((await post(new URLSearchParams({ csrf, contentRevision: "0", reviewRevision: "0", action: "mark_not_invoice" }))).status).toBe(409);
  expect((await post(new URLSearchParams({ csrf, contentRevision: "1", reviewRevision: "0", action: "mark_not_invoice" }))).status).toBe(303);
  expect(database.getBill(id)).toMatchObject({ classification: "not_invoice", status: "failed", contentRevision: 2, reviewRevision: 1 });
  expect(database.getReviewEvents(id).at(-1)).toMatchObject({ reviewerId: "alice", action: "mark_not_invoice" });
  expect(database.listJobsForBill(id).some((job) => job.type === "sync_review_correction" && job.state === "pending")).toBe(true);
  const notInvoiceDetail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const notInvoiceHtml = await notInvoiceDetail.text();
  expect(notInvoiceHtml).not.toContain('value="approve"');
  const notInvoiceCsrf = /name="csrf" value="([^"]+)"/.exec(notInvoiceHtml)?.[1]; if (!notInvoiceCsrf) throw new Error("missing csrf");
  expect((await post(new URLSearchParams({ csrf: notInvoiceCsrf, contentRevision: "2", reviewRevision: "1", action: "approve", vendorName: "Vendor", invoiceNumber: "N", invoiceDate: "2026-08-01", currency: "USD", subtotal: "9", vat: "1", total: "10", description: "ok" }))).status).toBe(409);
  const stale = new URLSearchParams({ csrf, contentRevision: "1", reviewRevision: "0", action: "reclassify_invoice" });
  expect((await post(stale)).status).toBe(409);
  const reclassifyDetail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const fresh = /name="csrf" value="([^"]+)"/.exec(await reclassifyDetail.text())?.[1]; if (!fresh) throw new Error("missing csrf");
  expect((await post(new URLSearchParams({ csrf: fresh, contentRevision: "2", reviewRevision: "1", action: "reclassify_invoice" }))).status).toBe(303);
  expect(database.getBill(id)).toMatchObject({ classification: "invoice", status: "needs_review" });
});
