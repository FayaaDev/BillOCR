import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const directory = join(import.meta.dir, "fixtures", "approved");
const expected = {
  "example3.json": { vendorName: "Al-Anzi Lathe", invoiceNumber: "0427", invoiceDate: "2026-08-26", currency: null, subtotal: 70, vat: null, total: 70, description: null },
  "example4.json": { vendorName: "Car electrical & A/C", invoiceNumber: "0062", invoiceDate: "2024-08-26", currency: null, subtotal: 200, vat: null, total: 200, description: "5184" },
};

test("approved fixture manifests contain complete ground truth and existing image sources", () => {
  for (const [name, groundTruth] of Object.entries(expected)) {
    const manifest = JSON.parse(readFileSync(join(directory, name), "utf8")) as { source: unknown; expected: unknown };
    expect(manifest.expected).toEqual(groundTruth);
    expect(typeof manifest.source).toBe("string");
    expect(existsSync(resolve(directory, manifest.source as string))).toBe(true);
  }
});
