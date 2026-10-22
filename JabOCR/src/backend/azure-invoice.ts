import type { ExtractedBill, FieldEvidence } from "./contracts";
import { isSupportedDocumentMimeType } from "./attachment-mime";
import { RetryableExtractionError } from "./extraction-errors";
import { PermanentJobError } from "./worker";

const API_VERSION = "2024-11-30";
const MODEL_ID = "prebuilt-invoice";
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_IN_PROCESS_WAIT_MS = 30_000;
// SQLite stores ISO dates through JavaScript Date; larger provider delays cannot be persisted safely.
const MAX_DATE_MS = 253_402_300_799_999;
const MAX_VENDOR_LENGTH = 512;
const MAX_INVOICE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_SOURCE_TEXT_LENGTH = 2_000;
const invoiceFieldNames = ["vendorName", "vendorTaxNumber", "invoiceNumber", "invoiceDate", "currency", "subtotal", "vat", "total", "description"] as const;
type InvoiceFieldName = (typeof invoiceFieldNames)[number];
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class AzureMalformedInvoiceOutputError extends RetryableExtractionError {
  constructor(message: string, readonly rawProviderResponse: string) { super(message, undefined, true); }
}

/** Azure definitively rejected this submission before creating an operation. */
export class AzureSubmissionRejectedError extends RetryableExtractionError {
  constructor(retryAfterMs?: number) { super("Azure Document Intelligence submission failed with HTTP 429", retryAfterMs, true); }
}

export class AzureRetryableExtractionError extends RetryableExtractionError {
  constructor(message: string, retryAfterMs?: number) { super(message, retryAfterMs, true); }
}
/** No POST was started, so the durable submitting marker can safely be released. */
export class AzureSubmissionNotSentError extends AzureRetryableExtractionError {}

export type AzureInvoiceAnalysis =
  | { classification: "invoice"; bill: ExtractedBill; rawResponse: string; model: string }
  | { classification: "not_invoice"; bill: ExtractedBill; rawResponse: string; model: string };

export interface AzureInvoiceProvider {
  prepareSubmission?(): Promise<unknown>;
  submit(input: { bytes: Uint8Array; mimeType: string; submissionPermit?: unknown }): Promise<{ operationLocation: string }>;
  poll(input: { operationLocation: string }): Promise<AzureInvoiceAnalysis>;
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
  now?: () => number;
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
  private readonly now: () => number;
  private nextPostStart = 0;
  private nextGetStart = 0;
  private nextPostReservation = 0;
  private nextGetReservation = 0;
  private cooldownUntil = 0;

  constructor(private readonly options: AzureDocumentIntelligenceInvoiceProviderOptions) {
    this.endpoint = parseAzureEndpoint(options.endpoint);
    if (!options.apiKey.trim()) throw new Error("Azure Document Intelligence API key must not be blank");
    this.apiVersion = options.apiVersion ?? API_VERSION;
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.pollIntervalMs = nonNegativeInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? sleepWithAbort;
    this.now = options.now ?? Date.now;
  }

  async extract(input: { bytes: Uint8Array; mimeType: string }): Promise<AzureInvoiceAnalysis> {
    const submitted = await this.submit(input);
    return this.poll({ operationLocation: submitted.operationLocation });
  }

  async prepareSubmission(): Promise<unknown> { return this.reserve("post", new AbortController().signal); }

  async submit(input: { bytes: Uint8Array; mimeType: string; submissionPermit?: unknown }): Promise<{ operationLocation: string }> {
    const mimeType = input.mimeType.toLowerCase();
    if (!isSupportedDocumentMimeType(mimeType)) throw new PermanentJobError("Unsupported persisted original MIME type");
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const permit = input.submissionPermit instanceof AzureRequestPermit ? input.submissionPermit : await this.reserve("post", abort.signal);
      if (permit.provider !== this || permit.used) throw new AzureRetryableExtractionError("Azure Document Intelligence submission permit is invalid");
      permit.used = true;
      const operationUrl = await this.submitRequest(input.bytes, mimeType, abort.signal);
      return { operationLocation: operationUrl.toString() };
    } catch (error) {
      if (error instanceof PermanentJobError || (error instanceof RetryableExtractionError && error.addJitter)) throw error;
      if (error instanceof RetryableExtractionError) throw new AzureRetryableExtractionError(error.message, error.retryAfterMs);
      if (abort.signal.aborted) throw new AzureRetryableExtractionError("Azure Document Intelligence request timeout");
      throw new AzureRetryableExtractionError("Azure Document Intelligence network failure");
    } finally {
      clearTimeout(timeout);
    }
  }

  async poll(input: { operationLocation: string }): Promise<AzureInvoiceAnalysis> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      return await this.pollRequest(sameOriginOperationUrl(input.operationLocation, this.endpoint), abort.signal);
    } catch (error) {
      if (error instanceof PermanentJobError || (error instanceof RetryableExtractionError && error.addJitter)) throw error;
      if (error instanceof RetryableExtractionError) throw new AzureRetryableExtractionError(error.message, error.retryAfterMs);
      if (abort.signal.aborted) throw new AzureRetryableExtractionError("Azure Document Intelligence request timeout");
      throw new AzureRetryableExtractionError("Azure Document Intelligence network failure");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async submitRequest(bytes: Uint8Array, mimeType: string, signal: AbortSignal): Promise<URL> {
    const url = new URL("/documentintelligence/documentModels/prebuilt-invoice:analyze", this.endpoint);
    url.searchParams.set("api-version", this.apiVersion);
    const response = await this.request(url, { method: "POST", headers: this.headers(mimeType), body: new Uint8Array(bytes), signal, redirect: "error" });
    if (response.status === 429) {
      void response.body?.cancel().catch(() => undefined);
      const retryAfterMs = retryAfter(response.headers, this.now());
      this.applyCooldown(retryAfterMs ?? 1_000);
      throw new AzureSubmissionRejectedError(retryAfterMs);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw classifiedHttpError(response.status, retryAfter(response.headers, this.now()));
    }
    const rawResponse = await readLimitedResponse(response, this.maxResponseBytes, signal);
    if (response.status !== 202) throw new AzureMalformedInvoiceOutputError("Azure Document Intelligence returned an unexpected submission response", rawResponse);
    const location = response.headers.get("operation-location");
    if (!location) throw new AzureMalformedInvoiceOutputError("Azure Document Intelligence response is missing operation location", rawResponse);
    return sameOriginOperationUrl(location, this.endpoint);
  }

  private async pollRequest(operationUrl: URL, signal: AbortSignal): Promise<AzureInvoiceAnalysis> {
    while (true) {
      if (signal.aborted) throw new RetryableExtractionError("Azure Document Intelligence request timeout");
      await this.reserve("get", signal);
      const response = await this.request(operationUrl, { method: "GET", headers: this.headers(), signal, redirect: "error" });
      if (!response.ok && response.status !== 202) {
        const retryAfterMs = retryAfter(response.headers, this.now());
        if (response.status === 429) this.applyCooldown(retryAfterMs ?? 1_000);
        void response.body?.cancel().catch(() => undefined);
        throw classifiedHttpError(response.status, retryAfterMs);
      }
      const rawResponse = await readLimitedResponse(response, this.maxResponseBytes, signal);
      if (response.status === 202) {
        await this.waitForPoll(response, signal);
        continue;
      }
      const payload = parseJson(rawResponse);
      const status = string(payload.status);
      if (status === "notStarted" || status === "running") {
        await this.waitForPoll(response, signal);
        continue;
      }
      if (status === "failed" || status === "cancelled") throw new PermanentJobError("Azure Document Intelligence invoice analysis failed");
      if (status !== "succeeded") throw new AzureMalformedInvoiceOutputError("Azure Document Intelligence returned an invalid operation status", rawResponse);
      try { return parseAzureInvoiceAnalysis(rawResponse); } catch (error) {
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
    const kind = init.method === "POST" ? "post" : "get";
    try { await this.start(kind, signal); } catch (error) {
      if (kind === "post" && error instanceof RetryableExtractionError) throw new AzureSubmissionNotSentError(error.message, error.retryAfterMs);
      throw error;
    }
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
    return retryAfter(response.headers, this.now()) ?? this.pollIntervalMs;
  }

  private async waitForPoll(response: Response, signal: AbortSignal): Promise<void> {
    const delay = this.pollDelay(response);
    if (delay > MAX_IN_PROCESS_WAIT_MS) throw new AzureRetryableExtractionError("Azure Document Intelligence polling deferred", delay);
    await this.sleep(delay, signal);
  }

  private async reserve(kind: "post" | "get", signal: AbortSignal): Promise<AzureRequestPermit> {
    if (signal.aborted) throw new AzureRetryableExtractionError("Azure Document Intelligence request timeout");
    const now = this.now();
    const next = kind === "post" ? this.nextPostReservation : this.nextGetReservation;
    const start = Math.max(now, next, this.cooldownUntil);
    if (start - now > MAX_IN_PROCESS_WAIT_MS) throw new AzureRetryableExtractionError("Azure Document Intelligence request deferred", start - now);
    if (kind === "post") this.nextPostReservation = start + 1_000;
    else this.nextGetReservation = start + 1_000;
    if (start > now) await this.sleep(start - now, signal);
    return new AzureRequestPermit(this);
  }

  private async start(kind: "post" | "get", signal: AbortSignal | null | undefined): Promise<void> {
    if (signal?.aborted) throw new AzureRetryableExtractionError("Azure Document Intelligence request timeout");
    const now = this.now();
    const next = kind === "post" ? this.nextPostStart : this.nextGetStart;
    const start = Math.max(now, next, this.cooldownUntil);
    if (start - now > MAX_IN_PROCESS_WAIT_MS) throw new AzureRetryableExtractionError("Azure Document Intelligence request deferred", start - now);
    if (kind === "post") this.nextPostStart = start + 1_000;
    else this.nextGetStart = start + 1_000;
    if (start > now) await this.sleep(start - now, signal ?? new AbortController().signal);
    const actual = this.now();
    if (kind === "post") this.nextPostStart = Math.max(this.nextPostStart, actual + 1_000);
    else this.nextGetStart = Math.max(this.nextGetStart, actual + 1_000);
  }

  private applyCooldown(retryAfterMs: number | undefined): void {
    if (retryAfterMs !== undefined) this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + retryAfterMs);
  }
}
class AzureRequestPermit { used = false; constructor(readonly provider: AzureDocumentIntelligenceInvoiceProvider) {} }
export function parseAzureInvoiceAnalysis(rawResponse: string): AzureInvoiceAnalysis {
  const payload = parseJson(rawResponse);
  if (string(payload.status) !== "succeeded") throw new AzureMalformedInvoiceOutputError("Azure Document Intelligence returned an invalid operation status", rawResponse);
  const bill = mapInvoice(payload);
  return bill === null ? { classification: "not_invoice", bill: emptyInvoice(), rawResponse, model: MODEL_ID } : { classification: "invoice", bill, rawResponse, model: MODEL_ID };
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
function classifiedHttpError(status: number, retryAfterMs?: number): Error {
  const message = `Azure Document Intelligence request failed with HTTP ${status}`;
  return status === 408 || status === 409 || status === 429 || status >= 500 ? new AzureRetryableExtractionError(message, retryAfterMs) : new PermanentJobError(message);
}
function retryAfter(headers: Headers, now: number): number | undefined {
  const milliseconds = headerValue(headers, "x-ms-retry-after-ms");
  if (milliseconds !== null) {
    const value = Number(milliseconds);
    if (Number.isFinite(value) && value >= 0 && value <= MAX_DATE_MS - now) return value;
  }
  for (const value of [headers.get("retry-after"), headers.get("x-ms-retry-after")]) {
    if (!value?.trim()) continue;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= (MAX_DATE_MS - now) / 1_000) return seconds * 1_000;
    const date = Date.parse(value);
    if (Number.isFinite(date) && date <= MAX_DATE_MS) return Math.max(0, date - now);
  }
  return undefined;
}
function headerValue(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value !== null && value.trim() ? value : null;
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
  const content = !hasTypedAmount && field?.type === "currency" ? localizedContentMoney(field.content) : null;
  return { amount: amount ?? content?.amount ?? null, currency: typeof value?.currencyCode === "string" && /^[A-Z]{3}$/.test(value.currencyCode) ? value.currencyCode : content?.currency ?? null };
}
function typedAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  return parseLocalizedAmount(value, { allowSign: true, allowExponent: true });
}
function localizedContentMoney(value: unknown): { amount: number; currency: string | null } | null {
  if (typeof value !== "string") return null;
  const match = /^(.*?)(?:\s*([A-Z]{3}))?$/.exec(value);
  if (!match) return null;
  const amount = parseLocalizedAmount(match[1]!, { allowSign: false, allowExponent: false });
  return amount === null ? null : { amount, currency: match[2] ?? null };
}
function parseLocalizedAmount(value: string, options: { allowSign: boolean; allowExponent: boolean }): number | null {
  let normalized = value.replace(/\u066b/g, ".").replace(/\u066c/g, ",").replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) % 16));
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
  if (parts.length > 2) return parts.slice(1).every((part) => part.length === 3) ? parts.join("") : null;
  if (parts[1]!.length === 3) return null;
  return `${parts[0]}.${parts[1]}`;
}
function getField(fields: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const value = fields?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function itemDescription(items: Record<string, unknown> | null): { value: string | null; evidence: FieldEvidence } {
  if (items?.type !== "array" || !Array.isArray(items.valueArray)) return { value: null, evidence: { sourceText: null, confidence: null } };
  const descriptions = items.valueArray.flatMap((item) => {
    const entry = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
    if (entry?.type !== "object") return [];
    const description = getField(getField(entry, "valueObject"), "Description");
    return description?.type === "string" && typeof description.valueString === "string" && description.valueString.trim() ? [description] : [];
  });
  if (!descriptions.length) return { value: null, evidence: { sourceText: null, confidence: null } };
  const joinedValue = descriptions.map((description) => description.valueString as string).join("\n");
  const evidenceParts = descriptions.map(fieldEvidence);
  const sourceParts = evidenceParts.map((item) => item.sourceText);
  const joinedSource = sourceParts.every((item): item is string => item !== null) ? sourceParts.join("\n") : null;
  const confidences = evidenceParts.map((item) => item.confidence);
  return {
    value: joinedValue.length <= MAX_DESCRIPTION_LENGTH ? joinedValue : null,
    evidence: {
      sourceText: joinedSource !== null && joinedSource.length <= MAX_SOURCE_TEXT_LENGTH ? joinedSource : null,
      confidence: confidences.every((item): item is number => item !== null) ? Math.min(...confidences) : null,
    },
  };
}
function emptyInvoice(): ExtractedBill {
  const evidence = { confidence: null, sourceText: null };
  return {
    schemaVersion: "1", vendorName: null, vendorTaxNumber: null, invoiceNumber: null, invoiceDate: null, currency: null,
    subtotal: null, vat: null, total: null, description: null,
    fields: {
      vendorName: evidence, vendorTaxNumber: evidence, invoiceNumber: evidence, invoiceDate: evidence, currency: evidence,
      subtotal: evidence, vat: evidence, total: evidence, description: evidence,
    },
  };
}
function mapInvoice(payload: Record<string, unknown>): ExtractedBill | null {
  const analysis = record(payload.analyzeResult, "Azure Document Intelligence response is missing analysis result");
  if (!Array.isArray(analysis.documents)) throw new AzureMalformedInvoiceOutputError("Azure Document Intelligence response has invalid documents", "");
  if (analysis.documents.length === 0) return null;
  const documents = analysis.documents.map((document) => record(document, "Azure Document Intelligence response has invalid document"));
  const fields = documents[0]!.fields ?? null;
  if (fields !== null && (typeof fields !== "object" || Array.isArray(fields))) throw new AzureMalformedInvoiceOutputError("Azure Document Intelligence invoice fields are invalid", "");
  const azureFields = (fields ?? {}) as Record<string, unknown>;
  const vendor = getField(azureFields, "VendorName");
  const vendorTaxNumber = getField(azureFields, "VendorTaxId");
  const invoiceNumber = getField(azureFields, "InvoiceId");
  const invoiceDate = getField(azureFields, "InvoiceDate");
  const total = getField(azureFields, "InvoiceTotal");
  const subtotal = getField(azureFields, "SubTotal");
  const vat = getField(azureFields, "TotalTax");
  const description = itemDescription(getField(azureFields, "Items"));
  const totalMoney = typedMoney(total);
  const subtotalMoney = typedMoney(subtotal);
  const vatMoney = typedMoney(vat);
  const evidence: Record<InvoiceFieldName, FieldEvidence> = {
    vendorName: fieldEvidence(vendor), vendorTaxNumber: fieldEvidence(vendorTaxNumber), invoiceNumber: fieldEvidence(invoiceNumber), invoiceDate: fieldEvidence(invoiceDate), currency: fieldEvidence(total ?? subtotal ?? vat),
    subtotal: fieldEvidence(subtotal), vat: fieldEvidence(vat), total: fieldEvidence(total), description: description.evidence,
  };
  return {
    schemaVersion: "1", vendorName: typedString(vendor, "string", MAX_VENDOR_LENGTH), vendorTaxNumber: typedString(vendorTaxNumber, "string", MAX_INVOICE_LENGTH), invoiceNumber: typedString(invoiceNumber, "string", MAX_INVOICE_LENGTH), invoiceDate: typedDate(invoiceDate),
    currency: totalMoney.currency ?? subtotalMoney.currency ?? vatMoney.currency, subtotal: subtotalMoney.amount, vat: vatMoney.amount, total: totalMoney.amount,
    description: description.value, fields: evidence,
  };
}
