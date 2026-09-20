import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { AppConfig } from "../src/config";
import type { WhatsAppAdminTransport } from "../src/baileys-transport";
import { BillDatabase } from "../src/database";
import { startService, type RunningService } from "../src/server";

const root = join(import.meta.dir, "..");
const build = Bun.spawnSync({ cmd: ["bun", "run", "build"], cwd: root, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) throw new Error("Could not build UI assets for preview");

const directory = realpathSync(mkdtempSync(join(tmpdir(), "bill-ui-preview-")));
const originals = join(directory, "originals");
mkdirSync(originals);
const config: AppConfig = {
  host: "127.0.0.1", port: 3107, dataDir: directory, databasePath: join(directory, "ledger.sqlite"), logLevel: "error",
  originals: { dir: originals, maxAttachmentBytes: 2 * 1024 * 1024 },
  telegram: { enabled: true, botToken: "preview-only", groupIds: ["-100-preview-bills", "-100-preview-archive"], pollTimeoutSeconds: 1, requestTimeoutMs: 1, maxResponseBytes: 1024 },
  whatsapp: { enabled: true, groupId: "preview-bills", authPath: join(directory, "auth"), originalsDir: originals, maxAttachmentBytes: 2 * 1024 * 1024 },
  mistral: { apiKey: "preview-only", model: "preview", maxResponseBytes: 1024, requestTimeoutMs: 1 },
  azure: { enabled: true, endpoint: "https://preview.invalid", apiKey: "preview-only", maxResponseBytes: 1024, requestTimeoutMs: 1, pollIntervalMs: 0, fallbackConfidenceThreshold: 0.8 },
  imagePreprocessing: { enabled: false, timeoutMs: 1 },
  google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 },
  review: { username: "preview", password: "preview-only" },
  validation: { currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 },
  jobs: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 },
};

async function seed(): Promise<string[]> {
  if (process.env.UI_PREVIEW_EMPTY === "1") return [];
  const database = new BillDatabase(config.databasePath);
  const ids: string[] = [];
  try {
    for (let index = 0; index < 24; index += 1) {
      const id = index === 23 ? "preview-not-invoice" : `preview-bill-${String(index + 1).padStart(2, "0")}`;
      const date = new Date(Date.now() - index * 3 * 86_400_000).toISOString();
      const originalPath = join(originals, `${id}.png`);
      const svg = `<svg width="900" height="1200" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="60" y="100" font-size="42" fill="black">SYNTHETIC INVOICE ${index + 1}</text><text x="60" y="180" font-size="28" fill="black">Preview Vendor ${index + 1} • VAT 15% • SAR ${(100 + index * 13).toFixed(2)}</text></svg>`;
      await sharp(Buffer.from(svg)).png().toFile(originalPath);
      const bytes = readFileSync(originalPath);
      const status = index < 12 ? "approved" : index < 19 ? "needs_review" : index < 22 ? "failed" : "received";
      const classification = index === 23 ? "not_invoice" : "invoice";
      const vendorName = index >= 12 && index < 15 ? null : `Preview Vendor ${index + 1}`;
      const bill = database.createBillWithInitialJobs({
        id, source: index % 3 === 0 ? "telegram" : "whatsapp", sourceMessageId: `preview-message-${index + 1}`, sourceChatId: index % 3 === 0 ? "-100-preview-bills" : "preview-bills", sourceSenderId: `preview-sender-${index + 1}`, attachmentIndex: 0,
        receivedAt: date, mimeType: "image/png", originalPath, contentSha256: createHash("sha256").update(bytes).digest("hex"), classification,
      }, []).bill;
      database.sqlite.query("UPDATE bills SET status = ?, manual_review_required = ? WHERE id = ?").run(classification === "not_invoice" ? "failed" : status, status === "needs_review" ? 1 : 0, bill.id);
      database.sqlite.query("INSERT INTO extractions (id,bill_id,schema_version,normalized_json,raw_provider_response,provider_model,prompt_schema_version,requested_at,completed_at,created_at,updated_at) VALUES (?,?, '1', ?, 'fixture only', 'preview', '1', ?, ?, ?, ?)").run(
        `preview-extraction-${index + 1}`, bill.id,
        JSON.stringify({ schemaVersion: "1", vendorName, vendorTaxNumber: `3101234567${String(index).padStart(5, "0")}`, invoiceNumber: `PRE-${String(index + 1).padStart(4, "0")}`, invoiceDate: date.slice(0, 10), currency: "SAR", subtotal: 100 + index * 13, vat: 15 + index * 1.95, total: 115 + index * 14.95, description: index === 23 ? "Synthetic non-invoice attachment" : `Synthetic invoice fixture ${index + 1}`, truckNumber: `TRK-${100 + index}`, fields: {} }), date, date, date, date,
      );
      ids.push(id);
    }
  } finally { database.close(); }
  return ids;
}

const ids = await seed();
const whatsappTransport: WhatsAppAdminTransport = {
  start: async () => undefined, stop: async () => undefined,
  status: () => ({ state: "connected", canPair: true }), pairingQr: async () => null,
  groups: async () => ({ available: true, groups: [{ id: "preview-bills", subject: "Preview bills" }, { id: "preview-ops", subject: "Preview operations" }] }),
  startPairing: async () => undefined, cancelPairing: async () => undefined,
};
let service: RunningService | undefined;
try {
  service = startService(config, {}, {
    enableTelegram: false,
    whatsappTransport,
    mistralProvider: { extract: async () => { throw new Error("Preview fixture never calls Mistral"); } },
    azureProvider: { submit: async () => { throw new Error("Preview fixture never calls Azure"); }, poll: async () => { throw new Error("Preview fixture never calls Azure"); } },
  });
  const login = await fetch(new URL("login", service.url), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=preview&password=preview-only&return=%2Fadmin", redirect: "manual" });
  const cookie = login.headers.get("set-cookie");
  const admin = cookie ? await fetch(new URL("admin", service.url), { headers: { cookie } }) : undefined;
  const review = cookie ? await fetch(new URL("review", service.url), { headers: { cookie } }) : undefined;
  const adminAsset = cookie ? await fetch(new URL("admin/assets/client.js", service.url), { headers: { cookie } }) : undefined;
  const reviewAsset = cookie ? await fetch(new URL("review/assets/client.js", service.url), { headers: { cookie } }) : undefined;
  const [adminHtml, reviewHtml] = await Promise.all([admin?.text(), review?.text(), adminAsset?.arrayBuffer(), reviewAsset?.arrayBuffer()]);
  if (login.status !== 303 || !cookie || admin?.status !== 200 || review?.status !== 200 || adminAsset?.status !== 200 || reviewAsset?.status !== 200 || !adminHtml?.includes("data-clear-csrf") || !reviewHtml?.includes("data-csrf")) throw new Error("Preview auth/CSRF/assets smoke check failed");
} catch (error) {
  await service?.shutdown();
  rmSync(directory, { recursive: true, force: true });
  throw error;
}

const shutdown = async () => { await service?.shutdown(); rmSync(directory, { recursive: true, force: true }); };
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
console.log(`UI preview: ${service.url}admin`);
console.log("Login: preview / preview-only (local fixture only)");
console.log(ids.length ? `Seeded bill IDs: ${ids.join(", ")}` : "Seeded bill IDs: none (UI_PREVIEW_EMPTY=1)");
console.log("Try admin metrics/integrations, review detail/original, approve or reject, clear bills, and logout. Ctrl-C removes the temporary fixture.");
