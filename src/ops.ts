import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { canonicalOriginalsDir, loadConfig, type AppConfig } from "./config";
import { BillDatabase } from "./database";
import type { Bill } from "./contracts";
import { readVerifiedOriginal } from "./originals";

export interface OpsDependencies {
  config: AppConfig;
  createDatabase?: (path: string) => BillDatabase;
  output?: (line: string) => void;
  now?: () => Date;
  /** Test-only synchronization hooks; production uses the same verified reader without hooks. */
  afterSnapshot?: (snapshotPath: string) => Promise<void> | void;
  beforeOpenOriginalChild?: (bill: { id: string; originalPath: string }) => Promise<void> | void;
}
function usage(): never { throw new Error("Usage: bun run ops <migrate|inspect|failed-jobs|retry|backup> [arguments]"); }
function billView(database: BillDatabase, bill: Bill): object {
  return { bill, extraction: database.getExtraction(bill.id), validationIssues: database.getValidationIssues(bill.id), jobs: database.listJobsForBill(bill.id), projections: { drive: database.getProjectionMetadata("drive", bill.id), sheets: database.getProjectionMetadata("sheets", bill.id) } };
}
function safeBackupName(value: string): string { return basename(value).replace(/[^A-Za-z0-9._-]/g, "_") || "backup"; }
function sha256(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
type BackupFile = { path: string; size: number; sha256: string; billIds: string[]; sourceCanonicalPath: string; archiveRelativePath: string };
async function copySnapshotOriginals(snapshotPath: string, originalsRoot: string, destination: string, maxBytes: number, beforeOpenOriginalChild?: OpsDependencies["beforeOpenOriginalChild"]): Promise<BackupFile[]> {
  const snapshot = new BillDatabase(snapshotPath);
  try {
    const root = resolve(originalsRoot);
    const unique = new Map<string, { id: string; originalPath: string; contentSha256: string; mimeType: string; billIds: string[] }>();
    for (const bill of snapshot.listCanonicalOriginals()) {
      const key = `${bill.originalPath}\u0000${bill.contentSha256}\u0000${bill.mimeType}`; const existing = unique.get(key);
      if (existing) existing.billIds.push(bill.id); else unique.set(key, { ...bill, billIds: [bill.id] });
    }
    const names = new Map<string, { contentSha256: string; mimeType: string }>();
    for (const item of unique.values()) {
      const source = resolve(item.originalPath); const name = basename(source);
      if (source !== item.originalPath || source.startsWith(`${root}/`) === false || source.slice(root.length + 1).includes("/") || !name || name === "." || name === "..") throw new Error(`Canonical original is not a direct child of configured root: ${item.id}`);
      const collision = names.get(name);
      if (collision && (collision.contentSha256 !== item.contentSha256 || collision.mimeType !== item.mimeType)) throw new Error(`Conflicting canonical original basename: ${name}`);
      names.set(name, { contentSha256: item.contentSha256, mimeType: item.mimeType });
    }
    mkdirSync(destination, { recursive: true }); const copied: BackupFile[] = [];
    for (const item of unique.values()) {
      const source = resolve(item.originalPath); const name = basename(source);
      const verified = await readVerifiedOriginal({ path: item.originalPath, root: originalsRoot, maxBytes, sha256: item.contentSha256, mimeType: item.mimeType, requireMagic: true, beforeOpenChild: async () => { await beforeOpenOriginalChild?.({ id: item.id, originalPath: item.originalPath }); } });
      const path = name; const output = join(destination, path);
      writeFileSync(output, verified.bytes, { flag: "wx" });
      copied.push({ path, size: verified.bytes.byteLength, sha256: createHash("sha256").update(verified.bytes).digest("hex"), billIds: item.billIds.sort(), sourceCanonicalPath: item.originalPath, archiveRelativePath: path });
    }
    return copied;
  } finally { snapshot.close(); }
}

/** Local-only operator CLI. Dependencies make parsing and output testable without environment or network access. */
export async function runOps(args: readonly string[], dependencies: OpsDependencies): Promise<void> {
  const [command, ...argv] = args; if (!command) usage();
  const output = dependencies.output ?? console.log;
  const write = (value: unknown): void => output(JSON.stringify(value, null, 2));
  const database = (dependencies.createDatabase ?? ((path: string) => new BillDatabase(path)))(dependencies.config.databasePath);
  try {
    if (command === "migrate") { write({ database: dependencies.config.databasePath, status: "migrated" }); return; }
    if (command === "inspect") {
      const identifier = argv[0]; if (!identifier || argv.length !== 1) usage();
      write(database.findBillsByIdentifier(identifier).map((bill) => billView(database, bill))); return;
    }
    if (command === "failed-jobs") { write(database.listJobs(["retryable_failure", "permanent_failure"]).map((job) => ({ job, bill: database.getBill(job.billId) }))); return; }
    if (command === "retry") {
      const includePermanent = argv[0] === "--include-permanent"; const jobIds = argv.slice(includePermanent ? 1 : 0); if (!jobIds.length) usage();
      write(jobIds.map((id) => ({ id, requeued: database.requeueJob(id, includePermanent) }))); return;
    }
    if (command === "backup") {
      const destination = argv[0]; if (!destination || argv.length !== 1) usage();
      mkdirSync(dependencies.config.originals.dir, { recursive: true });
      const root = resolve(destination); const originalsRoot = canonicalOriginalsDir(dependencies.config.originals.dir);
      if (root === originalsRoot || root.startsWith(`${originalsRoot}/`) || root === resolve(dependencies.config.databasePath)) throw new Error("Backup destination must be outside originals and database paths");
      mkdirSync(root, { recursive: true });
      const stamp = (dependencies.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-"); const target = join(root, `bill-ledger-${stamp}`); mkdirSync(target);
      try {
        // VACUUM INTO is SQLite's consistent WAL-safe online snapshot mechanism.
        const dbCopy = join(target, safeBackupName(dependencies.config.databasePath)); database.sqlite.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
        await dependencies.afterSnapshot?.(dbCopy);
        const originals = join(target, "originals"); const copied = await copySnapshotOriginals(dbCopy, originalsRoot, originals, dependencies.config.originals.maxAttachmentBytes, dependencies.beforeOpenOriginalChild);
        const manifest = { version: 1, createdAt: (dependencies.now ?? (() => new Date()))().toISOString(), originalsRoot, database: { path: basename(dbCopy), sha256: sha256(dbCopy) }, originals: copied, restore: `Stop the service. Restore this database file and originals/ directory together into APP_DATABASE_PATH and the same absolute WHATSAPP_ORIGINALS_DIR (${originalsRoot}). Run bun run migrate, verify checksums, then start one service host.` };
        const manifestPath = join(target, "manifest.json"); writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        write({ backup: target, database: dbCopy, originals, manifest: manifestPath, restore: manifest.restore }); return;
      } catch (error) { rmSync(target, { recursive: true, force: true }); throw error; }
    }
    usage();
  } finally { database.close(); }
}
if (import.meta.main) void runOps(Bun.argv.slice(2), { config: loadConfig() }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
