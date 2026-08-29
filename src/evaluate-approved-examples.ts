import { lstat, readFile, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { EXTRACTION_PROMPT_VERSION, groundRequiredFieldConfidence, MistralHttpOcrProvider, type MistralOcrProvider, type OcrEvidence, parseProviderExtractedBill } from "./extraction";
import { WorkerImagePreprocessor, type ImagePreprocessor } from "./image-preprocessing";
import { validateExtractedBill } from "./validation";
import { loadValidationConfig } from "./config";

const fixtureDirectory = resolve(import.meta.dir, "../test/fixtures/approved");
const workspaceRoot = resolve(import.meta.dir, "..");
const fixtureNames = ["example3.json", "example4.json"] as const;
const maxAttachmentBytes = 20 * 1024 * 1024;
const fields = ["vendorName", "invoiceNumber", "invoiceDate", "currency", "subtotal", "vat", "total", "description", "handwritten"] as const;
const variants = ["original", "sharp", "opencv"] as const;
type Field = typeof fields[number];
type Variant = typeof variants[number];
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
export type ApprovedExampleEvaluationRecord = {
  fixture: string;
  variant: Variant;
  differences: EvaluatorResult["differences"];
  decision: EvaluatorResult["decision"];
  issues: EvaluatorResult["issues"];
  mode: "original" | "sharp" | "opencv";
  dimensions: { width: number; height: number } | null;
};

export type ApprovedExampleEvaluationDependencies = {
  provider: Pick<MistralOcrProvider, "extract">;
  preprocessor: ImagePreprocessor;
  runToken?: string;
};

function failureRecord(name: string, variant: Variant, code: string): ApprovedExampleEvaluationRecord {
  return { fixture: name, variant, differences: [], decision: "needs_review", issues: [{ code, field: null }], mode: variant, dimensions: null };
}

export async function runApprovedExampleEvaluation(dependencies: ApprovedExampleEvaluationDependencies): Promise<ApprovedExampleEvaluationRecord[]> {
  const runToken = dependencies.runToken ?? randomUUID();
  const records: ApprovedExampleEvaluationRecord[] = [];
  for (const name of fixtureNames) {
    let approved: { source: string; expected: ApprovedExpected }; let originalBytes: Uint8Array;
    try {
      approved = fixture(JSON.parse(await readFile(resolve(fixtureDirectory, name), "utf8")));
      originalBytes = await readApprovedFixturePng(approved.source);
    } catch {
      records.push(...variants.map((variant) => failureRecord(name, variant, "evaluator_fixture_failure")));
      continue;
    }

    for (const variant of variants) {
      let bytes = originalBytes;
      let mode: ApprovedExampleEvaluationRecord["mode"] = "original";
      let dimensions: ApprovedExampleEvaluationRecord["dimensions"] = null;
      if (variant !== "original") {
        let derivative: Awaited<ReturnType<ImagePreprocessor["preprocess"]>>;
        try { derivative = await dependencies.preprocessor.preprocess({ bytes: originalBytes, mimeType: "image/png", mode: variant }); } catch { derivative = null; }
        if (!derivative) {
          records.push(failureRecord(name, variant, "evaluator_preprocessing_failure"));
          continue;
        }
        bytes = derivative.bytes;
        mode = derivative.mode;
        dimensions = { width: derivative.width, height: derivative.height };
      }

      let result: Awaited<ReturnType<MistralOcrProvider["extract"]>>;
      try {
        const idempotencyKey = `approved-evaluation:${EXTRACTION_PROMPT_VERSION}:${runToken}:${name}:${variant}`;
        result = await dependencies.provider.extract({ bytes, mimeType: "image/png", caption: null, idempotencyKey });
      } catch {
        records.push(failureRecord(name, variant, "evaluator_provider_failure"));
        continue;
      }
      try {
        const evaluation = evaluateApprovedAnnotation(result.annotation, approved.expected, result.evidence);
        records.push({ fixture: name, variant, differences: evaluation.differences, decision: evaluation.decision, issues: evaluation.issues, mode, dimensions });
      } catch (error) {
        records.push(failureRecord(name, variant, `evaluator_schema_${schemaReason(error)}`));
      }
    }
  }
  return records;
}

async function main(): Promise<void> {
  const apiKey = Bun.env.MISTRAL_API_KEY?.trim(); const model = Bun.env.MISTRAL_MODEL?.trim();
  if (!apiKey || !model) throw new Error("MISTRAL_API_KEY and MISTRAL_MODEL are required");
  const records = await runApprovedExampleEvaluation({ provider: new MistralHttpOcrProvider(apiKey, model), preprocessor: new WorkerImagePreprocessor({ timeoutMs: 8_000 }) });
  for (const record of records) console.log(JSON.stringify(record));
  if (records.some((record) => record.decision !== "approved" || record.differences.length > 0)) process.exitCode = 1;
}

if (import.meta.main) {
  if (Bun.env.APPROVED_EXAMPLE_EVALUATION_AUTHORIZED !== "true") throw new Error("Set APPROVED_EXAMPLE_EVALUATION_AUTHORIZED=true to run live approved-example evaluation");
  void main();
}
