import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config";
import { BillDatabase } from "../src/database";
import { handleRequest } from "../src/http";
import { createReviewAuth } from "../src/review-auth";

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
  const html = await page?.text(); expect(html).toContain('data-slot="card"'); expect(html).toContain('<label for="username">'); expect(html).toContain('type="password"');
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
