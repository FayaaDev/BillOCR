import type { AppConfig } from "./config";
import type { BillDatabase } from "./database";
import { handleAdminRequest, type AdminHttpCapabilities } from "./admin-ui";
import { handleReviewRequest } from "./review-ui";
import { handleLoginRequest, reviewAuth, type ReviewAuth } from "./review-auth";
import { createHash, timingSafeEqual } from "node:crypto";

function tokenMatches(supplied: string | null, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return !!supplied && timingSafeEqual(digest(supplied), digest(`Bearer ${expected}`));
}

export function handleRequest(request: Request, database?: BillDatabase, config?: AppConfig, admin?: AdminHttpCapabilities, auth?: ReviewAuth): Response | Promise<Response> {
  if (new URL(request.url).pathname === "/health") return Response.json({ status: "ok" });
  const pathname = new URL(request.url).pathname;
  if (pathname === "/monitor/status") {
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (!config?.monitorToken || !tokenMatches(request.headers.get("authorization"), config.monitorToken)) return new Response("Unauthorized", { status: 401, headers });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...headers, allow: "GET" } });
    if (!database) return new Response("Unavailable", { status: 503, headers });
    return Response.json({ metrics: database.getDashboardMetrics() }, { headers });
  }
  const session = config ? auth ?? reviewAuth(config) : undefined;
  if (config && pathname === "/login") return handleLoginRequest(request, config, session);
  if (config && pathname === "/logout") {
    if (request.method !== "POST") return new Response("الطريقة غير مسموح بها", { status: 405, headers: { ...authHeaders(), allow: "POST" } });
    if (!session?.user(request)) return new Response("غير مصرح", { status: 401, headers: authHeaders() });
    return logoutCsrf(request, session).then((valid) => {
      if (!valid) return new Response("طلب غير صالح", { status: 400, headers: authHeaders() });
      session.logout(request); return new Response(null, { status: 303, headers: { ...authHeaders(), location: "/login", "set-cookie": session.expiredCookie(request) } });
    });
  }
  if (config && (pathname === "/admin" || pathname.startsWith("/admin/"))) return handleAdminRequest(request, config, admin, undefined, session);
  if (database && config && (pathname === "/review" || pathname.startsWith("/review/"))) return handleReviewRequest(request, database, config, undefined, session);
  return new Response("Not found", { status: 404 });
}

function authHeaders(): Record<string, string> { return { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" }; }
async function logoutCsrf(request: Request, auth: ReviewAuth): Promise<boolean> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() !== "application/x-www-form-urlencoded") return false;
  const reader = request.body?.getReader(); if (!reader) return false; const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 512) return false; chunks.push(next.value); }
  let raw: string; try { raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { return false; }
  if (/%(?![0-9A-Fa-f]{2})/.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) return false;
  const fields = new URLSearchParams(raw); let token: string | null = null;
  for (const [key, value] of fields) { if (key !== "logoutCsrf" || token !== null || /[\x00-\x1f\x7f]/.test(value)) return false; token = value; }
  return auth.csrfValid(request, "logout", token);
}
