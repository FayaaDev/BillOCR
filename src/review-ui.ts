import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as XLSX from "xlsx";
import type { AppConfig } from "./config";
import type { ExtractedBill } from "./contracts";
import type { BillDatabase, CompletedInvoiceExportRecord, ReviewQueueFilters } from "./database";
import { readVerifiedOriginal } from "./originals";
import { isSupportedImageMimeType } from "./attachment-mime";
import { isReviewFormField, reviewFieldLimits, reviewFormMaxBytes } from "./review-form";

const editable = ["invoiceDate", "total", "vat", "subtotal", "description", "truckNumber", "vendorTaxNumber", "vendorName", "invoiceNumber"] as const;
type Editable = (typeof editable)[number];
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'" };
/** Columns in the completed-invoice download, in CSV order. */
export const completedInvoiceCsvHeaders = ["تاريخ الفاتورة", "مبلغ اجمالي بعد الضريبة", "قيمة الضريبة", "مبلغ قبل الضريبة", "وصف القطع وبيانها", "رقم الشاحنة ( المسؤليه )", "الرقم الضريبي للمورد", "اسم المورد", "رقم الفاتورة", "رقم مرسل الفاتورة", "تاريخ وتوقيت الارسال"] as const;
const esc = (value: unknown): string => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
function csvCell(value: string | number | null | undefined): string {
  let text = String(value ?? "");
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function completedInvoiceCsv(records: CompletedInvoiceExportRecord[]): string {
  const values = completedInvoiceRows(records);
  return `\uFEFF${[completedInvoiceCsvHeaders, ...values].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
function completedInvoiceRows(records: CompletedInvoiceExportRecord[]): Array<Array<string | number | null>> {
  return records.map(({ receivedAt, senderId, extraction }) => [extraction.invoiceDate ?? null, extraction.total ?? null, extraction.vat ?? null, extraction.subtotal ?? null, extraction.description ?? null, extraction.truckNumber ?? null, extraction.vendorTaxNumber ?? null, extraction.vendorName ?? null, extraction.invoiceNumber ?? null, senderId ?? null, receivedAt]);
}
function completedInvoiceXlsx(records: CompletedInvoiceExportRecord[]): ArrayBuffer {
  const worksheet = XLSX.utils.aoa_to_sheet([[...completedInvoiceCsvHeaders], ...completedInvoiceRows(records)]);
  worksheet["!cols"] = completedInvoiceCsvHeaders.map(() => ({ wch: 24 }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "الفواتير المكتملة");
  const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array", compression: true });
  return bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
const page = (_title: string, body: string, status = 200): Response => new Response(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ماسح الفواتير</title><script src="/review/assets/theme.js"></script><link rel="stylesheet" href="/review/assets/client.css"></head><body>${body}</body></html>`, { status, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
const appShell = (csrfToken: string): Response => new Response(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ماسح الفواتير</title><script src="/review/assets/theme.js"></script><link rel="stylesheet" href="/review/assets/client.css"></head><body><div id="review-actions"></div><div id="root" data-csrf="${esc(csrfToken)}"></div><script src="/review/assets/client.js" defer></script></body></html>`, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
const reviewNavigation = `<nav class="review-tabs" aria-label="التنقل الإداري"><a href="/admin">لوحة الإدارة</a><a href="/review" aria-current="page">مراجعة الفواتير</a></nav>`;

function authenticated(request: Request, config: AppConfig): string | null {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Basic ")) return null;
  let decoded: string; try { decoded = atob(value.slice(6)); } catch { return null; }
  const cut = decoded.indexOf(":"); if (cut < 0) return null;
  const [user, password] = [decoded.slice(0, cut), decoded.slice(cut + 1)];
  // Digest fixed-length inputs before constant-time comparison, including malformed lengths.
  const digest = (item: string) => createHmac("sha256", "review-basic").update(item).digest();
  return timingSafeEqual(digest(user), digest(config.review.username)) && timingSafeEqual(digest(password), digest(config.review.password)) ? user : null;
}
function csrf(config: AppConfig, user: string, billId: string): string { const nonce = randomBytes(16).toString("base64url"); return `${nonce}.${createHmac("sha256", config.review.password).update(`${user}:${billId}:${nonce}`).digest("base64url")}`; }
function csrfValid(value: string | null, config: AppConfig, user: string, billId: string): boolean { const [nonce, signature, extra] = value?.split(".") ?? []; if (!nonce || !signature || extra || nonce.length > 64 || signature.length > 128) return false; const expected = createHmac("sha256", config.review.password).update(`${user}:${billId}:${nonce}`).digest("base64url"); const supplied = Buffer.from(signature); const expectedBytes = Buffer.from(expected); return supplied.byteLength === expectedBytes.byteLength && timingSafeEqual(supplied, expectedBytes); }
function challenge(): Response { return new Response("غير مصرح", { status: 401, headers: { ...headers, "www-authenticate": 'Basic realm="internal review", charset="UTF-8"' } }); }
function numberOrNull(value: string | null): number | null { if (value === null || value.trim() === "") return null; const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error("invalid"); return parsed; }
function valueOrNull(value: string | null): string | null { const result = value?.trim() ?? ""; return result || null; }
function corrected(form: URLSearchParams, original: ExtractedBill): ExtractedBill {
  const result = { ...original, fields: { ...original.fields } };
  for (const field of editable) {
    const value = form.get(field);
    if (field === "subtotal" || field === "vat" || field === "total") result[field] = numberOrNull(value);
    else result[field] = valueOrNull(value);
  }
  return result;
}
function reviewFilters(url: URL): ReviewQueueFilters | null {
  const source = url.searchParams.get("source"); const batchId = url.searchParams.get("batch"); const status = url.searchParams.get("status");
  if ((source !== null && source !== "whatsapp" && source !== "telegram" && source !== "admin_upload") || (batchId !== null && (!/^[A-Za-z0-9_-]{1,128}$/.test(batchId))) || (status !== null && !["received", "extracting", "needs_review", "approved", "failed", "complete", "not_invoice"].includes(status))) return null;
  return { ...(source ? { source } : {}), ...(batchId ? { batchId } : {}), ...(status ? { status: status as ReviewQueueFilters["status"] } : {}) };
}
const unavailableExtraction = (): ExtractedBill => ({ schemaVersion: "1", vendorName: null, vendorTaxNumber: null, invoiceNumber: null, invoiceDate: null, currency: null, subtotal: null, vat: null, total: null, description: null, truckNumber: null, fields: {} });
class FormError extends Error { constructor(readonly status: number) { super("invalid form"); } }
async function parseForm(request: Request): Promise<URLSearchParams> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) throw new FormError(415);
  const reader = request.body?.getReader(); if (!reader) throw new FormError(400); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > reviewFormMaxBytes) throw new FormError(413); chunks.push(next.value); }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  if (/%(?![0-9A-Fa-f]{2})/.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) throw new FormError(400);
  const parsed = new URLSearchParams(raw); const form = new URLSearchParams(); const seen = new Set<string>();
  for (const [key, value] of parsed) {
    if (!isReviewFormField(key)) continue;
    if (seen.has(key)) throw new FormError(400);
    const controls = key === "description" ? /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/;
    if (value.length > (reviewFieldLimits[key as keyof typeof reviewFieldLimits] ?? 1_024) || controls.test(value)) throw new FormError(413);
    seen.add(key); form.append(key, value);
  }
  return form;
}

export async function handleReviewRequest(request: Request, database: BillDatabase, config: AppConfig, assetDir = join(import.meta.dir, "..", "dist", "review")): Promise<Response> {
  const user = authenticated(request, config); if (!user) return challenge();
  const url = new URL(request.url); const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && url.pathname === "/review") {
    return appShell(csrf(config, user, "review-clear-bills"));
  }
  if (url.pathname === "/review/export.csv") {
    if (request.method !== "GET") return new Response("الطريقة غير مسموح بها", { status: 405, headers: { ...headers, allow: "GET" } });
    return new Response(completedInvoiceCsv(database.listCompletedInvoiceExports()), { headers: { ...headers, "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="completed-invoices.csv"' } });
  }
  if (url.pathname === "/review/export.xlsx") {
    if (request.method !== "GET") return new Response("الطريقة غير مسموح بها", { status: 405, headers: { ...headers, allow: "GET" } });
    return new Response(completedInvoiceXlsx(database.listCompletedInvoiceExports()), { headers: { ...headers, "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": 'attachment; filename="completed-invoices.xlsx"' } });
  }
  if (url.pathname === "/review/api/bills") {
    if (request.method !== "GET") return new Response("الطريقة غير مسموح بها", { status: 405, headers: { ...headers, allow: "GET" } });
    const filters = reviewFilters(url); if (!filters) return new Response("طلب غير صالح", { status: 400, headers });
    const bills = database.listReviewBills(filters).map(({ id, source, status, displayStatus, batchId, sourceSenderId, receivedAt, updatedAt, extraction }) => ({
      id, source, status, displayStatus, batchId, invoiceDate: extraction?.invoiceDate ?? null, total: extraction?.total ?? null, currency: extraction?.currency ?? null, vat: extraction?.vat ?? null,
      subtotal: extraction?.subtotal ?? null, description: extraction?.description ?? null, truckNumber: extraction?.truckNumber ?? null,
      vendorTaxNumber: extraction?.vendorTaxNumber ?? null, vendorName: extraction?.vendorName ?? null,
      invoiceNumber: extraction?.invoiceNumber ?? null, senderId: source === "admin_upload" ? null : sourceSenderId, receivedAt, updatedAt,
    }));
    return Response.json(bills, { headers });
  }
  if (url.pathname === "/review/api/bills/clear") {
    if (request.method !== "POST") return new Response("الطريقة غير مسموح بها", { status: 405, headers: { ...headers, allow: "POST" } });
    if (!csrfValid(request.headers.get("x-csrf-token"), config, user, "review-clear-bills")) return new Response("طلب غير صالح", { status: 400, headers });
    const result = database.clearAllBills();
    if ("busy" in result) return new Response("تعذر حذف الفواتير أثناء معالجة نشطة. حاول مرة أخرى بعد اكتمال المعالجة.", { status: 409, headers });
    return Response.json(result, { headers });
  }
  const font = /^\/review\/assets\/files\/(noto-sans-arabic-arabic-(?:400|700)-normal\.woff2)$/.exec(url.pathname)?.[1];
  if (url.pathname === "/review/assets/client.js" || url.pathname === "/review/assets/theme.js" || url.pathname === "/review/assets/client.css" || font) {
    if (request.method !== "GET") return new Response("الطريقة غير مسموح بها", { status: 405, headers: { ...headers, allow: "GET" } });
    const name = font ? join("files", font) : url.pathname.endsWith("client.js") ? "client.js" : url.pathname.endsWith("theme.js") ? "theme.js" : "client.css";
    try {
      const content = await readFile(join(assetDir, name));
      return new Response(content, { headers: { ...headers, "content-type": name.endsWith(".js") ? "text/javascript; charset=utf-8" : name.endsWith(".woff2") ? "font/woff2" : "text/css; charset=utf-8" } });
    } catch { return new Response("غير موجود", { status: 404, headers }); }
  }
  const billId = parts[2]; if (parts[0] !== "review" || parts[1] !== "bills" || !billId || parts.length > 4) return page("غير موجود", "غير موجود", 404);
  const bill = database.getBill(billId); if (!bill) return page("غير موجود", "غير موجود", 404);
  if (request.method === "GET" && parts[3] === "original") {
    let original: { bytes: Uint8Array; magicMatches: boolean }; try { original = await readVerifiedOriginal({ path: bill.originalPath, root: config.originals.dir, maxBytes: config.originals.maxAttachmentBytes, sha256: bill.contentSha256, mimeType: bill.mimeType, requireMagic: false }); } catch { return page("غير موجود", "غير موجود", 404); }
    const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
    return new Response(new Blob([new Uint8Array(original.bytes)]), { headers: { ...headers, "content-type": original.magicMatches ? bill.mimeType : "application/octet-stream", "content-disposition": `${disposition}; filename="${encodeURIComponent(bill.originalFilename ?? "original")}"` } });
  }
  if (request.method === "POST" && parts[3] === "review") {
    try {
      const form = await parseForm(request);
      if (!csrfValid(form.get("csrf"), config, user, billId)) return page("تعذرت المراجعة", "تعذر إرسال المراجعة.", 400);
      const action = form.get("action");
       if (action === "mark_not_invoice" || action === "reclassify_invoice") {
         const content = Number(form.get("contentRevision")); const review = Number(form.get("reviewRevision"));
         if (!Number.isInteger(content) || !Number.isInteger(review) || !database.overrideClassification({ billId, reviewerId: user, action, expectedContentRevision: content, expectedReviewRevision: review })) return page("تعارض في المراجعة", "تعذر إرسال المراجعة بسبب تغيير أحدث.", 409);
         return new Response(null, { status: 303, headers: { ...headers, location: `/review/bills/${encodeURIComponent(billId)}` } });
       }
       if (action !== "approve" && action !== "reject") return page("تعذرت المراجعة", "تعذر إرسال المراجعة.", 400);
      const original = database.getEffectiveExtraction(billId) ?? unavailableExtraction();
      const data = corrected(form, original);
      const content = Number(form.get("contentRevision")); const review = Number(form.get("reviewRevision"));
      if (!Number.isInteger(content) || !Number.isInteger(review) || !database.submitReview({ billId, reviewerId: user, action, reason: null, note: null, expectedContentRevision: content, expectedReviewRevision: review, corrected: data }, [])) return page("تعارض في المراجعة", "تعذر إرسال المراجعة بسبب تغيير أحدث.", 409);
      return new Response(null, { status: 303, headers: { ...headers, location: "/review" } });
    } catch (error) { const status = error instanceof FormError ? error.status : 400; return page("تعذرت المراجعة", status === 413 ? "بيانات المراجعة أكبر من الحد المسموح. اختصر القيم ثم حاول مرة أخرى." : "تعذر إرسال المراجعة.", status); }
  }
  if (parts[3] && parts[3] !== "original" && parts[3] !== "review") return page("غير موجود", "غير موجود", 404);
  if (request.method !== "GET") return new Response("الطريقة غير مسموح بها", { status: 405, headers: { ...headers, allow: parts[3] === "review" ? "POST" : "GET" } });
  const extraction = database.getExtraction(billId); const effective = database.getEffectiveExtraction(billId);
  const formData = effective ?? unavailableExtraction();
  const canSubmitReview = bill.classification === "not_invoice" || bill.status === "needs_review" || bill.status === "failed" || bill.status === "approved";
  const fieldLabels: Record<Editable, string> = { invoiceDate: "تاريخ الفاتورة", total: "مبلغ اجمالي بعد الضريبة", vat: "قيمة الضريبة", subtotal: "مبلغ قبل الضريبة", description: "وصف القطع وبيانها", truckNumber: "رقم الشاحنة ( المسؤليه )", vendorTaxNumber: "الرقم الضريبي للمورد", vendorName: "اسم المورد", invoiceNumber: "رقم الفاتورة" };
  const readOnly = canSubmitReview ? "" : " readonly";
  const fields = editable.map((field) => `<label class="review-field${field === "description" ? " review-field-full" : ""}" for="${field}"><span>${fieldLabels[field]}</span>${field === "description" ? `<textarea id="description" name="description" rows="4" maxlength="${reviewFieldLimits.description}"${readOnly}>${esc(formData.description ?? "")}</textarea>` : `<input id="${field}" name="${field}" value="${esc(formData[field] ?? "")}" maxlength="${reviewFieldLimits[field]}"${readOnly}>`}</label>`).join("");
  const extractionUnavailable = !extraction?.normalized;
   const statusLabels: Record<string, string> = { needs_review: "تحتاج إلى مراجعة", approved: "مكتملة", failed: "فشلت", pending: "قيد الانتظار", not_invoice: "ليست فاتورة" };
  const originalUrl = `/review/bills/${encodeURIComponent(bill.id)}/original`;
  const originalPreview = isSupportedImageMimeType(bill.mimeType) ? `<a class="button-link" id="original-preview-trigger" href="${originalUrl}">عرض الأصل</a><dialog id="original-preview-dialog" aria-labelledby="original-preview-title"><div class="original-preview-content"><h2 id="original-preview-title">عرض الأصل</h2><button class="button-link button-link-secondary" type="button" id="original-preview-close">إغلاق عرض الأصل</button><img id="original-preview-image" alt="معاينة الأصل"></div></dialog>` : `<a class="button-link" href="${originalUrl}">عرض الأصل</a>`;
   const csrfInput = `<input type="hidden" name="csrf" value="${esc(csrf(config, user, bill.id))}"><input type="hidden" name="contentRevision" value="${bill.contentRevision}"><input type="hidden" name="reviewRevision" value="${bill.reviewRevision}">`;
   const override = bill.classification === "not_invoice" ? `<button class="review-action" name="action" value="reclassify_invoice">إعادة تصنيفها كفاتورة للمراجعة اليدوية</button>` : `<button class="review-action reject-action" name="action" value="mark_not_invoice">وضع علامة ليست فاتورة</button>`;
    const reviewActions = bill.classification === "not_invoice" ? override : `<button class="review-action approve-action" name="action" value="approve">${bill.status === "approved" ? "حفظ التعديلات" : "اعتماد الفاتورة"}</button><button class="review-action reject-action" name="action" value="reject">رفض الفاتورة</button>${override}`;
     const senderId = bill.source === "admin_upload" ? "" : bill.sourceSenderId;
    const sourceFields = `<label class="review-field" for="senderId"><span>رقم مرسل الفاتورة</span><input id="senderId" value="${esc(senderId)}" readonly></label><label class="review-field" for="receivedAt"><span>تاريخ وتوقيت الارسال</span><input id="receivedAt" value="${esc(bill.receivedAt)}" readonly></label>`;
    const correction = canSubmitReview
      ? `<form id="review-correction-form" class="correction-form" method="post" action="/review/bills/${encodeURIComponent(bill.id)}/review">${csrfInput}<div class="form-grid">${fields}${sourceFields}</div><p id="review-form-error" class="notice error review-form-error" role="alert" aria-live="polite"></p><div class="review-actions">${reviewActions}</div></form>`
      : `<div class="correction-form"><div class="form-grid">${fields}${sourceFields}</div><p class="notice">تكتمل معالجة الفاتورة قبل مراجعتها.</p></div>`;
      return page("مراجعة الفاتورة", `<main class="review-page review-detail"><header class="review-detail-header">${reviewNavigation}<a class="queue-back" href="/review">قائمة المراجعة →</a><div class="review-title"><h1 dir="ltr">${esc(bill.id)}</h1><span class="status-badge">${esc(bill.classification === "not_invoice" ? statusLabels.not_invoice : statusLabels[bill.status] ?? bill.status)}</span></div><nav class="original-actions" aria-label="المرفق الأصلي">${originalPreview}<a class="button-link button-link-secondary" href="${originalUrl}?download=1">تنزيل الأصل</a></nav></header>${extractionUnavailable ? `<p class="notice error permanent-failure">تعذر استخراج بيانات الفاتورة. أدخل البيانات المصححة أدناه.</p>` : ""}<section class="review-section correction-section" aria-labelledby="correction-heading"><div class="section-heading"><h2 id="correction-heading">تصحيح بيانات الفاتورة</h2><p>${canSubmitReview ? "راجع القيم المستخرجة وصححها قبل تحديد الإجراء." : "يمكنك عرض البيانات الآن، وستتاح المراجعة بعد اكتمال المعالجة."}</p></div>${correction}</section></main><script src="/review/assets/client.js" defer></script>`);
}
