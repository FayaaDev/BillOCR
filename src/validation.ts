import type { ExtractedBill, ValidationIssue } from "./contracts";
import type { BillDatabase } from "./database";
import { currencyMinorUnits, knownIso4217Codes, toleranceForCurrency } from "./currency";

export interface ValidationConfig {
  confidenceThreshold: number;
  currencyRoundingTolerance: number;
  maxFutureInvoiceDays: number;
}

export interface ValidationResult {
  decision: "approved" | "needs_review";
  issues: Array<Omit<ValidationIssue, "id" | "billId" | "createdAt">>;
}

export const requiredConfidenceKeys = {
  vendorName: ["vendorName"], invoiceDate: ["invoiceDate"], total: ["total"],
} as const;

/** JSON-safe audit encoding. Non-finite values remain distinguishable after persistence. */
export function serializeObservedValue(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (item: unknown): unknown => {
    if (typeof item === "number" && !Number.isFinite(item)) return { $number: String(item) };
    if (typeof item === "bigint") return { $bigint: item.toString() };
    if (item === undefined) return { $undefined: true };
    if (typeof item === "function" || typeof item === "symbol") return { $type: typeof item, value: String(item) };
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return { $circular: true };
      seen.add(item);
      if (Array.isArray(item)) return item.map(normalize);
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, normalize(child)]));
    }
    return item;
  };
  try { return JSON.stringify(normalize(value)); } catch { return JSON.stringify({ $unserializable: true }); }
}
export function parseObservedValue(value: string): unknown { return JSON.parse(value); }
function decimal(value: number | string): { units: bigint; scale: number } {
  const match = /^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) throw new Error("Invalid decimal");
  const exponent = Number(match[4] ?? 0); const fraction = match[3] ?? "";
  let scale = fraction.length - exponent; let units = BigInt(`${match[1] === "-" ? "-" : ""}${match[2]}${fraction}`);
  if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
  return { units, scale };
}
function addDecimals(a: number, b: number): { units: bigint; scale: number } {
  const values = [decimal(a), decimal(b)]; const scale = Math.max(...values.map((item) => item.scale));
  return { units: values.reduce((total, item) => total + item.units * 10n ** BigInt(scale - item.scale), 0n), scale };
}
function exceedsTolerance(a: { units: bigint; scale: number }, b: number, tolerance: string): boolean {
  const values = [a, decimal(b), decimal(tolerance)]; const scale = Math.max(...values.map((item) => item.scale));
  const at = values.map((item) => item.units * 10n ** BigInt(scale - item.scale));
  const difference = at[0]! - at[1]!;
  return (difference < 0n ? -difference : difference) > at[2]!;
}
function issue(field: string | null, code: string, message: string, value: unknown): Omit<ValidationIssue, "id" | "billId" | "createdAt"> {
  return { field, code, message, severity: "blocking", observedValue: serializeObservedValue(value) };
}
function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}
function utcDay(value: string): number { return Date.parse(`${value}T00:00:00.000Z`); }

/** Pure authoritative validation: all automatic approval decisions originate here. */
export function validateExtractedBill(extracted: ExtractedBill, config: ValidationConfig, now = new Date()): ValidationResult {
  const issues: ValidationResult["issues"] = [];
  for (const key of ["subtotal", "vat", "total"] as const) {
    const amount = extracted[key];
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) issues.push(issue(key, "monetary_value_invalid", `${key} must be a finite non-negative amount.`, amount));
  }
  const tolerance = toleranceForCurrency(extracted.currency, config.currencyRoundingTolerance);
  if (extracted.subtotal !== null && extracted.vat !== null && extracted.total !== null && Number.isFinite(extracted.subtotal) && Number.isFinite(extracted.vat) && Number.isFinite(extracted.total) && exceedsTolerance(addDecimals(extracted.subtotal, extracted.vat), extracted.total, tolerance)) {
    issues.push(issue("total", "total_mismatch", "Subtotal plus VAT does not equal total within the currency rounding tolerance.", { subtotal: extracted.subtotal, vat: extracted.vat, total: extracted.total, tolerance, minorUnits: extracted.currency === null ? null : currencyMinorUnits(extracted.currency) }));
  }
  if (extracted.invoiceDate !== null) {
    if (!validIsoDate(extracted.invoiceDate)) issues.push(issue("invoiceDate", "invoice_date_invalid", "Invoice date must be a valid ISO YYYY-MM-DD date.", extracted.invoiceDate));
    else if (utcDay(extracted.invoiceDate) > utcDay(now.toISOString().slice(0, 10)) + config.maxFutureInvoiceDays * 86_400_000) issues.push(issue("invoiceDate", "invoice_date_too_future", "Invoice date is too far in the future.", extracted.invoiceDate));
  }
  if (extracted.currency !== null && !knownIso4217Codes.has(extracted.currency)) issues.push(issue("currency", "currency_unknown", "Currency must be a known ISO 4217 code.", extracted.currency));
  for (const key of ["vendorName", "invoiceDate", "total"] as const) {
    const value = extracted[key];
    if (value === null || (typeof value === "string" && !value.trim())) {
      issues.push(issue(key, "required_field_missing", `${key} is required for automatic approval.`, value));
      continue;
    }
    const confidenceEntry = extracted.fields[key];
    if (!confidenceEntry) issues.push(issue(key, "required_field_confidence_missing", `${key} confidence is required for automatic approval.`, null));
    else if (!Number.isFinite(confidenceEntry.confidence) || confidenceEntry.confidence < config.confidenceThreshold) issues.push(issue(key, "required_field_confidence_low", `${key} confidence is below the required threshold.`, { confidence: confidenceEntry.confidence, threshold: config.confidenceThreshold }));
  }
  return { decision: issues.some((item) => item.severity === "blocking") ? "needs_review" : "approved", issues };
}

/** Durable Phase 2 callback. Replays replace issues and preserve one job per projection type. */
export function createExtractionValidationCallback(database: BillDatabase, config: ValidationConfig, clock: () => Date = () => new Date()): (billId: string) => void {
  return (billId) => {
    const snapshot = database.getValidationSnapshot(billId);
    if (!snapshot) throw new Error("Cannot validate a missing normalized extraction");
    const result = validateExtractedBill(snapshot.extraction.normalized!, config, clock());
    database.persistValidationDecision({ billId, expectedContentRevision: snapshot.contentRevision, expectedReviewRevision: snapshot.reviewRevision, decision: result.decision, issues: result.issues });
  };
}
