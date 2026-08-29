import { lstat, readFile, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { EXTRACTION_PROMPT_VERSION, groundRequiredFieldConfidence, MistralHttpOcrProvider, type OcrEvidence, parseProviderExtractedBill } from "./extraction";
import { validateExtractedBill } from "./validation";
import { loadValidationConfig } from "./config";

const fixtureDirectory = resolve(import.meta.dir, "../test/fixtures/approved");
const workspaceRoot = resolve(import.meta.dir, "..");
const fixtureNames = ["example3.json", "example4.json"] as const;
const maxAttachmentBytes = 20 * 1024 * 1024;
const runToken = randomUUID();
const fields = ["vendorName", "invoiceNumber", "invoiceDate", "currency", "subtotal", "vat", "total", "description", "handwritten"] as const;
type Field = typeof fields[number];
export type ApprovedExpected = Record<Field, string | number | boolean | null>;

function fixture(value: unknown): { source: string; expected: ApprovedExpected } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid fixture");
  const record = value as Record<string, unknown>;
  if (typeof record.source !== "string" || !record.expected || typeof record.expected !== "object" || Array.isArray(record.expected)) throw new Error("invalid fixture");
  const expected = record.expected as Record<string, unknown>;
  for (const field of fields) if (!(field in expected) || (!["string", "number", "boolean"].includes(typeof expected[field]) && expected[field] !== null)) throw new Error("invalid fixture");
  return { source: record.source, expected: expected as ApprovedExpected };
}

function fixtureSource(source: string): string {
  const path = resolve(fixtureDirectory, source);
  if (!path.startsWith(`${workspaceRoot}/`)) throw new Error("invalid fixture source");
  return path;
}
function isPng(bytes: Uint8Array): boolean { return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value); }
export async function readApprovedFixturePng(source: string): Promise<Uint8Array> {
  const path = fixtureSource(source); const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > maxAttachmentBytes) throw new Error("invalid fixture source");
  const real = await realpath(path);
  if (!real.startsWith(`${workspaceRoot}/`) || !(await lstat(real)).isFile()) throw new Error("invalid fixture source");
  const bytes = await readFile(real);
  if (bytes.byteLength > maxAttachmentBytes || !isPng(bytes)) throw new Error("invalid fixture source");
  return bytes;
}

function schemaReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  for (const field of ["schemaVersion", "vendorName", "invoiceNumber", "invoiceDate", "currency", "subtotal", "vat", "total", "description", "handwritten", "fields"]) if (message.includes(field)) return field;
  return "schema";
}
type EvaluatorResult = { differences: Array<{ field: Field; expected: ApprovedExpected[Field]; actual: ApprovedExpected[Field] }>; decision: "approved" | "needs_review"; issues: Array<{ code: string; field: string | null }>; passed: boolean };
export function evaluateApprovedAnnotation(annotation: unknown, expected: ApprovedExpected, evidence: OcrEvidence | undefined, now = new Date()): EvaluatorResult {
  const parsed = parseProviderExtractedBill(annotation);
  const grounded = groundRequiredFieldConfidence(parsed, evidence ?? { regions: [] });
  const validation = validateExtractedBill(grounded, loadValidationConfig(Bun.env), now);
  const differences = fields.flatMap((field) => Object.is(grounded[field], expected[field]) ? [] : [{ field, expected: expected[field], actual: grounded[field] }]);
  return { differences, decision: validation.decision, issues: validation.issues.map(({ code, field }) => ({ code, field })), passed: differences.length === 0 && validation.decision === "approved" };
}
function printFailure(name: string, category: "fixture" | "provider" | "schema", reason?: string): void {
  console.log(JSON.stringify({ fixture: name, differences: [], decision: "needs_review", issues: [{ code: category === "schema" ? `evaluator_schema_${reason ?? "schema"}` : `evaluator_${category}_failure`, field: null }] }));
}

async function main(): Promise<void> {
  const apiKey = Bun.env.MISTRAL_API_KEY?.trim(); const model = Bun.env.MISTRAL_MODEL?.trim();
  if (!apiKey || !model) throw new Error("MISTRAL_API_KEY and MISTRAL_MODEL are required");
  const provider = new MistralHttpOcrProvider(apiKey, model);
  let failed = false;
  for (const name of fixtureNames) {
    let approved: { source: string; expected: ApprovedExpected }; let bytes: Uint8Array;
    try {
      approved = fixture(JSON.parse(await readFile(resolve(fixtureDirectory, name), "utf8"))); bytes = await readApprovedFixturePng(approved.source);
    } catch {
      failed = true; printFailure(name, "fixture"); continue;
    }
    let result: Awaited<ReturnType<MistralHttpOcrProvider["extract"]>>;
    try {
      result = await provider.extract({ bytes, mimeType: "image/png", caption: null, idempotencyKey: `approved-evaluation:${EXTRACTION_PROMPT_VERSION}:${runToken}:${name}` });
    } catch {
      failed = true; printFailure(name, "provider"); continue;
    }
    try {
      const evaluation = evaluateApprovedAnnotation(result.annotation, approved.expected, result.evidence);
      failed ||= !evaluation.passed;
      console.log(JSON.stringify({ fixture: name, differences: evaluation.differences, decision: evaluation.decision, issues: evaluation.issues }));
    } catch (error) {
      failed = true;
      printFailure(name, "schema", schemaReason(error));
    }
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.main) void main();
