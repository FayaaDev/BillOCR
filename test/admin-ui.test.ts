import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config";
import { BillDatabase } from "../src/database";
import { handleAdminRequest, type AdminHttpCapabilities } from "../src/admin-ui";
import { reviewAuth } from "../src/review-auth";

const config: AppConfig = {
  host: "127.0.0.1", port: 0, dataDir: "/tmp", databasePath: "/tmp/test.sqlite", logLevel: "error", originals: { dir: "/tmp/originals", maxAttachmentBytes: 1 }, telegram: { enabled: false, botToken: null, groupIds: [], pollTimeoutSeconds: 30, requestTimeoutMs: 35_000, maxResponseBytes: 1 },
  whatsapp: { enabled: true, groupId: "group", authPath: "/private/auth", originalsDir: "/tmp/originals", maxAttachmentBytes: 1 }, mistral: { apiKey: "mistral-secret", model: "model", maxResponseBytes: 1, requestTimeoutMs: 1 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1, requestTimeoutMs: 1, pollIntervalMs: 0, fallbackConfidenceThreshold: .8 }, imagePreprocessing: { enabled: false, timeoutMs: 1 }, google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "admin", password: "password" }, validation: { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, jobs: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 1 },
};
const id = reviewAuth(config).login("admin", "password"); if (!id) throw new Error("login failed");
const auth = { cookie: `review_session=${id}` };

test("admin routes require a review session and are never cached", async () => {
  expect((await handleAdminRequest(new Request("http://x/admin"), config)).status).toBe(303);
  const shell = await handleAdminRequest(new Request("http://x/admin", { headers: auth }), config);
  expect(shell.status).toBe(200); expect(shell.headers.get("cache-control")).toBe("no-store"); expect(shell.headers.get("content-security-policy")).toContain("font-src 'self'");
  const html = await shell.text();
  expect(html).toContain('<html lang="ar" dir="rtl">');
   const session = reviewAuth(config);
   const request = new Request("http://x/admin", { headers: auth });
   const logout = /data-logout-csrf="([^"]+)"/.exec(html)?.[1] ?? null;
   const clear = /data-clear-csrf="([^"]+)"/.exec(html)?.[1] ?? null;
   expect(session.csrfValid(request, "logout", logout)).toBe(true);
   expect(session.csrfValid(request, "review-clear-bills", clear)).toBe(true);
   expect(session.csrfValid(request, "logout", clear)).toBe(false);
   expect(session.csrfValid(request, "review-clear-bills", logout)).toBe(false);
  expect(html).toContain('<title>ماسح الفواتير</title>');
  expect(html).toContain('<link rel="icon" href="/admin/assets/favicon.png" type="image/png">');
  expect(html).toContain('src="/admin/assets/client.js"');
  expect(html).not.toContain(config.mistral.apiKey);
  expect(html).not.toContain(config.whatsapp.authPath);
  expect((await handleAdminRequest(new Request("http://x/admin/api/metrics", { headers: auth }), config)).status).toBe(503);
  const wrongMethod = await handleAdminRequest(new Request("http://x/admin/api/metrics", { method: "POST", headers: auth }), config, capabilities());
  expect(wrongMethod.status).toBe(405); expect(wrongMethod.headers.get("allow")).toBe("GET");
});

test("admin returns only rendered QR bytes, never its private pairing token", async () => {
  const token = "private-pairing-token";
  const result = await handleAdminRequest(new Request("http://x/admin/api/whatsapp/qr", { headers: auth }), config, capabilities({ status: () => ({ state: "awaiting_pairing", canPair: true }), pairingQr: async () => ({ body: new TextEncoder().encode("<svg>rendered code</svg>"), contentType: "image/svg+xml" }) }));
  expect(result.status).toBe(200); expect(result.headers.get("content-type")).toBe("image/svg+xml"); expect(await result.text()).not.toContain(token);
  expect((await handleAdminRequest(new Request("http://x/admin/api/whatsapp/qr", { headers: auth }), config, capabilities())).status).toBe(404);
});

test("admin dashboard pairing actions are explicit, state-gated, and CSRF-protected", async () => {
  let started = 0;
  let cancelled = 0;
  const api = capabilities({ startPairing: async () => { started += 1; }, cancelPairing: async () => { cancelled += 1; } });
  expect(await (await handleAdminRequest(new Request("http://x/admin/api/metrics", { headers: auth }), config, api)).json()).toMatchObject({ receivedBills: 1 });
  expect(await (await handleAdminRequest(new Request("http://x/admin/api/whatsapp/status", { headers: auth }), config, api)).json()).toEqual({ state: "connected", canPair: true });
  expect(await (await handleAdminRequest(new Request("http://x/admin/api/whatsapp/groups", { headers: auth }), config, api)).json()).toEqual([{ id: "group", name: "Bills" }]);
  config.telegram.enabled = true; config.telegram.groupIds = ["-100123"];
  const overview = await (await handleAdminRequest(new Request("http://x/admin/api/overview", { headers: auth }), config, api)).json() as Record<string, unknown>;
  expect(overview).toMatchObject({ metrics: { received: 1, approved: 0, failed: 0, retryableJobs: 0, permanentFailureJobs: 0 }, whatsapp: { state: "connected", configuredGroupId: "group", groups: [{ id: "group", name: "Bills" }] }, telegram: { enabled: true, groupIds: ["-100123"] } });
  expect(JSON.stringify(overview)).not.toContain("botToken");
  config.telegram.enabled = false; config.telegram.groupIds = [];
  expect((await handleAdminRequest(new Request("http://x/admin/whatsapp/pairing/start", { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: "csrf=nope" }), config, api)).status).toBe(400);
  const shell = await handleAdminRequest(new Request("http://x/admin", { headers: auth }), config, api);
  const csrf = /data-csrf="([^"]+)"/.exec(await shell.text())?.[1]; if (!csrf) throw new Error("missing CSRF token");
  const startWhileConnected = await handleAdminRequest(new Request("http://x/admin/whatsapp/pairing/start", { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }) }), config, api);
  expect(startWhileConnected.status).toBe(409); expect(started).toBe(0); expect(cancelled).toBe(0);
  api.whatsapp.status = () => ({ state: "unavailable", canPair: true });
  const start = await handleAdminRequest(new Request("http://x/admin/whatsapp/pairing/start", { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }) }), config, api);
  expect(start.status).toBe(303); expect(started).toBe(1);
  api.whatsapp.status = () => ({ state: "unavailable", canPair: false });
  const unavailableStart = await handleAdminRequest(new Request("http://x/admin/whatsapp/pairing/start", { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }) }), config, api);
  expect(unavailableStart.status).toBe(409); expect(started).toBe(1);
  api.whatsapp.status = () => ({ state: "awaiting_pairing", canPair: true });
  const cancel = await handleAdminRequest(new Request("http://x/admin/whatsapp/pairing/cancel", { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }) }), config, api);
  expect(cancel.status).toBe(303); expect(cancelled).toBe(1);
});

test("admin protects every route, serves only known assets, and rejects malformed unpair requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "admin-assets-"));
  try {
    writeFileSync(join(directory, "client.js"), "window.adminClient = true;");
    writeFileSync(join(directory, "theme.js"), "window.adminTheme = true;");
    writeFileSync(join(directory, "client.css"), ".admin-page{}");
    writeFileSync(join(directory, "favicon.png"), new Uint8Array([137, 80, 78, 71]));
    for (const path of ["/admin", "/admin/api/overview", "/admin/api/metrics", "/admin/api/whatsapp/status", "/admin/api/whatsapp/qr", "/admin/api/whatsapp/groups", "/admin/assets/client.js", "/admin/assets/favicon.png", "/admin/assets/missing.js"]) {
      expect((await handleAdminRequest(new Request(`http://x${path}`), config, capabilities(), directory)).status).toBe(path === "/admin" ? 303 : 401);
    }
    expect((await handleAdminRequest(new Request("http://x/admin/assets/client.js", { headers: auth }), config, capabilities(), directory)).status).toBe(200);
    const favicon = await handleAdminRequest(new Request("http://x/admin/assets/favicon.png", { headers: auth }), config, capabilities(), directory);
    expect(favicon.status).toBe(200); expect(favicon.headers.get("content-type")).toBe("image/png"); expect(await favicon.bytes()).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect((await handleAdminRequest(new Request("http://x/admin/assets/missing.js", { headers: auth }), config, capabilities(), directory)).status).toBe(404);
    expect((await handleAdminRequest(new Request("http://x/admin/assets/client.js", { method: "POST", headers: auth }), config, capabilities(), directory)).status).toBe(405);
    const shell = await handleAdminRequest(new Request("http://x/admin", { headers: auth }), config, capabilities(), directory);
    const csrf = /data-csrf="([^"]+)"/.exec(await shell.text())?.[1]; if (!csrf) throw new Error("missing CSRF token");
    for (const request of [
       new Request("http://x/admin/whatsapp/pairing/cancel", { headers: auth }),
       new Request("http://x/admin/whatsapp/pairing/cancel", { method: "POST", headers: auth, body: "csrf=x" }),
       new Request("http://x/admin/whatsapp/pairing/cancel", { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: "csrf=%ZZ" }),
       new Request("http://x/admin/whatsapp/pairing/cancel", { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: `csrf=${encodeURIComponent(csrf)}&${"x".repeat(1_100)}=y` }),
    ]) expect((await handleAdminRequest(request, config, capabilities(), directory)).status).toBe(request.method === "GET" ? 405 : 400);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("admin ZIP API is authenticated, separately CSRF-protected, bounded, and returns only batch status", async () => {
  const api = capabilities();
  let received = 0;
  api.zip.ingest = async ({ bytes }) => { for await (const chunk of bytes) received += chunk.byteLength; return { batch: { id: "batch-1", idempotencyKey: "private-key", originalFilename: "bills.zip", state: "queued", createdAt: "now", updatedAt: "now" }, counts: { accepted: 1, rejected: 0, ignored: 0 } }; };
  expect((await handleAdminRequest(new Request("http://x/admin/api/zip", { method: "POST" }), config, api)).status).toBe(401);
  const overview = await (await handleAdminRequest(new Request("http://x/admin/api/overview", { headers: auth }), config, api)).json() as { whatsapp: { csrf: string }; zip: { csrf: string } };
  const headers = { ...auth, "content-type": "application/zip", "content-length": "3", "x-upload-id": "upload_1", "x-upload-filename": "bills.zip", "x-csrf-token": overview.zip.csrf };
  const uploaded = await handleAdminRequest(new Request("http://x/admin/api/zip", { method: "POST", headers, body: new Uint8Array([1, 2, 3]) }), config, api);
  expect(uploaded.status).toBe(202); expect(received).toBe(3); expect(await uploaded.json()).toEqual({ batch: { id: "batch-1", originalFilename: "bills.zip", state: "queued" }, counts: { accepted: 1, rejected: 0, ignored: 0 } });
  expect((await handleAdminRequest(new Request("http://x/admin/api/zip", { method: "POST", headers: { ...headers, "x-csrf-token": overview.whatsapp.csrf }, body: new Uint8Array([1]) }), config, api)).status).toBe(400);
  expect((await handleAdminRequest(new Request("http://x/admin/api/zip", { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: new Uint8Array([1]) }), config, api)).status).toBe(400);
  expect((await handleAdminRequest(new Request("http://x/admin/api/zip", { method: "POST", headers: { ...headers, "content-length": "101" }, body: new Uint8Array([1]) }), config, api)).status).toBe(400);
  const status = await handleAdminRequest(new Request("http://x/admin/api/zip/batch-1", { headers: auth }), config, api);
  expect(status.status).toBe(200); expect(await status.text()).not.toContain("private-key");
  expect((await handleAdminRequest(new Request("http://x/admin/api/zip/batch-1", { method: "POST", headers: auth }), config, api)).status).toBe(405);
});

test("admin ZIP API does not submit while Azure ingestion is unavailable", async () => {
  const api = capabilities(); api.zip.available = () => false;
  const overview = await (await handleAdminRequest(new Request("http://x/admin/api/overview", { headers: auth }), config, api)).json() as { zip: { csrf: string } };
  const response = await handleAdminRequest(new Request("http://x/admin/api/zip", { method: "POST", headers: { ...auth, "content-type": "application/zip", "content-length": "1", "x-upload-id": "upload_1", "x-upload-filename": "bills.zip", "x-csrf-token": overview.zip.csrf }, body: new Uint8Array([1]) }), config, api);
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("Azure");
});

test("unavailable WhatsApp discovery is explicit and admin reads never mutate canonical records or originals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "admin-canonical-"));
  const original = join(directory, "original.png");
  const bytes = new Uint8Array([1, 2, 3]);
  const database = new BillDatabase(join(directory, "ledger.sqlite"));
  try {
    writeFileSync(original, bytes);
    const bill = database.createBillWithInitialJobs({ whatsappMessageId: "admin-read", whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: "2026-08-31T00:00:00.000Z", mimeType: "image/png", originalPath: original, contentSha256: createHash("sha256").update(bytes).digest("hex") }, [{ type: "extract", idempotencyKey: "admin-read" }]).bill;
    const before = database.getBill(bill.id);
   const api = capabilities({ status: () => ({ state: "unavailable", canPair: false }), groups: () => [] });
    api.metrics = () => database.getDashboardMetrics();
    const overview = await (await handleAdminRequest(new Request("http://x/admin/api/overview", { headers: auth }), config, api)).json();
    expect(overview).toMatchObject({ metrics: { received: 1, approved: 0, failed: 0, retryableJobs: 0, permanentFailureJobs: 0 }, whatsapp: { state: "unavailable", groups: [] } });
    expect(database.getBill(bill.id)).toEqual(before);
    expect(createHash("sha256").update(readFileSync(original)).digest("hex")).toBe(bill.contentSha256);
    expect(readFileSync(original)).toEqual(Buffer.from(bytes));
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

function capabilities(overrides: Partial<AdminHttpCapabilities["whatsapp"]> = {}): AdminHttpCapabilities {
  return { metrics: () => ({ receivedBills: 1, approvedBills: 0, failedBills: 0, retryableJobs: 0, permanentFailureJobs: 0 }), whatsapp: { status: () => ({ state: "connected" as const, canPair: true }), pairingQr: async () => null, groups: () => [{ id: "group", name: "Bills" }], startPairing: async () => undefined, cancelPairing: async () => undefined, ...overrides }, zip: { available: () => true, maxCompressedBytes: 100, ingest: async () => ({ batch: { id: "batch-1", idempotencyKey: "key", originalFilename: "bills.zip", state: "queued", createdAt: "now", updatedAt: "now" }, counts: { accepted: 1, rejected: 0, ignored: 0 } }), status: () => ({ batch: { id: "batch-1", idempotencyKey: "key", originalFilename: "bills.zip", state: "completed", createdAt: "now", updatedAt: "now" }, counts: { total: 1, queued: 0, processing: 0, complete: 1, notInvoice: 0, rejected: 0, failed: 0 }, items: [{ entryPath: "invoice.pdf", state: "complete", errorCode: null, billId: "bill-1" }] }) } };
}
