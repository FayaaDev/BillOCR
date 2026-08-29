import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AppConfig } from "../src/config";
import { BillDatabase, type RetryPolicy } from "../src/database";
import { runOps, type OpsDependencies } from "../src/ops";

const policy: RetryPolicy = { maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 1, leaseMs: 60_000 };
let directory: string; let database: BillDatabase; let config: AppConfig;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "bill-ops-"))); const originals = join(directory, "originals");
  config = { host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "ledger.sqlite"), logLevel: "error", whatsapp: { enabled: false, groupId: "group", authPath: join(directory, "auth"), originalsDir: originals, maxAttachmentBytes: 1024 }, mistral: { apiKey: "x", model: "x", maxResponseBytes: 1, requestTimeoutMs: 1 }, imagePreprocessing: { enabled: false, timeoutMs: 8_000 }, google: { enabled: false, authMode: "disabled", credentialJson: null, driveFolderId: null, sheetId: null, sheetName: "Ledger", requestTimeoutMs: 1, maxResponseBytes: 1 }, review: { username: "reviewer", password: "secret" }, validation: { confidenceThreshold: .85, handwrittenConfidenceThreshold: .92, currencyRoundingTolerance: .01, maxFutureInvoiceDays: 30 }, jobs: policy };
  database = new BillDatabase(config.databasePath);
});
afterEach(() => { try { database.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
function bill() { return database.createBillWithInitialJobs({ id: "ops-bill", whatsappMessageId: "wa-ops", whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: "2026-08-27T00:00:00.000Z", mimeType: "image/png", originalPath: join(config.whatsapp.originalsDir, "original.png"), contentSha256: "a".repeat(64) }, [{ type: "extract", idempotencyKey: "ops-extract" }]).bill; }
async function invoke(args: string[], extra: Omit<OpsDependencies, "config" | "createDatabase" | "output" | "now"> = {}): Promise<unknown> { const lines: string[] = []; await runOps(args, { ...extra, config, createDatabase: () => database, output: (line) => lines.push(line), now: () => new Date("2026-08-28T00:00:00.000Z") }); return JSON.parse(lines[0]!); }

test("ops parses status/errors and inspects every documented bill identifier", async () => {
  const item = bill(); database.sqlite.query("UPDATE bills SET drive_file_id = 'drive-id', sheet_row_key = 'sheet-key' WHERE id = ?").run(item.id);
  expect(await invoke(["migrate"])).toEqual({ database: config.databasePath, status: "migrated" });
  for (const identifier of ["wa-ops", "ops-bill", "drive-id", "sheet-key"]) {
    database = new BillDatabase(config.databasePath); const result = await invoke(["inspect", identifier]) as Array<{ bill: { id: string } }>;
    expect(result[0]?.bill.id).toBe(item.id);
  }
  database = new BillDatabase(config.databasePath);
  await expect(invoke([])).rejects.toThrow("Usage:"); await expect(invoke(["inspect"])).rejects.toThrow("Usage:"); await expect(invoke(["unknown"])).rejects.toThrow("Usage:");
});

test("failed-jobs and retry report eligibility and preserve running/succeeded jobs", async () => {
  const item = bill(); const claimed = database.claimNextJob("worker", policy)!;
  expect(await invoke(["retry", claimed.id])).toEqual([{ id: claimed.id, requeued: false }]);
  database = new BillDatabase(config.databasePath); database.completeJob(claimed.id, claimed.leaseToken);
  expect(await invoke(["retry", claimed.id])).toEqual([{ id: claimed.id, requeued: false }]);
  database = new BillDatabase(config.databasePath); database.sqlite.query("UPDATE jobs SET state = 'retryable_failure', last_error = 'provider_timeout' WHERE id = ?").run(claimed.id);
  const listed = await invoke(["failed-jobs"]) as Array<{ job: { id: string; state: string }; bill: { id: string } }>;
  expect(listed).toContainEqual(expect.objectContaining({ job: expect.objectContaining({ id: claimed.id, state: "retryable_failure" }), bill: expect.objectContaining({ id: item.id }) }));
  database = new BillDatabase(config.databasePath); expect(await invoke(["retry", claimed.id])).toEqual([{ id: claimed.id, requeued: true }]);
  database = new BillDatabase(config.databasePath); expect(database.getJob(claimed.id)).toMatchObject({ state: "pending" }); expect(database.getJobTransitions(claimed.id).at(-1)).toMatchObject({ reason: "operator_replay" });
  database.sqlite.query("UPDATE jobs SET state = 'permanent_failure', last_error = 'malformed_provider_output' WHERE id = ?").run(claimed.id);
  expect(await invoke(["retry", claimed.id])).toEqual([{ id: claimed.id, requeued: false }]);
  database = new BillDatabase(config.databasePath); expect(await invoke(["retry", "--include-permanent", claimed.id])).toEqual([{ id: claimed.id, requeued: true }]);
});

test("backup writes a WAL-safe SQLite snapshot, originals checksums, and restore manifest", async () => {
  const item = bill(); const original = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  mkdirSync(config.whatsapp.originalsDir); writeFileSync(item.originalPath, original); database.sqlite.query("UPDATE bills SET content_sha256 = ? WHERE id = ?").run(createHash("sha256").update(original).digest("hex"), item.id); const backupRoot = join(directory, "backups"); const result = await invoke(["backup", backupRoot]) as { database: string; originals: string; manifest: string };
  expect(existsSync(result.database)).toBe(true); expect(existsSync(join(result.originals, "original.png"))).toBe(true);
  const manifest = JSON.parse(readFileSync(result.manifest, "utf8")) as { originalsRoot: string; database: { sha256: string }; originals: Array<{ path: string; size: number; sha256: string; billIds: string[]; sourceCanonicalPath: string; archiveRelativePath: string }>; restore: string };
  expect(manifest.database.sha256).toBe(createHash("sha256").update(readFileSync(result.database)).digest("hex")); expect(manifest.originals).toEqual([{ path: "original.png", size: original.byteLength, sha256: createHash("sha256").update(original).digest("hex"), billIds: [item.id], sourceCanonicalPath: item.originalPath, archiveRelativePath: "original.png" }]); expect(manifest.originalsRoot).toBe(config.whatsapp.originalsDir); expect(manifest.restore).toContain(config.whatsapp.originalsDir);
  // The documented restore layout is the same absolute originals root encoded in the snapshot.
  rmSync(config.whatsapp.originalsDir, { recursive: true }); mkdirSync(config.whatsapp.originalsDir); copyFileSync(join(result.originals, "original.png"), item.originalPath);
  const snapshot = new BillDatabase(result.database); for (const canonical of snapshot.listCanonicalOriginals()) { expect(existsSync(canonical.originalPath)).toBe(true); expect(createHash("sha256").update(readFileSync(canonical.originalPath)).digest("hex")).toBe(canonical.contentSha256); } snapshot.close();
});

test("backup rejects a symlinked original without reading it or leaving a usable archive", async () => {
  bill(); mkdirSync(config.whatsapp.originalsDir); const secret = join(directory, "outside-secret"); writeFileSync(secret, "do-not-copy"); symlinkSync(secret, join(config.whatsapp.originalsDir, "linked-secret"));
  const backupRoot = join(directory, "backups"); await expect(invoke(["backup", backupRoot])).rejects.toThrow("original unavailable");
  expect(existsSync(join(backupRoot, "bill-ledger-2026-08-28T00-00-00-000Z"))).toBe(false);
  expect(readFileSync(secret, "utf8")).toBe("do-not-copy");
});

test("backup uses only snapshot bills: concurrent later ingestion and orphan files are omitted", async () => {
  const first = bill(); const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]); mkdirSync(config.whatsapp.originalsDir); writeFileSync(first.originalPath, bytes); writeFileSync(join(config.whatsapp.originalsDir, "orphan.png"), bytes);
  database.sqlite.query("UPDATE bills SET content_sha256 = ? WHERE id = ?").run(createHash("sha256").update(bytes).digest("hex"), first.id);
  const backupRoot = join(directory, "backups"); const result = await invoke(["backup", backupRoot], { afterSnapshot: () => {
    const live = new BillDatabase(config.databasePath); const secondPath = join(config.whatsapp.originalsDir, "later.png"); writeFileSync(secondPath, bytes); live.createBillWithInitialJobs({ id: "later-bill", whatsappMessageId: "later", whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: "2026-08-28T00:00:00.000Z", mimeType: "image/png", originalPath: secondPath, contentSha256: createHash("sha256").update(bytes).digest("hex") }, []); live.close();
  } }) as { manifest: string; originals: string };
  const manifest = JSON.parse(readFileSync(result.manifest, "utf8")) as { originals: Array<{ billIds: string[] }> }; expect(manifest.originals).toEqual([expect.objectContaining({ billIds: [first.id] })]);
  expect(readdirSync(result.originals)).toEqual(["original.png"]);
  const snapshotPath = join(dirname(result.manifest), "ledger.sqlite"); const snapshot = new BillDatabase(snapshotPath); expect(snapshot.listCanonicalOriginals().map((item) => item.id)).toEqual([first.id]); snapshot.close();
});

test("backup fails closed when a pathname is swapped to an outside symlink after opening the originals root", async () => {
  const item = bill(); const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]); mkdirSync(config.whatsapp.originalsDir); writeFileSync(item.originalPath, bytes); database.sqlite.query("UPDATE bills SET content_sha256 = ? WHERE id = ?").run(createHash("sha256").update(bytes).digest("hex"), item.id);
  const secret = join(directory, "outside-secret"); const moved = join(config.whatsapp.originalsDir, "moved.png"); writeFileSync(secret, "outside bytes"); const backupRoot = join(directory, "backups");
  await expect(invoke(["backup", backupRoot], { beforeOpenOriginalChild: () => { renameSync(item.originalPath, moved); symlinkSync(secret, item.originalPath); } })).rejects.toThrow("original unavailable");
  expect(existsSync(join(backupRoot, "bill-ledger-2026-08-28T00-00-00-000Z"))).toBe(false); expect(readFileSync(secret, "utf8")).toBe("outside bytes");
});

test("backup fails with no usable archive when a snapshot-referenced original is missing", async () => {
  bill(); const backupRoot = join(directory, "backups"); await expect(invoke(["backup", backupRoot])).rejects.toThrow("original unavailable");
  expect(existsSync(join(backupRoot, "bill-ledger-2026-08-28T00-00-00-000Z"))).toBe(false);
});

test("backup rejects conflicting snapshot records for one canonical basename", async () => {
  const first = bill(); const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]); mkdirSync(config.whatsapp.originalsDir); writeFileSync(first.originalPath, bytes); const hash = createHash("sha256").update(bytes).digest("hex"); database.sqlite.query("UPDATE bills SET content_sha256 = ? WHERE id = ?").run(hash, first.id);
  database.createBillWithInitialJobs({ id: "conflict-bill", whatsappMessageId: "conflict", whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: "2026-08-28T00:00:00.000Z", mimeType: "image/png", originalPath: first.originalPath, contentSha256: "b".repeat(64) }, []);
  const backupRoot = join(directory, "backups"); await expect(invoke(["backup", backupRoot])).rejects.toThrow("Conflicting canonical original basename");
  expect(existsSync(join(backupRoot, "bill-ledger-2026-08-28T00-00-00-000Z"))).toBe(false);
});
