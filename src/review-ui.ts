import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config";
import type { ExtractedBill } from "./contracts";
import type { BillDatabase } from "./database";
import { readVerifiedOriginal } from "./originals";

const editable = ["vendorName", "invoiceNumber", "invoiceDate", "currency", "subtotal", "vat", "total", "description"] as const;
type Editable = (typeof editable)[number];
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'" };
const esc = (value: unknown): string => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const page = (title: string, body: string, status = 200): Response => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/review/assets/client.css"></head><body>${body}</body></html>`, { status, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
const appShell = (): Response => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Review queue</title><link rel="stylesheet" href="/review/assets/client.css"></head><body><div id="root"></div><script src="/review/assets/client.js" defer></script></body></html>`, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });

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
function csrfValid(value: string | null, config: AppConfig, user: string, billId: string): boolean { if (!value) return false; const [nonce, signature] = value.split("."); if (!nonce || !signature) return false; const expected = createHmac("sha256", config.review.password).update(`${user}:${billId}:${nonce}`).digest("base64url"); return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); }
function challenge(): Response { return new Response("Unauthorized", { status: 401, headers: { ...headers, "www-authenticate": 'Basic realm="internal review", charset="UTF-8"' } }); }
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
const unavailableExtraction = (): ExtractedBill => ({ schemaVersion: "1", vendorName: null, invoiceNumber: null, invoiceDate: null, currency: null, subtotal: null, vat: null, total: null, description: null, fields: {} });
class FormError extends Error { constructor(readonly status: number) { super("invalid form"); } }
async function parseForm(request: Request): Promise<URLSearchParams> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) throw new FormError(415);
  const reader = request.body?.getReader(); if (!reader) throw new FormError(400); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 32 * 1024) throw new FormError(413); chunks.push(next.value); }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  if (/%(?![0-9A-Fa-f]{2})/.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) throw new FormError(400);
  const form = new URLSearchParams(raw); if ([...form].length > 32 || [...form].some(([key, value]) => key.length > 64 || value.length > (key === "reason" || key === "note" ? 4_096 : key === "description" ? 2_000 : 1_024) || /[\x00-\x1f\x7f]/.test(value))) throw new FormError(413); return form;
}

export async function handleReviewRequest(request: Request, database: BillDatabase, config: AppConfig, assetDir = join(import.meta.dir, "..", "dist", "review")): Promise<Response> {
  const user = authenticated(request, config); if (!user) return challenge();
  const url = new URL(request.url); const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && url.pathname === "/review") {
    return appShell();
  }
  if (url.pathname === "/review/api/bills") {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...headers, allow: "GET" } });
    const bills = database.listReviewBills().map(({ id, status, originalFilename, receivedAt, updatedAt }) => ({ id, status, originalFilename, receivedAt, updatedAt }));
    return Response.json(bills, { headers });
  }
  if (url.pathname === "/review/assets/client.js" || url.pathname === "/review/assets/client.css") {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...headers, allow: "GET" } });
    const name = url.pathname.endsWith(".js") ? "client.js" : "client.css";
    try {
      const content = await readFile(join(assetDir, name));
      return new Response(content, { headers: { ...headers, "content-type": name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" } });
    } catch { return new Response("Not found", { status: 404, headers }); }
  }
  const billId = parts[2]; if (parts[0] !== "review" || parts[1] !== "bills" || !billId || parts.length > 4) return page("Not found", "Not found", 404);
  const bill = database.getBill(billId); if (!bill) return page("Not found", "Not found", 404);
  if (request.method === "GET" && parts[3] === "original") {
    let original: { bytes: Uint8Array; magicMatches: boolean }; try { original = await readVerifiedOriginal({ path: bill.originalPath, root: config.whatsapp.originalsDir, maxBytes: config.whatsapp.maxAttachmentBytes, sha256: bill.contentSha256, mimeType: bill.mimeType, requireMagic: false }); } catch { return page("Not found", "Not found", 404); }
    const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
    return new Response(new Blob([new Uint8Array(original.bytes)]), { headers: { ...headers, "content-type": original.magicMatches ? bill.mimeType : "application/octet-stream", "content-disposition": `${disposition}; filename="${encodeURIComponent(bill.originalFilename ?? "original")}"` } });
  }
  if (request.method === "POST" && parts[3] === "review") {
    try {
      const form = await parseForm(request);
      if (!csrfValid(form.get("csrf"), config, user, billId)) return page("Review failed", "Review submission failed.", 400);
      const action = form.get("action");
      if (action !== "approve" && action !== "reject") return page("Review failed", "Review submission failed.", 400);
      const original = database.getEffectiveExtraction(billId) ?? unavailableExtraction();
      const data = corrected(form, original);
      const content = Number(form.get("contentRevision")); const review = Number(form.get("reviewRevision"));
      if (!Number.isInteger(content) || !Number.isInteger(review) || !database.submitReview({ billId, reviewerId: user, action, reason: null, note: null, expectedContentRevision: content, expectedReviewRevision: review, corrected: data }, [])) return page("Review conflict", "Review submission failed.", 409);
      return new Response(null, { status: 303, headers: { ...headers, location: "/review" } });
    } catch (error) { return page("Review failed", "Review submission failed.", error instanceof FormError ? error.status : 400); }
  }
  if (parts[3] && parts[3] !== "original" && parts[3] !== "review") return page("Not found", "Not found", 404);
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...headers, allow: parts[3] === "review" ? "POST" : "GET" } });
  const extraction = database.getExtraction(billId); const effective = database.getEffectiveExtraction(billId);
  const formData = effective ?? unavailableExtraction();
  const fieldLabels: Record<Exclude<Editable, "description">, string> = { vendorName: "Vendor name", invoiceNumber: "Invoice number", invoiceDate: "Invoice date", currency: "Currency", subtotal: "Subtotal", vat: "VAT", total: "Total" };
  const fields = (Object.keys(fieldLabels) as Exclude<Editable, "description">[]).map((field) => `<label class="review-field" for="${field}"><span>${fieldLabels[field]}</span><input id="${field}" name="${field}" value="${esc(formData[field] ?? "")}"></label>`).join("");
  const extractionUnavailable = !extraction?.normalized;
  return page("Review bill", `<main class="review-page review-detail"><header class="review-detail-header"><a class="queue-back" href="/review">← Review queue</a><div class="review-title"><h1>${esc(bill.id)}</h1><span class="status-badge">${esc(bill.status)}</span></div><nav class="original-actions" aria-label="Original attachment"><a class="button-link" href="/review/bills/${encodeURIComponent(bill.id)}/original">View original</a><a class="button-link button-link-secondary" href="/review/bills/${encodeURIComponent(bill.id)}/original?download=1">Download original</a></nav></header>${extractionUnavailable ? `<p class="notice error permanent-failure">Permanent extraction failure: normalized extraction was not persisted. Enter the corrected bill details below.</p>` : ""}<section class="review-section correction-section" aria-labelledby="correction-heading"><div class="section-heading"><h2 id="correction-heading">Correct bill details</h2><p>Review and correct the extracted values before choosing an outcome.</p></div><form class="correction-form" method="post" action="/review/bills/${encodeURIComponent(bill.id)}/review"><input type="hidden" name="csrf" value="${esc(csrf(config, user, bill.id))}"><input type="hidden" name="contentRevision" value="${bill.contentRevision}"><input type="hidden" name="reviewRevision" value="${bill.reviewRevision}"><div class="form-grid">${fields}</div><label class="review-field review-field-full" for="description"><span>Description</span><textarea id="description" name="description" rows="4">${esc(formData.description ?? "")}</textarea></label><div class="review-actions"><button class="review-action approve-action" name="action" value="approve">Approve bill</button><button class="review-action reject-action" name="action" value="reject">Reject bill</button></div></form></section></main>`);
}
