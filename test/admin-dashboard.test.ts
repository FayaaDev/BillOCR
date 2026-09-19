import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminZipTerminal, parseAdminOverview, parseAdminZipStatus, whatsappPairingView, type AdminOverview, type AdminZipStatus } from "../src/admin-dashboard";

const overview = { metrics: { received: 12, approved: 9, failed: 1, retryableJobs: 2, permanentFailureJobs: 3 }, whatsapp: { state: "awaiting_pairing", canPair: true, configuredGroupId: "1203630@g.us", groups: [{ id: "1203630@g.us", name: "الفواتير" }], csrf: "signed-token" }, telegram: { enabled: true, groupIds: ["-100123"] }, zip: { available: true, maxCompressedBytes: 1024, csrf: "zip-token" } } satisfies AdminOverview;

test("admin dashboard accepts the bounded safe overview contract", () => {
  expect(parseAdminOverview(overview)).toEqual(overview);
  expect(parseAdminOverview({ ...overview, whatsapp: { ...overview.whatsapp, configuredGroupId: null } })?.whatsapp.configuredGroupId).toBeNull();
});

test("admin dashboard rejects secret-like or malformed overview values", () => {
  expect(parseAdminOverview({ ...overview, whatsapp: { ...overview.whatsapp, qrToken: "secret" } })).toEqual(overview);
  expect(parseAdminOverview({ ...overview, metrics: { ...overview.metrics, received: -1 } })).toBeNull();
  expect(parseAdminOverview({ ...overview, whatsapp: { ...overview.whatsapp, state: "token" } })).toBeNull();
  expect(parseAdminOverview({ ...overview, whatsapp: { ...overview.whatsapp, canPair: "yes" } })).toBeNull();
  expect(parseAdminOverview({ ...overview, whatsapp: { ...overview.whatsapp, configuredGroupId: "" } })).toBeNull();
  expect(parseAdminOverview({ ...overview, whatsapp: { ...overview.whatsapp, groups: [{ id: "", name: null }] } })).toBeNull();
  expect(parseAdminOverview({ ...overview, telegram: { enabled: "yes", groupIds: [] } })).toBeNull();
  expect(parseAdminOverview({ ...overview, telegram: { enabled: true, groupIds: [""] } })).toBeNull();
  expect(parseAdminOverview({ ...overview, telegram: { enabled: true, groupIds: ["x".repeat(513)] } })).toBeNull();
});

test("pairing view exposes QR and cancel only after it is ready, then offers a safe restart", () => {
  expect(whatsappPairingView("connecting", true)).toBe("waiting");
  expect(whatsappPairingView("awaiting_pairing", true)).toBe("qr");
  expect(whatsappPairingView("unavailable", true)).toBe("start");
  expect(whatsappPairingView("unavailable", false)).toBe("unavailable");
  expect(whatsappPairingView("connected", true)).toBe("connected");
});

test("admin navigation links to the authenticated review queue without operational failures card", () => {
  const client = readFileSync(join(import.meta.dir, "..", "src", "admin-client.tsx"), "utf8");
  expect(client).toContain('className="admin-tabs"');
  expect(client).toContain('href="/review">مراجعة الفواتير</a>');
  expect(client).not.toContain("ملخص الأعطال التشغيلية");
  expect(client).toContain('type="file"');
  expect(client).toContain("تقدم الرفع");
  expect(client).toContain("خدمة التحليل غير مهيأة");
   expect(client).toContain('disabled aria-disabled="true" id="whatsapp-tab"');
   expect(client).not.toContain("معرّف المجموعة المكوّنة");
   expect(client).not.toContain("المجموعات المكتشفة");
   expect(client).not.toContain("لا يدعم هذا النقل بدء الاقتران من لوحة الإدارة.");
  expect(client).toContain('role="tablist"');
   expect(client).toContain('id="telegram-panel"');
   expect(client).toContain('id="zip-panel"');
   expect(client).not.toContain('id="whatsapp-panel"');
   expect(client).not.toContain('tabIndex={channel === "whatsapp" ? 0 : -1}');
  expect(client).toContain("رمز البوت");
});

test("ZIP status parser accepts safe aggregate and entry data only and identifies terminal batches", () => {
  const status = { batch: { id: "batch-1", originalFilename: "bills.zip", state: "completed" }, counts: { total: 2, queued: 0, processing: 0, complete: 1, notInvoice: 0, rejected: 1, failed: 0 }, items: [{ entryPath: "invoice.pdf", state: "complete", errorCode: null, billId: "bill-1" }, { entryPath: "notes.txt", state: "rejected", errorCode: "unsupported_content", billId: null }] } satisfies AdminZipStatus;
  expect(parseAdminZipStatus(status)).toEqual(status);
  expect(adminZipTerminal(status)).toBe(true);
  expect(adminZipTerminal({ ...status, counts: { ...status.counts, queued: 1 } })).toBe(false);
  expect(parseAdminZipStatus({ ...status, items: [{ ...status.items[0], state: "raw_provider_error" }] })).toBeNull();
  expect(parseAdminZipStatus({ ...status, counts: { ...status.counts, total: -1 } })).toBeNull();
});
