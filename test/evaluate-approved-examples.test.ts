import { expect, test } from "bun:test";
import { rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluateApprovedAnnotation, readApprovedFixturePng } from "../src/evaluate-approved-examples";

test("evaluator accepts approved root-relative fixture images and rejects workspace escapes", async () => {
  await expect(readApprovedFixturePng("../../../example3.png")).resolves.toBeInstanceOf(Uint8Array);
  await expect(readApprovedFixturePng("../../../../etc/passwd")).rejects.toThrow("invalid fixture source");
});

test("evaluator rejects a symlink even when its target is a safe workspace image", async () => {
  const name = `evaluator-symlink-${Date.now()}.png`;
  const path = join(import.meta.dir, "fixtures", "approved", name);
  symlinkSync(resolve(import.meta.dir, "..", "example3.png"), path);
  try { await expect(readApprovedFixturePng(`./${name}`)).rejects.toThrow("invalid fixture source"); }
  finally { rmSync(path, { force: true }); }
});

test("evaluator requires both exact values and an approved production validation decision", () => {
  const expected = { vendorName: "Al-Anzi Lathe", invoiceNumber: "0427", invoiceDate: "2026-08-26", currency: null, subtotal: 70, vat: null, total: 70, description: null, handwritten: null };
  const annotation = { schemaVersion: "1", ...expected, fields: { vendorName: { confidence: 0.99, sourceText: "Al-Anzi Lathe" }, invoiceDate: { confidence: 0.99, sourceText: "26/08/2026" }, total: { confidence: 0.99, sourceText: "Total: 70" } } };
  const text = "Al-Anzi Lathe Invoice Date: 26/08/2026 Total: 70";
  const evidence = { regions: [{ text, words: ["Al-Anzi", "Lathe", "26/08/2026", "Total:", "70"].map((word) => ({ text: word, confidence: 0.95, startIndex: text.indexOf(word) })) }] };
  expect(evaluateApprovedAnnotation(annotation, expected, evidence, new Date("2026-08-29T00:00:00.000Z"))).toMatchObject({ differences: [], decision: "approved", issues: [], passed: true });
  const review = evaluateApprovedAnnotation(annotation, expected, undefined, new Date("2026-08-29T00:00:00.000Z"));
  expect(review).toMatchObject({ decision: "needs_review", passed: false });
  expect(review.issues).toEqual(expect.arrayContaining([{ code: "required_field_confidence_low", field: "vendorName" }, { code: "required_field_confidence_low", field: "invoiceDate" }, { code: "required_field_confidence_low", field: "total" }]));
});
