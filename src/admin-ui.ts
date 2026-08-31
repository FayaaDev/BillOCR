import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config";
import type { AdminUploadBatch, AdminUploadBatchStatusCounts, DashboardMetrics } from "./contracts";

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'" };

/** Intentionally narrow service boundary: admin routes never receive a transport or database. */
export interface AdminHttpCapabilities {
  metrics(): Promise<DashboardMetrics> | DashboardMetrics;
  whatsapp: {
    status(): Promise<{ state: "connecting" | "connected" | "awaiting_pairing" | "unavailable"; canPair: boolean }> | { state: "connecting" | "connected" | "awaiting_pairing" | "unavailable"; canPair: boolean };
    pairingQr(): Promise<{ body: Uint8Array; contentType: "image/png" | "image/svg+xml" } | null>;
    groups(): Promise<Array<{ id: string; name: string | null }>> | Array<{ id: string; name: string | null }>;
    startPairing(): Promise<void>;
    cancelPairing(): Promise<void>;
  };
  zip: {
    available(): boolean;
    maxCompressedBytes: number;
    ingest(input: { sourceId: string; originalFilename: string; bytes: AsyncIterable<Uint8Array> }): Promise<{ batch: AdminUploadBatch; counts: { accepted: number; rejected: number; ignored: number } }>;
    status(batchId: string): { batch: AdminUploadBatch; counts: AdminUploadBatchStatusCounts; items: Array<{ entryPath: string; state: string; errorCode: string | null; billId: string | null }> } | null;
  };
}

function authenticated(request: Request, config: AppConfig): string | null {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Basic ")) return null;
  let decoded: string; try { decoded = atob(value.slice(6)); } catch { return null; }
  const cut = decoded.indexOf(":"); if (cut < 0) return null;
  const digest = (item: string) => createHmac("sha256", "review-basic").update(item).digest();
  return timingSafeEqual(digest(decoded.slice(0, cut)), digest(config.review.username)) && timingSafeEqual(digest(decoded.slice(cut + 1)), digest(config.review.password)) ? decoded.slice(0, cut) : null;
}
function csrf(config: AppConfig, user: string, scope: "admin-whatsapp-action" | "admin-zip-upload"): string { const nonce = randomBytes(16).toString("base64url"); return `${nonce}.${createHmac("sha256", config.review.password).update(`${user}:${scope}:${nonce}`).digest("base64url")}`; }
function csrfValid(value: string | null, config: AppConfig, user: string, scope: "admin-whatsapp-action" | "admin-zip-upload"): boolean {
  const [nonce, signature, extra] = value?.split(".") ?? [];
  if (!nonce || !signature || extra || nonce.length > 64 || signature.length > 128) return false;
  const expected = createHmac("sha256", config.review.password).update(`${user}:${scope}:${nonce}`).digest("base64url");
  const supplied = Buffer.from(signature); const expectedBytes = Buffer.from(expected);
  return supplied.byteLength === expectedBytes.byteLength && timingSafeEqual(supplied, expectedBytes);
}
function zipFilename(value: string | null): string | null {
  if (!value || value.length > 512) return null;
  try { const name = decodeURIComponent(value); return name && name.length <= 512 && /\.zip$/i.test(name) && !/[\0\r\n]/.test(name) ? name : null; } catch { return null; }
}
function uploadId(value: string | null): string | null { return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null; }
function compressedLength(request: Request, maximum: number): number | null {
  const value = request.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return null;
  const length = Number(value); return Number.isSafeInteger(length) && length <= maximum ? length : null;
}
async function* requestBytes(request: Request): AsyncIterable<Uint8Array> {
  const reader = request.body?.getReader(); if (!reader) return;
  try { for (;;) { const next = await reader.read(); if (next.done) return; yield next.value; } } finally { reader.releaseLock(); }
}
function challenge(): Response { return new Response("غير مصرح", { status: 401, headers: { ...headers, "www-authenticate": 'Basic realm="internal review", charset="UTF-8"' } }); }
function methodNotAllowed(allow: string): Response { return new Response("الطريقة غير مسموح بها", { status: 405, headers: { ...headers, allow } }); }
async function parseUnpairForm(request: Request): Promise<URLSearchParams | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > 1024) return null;
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/%(?![0-9A-Fa-f]{2})/.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) return null;
  const form = new URLSearchParams(raw);
  return [...form].length <= 2 && [...form].every(([key, value]) => key.length <= 32 && value.length <= 256) ? form : null;
}

export async function handleAdminRequest(request: Request, config: AppConfig, capabilities?: AdminHttpCapabilities, assetDir = join(import.meta.dir, "..", "dist", "admin")): Promise<Response> {
  const user = authenticated(request, config); if (!user) return challenge();
  const pathname = new URL(request.url).pathname;
  if (pathname === "/admin") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const token = csrf(config, user, "admin-whatsapp-action");
    return new Response(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>إدارة واتساب</title><script src="/admin/assets/theme.js"></script><link rel="stylesheet" href="/admin/assets/client.css"></head><body><div id="root" data-csrf="${token}"></div><script src="/admin/assets/client.js" defer></script></body></html>`, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  }
  if (!capabilities) return new Response("الخدمة غير متاحة", { status: 503, headers });
  const font = /^\/admin\/assets\/files\/(noto-sans-arabic-arabic-(?:400|700)-normal\.woff2)$/.exec(pathname)?.[1];
  if (pathname === "/admin/assets/client.js" || pathname === "/admin/assets/theme.js" || pathname === "/admin/assets/client.css" || font) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const name = font ? join("files", font) : pathname.endsWith("client.js") ? "client.js" : pathname.endsWith("theme.js") ? "theme.js" : "client.css";
    try { const content = await readFile(join(assetDir, name)); return new Response(content, { headers: { ...headers, "content-type": name.endsWith(".js") ? "text/javascript; charset=utf-8" : name.endsWith(".woff2") ? "font/woff2" : "text/css; charset=utf-8" } }); } catch { return new Response("غير موجود", { status: 404, headers }); }
  }
  if (pathname === "/admin/api/overview") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const [metrics, whatsapp, groups] = await Promise.all([capabilities.metrics(), capabilities.whatsapp.status(), capabilities.whatsapp.groups()]);
    return Response.json({ metrics: { received: metrics.receivedBills, approved: metrics.approvedBills, failed: metrics.failedBills, retryableJobs: metrics.retryableJobs, permanentFailureJobs: metrics.permanentFailureJobs }, whatsapp: { ...whatsapp, configuredGroupId: config.whatsapp.groupId, groups, csrf: csrf(config, user, "admin-whatsapp-action") }, zip: { available: capabilities.zip.available(), maxCompressedBytes: capabilities.zip.maxCompressedBytes, csrf: csrf(config, user, "admin-zip-upload") } }, { headers });
  }
  if (pathname === "/admin/api/metrics") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return Response.json(await capabilities.metrics(), { headers });
  }
  if (pathname === "/admin/api/whatsapp/status") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return Response.json(await capabilities.whatsapp.status(), { headers });
  }
  if (pathname === "/admin/api/whatsapp/qr" || pathname === "/admin/api/whatsapp/pairing-qr") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    if ((await capabilities.whatsapp.status()).state !== "awaiting_pairing") return new Response(null, { status: 404, headers });
    const qr = await capabilities.whatsapp.pairingQr();
    return qr ? new Response(new Blob([new Uint8Array(qr.body)]), { headers: { ...headers, "content-type": qr.contentType } }) : new Response(null, { status: 404, headers });
  }
  if (pathname === "/admin/api/whatsapp/groups") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return Response.json(await capabilities.whatsapp.groups(), { headers });
  }
  if (pathname === "/admin/api/zip") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (!capabilities.zip.available()) return new Response("رفع ملفات ZIP غير متاح حاليًا", { status: 503, headers });
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
    const filename = zipFilename(request.headers.get("x-upload-filename"));
    const sourceId = uploadId(request.headers.get("x-upload-id"));
    if ((contentType !== "application/zip" && contentType !== "application/x-zip-compressed") || !filename || !sourceId || compressedLength(request, capabilities.zip.maxCompressedBytes) === null || !csrfValid(request.headers.get("x-csrf-token"), config, user, "admin-zip-upload")) return new Response("طلب رفع غير صالح", { status: 400, headers });
    try {
      const result = await capabilities.zip.ingest({ sourceId, originalFilename: filename, bytes: requestBytes(request) });
      return Response.json({ batch: { id: result.batch.id, originalFilename: result.batch.originalFilename, state: result.batch.state }, counts: result.counts }, { status: 202, headers });
    } catch { return new Response("تعذر قبول ملف ZIP. تحقق من الملف وحاول مرة أخرى.", { status: 422, headers }); }
  }
  const zipStatus = /^\/admin\/api\/zip\/([A-Za-z0-9-]{1,128})$/.exec(pathname);
  if (zipStatus) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const result = capabilities.zip.status(zipStatus[1]!);
    if (!result) return new Response("غير موجود", { status: 404, headers });
    return Response.json({ batch: { id: result.batch.id, originalFilename: result.batch.originalFilename, state: result.batch.state }, counts: result.counts, items: result.items }, { headers });
  }
  const pairingAction = pathname === "/admin/whatsapp/pairing/start" ? "start" : pathname === "/admin/whatsapp/pairing/cancel" ? "cancel" : null;
  if (pairingAction) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    try {
      const form = await parseUnpairForm(request);
      if (!form || !csrfValid(form.get("csrf"), config, user, "admin-whatsapp-action")) return new Response("طلب غير صالح", { status: 400, headers });
      const status = await capabilities.whatsapp.status();
      if (pairingAction === "start") {
        if (status.state !== "unavailable" || !status.canPair) return new Response("الاقتران غير متاح", { status: 409, headers });
        await capabilities.whatsapp.startPairing();
      } else {
        if (status.state !== "awaiting_pairing") return new Response("لا يوجد اقتران نشط", { status: 409, headers });
        await capabilities.whatsapp.cancelPairing();
      }
      return new Response(null, { status: 303, headers: { ...headers, location: "/admin" } });
    } catch { return new Response("تعذر تنفيذ إجراء الاقتران", { status: 503, headers }); }
  }
  return new Response("غير موجود", { status: 404, headers });
}
