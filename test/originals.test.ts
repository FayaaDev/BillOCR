import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { OriginalVerificationError, readVerifiedOriginal } from "../src/originals";

let dir: string; let root: string; let file: string; let bytes: Uint8Array;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "originals-"))); root = join(dir, "root"); mkdirSync(root); file = join(root, "bill.pdf"); bytes = new TextEncoder().encode("%PDF-1.7\nidentity"); writeFileSync(file, bytes); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const hash = () => createHash("sha256").update(bytes).digest("hex");
test("returns the opened, hash-verified bytes and rejects replacement/hash mismatch", async () => {
  expect((await readVerifiedOriginal({ path: file, root, maxBytes: 100, sha256: hash(), mimeType: "application/pdf", requireMagic: true })).bytes).toEqual(bytes);
  writeFileSync(file, "replacement");
  await expect(readVerifiedOriginal({ path: file, root, maxBytes: 100, sha256: hash(), mimeType: "application/pdf", requireMagic: true })).rejects.toBeInstanceOf(OriginalVerificationError);
});
test("rejects symlinked parents escaping root and archival MIME mismatches", async () => {
  const outside = join(dir, "outside"); mkdirSync(outside); writeFileSync(join(outside, "x.pdf"), bytes); symlinkSync(outside, join(root, "linked"));
  await expect(readVerifiedOriginal({ path: join(root, "linked", "x.pdf"), root, maxBytes: 100, sha256: hash(), mimeType: "application/pdf", requireMagic: true })).rejects.toBeInstanceOf(OriginalVerificationError);
  mkdirSync(join(root, "nested")); writeFileSync(join(root, "nested", "x.pdf"), bytes);
  await expect(readVerifiedOriginal({ path: join(root, "nested", "x.pdf"), root, maxBytes: 100, sha256: hash(), mimeType: "application/pdf", requireMagic: true })).rejects.toBeInstanceOf(OriginalVerificationError);
  writeFileSync(file, "not a PDF"); const otherHash = createHash("sha256").update("not a PDF").digest("hex");
  await expect(readVerifiedOriginal({ path: file, root, maxBytes: 100, sha256: otherHash, mimeType: "application/pdf", requireMagic: true })).rejects.toBeInstanceOf(OriginalVerificationError);
});
test("opens the original directory descriptor when the root path is swapped before child open", async () => {
  const outside = join(dir, "outside"); const movedRoot = join(dir, "root-before-swap"); mkdirSync(outside); writeFileSync(join(outside, "bill.pdf"), "%PDF-evil");
  const result = await readVerifiedOriginal({ path: file, root, maxBytes: 100, sha256: hash(), mimeType: "application/pdf", requireMagic: true, beforeOpenChild: async () => {
    renameSync(root, movedRoot); symlinkSync(outside, root);
  } });
  expect(result.bytes).toEqual(bytes);
});
test("walks canonical root ancestors by descriptor when an ancestor path is swapped", async () => {
  const ancestor = join(dir, "ancestor"); const protectedRoot = join(ancestor, "root"); const outside = join(dir, "outside"); const movedAncestor = join(dir, "moved-ancestor");
  mkdirSync(protectedRoot, { recursive: true }); mkdirSync(join(outside, "root"), { recursive: true }); writeFileSync(join(protectedRoot, "bill.pdf"), bytes); writeFileSync(join(outside, "root", "bill.pdf"), "%PDF-evil");
  const result = await readVerifiedOriginal({ path: join(protectedRoot, "bill.pdf"), root: protectedRoot, maxBytes: 100, sha256: hash(), mimeType: "application/pdf", requireMagic: true, beforeOpenRootComponent: async (component) => {
    if (component === "root") { renameSync(ancestor, movedAncestor); symlinkSync(outside, ancestor); }
  } });
  expect(result.bytes).toEqual(bytes);
});
