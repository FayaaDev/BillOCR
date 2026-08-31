import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAdminOverview, whatsappPairingView, type AdminOverview } from "../src/admin-dashboard";

const overview = { metrics: { received: 12, approved: 9, failed: 1, retryableJobs: 2, permanentFailureJobs: 3 }, whatsapp: { state: "awaiting_pairing", canPair: true, configuredGroupId: "1203630@g.us", groups: [{ id: "1203630@g.us", name: "الفواتير" }], csrf: "signed-token" } } satisfies AdminOverview;

test("admin dashboard accepts the bounded safe overview contract", () => {
  expect(parseAdminOverview(overview)).toEqual(overview);
});

test("admin dashboard rejects secret-like or malformed overview values", () => {
  expect(parseAdminOverview({ ...overview, whatsapp: { ...overview.whatsapp, qrToken: "secret" } })).toEqual(overview);
  expect(parseAdminOverview({ ...overview, metrics: { ...overview.metrics, received: -1 } })).toBeNull();
  expect(parseAdminOverview({ ...overview, whatsapp: { ...overview.whatsapp, state: "token" } })).toBeNull();
  expect(parseAdminOverview({ ...overview, whatsapp: { ...overview.whatsapp, canPair: "yes" } })).toBeNull();
  expect(parseAdminOverview({ ...overview, whatsapp: { ...overview.whatsapp, groups: [{ id: "", name: null }] } })).toBeNull();
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
});
