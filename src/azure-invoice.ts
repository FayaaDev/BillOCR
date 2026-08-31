import type { ExtractedBill, FieldEvidence } from "./contracts";
import { isSupportedDocumentMimeType } from "./attachment-mime";
import { RetryableExtractionError } from "./extraction";
import { PermanentJobError } from "./worker";

const API_VERSION = "2024-11-30";
const MODEL_ID = "prebuilt-invoice";
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_POLL_INTERVAL_MS = 5_000;
const MAX_VENDOR_LENGTH = 512;
const MAX_INVOICE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_SOURCE_TEXT_LENGTH = 2_000;
const invoiceFieldNames = ["vendorName", "invoiceNumber", "invoiceDate", "currency", "subtotal", "vat", "total", "description"] as const;
type InvoiceFieldName = (typeof invoiceFieldNames)[number];
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class AzureMalformedInvoiceOutputError extends RetryableExtractionError {
  constructor(message: string, readonly rawProviderResponse: string) { super(message); }
}

export interface AzureInvoiceProvider {
  submit(input: { bytes: Uint8Array; mimeType: string }): Promise<{ operationLocation: string }>;
  poll(input: { operationLocation: string }): Promise<{ bill: ExtractedBill; rawResponse: string; model: string }>;
}

export interface AzureDocumentIntelligenceInvoiceProviderOptions {
  endpoint: string;
  apiKey: string;
  apiVersion?: string;
  maxResponseBytes?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** Injectable REST-only boundary for Azure Document Intelligence prebuilt-invoice. */
export class AzureDocumentIntelligenceInvoiceProvider implements AzureInvoiceProvider {
  private readonly endpoint: URL;
  private readonly apiVersion: string;
  private readonly maxResponseBytes: number;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly options: AzureDocumentIntelligenceInvoiceProviderOptions) {
    this.endpoint = parseAzureEndpoint(options.endpoint);
    if (!options.apiKey.trim()) throw new Error("Azure Document Intelligence API key must not be blank");
    this.apiVersion = options.apiVersion ?? API_VERSION;
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.pollIntervalMs = nonNegativeInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? sleepWithAbort;
  }

  async extract(input: { bytes: Uint8Array; mimeType: string }): Promise<{ bill: ExtractedBill; rawResponse: string; model: string }> {
    const submitted = await this.submit(input);
    return this.poll({ operationLocation: submitted.operationLocation });
  }

  async submit(input: { bytes: Uint8Array; mimeType: string }): Promise<{ operationLocation: string }> {
    const mimeType = input.mimeType.toLowerCase();
    if (!isSupportedDocumentMimeType(mimeType)) throw new PermanentJobError("Unsupported persisted original MIME type");
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const operationUrl = await this.submitRequest(input.bytes, mimeType, abort.signal);
      return { operationLocation: operationUrl.toString() };
    } catch (error) {
      if (error instanceof RetryableExtractionError || error instanceof PermanentJobError) throw error;
      if (abort.signal.aborted) throw new RetryableExtractionError("Azure Document Intelligence request timeout");
      throw new RetryableExtractionError("Azure Document Intelligence network failure");
    } finally {
      clearTimeout(timeout);
    }
  }

  async poll(input: { operationLocation: string }): Promise<{ bill: ExtractedBill; rawResponse: string; model: string }> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      return await this.pollRequest(sameOriginOperationUrl(input.operationLocation, this.endpoint), abort.signal);
    } catch (error) {
      if (error instanceof RetryableExtractionError || error instanceof PermanentJobError) throw error;
      if (abort.signal.aborted) throw new RetryableExtractionError("Azure Document Intelligence request timeout");
      throw new RetryableExtractionError("Azure Document Intelligence network failure");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async submitRequest(bytes: Uint8Array, mimeType: string, signal: AbortSignal): Promise<URL> {
    const url = new URL("/documentintelligence/documentModels/prebuilt-invoice:analyze", this.endpoint);
    url.searchParams.set("api-version", this.apiVersion);
    const response = await this.request(url, { method: "POST", headers: this.headers(mimeType), body: new Uint8Array(bytes), signal, redirect: "error" });
    const rawResponse = await readLimitedResponse(response, this.maxResponseBytes, signal);
    if (!response.ok) throw classifiedHttpError(response.status);
    if (response.status !== 202) throw new AzureMalformedInvoiceOutputError("Azure Document Intelligence returned an unexpected submission response", rawResponse);
    const location = response.headers.get("operation-location");
    if (!location) throw new AzureMalformedInvoiceOutputError("Azure Document Intelligence response is missing operation location", rawResponse);
    return sameOriginOperationUrl(location, this.endpoint);
  }

  private async pollRequest(operationUrl: URL, signal: AbortSignal): Promise<{ bill: ExtractedBill; rawResponse: string; model: string }> {
    while (true) {
      if (signal.aborted) throw new RetryableExtractionError("Azure Document Intelligence request timeout");
      const response = await this.request(operationUrl, { method: "GET", headers: this.headers(), signal, redirect: "error" });
      const rawResponse = await readLimitedResponse(response, this.maxResponseBytes, signal);
      if (!response.ok && response.status !== 202) throw classifiedHttpError(response.status);
      if (response.status === 202) {
        await this.sleep(this.pollDelay(response), signal);
        continue;
      }
      const payload = parseJson(rawResponse);
      const status = string(payload.status);
      if (status === "notStarted" || status === "running") {
        await this.sleep(this.pollDelay(response), signal);
        continue;
      }
      if (status === "failed" || status === "cancelled") throw new PermanentJobError("Azure Document Intelligence invoice analysis failed");
      if (status !== "succeeded") throw new AzureMalformedInvoiceOutputError("Azure Document Intelligence returned an invalid operation status", rawResponse);
      try { return { bill: mapInvoice(payload), rawResponse, model: MODEL_ID }; } catch (error) {
        if (error instanceof AzureMalformedInvoiceOutputError) throw new AzureMalformedInvoiceOutputError(error.message, rawResponse);
        throw error;
      }
    }
  }

  private headers(mimeType?: string): HeadersInit {
    return { "Ocp-Apim-Subscription-Key": this.options.apiKey, Accept: "application/json", ...(mimeType ? { "Content-Type": mimeType } : {}) };
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    const signal = init.signal;
    if (signal?.aborted) throw new RetryableExtractionError("Azure Document Intelligence request timeout");
    let abort: (() => void) | undefined;
    const aborted = signal ? new Promise<never>((_resolve, reject) => {
      abort = () => reject(new RetryableExtractionError("Azure Document Intelligence request timeout"));
      signal.addEventListener("abort", abort, { once: true });
    }) : undefined;
    try { return await (aborted ? Promise.race([this.fetchImpl(url, init), aborted]) : this.fetchImpl(url, init)); } catch (error) {
      if (signal?.aborted) throw new RetryableExtractionError("Azure Document Intelligence request timeout");
      throw error;
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }

  private pollDelay(response: Response): number {
    const retryAfter = Number(response.headers.get("retry-after"));
    return Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(MAX_POLL_INTERVAL_MS, retryAfter * 1_000) : this.pollIntervalMs;
  }
}

function parseAzureEndpoint(value: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new Error("Azure Document Intelligence endpoint must be an HTTPS URL"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Azure Document Intelligence endpoint must be an HTTPS origin");
  return endpoint;
}

function sameOriginOperationUrl(value: string, endpoint: URL): URL {
  let operation: URL;
  try { operation = new URL(value); } catch { throw new PermanentJobError("Azure Document Intelligence returned an invalid operation location"); }
  if (operation.origin !== endpoint.origin || operation.username || operation.password) throw new PermanentJobError("Azure Document Intelligence returned a cross-origin operation location");
  return operation;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
function classifiedHttpError(status: number): Error {
  const message = `Azure Document Intelligence request failed with HTTP ${status}`;
  return status === 408 || status === 409 || status === 429 || status >= 500 ? new RetryableExtractionError(message) : new PermanentJobError(message);
}
async function readLimitedResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new RetryableExtractionError("Azure Document Intelligence response exceeds configured size limit");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await readWithAbort(reader, signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new RetryableExtractionError("Azure Document Intelligence response exceeds configured size limit"); }
      chunks.push(next.value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* A cancelled stalled stream may still hold a read request. */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
async function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  if (signal.aborted) throw new RetryableExtractionError("Azure Document Intelligence request timeout");
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      void reader.cancel().catch(() => undefined);
      reject(new RetryableExtractionError("Azure Document Intelligence request timeout"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([reader.read(), aborted]); }
  finally { signal.removeEventListener("abort", abort); }
}
async function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new RetryableExtractionError("Azure Document Intelligence request timeout");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new RetryableExtractionError("Azure Document Intelligence request timeout")); }, { once: true });
  });
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AzureMalformedInvoiceOutputError(message, "");
  return value as Record<string, unknown>;
}
function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
function parseJson(raw: string): Record<string, unknown> {
  try { return record(JSON.parse(raw), "Azure Document Intelligence returned invalid JSON"); } catch (error) {
    if (error instanceof AzureMalformedInvoiceOutputError) throw error;
    throw new AzureMalformedInvoiceOutputError("Azure Document Intelligence returned invalid JSON", raw);
  }
}
function fieldEvidence(field: Record<string, unknown> | null): FieldEvidence {
  const content = string(field?.content);
  const sourceText = content && content.length <= MAX_SOURCE_TEXT_LENGTH ? content : null;
  const confidence = field?.confidence;
  return { sourceText, confidence: typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null };
}
function typedString(field: Record<string, unknown> | null, type: string, maxLength: number): string | null {
  return field?.type === type && typeof field.valueString === "string" && field.valueString.trim() && field.valueString.length <= maxLength ? field.valueString : null;
}
function typedDate(field: Record<string, unknown> | null): string | null {
  const value = field?.type === "date" ? field.valueDate : null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day ? value : null;
}
function typedMoney(field: Record<string, unknown> | null): { amount: number | null; currency: string | null } {
  const value = field?.type === "currency" && field.valueCurrency && typeof field.valueCurrency === "object" && !Array.isArray(field.valueCurrency) ? field.valueCurrency as Record<string, unknown> : null;
  const amount = typedAmount(value?.amount);
  const hasTypedAmount = value !== null && Object.prototype.hasOwnProperty.call(value, "amount");
  return { amount: amount ?? (!hasTypedAmount && field?.type === "currency" ? localizedContentAmount(field.content) : null), currency: typeof value?.currencyCode === "string" && /^[A-Z]{3}$/.test(value.currencyCode) ? value.currencyCode : null };
}
function typedAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  return parseLocalizedAmount(value, { allowSign: true, allowExponent: true, allowCurrencyCode: false });
}
function localizedContentAmount(value: unknown): number | null {
  if (typeof value !== "string") return null;
  return parseLocalizedAmount(value, { allowSign: false, allowExponent: false, allowCurrencyCode: true });
}
function parseLocalizedAmount(value: string, options: { allowSign: boolean; allowExponent: boolean; allowCurrencyCode: boolean }): number | null {
  let normalized = value.replace(/\u066b/g, ".").replace(/\u066c/g, ",").replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) % 16));
  if (options.allowCurrencyCode) normalized = normalized.replace(/\s+[A-Za-z]{3}$/, "");
  const match = normalized.match(new RegExp(`^(${options.allowSign ? "[+-]?" : ""})(\\d[\\d.,]*?)${options.allowExponent ? "([eE][+-]?\\d+)?" : ""}$`));
  if (!match) return null;
  const sign = match[1]!;
  const exponent = match[3] ?? "";
  const digits = normalizeSeparators(match[2]!);
  if (digits === null) return null;
  const amount = Number(`${sign}${digits}${exponent}`);
  return Number.isFinite(amount) ? amount : null;
}
function normalizeSeparators(value: string): string | null {
  const dot = value.lastIndexOf(".");
  const comma = value.lastIndexOf(",");
  if (dot < 0 && comma < 0) return value;
  const decimal = dot >= 0 && comma >= 0 ? Math.max(dot, comma) : -1;
  if (decimal >= 0) {
    const integer = value.slice(0, decimal).replace(/[.,]/g, "");
    const fraction = value.slice(decimal + 1);
    return integer && /^\d+$/.test(integer) && /^\d+$/.test(fraction) ? `${integer}.${fraction}` : null;
  }
  const separator = dot >= 0 ? "." : ",";
  const parts = value.split(separator);
  if (parts.some((part) => !/^\d+$/.test(part))) return null;
  if (parts.length > 2 || parts[1]!.length === 3) return parts.slice(1).every((part) => part.length === 3) ? parts.join("") : null;
  return `${parts[0]}.${parts[1]}`;
}
function getField(fields: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = fields[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function mapInvoice(payload: Record<string, unknown>): ExtractedBill {
  const analysis = record(payload.analyzeResult, "Azure Document Intelligence response is missing analysis result");
  if (!Array.isArray(analysis.documents)) throw new AzureMalformedInvoiceOutputError("Azure Document Intelligence response has invalid documents", "");
  const document = analysis.documents[0];
  const fields = document && typeof document === "object" && !Array.isArray(document) ? (document as Record<string, unknown>).fields : null;
  if (fields !== null && (typeof fields !== "object" || Array.isArray(fields))) throw new AzureMalformedInvoiceOutputError("Azure Document Intelligence invoice fields are invalid", "");
  const azureFields = (fields ?? {}) as Record<string, unknown>;
  const vendor = getField(azureFields, "VendorName");
  const invoiceNumber = getField(azureFields, "InvoiceId");
  const invoiceDate = getField(azureFields, "InvoiceDate");
  const total = getField(azureFields, "InvoiceTotal");
  const subtotal = getField(azureFields, "SubTotal");
  const vat = getField(azureFields, "TotalTax");
  const description = getField(azureFields, "InvoiceDescription");
  const totalMoney = typedMoney(total);
  const subtotalMoney = typedMoney(subtotal);
  const vatMoney = typedMoney(vat);
  const evidence: Record<InvoiceFieldName, FieldEvidence> = {
    vendorName: fieldEvidence(vendor), invoiceNumber: fieldEvidence(invoiceNumber), invoiceDate: fieldEvidence(invoiceDate), currency: fieldEvidence(total ?? subtotal ?? vat),
    subtotal: fieldEvidence(subtotal), vat: fieldEvidence(vat), total: fieldEvidence(total), description: fieldEvidence(description),
  };
  return {
    schemaVersion: "1", vendorName: typedString(vendor, "string", MAX_VENDOR_LENGTH), invoiceNumber: typedString(invoiceNumber, "string", MAX_INVOICE_LENGTH), invoiceDate: typedDate(invoiceDate),
    currency: totalMoney.currency ?? subtotalMoney.currency ?? vatMoney.currency, subtotal: subtotalMoney.amount, vat: vatMoney.amount, total: totalMoney.amount,
    description: typedString(description, "string", MAX_DESCRIPTION_LENGTH), fields: evidence,
  };
}
