import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase } from "../src/database";
import { handleReviewRequest } from "../src/review-ui";
import type { AppConfig } from "../src/config";
import { createReviewCorrectionSyncHandler, createSheetsProjectionHandler, type SheetsAdapter } from "../src/google-projections";
import { JobWorker } from "../src/worker";
import { createLogger } from "../src/logger";
import { handleRequest } from "../src/http";

let dir: string; let assetDir: string; let database: BillDatabase; let config: AppConfig; let id: string;
const basic = (user = "alice", password = "password") => ({ authorization: `Basic ${btoa(`${user}:${password}`)}` });
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "review-ui-"))); const originals = join(dir, "originals");
  assetDir = join(dir, "review-assets"); mkdirSync(originals); mkdirSync(assetDir); mkdirSync(join(assetDir, "files")); writeFileSync(join(originals, "bill.png"), "original"); writeFileSync(join(assetDir, "client.js"), 'window.reviewQueue = "/review/api/bills";'); writeFileSync(join(assetDir, "theme.js"), 'window.reviewTheme = true;'); writeFileSync(join(assetDir, "client.css"), ".review-page{}"); writeFileSync(join(assetDir, "files", "noto-sans-arabic-arabic-400-normal.woff2"), "font"); database = new BillDatabase(join(dir, "db.sqlite"));
  config = { host: "127.0.0.1", port: 0, dataDir: dir, databasePath: join(dir, "db.sqlite"), logLevel: "error", whatsapp: { enabled: false, groupId: "g", authPath: dir, originalsDir: originals, maxAttachmentBytes: 1 }, mistral: { apiKey: "x", model: "x", maxResponseBytes: 1, requestTimeoutMs: 1 }, azure: { enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 1, requestTimeoutMs: 1, pollIntervalMs: 0, fallbackConfidenceThreshold: .80 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 }, google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "alice", password: "password" }, validation: { currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, jobs: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 1 } };
  id = database.createBillWithInitialJobs({ id: "review-bill", whatsappMessageId: "m", whatsappGroupId: "g", whatsappSenderId: "s", attachmentIndex: 0, receivedAt: "2026-08-01T00:00:00.000Z", mimeType: "image/png", originalPath: join(originals, "bill.png"), contentSha256: "a".repeat(64) }, [{ type: "extract", idempotencyKey: "extract:review" }]).bill.id;
  database.sqlite.query("UPDATE bills SET status = 'needs_review', content_revision = 1 WHERE id = ?").run(id);
  database.sqlite.query("INSERT INTO extractions (id,bill_id,schema_version,normalized_json,raw_provider_response,provider_model,prompt_schema_version,requested_at,completed_at,created_at,updated_at) VALUES ('e',?,'1',?,'<unsafe>','model','schema','2026-08-01','2026-08-01','2026-08-01','2026-08-01')").run(id, JSON.stringify({ schemaVersion: "1", vendorName: "<img src=x>", invoiceNumber: null, invoiceDate: "2026-08-01", currency: "USD", subtotal: 9, vat: 1, total: 10, description: null, fields: { total: { confidence: .1, sourceText: "x" } } }));
});
afterEach(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });

test("review requires Basic auth, escapes model output, and protects originals", async () => {
  expect((await handleReviewRequest(new Request("http://x/review"), database, config)).status).toBe(401);
  const detail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  expect(detail.headers.get("cache-control")).toBe("no-store"); expect(await detail.text()).not.toContain("<img src=x>");
  database.sqlite.query("UPDATE bills SET original_path = ? WHERE id = ?").run(join(dir, "outside"), id);
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/original`, { headers: basic() }), database, config)).status).toBe(404);
});

test("review detail omits evidence and has correction controls", async () => {
  const detail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const html = await detail.text();
  expect(html).toContain('<html lang="ar" dir="rtl">');
  expect(html).toContain('src="/review/assets/theme.js"');
  expect(html).toContain('<main class="review-page review-detail">'); expect(html).toContain('class="queue-back" href="/review"'); expect(html).toContain('class="status-badge">تحتاج إلى مراجعة</span>');
  expect(html).toContain('class="original-actions"'); expect(html).toContain('href="/review/bills/review-bill/original?download=1"'); expect(html).not.toContain('>Evidence</h2>'); expect(html).not.toContain('Immutable extraction data and review history.'); expect(html).not.toContain('Immutable model output'); expect(html).not.toContain('Confidence'); expect(html).not.toContain('Validation issues'); expect(html).not.toContain('Provenance'); expect(html).not.toContain('Audit events');
  expect(html).toContain('class="correction-form"'); expect(html).toContain('<label class="review-field" for="vendorName"><span>اسم المورد</span>'); expect(html).toContain('<textarea id="description" name="description"'); expect(html).not.toContain('name="handwritten"'); expect(html).not.toContain('name="reason"'); expect(html).not.toContain('name="note"'); expect(html).not.toContain('Reason for decision'); expect(html).not.toContain('Review note'); expect(html).toContain('class="review-action approve-action"'); expect(html).toContain('>اعتماد الفاتورة</button>'); expect(html).toContain('class="review-action reject-action"'); expect(html).toContain('>رفض الفاتورة</button>');
});

test("review queue shell, API, and fixed assets are authenticated", async () => {
  expect((await handleReviewRequest(new Request("http://x/review/api/bills"), database, config)).status).toBe(401);
  expect((await handleReviewRequest(new Request("http://x/review/assets/client.js"), database, config)).status).toBe(401);
  const shell = await handleReviewRequest(new Request("http://x/review", { headers: basic() }), database, config);
  const html = await shell.text();
  expect(html).toContain('<html lang="ar" dir="rtl">'); expect(html).toContain('<title>قائمة المراجعة</title>');
  expect(shell.headers.get("content-security-policy")).toContain("script-src 'self'"); expect(shell.headers.get("content-security-policy")).toContain("style-src 'self'"); expect(shell.headers.get("content-security-policy")).toContain("connect-src 'self'");
  expect(html).toContain('<div id="root"></div>'); expect(html).toContain('src="/review/assets/theme.js"'); expect(html).toContain('src="/review/assets/client.js"'); expect(html).toContain('href="/review/assets/client.css"'); expect(html).not.toContain("review-bill"); expect(html).not.toContain("<unsafe>");
  const api = await handleReviewRequest(new Request("http://x/review/api/bills", { headers: basic() }), database, config);
  expect(api.headers.get("content-type")).toContain("application/json"); expect(api.headers.get("cache-control")).toBe("no-store"); expect(await api.json()).toEqual([{ id, status: "needs_review", originalFilename: null, receivedAt: "2026-08-01T00:00:00.000Z", updatedAt: expect.any(String) }]);
  const apiPost = await handleReviewRequest(new Request("http://x/review/api/bills", { method: "POST", headers: basic() }), database, config);
  expect(apiPost.status).toBe(405); expect(apiPost.headers.get("allow")).toBe("GET");
  const script = await handleReviewRequest(new Request("http://x/review/assets/client.js", { headers: basic() }), database, config, assetDir);
  expect(script.status).toBe(200); expect(script.headers.get("content-type")).toContain("text/javascript"); expect(await script.text()).toContain("/review/api/bills");
  const theme = await handleReviewRequest(new Request("http://x/review/assets/theme.js", { headers: basic() }), database, config, assetDir);
  expect(theme.status).toBe(200); expect(theme.headers.get("content-type")).toContain("text/javascript"); expect(await theme.text()).toContain("reviewTheme");
  const font = await handleReviewRequest(new Request("http://x/review/assets/files/noto-sans-arabic-arabic-400-normal.woff2", { headers: basic() }), database, config, assetDir);
  expect(font.status).toBe(200); expect(font.headers.get("content-type")).toBe("font/woff2"); expect(await font.text()).toBe("font");
  const stylesheet = await handleReviewRequest(new Request("http://x/review/assets/client.css", { headers: basic() }), database, config, assetDir);
  expect(stylesheet.status).toBe(200); expect(stylesheet.headers.get("content-type")).toContain("text/css"); expect(await stylesheet.text()).toContain(".review-page");
  expect((await handleReviewRequest(new Request("http://x/review/assets/other.js", { headers: basic() }), database, config)).status).toBe(404);
  expect((await handleReviewRequest(new Request("http://x/review/assets/client.css", { method: "POST", headers: basic() }), database, config)).status).toBe(405);
});

test("CSRF-protected corrected approval preserves model output and is exactly once", async () => {
  const detail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await detail.text())?.[1]; if (!csrf) throw new Error("missing csrf");
  const form = new URLSearchParams({ csrf, contentRevision: "1", reviewRevision: "0", action: "approve", vendorName: "Vendor", invoiceNumber: "N", invoiceDate: "2026-08-01", currency: "USD", subtotal: "9", vat: "1", total: "10", description: "ok" });
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: { ...basic(), "content-type": "application/x-www-form-urlencoded" }, body: form }), database, config)).status).toBe(303);
  expect(database.getBill(id)).toMatchObject({ status: "approved", contentRevision: 2, reviewRevision: 1 }); expect(database.getExtraction(id)?.normalized?.vendorName).toBe("<img src=x>");
  expect(database.getReviewEvents(id)).toMatchObject([{ reason: null, note: null }]); expect(database.getEffectiveExtraction(id)?.vendorName).toBe("Vendor");
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: { ...basic(), "content-type": "application/x-www-form-urlencoded" }, body: form }), database, config)).status).toBe(409);
  expect(database.getReviewEvents(id)).toHaveLength(1); expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) count FROM jobs WHERE type = 'project_to_sheet'").get()?.count).toBe(1);
});

test("review approval accepts an extraction-length description", async () => {
  const description = "d".repeat(2_000);
  database.sqlite.query("UPDATE extractions SET normalized_json = ? WHERE bill_id = ?").run(JSON.stringify({ schemaVersion: "1", vendorName: "Vendor", invoiceNumber: "N", invoiceDate: "2026-08-01", currency: "USD", subtotal: 9, vat: 1, total: 10, description, fields: { total: { confidence: .1, sourceText: "x" } } }), id);
  const detail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await detail.text())?.[1]; if (!csrf) throw new Error("missing csrf");
  const form = new URLSearchParams({ csrf, contentRevision: "1", reviewRevision: "0", action: "approve", vendorName: "Vendor", invoiceNumber: "N", invoiceDate: "2026-08-01", currency: "USD", subtotal: "9", vat: "1", total: "10", description });
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: { ...basic(), "content-type": "application/x-www-form-urlencoded" }, body: form }), database, config)).status).toBe(303);
});

test("review mutations require bounded urlencoded forms and exact routes", async () => {
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: basic(), body: "x=y" }), database, config)).status).toBe(415);
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: { ...basic(), "content-type": "application/x-www-form-urlencoded" }, body: "csrf=%ZZ" }), database, config)).status).toBe(400);
  expect((await handleRequest(new Request("http://x/reviewevil", { headers: basic() }), database, config)).status).toBe(404);
  const method = await handleReviewRequest(new Request(`http://x/review/bills/${id}/original`, { method: "POST", headers: basic() }), database, config); expect(method.status).toBe(405); expect(method.headers.get("allow")).toBe("GET");
});

test("rejection creates no ledger projection and reconciles a stale hidden-ID row", async () => {
  const original = database.getExtraction(id)?.normalized; if (!original) throw new Error("missing extraction");
  database.sqlite.query("INSERT INTO provider_projection_metadata (id,bill_id,provider,projection_key,external_id,created_at,updated_at) VALUES ('sheet',?,'sheets',?,'3','now','now')").run(id, id);
  expect(database.submitReview({ billId: id, reviewerId: "alice", action: "reject", reason: "not a bill", note: "discard", expectedContentRevision: 1, expectedReviewRevision: 0, corrected: original }, [])).toBe(true);
  expect(database.getBill(id)?.status).toBe("failed"); expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) count FROM jobs WHERE type = 'project_to_sheet' AND state IN ('pending','retryable_failure')").get()?.count).toBe(0);
  const rows = [3]; const sheets: SheetsAdapter = { initializeLedger: async () => undefined, findRowByBillId: async () => rows[0] ?? null, findRowsByBillId: async () => [...rows], clearRows: async () => { rows.length = 0; }, appendRow: async () => 4, updateRow: async () => undefined };
  await new JobWorker(database, { sync_review_correction: createReviewCorrectionSyncHandler(database, sheets) }, { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 }, "test", createLogger("error")).runOnce();
  expect(rows).toEqual([]);
});

test("stale rejection sync repairs a reapproved current projection after clearing its row", async () => {
  const original = database.getExtraction(id)?.normalized; if (!original) throw new Error("missing extraction");
  database.sqlite.query("UPDATE bills SET status = 'failed', manual_review_required = 1, content_revision = 2, review_revision = 1 WHERE id = ?").run(id);
  database.sqlite.query("INSERT INTO provider_projection_metadata (id,bill_id,provider,projection_key,external_id,external_url,created_at,updated_at) VALUES ('drive',?,'drive',?,'drive-file','https://drive.example/file','now','now')").run(id, id);
  database.sqlite.query("INSERT INTO jobs (id,bill_id,type,state,idempotency_key,attempts,available_at,expected_revision,created_at,updated_at) VALUES ('sync',?,'sync_review_correction','pending','sync_review_correction:review-bill:1',0,?,1,?,?)").run(id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  const rows = new Map<number, (string | number | null)[]>([[3, [null, null, null, null, null, null, null, null, null, null, null, "failed", null, id, 2]]]);
  let found!: () => void; let resume!: () => void; const paused = new Promise<void>((resolve) => { found = resolve; }); const release = new Promise<void>((resolve) => { resume = resolve; });
  const sheets: SheetsAdapter = {
    initializeLedger: async () => undefined,
    findRowByBillId: async (billId) => [...rows.entries()].find(([, values]) => values[13] === billId)?.[0] ?? null,
    findRowsByBillId: async (billId) => { const matched = [...rows.entries()].filter(([, values]) => values[13] === billId).map(([row]) => row); found(); await release; return matched; },
    findLedgerRows: async (billId) => [...rows.entries()].filter(([, values]) => values[13] === billId).map(([row, values]) => ({ row, revision: Number(values[14]) })),
    clearRows: async (targets) => { for (const row of targets) rows.delete(row); },
    appendRow: async (values) => { rows.set(4, [...values]); return 4; }, updateRow: async (row, values) => { rows.set(row, [...values]); },
  };
  const policy = { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 };
  const sync = new JobWorker(database, { sync_review_correction: createReviewCorrectionSyncHandler(database, sheets) }, policy, "sync", createLogger("error"));
  const syncing = sync.runOnce(); await paused;
  expect(database.approveReviewCorrection({ billId: id, reviewerId: "alice", expectedContentRevision: 2, expectedReviewRevision: 1 })).toBe(true);
  await new JobWorker(database, { project_to_sheet: createSheetsProjectionHandler(database, sheets) }, policy, "current", createLogger("error")).runOnce();
  expect(database.sqlite.query<{ count: number }, []>("SELECT count(*) count FROM jobs WHERE type = 'project_to_sheet' AND state = 'succeeded'").get()?.count).toBe(1);
  resume(); await syncing;
  const repair = database.sqlite.query<{ id: string }, []>("SELECT id FROM jobs WHERE idempotency_key = 'repair:sync:2'").get(); expect(repair).not.toBeNull();
  await new JobWorker(database, { project_to_sheet: createSheetsProjectionHandler(database, sheets) }, policy, "repair", createLogger("error")).runOnce();
  expect(database.getJob(repair!.id)?.state).toBe("succeeded"); expect([...rows.values()].filter((values) => values[13] === id && values[14] === 2)).toHaveLength(1); expect(database.getBill(id)?.status).toBe("approved");
});

test("permanent extraction failure renders a corrective form and can be approved", async () => {
  database.sqlite.query("DELETE FROM extractions WHERE bill_id = ?").run(id);
  database.sqlite.query("INSERT INTO extractions (id,bill_id,schema_version,normalized_json,provider_model,prompt_schema_version,requested_at,completed_at,error_details,created_at,updated_at) VALUES ('failed',?,'1',NULL,'model','schema','2026-08-01','2026-08-02','malformed provider output','now','now')").run(id);
  database.sqlite.query("UPDATE jobs SET state = 'permanent_failure' WHERE bill_id = ?").run(id);
  const detail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const html = await detail.text(); expect(detail.status).toBe(200); expect(html).toContain("تعذر استخراج بيانات الفاتورة. أدخل البيانات المصححة أدناه."); expect(html).not.toContain('>Evidence</h2>'); expect(html).toContain('name="vendorName"'); expect(html).toContain('class="correction-form"');
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]; if (!csrf) throw new Error("missing csrf");
  const form = new URLSearchParams({ csrf, contentRevision: "1", reviewRevision: "0", action: "approve", vendorName: "Vendor", invoiceNumber: "N", invoiceDate: "2026-08-01", currency: "USD", subtotal: "9", vat: "1", total: "10", description: "ok" });
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: { ...basic(), "content-type": "application/x-www-form-urlencoded" }, body: form }), database, config)).status).toBe(303);
  expect(database.getBill(id)?.status).toBe("approved"); expect(database.getEffectiveExtraction(id)?.vendorName).toBe("Vendor");
});

test("manual approval bypasses automated factual validation", async () => {
  const detail = await handleReviewRequest(new Request(`http://x/review/bills/${id}`, { headers: basic() }), database, config);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await detail.text())?.[1]; if (!csrf) throw new Error("missing csrf");
  const form = new URLSearchParams({ csrf, contentRevision: "1", reviewRevision: "0", action: "approve", vendorName: "Vendor", invoiceNumber: "N", invoiceDate: "2026-08-01", currency: "NOT", subtotal: "9", vat: "1", total: "20", description: "ok" });
  expect((await handleReviewRequest(new Request(`http://x/review/bills/${id}/review`, { method: "POST", headers: { ...basic(), "content-type": "application/x-www-form-urlencoded" }, body: form }), database, config)).status).toBe(303);
  expect(database.getBill(id)?.status).toBe("approved");
});
