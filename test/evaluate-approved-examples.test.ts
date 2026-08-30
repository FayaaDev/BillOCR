import { expect, test } from "bun:test";
import { rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluateApprovedAnnotation, readApprovedFixturePng, runApprovedExampleEvaluation } from "../src/evaluate-approved-examples";

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
  const expected = { vendorName: "Al-Anzi Lathe", invoiceNumber: "0427", invoiceDate: "2026-08-26", currency: null, subtotal: 70, vat: null, total: 70, description: null };
  const annotation = { schemaVersion: "1", ...expected, fields: { vendorName: { confidence: 0.99, sourceText: "Al-Anzi Lathe" }, invoiceDate: { confidence: 0.99, sourceText: "26/08/2026" }, total: { confidence: 0.99, sourceText: "Total: 70" } } };
  expect(evaluateApprovedAnnotation(annotation, expected, new Date("2026-08-29T00:00:00.000Z"))).toMatchObject({ differences: [], decision: "approved", issues: [], passed: true });
  const review = evaluateApprovedAnnotation({ ...annotation, fields: { ...annotation.fields, total: { confidence: 0, sourceText: "Total: 70" } } }, expected, new Date("2026-08-29T00:00:00.000Z"));
  expect(review).toMatchObject({ decision: "needs_review", passed: false });
  expect(review.issues).toEqual(expect.arrayContaining([{ code: "required_field_confidence_low", field: "total" }]));
});

test("evaluator emits six sanitized records for original, sharp, and opencv variants", async () => {
  const providerCalls: Array<{ bytes: Uint8Array; idempotencyKey: string }> = [];
  const preprocessCalls: Array<{ bytes: Uint8Array; mimeType: string; mode?: "auto" | "sharp" | "opencv" }> = [];
  const expected = {
    "example3.json": { vendorName: "Al-Anzi Lathe", invoiceNumber: "0427", invoiceDate: "2026-08-26", currency: null, subtotal: 70, vat: null, total: 70, description: null },
    "example4.json": { vendorName: "Car electrical & A/C", invoiceNumber: "0062", invoiceDate: "2024-08-26", currency: null, subtotal: 200, vat: null, total: 200, description: "5184" },
  } as const;
  const records = await runApprovedExampleEvaluation({
    runToken: "test-run",
    preprocessor: {
      preprocess: async (input) => {
        preprocessCalls.push(input);
        return { bytes: new Uint8Array([input.mode === "sharp" ? 1 : 2]), mimeType: "image/png", mode: input.mode === "sharp" ? "sharp" : "opencv", width: 100, height: 200 };
      },
    },
    provider: {
      extract: async (input) => {
        providerCalls.push(input);
        const name = input.idempotencyKey.includes(":example3.json:") ? "example3.json" : "example4.json";
        const value = expected[name];
        return { annotation: { schemaVersion: "1", ...value, fields: { vendorName: { confidence: 0.99, sourceText: value.vendorName }, invoiceDate: { confidence: 0.99, sourceText: value.invoiceDate }, total: { confidence: 0.99, sourceText: String(value.total) } } }, rawResponse: "provider response", model: "test-model" };
      },
    },
  });

  expect(records).toHaveLength(6);
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ fixture: "example3.json", variant: "original", mode: "original", dimensions: null }),
    expect.objectContaining({ fixture: "example3.json", variant: "sharp", mode: "sharp", dimensions: { width: 100, height: 200 } }),
    expect.objectContaining({ fixture: "example3.json", variant: "opencv", mode: "opencv", dimensions: { width: 100, height: 200 } }),
  ]));
  expect(preprocessCalls.map(({ mode }) => mode)).toEqual(["sharp", "opencv", "sharp", "opencv"]);
  expect(providerCalls).toHaveLength(6);
  expect(providerCalls.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
    "approved-evaluation:extracted-bill-v4:test-run:example3.json:original",
    "approved-evaluation:extracted-bill-v4:test-run:example3.json:sharp",
    "approved-evaluation:extracted-bill-v4:test-run:example3.json:opencv",
    "approved-evaluation:extracted-bill-v4:test-run:example4.json:original",
    "approved-evaluation:extracted-bill-v4:test-run:example4.json:sharp",
    "approved-evaluation:extracted-bill-v4:test-run:example4.json:opencv",
  ]);
  await expect(readApprovedFixturePng("../../../example3.png")).resolves.toEqual(providerCalls[0]!.bytes);
  await expect(readApprovedFixturePng("../../../example4.png")).resolves.toEqual(providerCalls[3]!.bytes);
  for (const record of records) expect(Object.keys(record).sort()).toEqual(["decision", "differences", "dimensions", "fixture", "issues", "mode", "variant"]);
  expect(JSON.stringify(records)).not.toContain("provider response");
  expect(JSON.stringify(records)).not.toContain("test-model");
  expect(JSON.stringify(records)).not.toContain("test-run");
});

test("evaluator reports failed preprocessing locally without calling the provider", async () => {
  let calls = 0;
  const records = await runApprovedExampleEvaluation({
    runToken: "test-run",
    preprocessor: { preprocess: async () => null },
    provider: { extract: async () => { calls++; throw new Error("must not run"); } },
  });

  expect(calls).toBe(2);
  expect(records).toHaveLength(6);
  expect(records.filter(({ variant }) => variant !== "original")).toEqual(Array(4).fill(expect.objectContaining({ decision: "needs_review", issues: [{ code: "evaluator_preprocessing_failure", field: null }] })));
});
