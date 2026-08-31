import { expect, test } from "bun:test";
import { AzureDocumentIntelligenceInvoiceProvider, AzureMalformedInvoiceOutputError } from "../src/azure-invoice";
import { PermanentJobError } from "../src/worker";
import { RetryableExtractionError } from "../src/extraction";

const endpoint = "https://example.cognitiveservices.azure.com";
const completed = (fields: Record<string, unknown> = {}) => ({
  status: "succeeded",
  analyzeResult: {
    modelId: "prebuilt-invoice",
    documents: [{
      fields: {
        VendorName: { type: "string", valueString: "متجر Example", content: "متجر Example", confidence: 0.98 },
        InvoiceId: { type: "string", valueString: "INV-0042", content: "INV-0042", confidence: 0.93 },
        InvoiceDate: { type: "date", valueDate: "2026-08-28", content: "28/08/2026", confidence: 0.9 },
        InvoiceTotal: { type: "currency", valueCurrency: { amount: 11, currencyCode: "USD" }, content: "$11.00", confidence: 0.95 },
        SubTotal: { type: "currency", valueCurrency: { amount: 10, currencyCode: "USD" }, content: "$10.00", confidence: 0.92 },
        TotalTax: { type: "currency", valueCurrency: { amount: 1, currencyCode: "USD" }, content: "$1.00", confidence: 0.91 },
        InvoiceDescription: { type: "string", valueString: "handwritten repair", content: "handwritten repair", confidence: 0.8 },
        ...fields,
      },
    }],
  },
});

async function extractTypedTotal(amount: unknown): Promise<number | null> {
  const provider = new AzureDocumentIntelligenceInvoiceProvider({
    endpoint,
    apiKey: "secret",
    pollIntervalMs: 0,
    fetchImpl: async (_input, init) => new Request(_input, init).method === "POST"
      ? new Response(null, { status: 202, headers: { "operation-location": `${endpoint}/result` } })
      : Response.json(completed({ InvoiceTotal: { type: "currency", valueCurrency: { amount, currencyCode: "USD" } } })),
  });
  return (await provider.extract({ bytes: new Uint8Array(), mimeType: "image/png" })).bill.total;
}

test("submits original bytes, polls only its Azure origin, and maps typed invoice fields", async () => {
  const requests: Request[] = [];
  const provider = new AzureDocumentIntelligenceInvoiceProvider({
    endpoint,
    apiKey: "secret",
    pollIntervalMs: 0,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (requests.length === 1) {
        expect(await request.bytes()).toEqual(new Uint8Array([1, 2, 3]));
        return new Response(null, { status: 202, headers: { "operation-location": `${endpoint}/documentintelligence/documentModels/prebuilt-invoice/analyzeResults/abc` } });
      }
      return Response.json(completed());
    },
  });

  const result = await provider.extract({ bytes: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" });
  expect(requests).toHaveLength(2);
  expect(requests[0]!.url).toBe(`${endpoint}/documentintelligence/documentModels/prebuilt-invoice:analyze?api-version=2024-11-30`);
  expect(requests[0]!.headers.get("ocp-apim-subscription-key")).toBe("secret");
  expect(requests[0]!.headers.get("x-ms-client-request-id")).toBeNull();
  expect(requests[0]!.headers.get("content-type")).toBe("application/pdf");
  expect(requests[1]!.headers.get("x-ms-client-request-id")).toBeNull();
  expect(result.model).toBe("prebuilt-invoice");
  expect(result.bill).toMatchObject({ vendorName: "متجر Example", invoiceNumber: "INV-0042", invoiceDate: "2026-08-28", currency: "USD", subtotal: 10, vat: 1, total: 11, description: "handwritten repair" });
  expect(result.bill.fields).toMatchObject({ total: { sourceText: "$11.00", confidence: 0.95 }, vendorName: { sourceText: "متجر Example", confidence: 0.98 } });
});

test("keeps omitted and unsupported typed values null without using OCR prose", async () => {
  const provider = new AzureDocumentIntelligenceInvoiceProvider({
    endpoint,
    apiKey: "secret",
    pollIntervalMs: 0,
    fetchImpl: async (_input, init) => new Request(_input, init).method === "POST"
      ? new Response(null, { status: 202, headers: { "operation-location": `${endpoint}/result` } })
      : Response.json(completed({ VendorName: { type: "string", content: "visible but unknown" }, InvoiceTotal: { type: "currency", valueCurrency: { amount: "eleven" }, content: "$11" } })),
  });
  const result = await provider.extract({ bytes: new Uint8Array(), mimeType: "image/png" });
  expect(result.bill).toMatchObject({ vendorName: null, total: null, currency: "USD" });
  expect(result.bill.fields.vendorName).toEqual({ sourceText: "visible but unknown", confidence: null });
  expect(result.bill.fields.total).toEqual({ sourceText: "$11", confidence: null });
});

test("normalizes every Arabic-Indic and Persian digit in typed-money strings", async () => {
  for (const [input, expected] of [["٠١٢٣٤٥٦٧٨٩", 123456789], ["۰۱۲۳۴۵۶۷۸۹", 123456789], ["٧٠٫٥", 70.5], ["۷۰٫۵", 70.5], ["١٢.٥٠٠,٠٠", 12500]] as const) {
    expect(await extractTypedTotal(input)).toBe(expected);
  }
});

test("keeps signed and exponent typed-money strings supported", async () => {
  expect(await extractTypedTotal("-٧٠")).toBe(-70);
  expect(await extractTypedTotal("٧e1")).toBe(70);
});

test("rejects malformed typed-money strings", async () => {
  for (const input of [" ٧٠", "٧٠ ", "70,,5", "70.5.4", "٧٠x", "٧٠٫", "١e٣٠٩"]) {
    expect(await extractTypedTotal(input)).toBeNull();
  }
});

test("uses strictly numeric localized currency content when Azure omits valueCurrency", async () => {
  const provider = new AzureDocumentIntelligenceInvoiceProvider({
    endpoint,
    apiKey: "secret",
    pollIntervalMs: 0,
    fetchImpl: async (_input, init) => new Request(_input, init).method === "POST"
      ? new Response(null, { status: 202, headers: { "operation-location": `${endpoint}/result` } })
      : Response.json(completed({ InvoiceTotal: { type: "currency", content: "٧٠", confidence: 0.951 } })),
  });

  const result = await provider.extract({ bytes: new Uint8Array(), mimeType: "image/png" });
  expect(result.bill.total).toBe(70);
  expect(result.bill.fields.total?.sourceText).toBe("٧٠");
  expect(result.bill.fields.total?.confidence).toBe(0.951);
});

test("accepts a localized decimal currency content fallback", async () => {
  const provider = new AzureDocumentIntelligenceInvoiceProvider({
    endpoint,
    apiKey: "secret",
    pollIntervalMs: 0,
    fetchImpl: async (_input, init) => new Request(_input, init).method === "POST"
      ? new Response(null, { status: 202, headers: { "operation-location": `${endpoint}/result` } })
      : Response.json(completed({ InvoiceTotal: { type: "currency", content: "۷۰٫۵" } })),
  });

  expect((await provider.extract({ bytes: new Uint8Array(), mimeType: "image/png" })).bill.total).toBe(70.5);
});

test("normalizes grouped localized currency content when Azure omits valueCurrency", async () => {
  for (const [content, expected] of [["١٢.٥٠٠,٠٠ SAR", 12500], ["12,500.00 SAR", 12500], ["١٢٬٥٠٠٫٠٠", 12500]] as const) {
    const provider = new AzureDocumentIntelligenceInvoiceProvider({
      endpoint,
      apiKey: "secret",
      pollIntervalMs: 0,
      fetchImpl: async (_input, init) => new Request(_input, init).method === "POST"
        ? new Response(null, { status: 202, headers: { "operation-location": `${endpoint}/result` } })
        : Response.json(completed({ InvoiceTotal: { type: "currency", content } })),
    });

    expect((await provider.extract({ bytes: new Uint8Array(), mimeType: "image/png" })).bill.total).toBe(expected);
  }
});

test("prefers a valid typed currency amount over its content fallback", async () => {
  const provider = new AzureDocumentIntelligenceInvoiceProvider({
    endpoint,
    apiKey: "secret",
    pollIntervalMs: 0,
    fetchImpl: async (_input, init) => new Request(_input, init).method === "POST"
      ? new Response(null, { status: 202, headers: { "operation-location": `${endpoint}/result` } })
      : Response.json(completed({ InvoiceTotal: { type: "currency", valueCurrency: { amount: 71, currencyCode: "USD" }, content: "٧٠" } })),
  });

  const result = await provider.extract({ bytes: new Uint8Array(), mimeType: "image/png" });
  expect(result.bill).toMatchObject({ total: 71, currency: "USD" });
});

test("does not use content when Azure supplied an invalid typed amount", async () => {
  const provider = new AzureDocumentIntelligenceInvoiceProvider({
    endpoint,
    apiKey: "secret",
    pollIntervalMs: 0,
    fetchImpl: async (_input, init) => new Request(_input, init).method === "POST"
      ? new Response(null, { status: 202, headers: { "operation-location": `${endpoint}/result` } })
      : Response.json(completed({ InvoiceTotal: { type: "currency", valueCurrency: { amount: "invalid", currencyCode: "USD" }, content: "٧٠" } })),
  });

  const result = await provider.extract({ bytes: new Uint8Array(), mimeType: "image/png" });
  expect(result.bill).toMatchObject({ total: null, currency: "USD" });
});

test("rejects malformed, non-string, or non-currency source content as money", async () => {
  for (const field of [
    { type: "currency", content: "٧٠ ريال" },
    { type: "currency", content: " ٧٠" },
    { type: "currency", content: "+٧٠" },
    { type: "currency", content: "٧٠e1" },
    { type: "currency", content: "70,,5" },
    { type: "currency", content: 70 },
    { type: "string", content: "٧٠" },
  ]) {
    const provider = new AzureDocumentIntelligenceInvoiceProvider({
      endpoint,
      apiKey: "secret",
      pollIntervalMs: 0,
      fetchImpl: async (_input, init) => new Request(_input, init).method === "POST"
        ? new Response(null, { status: 202, headers: { "operation-location": `${endpoint}/result` } })
        : Response.json(completed({ InvoiceTotal: field })),
    });
    expect((await provider.extract({ bytes: new Uint8Array(), mimeType: "image/png" })).bill.total).toBeNull();
  }
});

test("rejects cross-origin operation URLs and bounds provider response bodies", async () => {
  const hostile = new AzureDocumentIntelligenceInvoiceProvider({ endpoint, apiKey: "secret", fetchImpl: async () => new Response(null, { status: 202, headers: { "operation-location": "https://attacker.example/result" } }) });
  await expect(hostile.extract({ bytes: new Uint8Array(), mimeType: "image/png" })).rejects.toBeInstanceOf(PermanentJobError);

  const oversized = new AzureDocumentIntelligenceInvoiceProvider({ endpoint, apiKey: "secret", maxResponseBytes: 2, fetchImpl: async (_input, init) => new Request(_input, init).method === "POST"
    ? new Response(null, { status: 202, headers: { "operation-location": `${endpoint}/result` } })
    : new Response("too large") });
  await expect(oversized.extract({ bytes: new Uint8Array(), mimeType: "image/png" })).rejects.toBeInstanceOf(RetryableExtractionError);
});

test("enforces the request deadline while an Azure response body stalls", async () => {
  let calls = 0;
  const stalledBody = new ReadableStream<Uint8Array>({ start: () => undefined });
  const provider = new AzureDocumentIntelligenceInvoiceProvider({
    endpoint,
    apiKey: "secret",
    timeoutMs: 5,
    fetchImpl: async () => ++calls === 1
      ? new Response(null, { status: 202, headers: { "operation-location": `${endpoint}/result` } })
      : new Response(stalledBody),
  });
  const outcome = await Promise.race([
    provider.extract({ bytes: new Uint8Array(), mimeType: "image/png" }).then(() => "completed", (error) => error instanceof RetryableExtractionError ? "timeout" : "other-error"),
    Bun.sleep(50).then(() => "pending"),
  ]);
  expect(outcome).toBe("timeout");
});

test("enforces the request deadline when an injected fetch ignores abort and never settles", async () => {
  const provider = new AzureDocumentIntelligenceInvoiceProvider({
    endpoint,
    apiKey: "secret",
    timeoutMs: 5,
    fetchImpl: async () => new Promise<Response>(() => undefined),
  });
  const outcome = await Promise.race([
    provider.extract({ bytes: new Uint8Array(), mimeType: "image/png" }).then(() => "completed", (error) => error instanceof RetryableExtractionError ? "timeout" : "other-error"),
    Bun.sleep(50).then(() => "pending"),
  ]);
  expect(outcome).toBe("timeout");
});

test("nulls Azure text beyond normalized extraction limits and calendar-invalid dates", async () => {
  const provider = new AzureDocumentIntelligenceInvoiceProvider({
    endpoint,
    apiKey: "secret",
    pollIntervalMs: 0,
    fetchImpl: async (_input, init) => new Request(_input, init).method === "POST"
      ? new Response(null, { status: 202, headers: { "operation-location": `${endpoint}/result` } })
      : Response.json(completed({
        VendorName: { type: "string", valueString: "v".repeat(513), content: "v".repeat(2_001), confidence: 0.9 },
        InvoiceId: { type: "string", valueString: "i".repeat(257), content: "i".repeat(2_001), confidence: 0.9 },
        InvoiceDate: { type: "date", valueDate: "2026-02-30", content: "2026-02-30", confidence: 0.9 },
        InvoiceDescription: { type: "string", valueString: "d".repeat(2_001), content: "d".repeat(2_001), confidence: 0.9 },
      })),
  });
  const result = await provider.extract({ bytes: new Uint8Array(), mimeType: "image/png" });
  expect(result.bill).toMatchObject({ vendorName: null, invoiceNumber: null, invoiceDate: null, description: null });
  expect(result.bill.fields).toMatchObject({
    vendorName: { sourceText: null, confidence: 0.9 },
    invoiceNumber: { sourceText: null, confidence: 0.9 },
    invoiceDate: { sourceText: "2026-02-30", confidence: 0.9 },
    description: { sourceText: null, confidence: 0.9 },
  });
});

test("classifies timeout, transient status, provider failure, and malformed successful output without exposing bodies", async () => {
  const timeout = new AzureDocumentIntelligenceInvoiceProvider({ endpoint, apiKey: "secret", timeoutMs: 1, fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) });
  await expect(timeout.extract({ bytes: new Uint8Array(), mimeType: "image/png" })).rejects.toBeInstanceOf(RetryableExtractionError);

  const unavailable = new AzureDocumentIntelligenceInvoiceProvider({ endpoint, apiKey: "secret", fetchImpl: async () => new Response("Bearer provider-secret-value-123456", { status: 503 }) });
  await expect(unavailable.extract({ bytes: new Uint8Array(), mimeType: "image/png" })).rejects.toBeInstanceOf(RetryableExtractionError);

  const rejected = new AzureDocumentIntelligenceInvoiceProvider({ endpoint, apiKey: "secret", fetchImpl: async () => new Response("Bearer provider-secret-value-123456", { status: 401 }) });
  try {
    await rejected.extract({ bytes: new Uint8Array(), mimeType: "image/png" });
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(PermanentJobError);
    expect((error as Error).message).not.toContain("provider-secret-value-123456");
  }

  const malformed = new AzureDocumentIntelligenceInvoiceProvider({ endpoint, apiKey: "secret", fetchImpl: async (_input, init) => new Request(_input, init).method === "POST"
    ? new Response(null, { status: 202, headers: { "operation-location": `${endpoint}/result` } })
    : Response.json({ status: "succeeded", analyzeResult: { documents: "not-an-array" } }) });
  await expect(malformed.extract({ bytes: new Uint8Array(), mimeType: "image/png" })).rejects.toBeInstanceOf(AzureMalformedInvoiceOutputError);
});
