import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/backend/config";
import { BillDatabase } from "../src/db/database";
import { handleRequest } from "../src/backend/http";
import { createReviewAuth, handleLoginRequest } from "../src/backend/review-auth";

let dir: string; let database: BillDatabase; let config: AppConfig;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "review-auth-"));
  config = { host: "127.0.0.1", port: 0, dataDir: dir, databasePath: join(dir, "db.sqlite"), logLevel: "error", originals: { dir, maxAttachmentBytes: 1 }, telegram: { enabled: false, botToken: null, groupIds: [], pollTimeoutSeconds: 1, requestTimeoutMs: 1, maxResponseBytes: 1 }, whatsapp: { enabled: false, groupId: "g", authPath: dir, originalsDir: dir, maxAttachmentBytes: 1 }, mistral: { apiKey: "x", model: "x", maxResponseBytes: 1, requestTimeoutMs: 1 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1, requestTimeoutMs: 1, pollIntervalMs: 0, fallbackConfidenceThreshold: .8 }, imagePreprocessing: { enabled: false, timeoutMs: 1 }, google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "reviewer", password: "secret" }, validation: { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 1 }, jobs: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 1 } };
  database = new BillDatabase(config.databasePath);
});
afterEach(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });

test("in-page login creates one shared session and renders an accessible Card", async () => {
  const auth = createReviewAuth(config);
  const login = await handleRequest(new Request("http://localhost/login?return=/admin", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=reviewer&password=secret&return=%2Fadmin" }), database, config, undefined, auth);
  expect(login?.status).toBe(303); expect(login?.headers.get("location")).toBe("/admin");
  const cookie = login?.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Lax"); expect(cookie).toContain("Path=/"); expect(cookie).not.toContain("Secure");
  expect((await handleRequest(new Request("http://x/admin", { headers: { cookie } }), database, config, undefined, auth))?.status).toBe(200);
  expect((await handleRequest(new Request("http://x/review", { headers: { cookie } }), database, config, undefined, auth))?.status).toBe(200);
  const page = await handleRequest(new Request("http://x/login"), database, config, undefined, auth);
  const html = await page?.text(); expect(html).toContain('<body><!-- dashboard-01:'); expect(html).toContain('data-slot="card"'); expect(html).toContain('for="username"'); expect(html).toContain('data-slot="field-label"'); expect(html).toContain('type="password"'); expect(html).toContain('data-slot="card-footer"'); expect(html).toContain('form="login-form"'); expect(html).toContain('name="return" value="/review"');
});

test("login rejects failures and malformed or open return targets without an auth challenge", async () => {
  const auth = createReviewAuth(config);
  const failed = await handleRequest(new Request("http://x/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=reviewer&password=wrong" }), database, config, undefined, auth);
  expect(failed?.status).toBe(401); expect(failed?.headers.get("www-authenticate")).toBeNull();
  for (const request of [
    new Request("http://x/login?return=https://evil.test"),
    new Request("http://x/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=reviewer&username=x&password=secret" }),
    new Request("http://x/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=reviewer&password=sec%00ret" }),
  ]) expect((await handleRequest(request, database, config, undefined, auth))?.status).toBe(400);
});

test("protected pages redirect while APIs reject invalid sessions, and logout requires a session CSRF token", async () => {
  const auth = createReviewAuth(config);
  expect((await handleRequest(new Request("http://x/review"), database, config, undefined, auth))?.headers.get("location")).toBe("/login?return=/review");
  const denied = await handleRequest(new Request("http://x/admin/api/metrics", { headers: { cookie: "review_session=invalid" } }), database, config, undefined, auth);
  expect(denied?.status).toBe(401); expect(denied?.headers.get("www-authenticate")).toBeNull();
  const id = auth.login("reviewer", "secret")!; const cookie = `review_session=${id}`;
  expect((await handleRequest(new Request("http://x/logout", { method: "POST", headers: { cookie } }), database, config, undefined, auth))?.status).toBe(400);
  expect((await handleRequest(new Request("http://x/logout", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "csrf=wrong" }), database, config, undefined, auth))?.status).toBe(400);
  expect((await handleRequest(new Request("http://x/logout", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new Uint8Array([108, 111, 103, 111, 117, 116, 67, 115, 114, 102, 61, 195, 40]) }), database, config, undefined, auth))?.status).toBe(400);
  const csrf = auth.csrf(new Request("http://x/logout", { headers: { cookie } }), "logout")!;
  const logout = await handleRequest(new Request("http://x/logout", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ logoutCsrf: csrf }) }), database, config, undefined, auth);
  expect(logout?.status).toBe(303); expect(logout?.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await handleRequest(new Request("http://x/review/api/bills", { headers: { cookie } }), database, config, undefined, auth))?.status).toBe(401);
});

test("sessions expire, evict the oldest at 128, and stay isolated per auth instance", async () => {
  let clock = 0; const auth = createReviewAuth(config, () => clock); const cookie = (id: string) => new Request("http://x", { headers: { cookie: `review_session=${id}` } });
  const expired = auth.login("reviewer", "secret")!; expect(auth.user(cookie(expired))).toBe("reviewer"); clock += 8 * 60 * 60 * 1_000; expect(auth.user(cookie(expired))).toBeNull();
  const ids = Array.from({ length: 129 }, () => auth.login("reviewer", "secret")!);
  expect(auth.user(cookie(ids[0]!))).toBeNull(); expect(auth.user(cookie(ids[128]!))).toBe("reviewer");
  const other = createReviewAuth(config, () => clock); expect(other.user(cookie(ids[128]!))).toBeNull();
});

test("cookies are insecure only for loopback HTTP", async () => {
  const auth = createReviewAuth(config); const login = (url: string) => handleRequest(new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=reviewer&password=secret" }), database, config, undefined, auth);
  expect((await login("http://127.0.0.1/login"))?.headers.get("set-cookie")).not.toContain("Secure");
  expect((await login("http://internal.example/login"))?.headers.get("set-cookie")).toContain("Secure");
});

test("configured login rejects mismatched destinations and browser origins before issuing a cookie", async () => {
  config.review.origin = "https://customer-a.example.test";
  const auth = createReviewAuth(config);
  for (const [url, extraHeaders] of [
    ["https://customer-b.example.test/login", {}],
    ["ftp://customer-a.example.test/login", {}],
    ["https://customer-a.example.test:8443/login", {}],
    ["http://customer-a.example.test:3000/login", {}],
    ["http://localhost:3000/login", { "x-forwarded-host": "customer-a.example.test", "x-forwarded-proto": "https", forwarded: "host=customer-a.example.test;proto=https" }],
    ["http://internal-service/login", { host: "customer-a.example.test", "x-forwarded-host": "customer-a.example.test", "x-forwarded-proto": "https" }],
    ["http://customer-a.example.test/login", { host: "internal-service", "x-forwarded-host": "customer-a.example.test" }],
    ["http://customer-a.example.test/login", { host: "customer-a.example.test:443" }],
    ["http://customer-a.example.test/login", { origin: "http://customer-a.example.test" }],
    ["http://customer-a.example.test/login", { origin: "https://customer-b.example.test" }],
    ["https://customer-a.example.test/login", { origin: "https://customer-b.example.test" }],
    ["https://customer-a.example.test/login", { origin: "null" }],
    ["https://customer-a.example.test/login", { host: "customer-b.example.test" }],
  ] as Array<[string, Record<string, string>]>) {
    for (const method of ["GET", "POST"]) {
      const request = new Request(url, { method, headers: { ...extraHeaders, "content-type": "application/x-www-form-urlencoded" }, ...(method === "POST" ? { body: "username=reviewer&password=secret" } : {}) });
      const response = await handleLoginRequest(request, config, auth);
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(auth.login("reviewer", "secret", request)).toBeNull();
      expect(() => auth.cookie("unused", request)).toThrow("origin mismatch");
      expect(() => auth.expiredCookie(request)).toThrow("origin mismatch");
    }
  }
  expect(auth.login("reviewer", "secret")).toBeNull();
});

test("configured sessions use host-only secure cookies and retain CSRF and logout behavior", async () => {
  const origin = "https://customer-a.example.test"; config.review.origin = origin;
  const auth = createReviewAuth(config);
  const response = await handleLoginRequest(new Request(`${origin}/login`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded", "x-forwarded-host": "ignored.example.test" }, body: "username=reviewer&password=secret" }), config, auth);
  expect(response.status).toBe(303);
  const setCookie = response.headers.get("set-cookie")!;
  expect(setCookie).toMatch(/^__Host-review_session=[A-Za-z0-9_-]{43}; Max-Age=28800; HttpOnly; SameSite=Lax; Path=\/; Secure$/);
  expect(setCookie).not.toContain("Domain=");
  const cookie = setCookie.split(";", 1)[0]!;
  const request = new Request(`${origin}/admin`, { headers: { cookie } });
  expect(auth.user(request)).toBe("reviewer");
  expect((await handleRequest(request, database, config, undefined, auth)).status).toBe(200);
  const token = auth.csrf(request, "logout")!;
  expect(auth.csrfValid(request, "logout", token)).toBe(true);
  expect(auth.csrfValid(request, "another-scope", token)).toBe(false);
  expect(auth.user(new Request(`${origin}/admin`, { headers: { cookie: cookie.replace("__Host-", "") } }))).toBeNull();
  expect(auth.user(new Request(`${origin}/admin`, { headers: { cookie: `${cookie}; ${cookie}` } }))).toBeNull();
  for (const url of ["https://customer-b.example.test/admin", `${origin}:8443/admin`, "http://internal-service/admin"]) {
    const wrong = new Request(url, { headers: { cookie } });
    expect(auth.user(wrong)).toBeNull(); expect(auth.binding(wrong)).toBeNull();
    expect(auth.csrf(wrong, "logout")).toBeNull(); expect(auth.csrfValid(wrong, "logout", token)).toBe(false);
    auth.logout(wrong); expect(auth.user(request)).toBe("reviewer");
  }
  const wrongSource = new Request(`${origin}/admin`, { headers: { cookie, origin: "https://customer-b.example.test" } });
  expect(auth.user(wrongSource)).toBeNull(); expect(auth.binding(wrongSource)).toBeNull();
  const logout = await handleRequest(new Request(`${origin}/logout`, { method: "POST", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ logoutCsrf: token }) }), database, config, undefined, auth);
  expect(logout.status).toBe(303);
  expect(logout.headers.get("set-cookie")).toBe("__Host-review_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/; Secure");
  expect(auth.user(request)).toBeNull();
});

test("TLS ingress preserves customer Host over backend HTTP with secure sessions and logout", async () => {
  const origin = "https://customer-a.example.test"; config.review.origin = origin;
  const backend = "http://customer-a.example.test";
  const auth = createReviewAuth(config);
  const headers = { host: "customer-a.example.test", origin, "content-type": "application/x-www-form-urlencoded", "x-forwarded-host": "ignored.example.test", "x-forwarded-proto": "http" };
  const response = await handleLoginRequest(new Request(`${backend}/login`, { method: "POST", headers, body: "username=reviewer&password=secret" }), config, auth);
  expect(response.status).toBe(303);
  const setCookie = response.headers.get("set-cookie")!;
  expect(setCookie).toMatch(/^__Host-review_session=[A-Za-z0-9_-]{43}; Max-Age=28800; HttpOnly; SameSite=Lax; Path=\/; Secure$/);
  expect(setCookie).not.toContain("Domain=");
  const cookie = setCookie.split(";", 1)[0]!;
  const request = new Request(`${backend}/admin`, { headers: { host: headers.host, cookie } });
  expect(auth.user(request)).toBe("reviewer");
  expect((await handleRequest(request, database, config, undefined, auth)).status).toBe(200);
  expect(auth.user(new Request(`${origin}/admin`, { headers: { cookie } }))).toBe("reviewer");
  const token = auth.csrf(request, "logout")!;
  expect(auth.csrfValid(request, "logout", token)).toBe(true);
  const wrong = new Request(`${backend}/logout`, { headers: { cookie, origin: "https://customer-b.example.test" } });
  expect(auth.user(wrong)).toBeNull(); expect(auth.csrfValid(wrong, "logout", token)).toBe(false);
  const logout = await handleRequest(new Request(`${backend}/logout`, { method: "POST", headers: { ...headers, cookie }, body: new URLSearchParams({ logoutCsrf: token }) }), database, config, undefined, auth);
  expect(logout.status).toBe(303);
  expect(logout.headers.get("set-cookie")).toBe("__Host-review_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/; Secure");
  expect(auth.user(request)).toBeNull();
});

test("Bun accepts preserved public Host on loopback HTTP without rewriting Request", async () => {
  config.review.origin = "https://customer-a.example.test";
  const auth = createReviewAuth(config);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handleLoginRequest(request, config, auth) });
  try {
    for (const host of ["customer-a.example.test", "localhost", "internal-service", "customer-b.example.test", "customer-a.example.test:3000"]) {
      const response = await fetch(new URL("/login", server.url), { method: "POST", redirect: "manual", headers: { host, origin: config.review.origin, "x-forwarded-host": "customer-a.example.test", "x-forwarded-proto": "https", "content-type": "application/x-www-form-urlencoded" }, body: "username=reviewer&password=secret" });
      if (host === "customer-a.example.test") {
        expect(response.status).toBe(303);
        expect(response.headers.get("set-cookie")).toMatch(/^__Host-review_session=.*; Secure$/);
      } else {
        expect(response.status).toBe(403);
        expect(response.headers.get("set-cookie")).toBeNull();
      }
      await response.arrayBuffer();
    }
  } finally { server.stop(true); }
});

test("sibling customer logins remain independent even with identical credentials", async () => {
  const a = { ...config, review: { ...config.review, origin: "https://a.example.test" } };
  const b = { ...config, review: { ...config.review, origin: "https://b.example.test" } };
  const authA = createReviewAuth(a); const authB = createReviewAuth(b);
  const login = async (customer: AppConfig, auth: ReturnType<typeof createReviewAuth>) => {
    const response = await handleLoginRequest(new Request(`${customer.review.origin}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=reviewer&password=secret" }), customer, auth);
    return response.headers.get("set-cookie")!.split(";", 1)[0]!;
  };
  const cookieA = await login(a, authA); const cookieB = await login(b, authB);
  const requestA = new Request(`${a.review.origin}/admin`, { headers: { cookie: cookieA } });
  const requestB = new Request(`${b.review.origin}/admin`, { headers: { cookie: cookieB } });
  expect(cookieA).not.toBe(cookieB);
  expect(authA.user(requestA)).toBe("reviewer"); expect(authB.user(requestB)).toBe("reviewer");
  expect(authB.user(new Request(`${b.review.origin}/admin`, { headers: { cookie: cookieA } }))).toBeNull();
  expect(authA.user(new Request(`${a.review.origin}/admin`, { headers: { cookie: cookieB } }))).toBeNull();
  expect(authB.csrfValid(requestB, "logout", authA.csrf(requestA, "logout"))).toBe(false);
  authB.logout(requestB);
  expect(authA.user(requestA)).toBe("reviewer"); expect(authB.user(requestB)).toBeNull();
});
