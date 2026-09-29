import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as XLSX from "xlsx";
import type { AppConfig } from "./config";
import type { ExtractedBill } from "./contracts";
import type { BillDatabase, CompletedInvoiceExportRecord, ReviewQueueFilters } from "../db/database";
import { readVerifiedOriginal, removeVerifiedOriginal } from "./originals";
import { isSupportedImageMimeType } from "./attachment-mime";
import { isReviewFormField, reviewFieldLimits, reviewFormMaxBytes } from "../frontend/review-form";
import { reviewAuth, type ReviewAuth } from "./review-auth";

const editable = ["invoiceDate", "total", "vat", "subtotal", "description", "truckNumber", "vendorTaxNumber", "vendorName", "invoiceNumber"] as const;
type Editable = (typeof editable)[number];
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'" };
/** Columns in the completed-invoice XLSX download. */
export const completedInvoiceHeaders = ["تاريخ الفاتورة", "مبلغ اجمالي بعد الضريبة", "قيمة الضريبة", "مبلغ قبل الضريبة", "وصف القطع وبيانها", "رقم الشاحنة ( المسؤليه )", "الرقم الضريبي للمورد", "اسم المورد", "رقم الفاتورة", "رقم مرسل الفاتورة", "تاريخ وتوقيت الارسال"] as const;
const esc = (value: unknown): string => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
function completedInvoiceRows(records: CompletedInvoiceExportRecord[]): Array<Array<string | number | null>> {
  return records.map(({ receivedAt, senderId, extraction }) => [extraction.invoiceDate ?? null, extraction.total ?? null, extraction.vat ?? null, extraction.subtotal ?? null, extraction.description ?? null, extraction.truckNumber ?? null, extraction.vendorTaxNumber ?? null, extraction.vendorName ?? null, extraction.invoiceNumber ?? null, senderId ?? null, receivedAt]);
}
function completedInvoiceXlsx(records: CompletedInvoiceExportRecord[]): ArrayBuffer {
  const worksheet = XLSX.utils.aoa_to_sheet([[...completedInvoiceHeaders], ...completedInvoiceRows(records)]);
  worksheet["!cols"] = completedInvoiceHeaders.map(() => ({ wch: 24 }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "الفواتير المكتملة");
  const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array", compression: true });
  return bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
const designContract = `<!-- dashboard-01: user-pinned neutral invoice workflow. THESIS: compare the original and accounting fields before deciding. OWN-WORLD: dark neutral shadcn tokens, restrained borders and shared radii. STORY: inspect, correct, approve or reclassify. FIRST VIEWPORT: compact navigation, document beside native fields; stacked on mobile. FORM: dashboard-01. -->`;
const page = (title: string, body: string, status = 200): Response => new Response(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><script src="/review/assets/theme.js"></script><link rel="stylesheet" href="/review/assets/client.css"></head><body>${designContract}${status >= 400 ? `<main class="flex min-h-svh items-center justify-center p-6"><section class="flex w-full max-w-lg flex-col gap-6 rounded-xl border bg-card p-6 text-card-foreground" aria-labelledby="error-title"><h1 id="error-title">${esc(title)}</h1><p role="alert">${esc(body)}</p><nav class="flex flex-wrap gap-3" aria-label="العودة"><a class="button-link" href="/admin">لوحة الإدارة</a><a class="button-link button-link-secondary" href="/review">مراجعة الفواتير</a></nav></section></main>` : body}</body></html>`, { status, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
const appShell = (csrfToken: string, logoutCsrf: string): Response => page("ماسح الفواتير", `<div id="root" data-csrf="${esc(csrfToken)}" data-clear-csrf="${esc(csrfToken)}" data-logout-csrf="${esc(logoutCsrf)}"></div><script type="module" src="/review/assets/client.js"></script>`);
const reviewNavigation = (logoutCsrf: string) => `<nav class="review-tabs flex flex-wrap items-center gap-3 border-b pb-4" aria-label="التنقل الإداري"><a class="button-link button-link-secondary" href="/admin">لوحة الإدارة</a><a class="button-link button-link-secondary" href="/admin?view=integrations">التكاملات</a><a class="button-link button-link-secondary" href="/review/export.xlsx">تصدير الفواتير</a><form class="ms-auto" method="post" action="/logout"><input type="hidden" name="logoutCsrf" value="${esc(logoutCsrf)}"><button class="button-link button-link-secondary" type="submit">تسجيل الخروج</button></form></nav>`;
function csrf(config: AppConfig, user: string, binding: string, billId: string): string { const nonce = randomBytes(16).toString("base64url"); return `${nonce}.${createHmac("sha256", config.review.password).update(`${user}:${binding}:${billId}:${nonce}`).digest("base64url")}`; }
export function reviewClearCsrf(config: AppConfig, user: string, binding: string): string { return csrf(config, user, binding, "review-clear-bills"); }
function csrfValid(value: string | null, config: AppConfig, user: string, binding: string, billId: string): boolean { const [nonce, signature, extra] = value?.split(".") ?? []; if (!nonce || !signature || extra || nonce.length > 64 || signature.length > 128) return false; const expected = createHmac("sha256", config.review.password).update(`${user}:${binding}:${billId}:${nonce}`).digest("base64url"); const supplied = Buffer.from(signature); const expectedBytes = Buffer.from(expected); return supplied.byteLength === expectedBytes.byteLength && timingSafeEqual(supplied, expectedBytes); }
function unauthorized(request: Request, pathname: string): Response { return request.method === "GET" && !pathname.includes("/api/") && !pathname.includes("/assets/") && !pathname.endsWith("/original") && !pathname.includes("/export.") ? new Response(null, { status: 303, headers: { ...headers, location: `/login?return=${pathname.startsWith("/admin") ? "/admin" : "/review"}` } }) : new Response("غير مصرح", { status: 401, headers }); }
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

export async function handleReviewRequest(request: Request, database: BillDatabase, config: AppConfig, assetDir = join(import.meta.dir, import.meta.path.endsWith(".ts") ? "../../dist/review" : "review"), auth: ReviewAuth = reviewAuth(config)): Promise<Response> {
  const url = new URL(request.url); const parts = url.pathname.split("/").filter(Boolean);
  const font = /^\/review\/assets\/files\/(noto-sans-arabic-arabic-(?:400|700)-normal\.woff2)$/.exec(url.pathname)?.[1];
  if (!auth.user(request) && request.method === "GET" && (url.pathname === "/review/assets/theme.js" || url.pathname === "/review/assets/client.css" || font)) {
    const name = font ? join("files", font) : url.pathname.endsWith("theme.js") ? "theme.js" : "client.css";
    try { const content = await readFile(join(assetDir, name)); return new Response(content, { headers: { ...headers, "content-type": name.endsWith(".js") ? "text/javascript; charset=utf-8" : name.endsWith(".woff2") ? "font/woff2" : "text/css; charset=utf-8" } }); } catch { return new Response("غير موجود", { status: 404, headers }); }
  }
  const user = auth.user(request); const binding = auth.binding(request); if (!user || !binding) return unauthorized(request, url.pathname);
  if (request.method === "GET" && url.pathname === "/review") {
    return appShell(reviewClearCsrf(config, user, binding), auth.csrf(request, "logout")!);
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
    if (!csrfValid(request.headers.get("x-csrf-token"), config, user, binding, "review-clear-bills")) return new Response("طلب غير صالح", { status: 400, headers });
    const result = database.clearAllBills();
    if ("busy" in result) return new Response("تعذر حذف الفواتير أثناء معالجة نشطة. حاول مرة أخرى بعد اكتمال المعالجة.", { status: 409, headers });
    return Response.json(result, { headers });
  }
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
       if (!csrfValid(form.get("csrf"), config, user, binding, billId)) return page("تعذرت المراجعة", "تعذر إرسال المراجعة.", 400);
       const action = form.get("action");
       if (action === "delete_bill") {
         const content = Number(form.get("contentRevision")); const review = Number(form.get("reviewRevision"));
         if (!Number.isInteger(content) || !Number.isInteger(review)) return page("تعذر حذف الفاتورة", "تعذر حذف الفاتورة.", 400);
         const resuming = database.hasBillDeletionRequest(billId);
         if (!resuming) {
           try { await readVerifiedOriginal({ path: bill.originalPath, root: config.originals.dir, maxBytes: config.originals.maxAttachmentBytes, sha256: bill.contentSha256, mimeType: bill.mimeType, requireMagic: false }); }
           catch { return page("تعذر حذف الفاتورة", "تعذر التحقق من الملف الأصلي، لذلك لم تُحذف الفاتورة.", 409); }
         }
         const result = database.prepareBillDeletion({ billId, expectedContentRevision: content, expectedReviewRevision: review });
         if ("busy" in result) return page("تعذر حذف الفاتورة", "تعذر حذف الفاتورة أثناء معالجة نشطة. حاول مرة أخرى بعد اكتمال المعالجة.", 409);
         if ("stale" in result) return page("تعارض في المراجعة", "تعذر حذف الفاتورة بسبب تغيير أحدث.", 409);
         if ("missing" in result) return page("غير موجود", "غير موجود", 404);
         try { await removeVerifiedOriginal({ path: bill.originalPath, root: config.originals.dir, maxBytes: config.originals.maxAttachmentBytes, sha256: bill.contentSha256, mimeType: bill.mimeType }); }
         catch { return page("تعذر حذف الفاتورة", "تعذر حذف الملف الأصلي. حاول مرة أخرى.", 500); }
         if (!database.completeBillDeletion(billId)) return page("تعذر حذف الفاتورة", "تعذر إكمال حذف الفاتورة. حاول مرة أخرى.", 500);
         return new Response(null, { status: 303, headers: { ...headers, location: "/review" } });
       }
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
  const originalPreview = isSupportedImageMimeType(bill.mimeType) ? `<a class="button-link original-preview-trigger" href="${originalUrl}">عرض الأصل</a><dialog id="original-preview-dialog" aria-labelledby="original-preview-title"><div class="original-preview-content"><h2 id="original-preview-title">عرض الأصل</h2><button class="button-link button-link-secondary" type="button" id="original-preview-close">إغلاق عرض الأصل</button><img id="original-preview-image" alt="معاينة الأصل"></div></dialog>` : `<a class="button-link" href="${originalUrl}">عرض الأصل</a>`;
   const csrfInput = `<input type="hidden" name="csrf" value="${esc(csrf(config, user, binding, bill.id))}"><input type="hidden" name="contentRevision" value="${bill.contentRevision}"><input type="hidden" name="reviewRevision" value="${bill.reviewRevision}">`;
    const override = bill.classification === "not_invoice" ? `<button class="review-action" name="action" value="reclassify_invoice">إعادة تصنيفها كفاتورة للمراجعة اليدوية</button>` : `<button class="review-action reject-action" name="action" value="mark_not_invoice">وضع علامة ليست فاتورة</button>`;
    const deleteAction = `<button class="review-action delete-action" name="action" value="delete_bill">حذف الفاتورة</button>`;
     const reviewActions = bill.classification === "not_invoice" ? `${override}${deleteAction}` : `<button class="review-action approve-action" name="action" value="approve">${bill.status === "approved" ? "حفظ التعديلات" : "اعتماد الفاتورة"}</button><button class="review-action reject-action" name="action" value="reject">رفض الفاتورة</button>${override}${deleteAction}`;
     const senderId = bill.source === "admin_upload" ? "" : bill.sourceSenderId;
    const sourceFields = `<label class="review-field" for="senderId"><span>رقم مرسل الفاتورة</span><input id="senderId" value="${esc(senderId)}" readonly></label><label class="review-field" for="receivedAt"><span>تاريخ وتوقيت الارسال</span><input id="receivedAt" value="${esc(bill.receivedAt)}" readonly></label>`;
    const correction = canSubmitReview
      ? `<form id="review-correction-form" class="correction-form" method="post" action="/review/bills/${encodeURIComponent(bill.id)}/review">${csrfInput}<div class="form-grid">${fields}${sourceFields}</div><p id="review-form-error" class="notice error review-form-error" role="alert" aria-live="polite"></p><div class="review-actions">${reviewActions}</div></form>`
      : `<div class="correction-form"><div class="form-grid">${fields}${sourceFields}</div><p class="notice">تكتمل معالجة الفاتورة قبل مراجعتها.</p></div>`;
   const documentPreview = isSupportedImageMimeType(bill.mimeType)
      ? `<a class="original-preview-trigger" href="${originalUrl}"><img class="mx-auto max-h-[65vh] w-full object-contain" src="${originalUrl}" alt="المرفق الأصلي للفاتورة"></a>`
     : `<div class="flex min-h-64 flex-col items-center justify-center gap-4 p-6 text-center"><p class="text-muted-foreground">${bill.mimeType === "application/pdf" ? "مستند PDF" : "المرفق الأصلي"}</p><p>افتح الأصل لمقارنة بياناته بالحقول المستخرجة.</p><a class="button-link button-link-secondary" href="${originalUrl}">عرض الأصل</a></div>`;
   return page("مراجعة الفاتورة", `<main class="mx-auto flex max-w-[1440px] flex-col gap-6 p-4 md:p-6">${reviewNavigation(auth.csrf(request, "logout")!)}<header class="flex flex-col gap-3"><a class="queue-back" href="/review">العودة إلى الفواتير</a><div class="review-title"><h1>مراجعة الفاتورة</h1><span class="status-badge">${esc(bill.classification === "not_invoice" ? statusLabels.not_invoice : statusLabels[bill.status] ?? bill.status)}</span></div><p class="text-sm text-muted-foreground"><bdi dir="ltr" class="break-all">${esc(bill.id)}</bdi></p></header>${extractionUnavailable ? `<p class="notice error permanent-failure" role="alert">تعذر استخراج بيانات الفاتورة. أدخل البيانات المصححة أدناه.</p>` : ""}<div class="grid min-w-0 items-start gap-6 lg:grid-cols-2"><section class="min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground lg:sticky lg:top-6" aria-labelledby="document-heading"><div class="flex flex-col gap-4 border-b p-5"><h2 id="document-heading" class="text-lg font-semibold">المرفق الأصلي</h2><nav class="original-actions" aria-label="المرفق الأصلي">${originalPreview}<a class="button-link button-link-secondary" href="${originalUrl}?download=1">تنزيل الأصل</a></nav></div><div class="bg-muted/30 p-4">${documentPreview}</div></section><section class="correction-section flex min-w-0 flex-col gap-6 rounded-xl border bg-card p-5 text-card-foreground" aria-labelledby="correction-heading"><div class="flex flex-col gap-2"><h2 id="correction-heading" class="text-lg font-semibold">تصحيح بيانات الفاتورة</h2><p class="text-sm text-muted-foreground">${canSubmitReview ? "راجع القيم المستخرجة وصححها قبل تحديد الإجراء." : "يمكنك عرض البيانات الآن، وستتاح المراجعة بعد اكتمال المعالجة."}</p></div>${correction}</section></div></main><script type="module" src="/review/assets/client.js"></script>`);
}
