import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config";

const cookieName = "review_session";
const lifetimeMs = 8 * 60 * 60 * 1_000;
const maximumSessions = 128;
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'" };

type Session = { user: string; expiresAt: number };
export interface ReviewAuth {
  login(username: string, password: string): string | null;
  user(request: Request): string | null;
  binding(request: Request): string | null;
  csrf(request: Request, scope: string): string | null;
  csrfValid(request: Request, scope: string, value: string | null): boolean;
  logout(request: Request): void;
  cookie(id: string, request: Request): string;
  expiredCookie(request: Request): string;
}

function digest(value: string): Buffer { return createHmac("sha256", "review-session").update(value).digest(); }
function credentialsMatch(username: string, password: string, config: AppConfig): boolean { return timingSafeEqual(digest(username), digest(config.review.username)) && timingSafeEqual(digest(password), digest(config.review.password)); }
function sessionId(request: Request): string | null {
  const values = request.headers.get("cookie")?.split(";") ?? [];
  let result: string | null = null;
  for (const value of values) {
    const match = /^\s*review_session=([A-Za-z0-9_-]{43})\s*$/.exec(value);
    if (!match) continue;
    if (result) return null;
    result = match[1]!;
  }
  return result;
}
function cookie(value: string, request: Request, maxAge: number): string {
  const url = new URL(request.url); const secure = url.protocol === "https:" || !/^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(url.hostname) ? "; Secure" : "";
  return `${cookieName}=${value}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Path=/${secure}`;
}

export function createReviewAuth(config: AppConfig, now = Date.now): ReviewAuth {
  const sessions = new Map<string, Session>();
  const purge = () => { const current = now(); for (const [id, session] of sessions) if (session.expiresAt <= current) sessions.delete(id); };
  return {
    login(username, password) {
      if (!credentialsMatch(username, password, config)) return null;
      purge();
      while (sessions.size >= maximumSessions) sessions.delete(sessions.keys().next().value!);
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, { user: config.review.username, expiresAt: now() + lifetimeMs });
      return id;
    },
    user(request) {
      purge();
      const id = sessionId(request); const session = id ? sessions.get(id) : undefined;
      return session?.user ?? null;
    },
    binding(request) { purge(); const id = sessionId(request); return id && sessions.has(id) ? id : null; },
    csrf(request, scope) { const id = this.binding(request); const user = this.user(request); if (!id || !user) return null; const nonce = randomBytes(16).toString("base64url"); return `${nonce}.${createHmac("sha256", config.review.password).update(`${user}:${id}:${scope}:${nonce}`).digest("base64url")}`; },
    csrfValid(request, scope, value) { const id = this.binding(request); const user = this.user(request); const [nonce, signature, extra] = value?.split(".") ?? []; if (!id || !user || !nonce || !signature || extra || nonce.length > 64 || signature.length > 128) return false; const expected = createHmac("sha256", config.review.password).update(`${user}:${id}:${scope}:${nonce}`).digest("base64url"); const supplied = Buffer.from(signature); const expectedBytes = Buffer.from(expected); return supplied.byteLength === expectedBytes.byteLength && timingSafeEqual(supplied, expectedBytes); },
    logout(request) { const id = sessionId(request); if (id) sessions.delete(id); },
    cookie(id, request) { return cookie(id, request, lifetimeMs / 1_000); },
    expiredCookie(request) { return cookie("", request, 0); },
  };
}

const defaultAuth = new WeakMap<AppConfig, ReviewAuth>();
export function reviewAuth(config: AppConfig): ReviewAuth {
  let auth = defaultAuth.get(config);
  if (!auth) { auth = createReviewAuth(config); defaultAuth.set(config, auth); }
  return auth;
}

class LoginFormError extends Error {}
async function loginForm(request: Request): Promise<{ username: string; password: string; returnTo: string }> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() !== "application/x-www-form-urlencoded") throw new LoginFormError();
  const reader = request.body?.getReader(); if (!reader) throw new LoginFormError(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 2_048) throw new LoginFormError(); chunks.push(next.value); }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  if (/%(?![0-9A-Fa-f]{2})/.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) throw new LoginFormError();
  const fields = new URLSearchParams(raw); const values = new Map<string, string>();
  for (const [key, value] of fields) { if (!/^(username|password|return)$/.test(key) || values.has(key) || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new LoginFormError(); values.set(key, value); }
  const username = values.get("username"); const password = values.get("password"); const returnTo = values.get("return") ?? "/review";
  if (username === undefined || password === undefined || (returnTo !== "/admin" && returnTo !== "/review")) throw new LoginFormError();
  return { username, password, returnTo };
}

export async function handleLoginRequest(request: Request, config: AppConfig, auth = reviewAuth(config)): Promise<Response> {
  const url = new URL(request.url); const returnTo = url.searchParams.get("return") ?? "/review";
  if ((request.method === "GET" && (returnTo !== "/admin" && returnTo !== "/review")) || url.searchParams.size > 1) return new Response("طلب غير صالح", { status: 400, headers });
  if (request.method === "GET") {
    if (auth.user(request)) return new Response(null, { status: 303, headers: { ...headers, location: returnTo } });
    const { renderLoginPage } = await import("./login-ui");
    return new Response(renderLoginPage(returnTo), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  }
  if (request.method !== "POST") return new Response("الطريقة غير مسموح بها", { status: 405, headers: { ...headers, allow: "GET, POST" } });
  try {
    const form = await loginForm(request); const id = auth.login(form.username, form.password);
    if (!id) { const { renderLoginPage } = await import("./login-ui"); return new Response(renderLoginPage(form.returnTo, true), { status: 401, headers: { ...headers, "content-type": "text/html; charset=utf-8" } }); }
    return new Response(null, { status: 303, headers: { ...headers, location: form.returnTo, "set-cookie": auth.cookie(id, request) } });
  } catch { return new Response("تعذر تسجيل الدخول. تحقق من البيانات وحاول مرة أخرى.", { status: 400, headers }); }
}

export function loginHeaders(): Record<string, string> { return headers; }
