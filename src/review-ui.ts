import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config";
import type { ExtractedBill } from "./contracts";
import type { BillDatabase } from "./database";
import { validateExtractedBill } from "./validation";
import { readVerifiedOriginal } from "./originals";

const editable = ["vendorName", "invoiceNumber", "invoiceDate", "currency", "subtotal", "vat", "total", "description", "handwritten"] as const;
type Editable = (typeof editable)[number];
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'" };
const esc = (value: unknown): string => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const page = (title: string, body: string, status = 200): Response => new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:sans-serif;max-width:1000px;margin:2rem auto}label{display:block;margin:.5rem 0}input,textarea{min-width:30rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}.error{color:#900}</style></head><body>${body}</body></html>`, { status, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });

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
    else if (field === "handwritten") result.handwritten = value === "true" ? true : value === "false" ? false : null;
    else result[field] = valueOrNull(value);
  }
  return result;
}
const unavailableExtraction = (): ExtractedBill => ({ schemaVersion: "1", vendorName: null, invoiceNumber: null, invoiceDate: null, currency: null, subtotal: null, vat: null, total: null, description: null, handwritten: null, fields: {} });
function safeError(value: string | null): string | null {
  if (!value) return null;
  if (/malformed|invalid structured|schema/i.test(value)) return "malformed_provider_output";
  if (/timeout/i.test(value)) return "provider_timeout";
  if (/rate|429/i.test(value)) return "provider_rate_limited";
  return "provider_failure";
}
class FormError extends Error { constructor(readonly status: number) { super("invalid form"); } }
async function parseForm(request: Request): Promise<URLSearchParams> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) throw new FormError(415);
  const reader = request.body?.getReader(); if (!reader) throw new FormError(400); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 32 * 1024) throw new FormError(413); chunks.push(next.value); }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  if (/%(?![0-9A-Fa-f]{2})/.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) throw new FormError(400);
  const form = new URLSearchParams(raw); if ([...form].length > 32 || [...form].some(([key, value]) => key.length > 64 || value.length > (key === "reason" || key === "note" ? 4_096 : 1_024) || /[\x00-\x1f\x7f]/.test(value))) throw new FormError(413); return form;
}

export async function handleReviewRequest(request: Request, database: BillDatabase, config: AppConfig): Promise<Response> {
  const user = authenticated(request, config); if (!user) return challenge();
  const url = new URL(request.url); const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && url.pathname === "/review") {
    const rows = database.listReviewBills().map((bill) => `<li><a href="/review/bills/${encodeURIComponent(bill.id)}">${esc(bill.id)}</a> — ${esc(bill.status)} — ${esc(bill.originalFilename)}</li>`).join("");
    return page("Review queue", `<h1>Review queue</h1><ul>${rows || "<li>No bills require review.</li>"}</ul>`);
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
      const action = form.get("action"); const reason = form.get("reason")?.trim(); const note = form.get("note")?.trim();
      if ((action !== "approve" && action !== "reject") || !reason || !note) return page("Review failed", "Review submission failed.", 400);
      const original = database.getEffectiveExtraction(billId) ?? unavailableExtraction();
      const data = corrected(form, original);
      // Human review deliberately overrides confidence and handwriting routing, not factual checks.
      const factual = validateExtractedBill(data, config.validation).issues.filter((issue) => !issue.code.includes("confidence"));
      if (action === "approve" && factual.length) return page("Review failed", "Review submission failed.", 400);
      const content = Number(form.get("contentRevision")); const review = Number(form.get("reviewRevision"));
      if (!Number.isInteger(content) || !Number.isInteger(review) || !database.submitReview({ billId, reviewerId: user, action, reason, note, expectedContentRevision: content, expectedReviewRevision: review, corrected: data }, factual)) return page("Review conflict", "Review submission failed.", 409);
      return new Response(null, { status: 303, headers: { ...headers, location: "/review" } });
    } catch (error) { return page("Review failed", "Review submission failed.", error instanceof FormError ? error.status : 400); }
  }
  if (parts[3] && parts[3] !== "original" && parts[3] !== "review") return page("Not found", "Not found", 404);
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...headers, allow: parts[3] === "review" ? "POST" : "GET" } });
  const extraction = database.getExtraction(billId); const attempt = database.getLatestExtractionAttempt(billId); const effective = database.getEffectiveExtraction(billId); const issues = database.getValidationIssues(billId); const events = database.getReviewEvents(billId);
  const formData = effective ?? unavailableExtraction();
  const fields = editable.map((field) => `<label>${field}<input name="${field}" value="${esc(formData[field] ?? "")}"></label>`).join("");
  const confidence = Object.entries(extraction?.normalized?.fields ?? {}).map(([key, field]) => `<li>${esc(key)}: ${esc(field.confidence)} (${esc(field.sourceText)})</li>`).join("");
  const provenance = attempt ?? (extraction ? { providerModel: extraction.providerModel, requestedAt: extraction.requestedAt, completedAt: extraction.completedAt, outcome: extraction.normalized ? "succeeded" : "failed", errorDetails: extraction.errorDetails } : null);
  return page("Review bill", `<h1>${esc(bill.id)}</h1><p><a href="/review/bills/${encodeURIComponent(bill.id)}/original">View original</a> | <a href="/review/bills/${encodeURIComponent(bill.id)}/original?download=1">Download original</a></p><h2>Immutable model output</h2><pre>${esc(extraction?.normalized ? JSON.stringify(extraction.normalized, null, 2) : "Unavailable: normalized extraction was not persisted.")}</pre><h2>Confidence</h2><pre>${confidence ? `<ul>${confidence}</ul>` : "Unavailable"}</pre><h2>Validation issues</h2><pre>${esc(issues.length ? JSON.stringify(issues, null, 2) : "Unavailable")}</pre><h2>Provenance</h2><pre>${esc(JSON.stringify(provenance && { ...provenance, promptSchemaVersion: extraction?.promptSchemaVersion ?? null, errorDetails: safeError(provenance.errorDetails) }, null, 2))}</pre><h2>Audit events</h2><pre>${esc(JSON.stringify(events, null, 2))}</pre><form method="post" action="/review/bills/${encodeURIComponent(bill.id)}/review"><input type="hidden" name="csrf" value="${esc(csrf(config, user, bill.id))}"><input type="hidden" name="contentRevision" value="${bill.contentRevision}"><input type="hidden" name="reviewRevision" value="${bill.reviewRevision}">${fields}<label>Reason<input required name="reason"></label><label>Note<textarea required name="note"></textarea></label><button name="action" value="approve">Approve</button><button name="action" value="reject">Reject</button></form>`);
}
