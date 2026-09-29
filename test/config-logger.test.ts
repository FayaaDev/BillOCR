import { expect, test } from "bun:test";
import { loadConfig, loadValidationConfig } from "../src/backend/config";
import { createLogger } from "../src/backend/logger";
import { readServiceAccountCredential } from "../src/backend/google-projections";

const validEnvironment = () => ({
  APP_DATA_DIR: "./data", WHATSAPP_GROUP_ID: "group", WHATSAPP_AUTH_PATH: "./auth",
  MISTRAL_API_KEY: "mistral-secret", MISTRAL_MODEL: "mistral-ocr-latest", AZURE_ENABLED: "false",
  GOOGLE_SERVICE_ACCOUNT_JSON: "./service-account.json", GOOGLE_DRIVE_FOLDER_ID: "folder", GOOGLE_SHEET_ID: "sheet",
  REVIEW_USERNAME: "reviewer", REVIEW_PASSWORD: "review-secret",
});

test("review origin is optional but configured customers require canonical HTTPS DNS origins", () => {
  expect(loadConfig(validEnvironment()).review.origin).toBeUndefined();
  for (const origin of ["https://customer-a.example.test", "https://customer-b.example.test", "https://xn--bcher-kva.example"]) {
    expect(loadConfig({ ...validEnvironment(), REVIEW_ORIGIN: origin }).review.origin).toBe(origin);
  }
  for (const origin of [
    "", " ", "not a URL", "http://customer.example.test", "http://localhost", "http://a.localhost",
    "https://localhost", "https://a.localhost", "https://localhost.", "https://127.0.0.1", "https://127.1",
    "https://[::1]", "https://2130706433", "https://customer", "https://customer.example.test:8443",
    "https://customer.example.test:443", "https://customer.example.test/", "https://customer.example.test/path",
    "https://customer.example.test?", "https://customer.example.test#", "https://user:secret@customer.example.test",
    "HTTPS://customer.example.test", "https://Customer.example.test", " https://customer.example.test",
    "https://customer.example.test.", "https://bad_name.example.test", "https://-bad.example.test",
  ]) expect(() => loadConfig({ ...validEnvironment(), REVIEW_ORIGIN: origin })).toThrow("REVIEW_ORIGIN");
});

test("configuration allows WhatsApp to be disabled for test environments", () => {
  expect(loadConfig({ ...validEnvironment(), WHATSAPP_ENABLED: "false" }).whatsapp.enabled).toBe(false);
});

test("configuration permits an active WhatsApp connection without an ingestion group", () => {
  const environment: Record<string, string> = { ...validEnvironment() };
  delete environment.WHATSAPP_GROUP_ID;
  expect(loadConfig(environment).whatsapp).toMatchObject({ enabled: true, groupId: null });
});

test("Telegram is disabled by default and does not require a bot token until enabled", () => {
  expect(loadConfig(validEnvironment()).telegram).toEqual({ enabled: false, botToken: null, groupIds: [], pollTimeoutSeconds: 30, requestTimeoutMs: 35_000, maxResponseBytes: 2 * 1024 * 1024 });
  expect(() => loadConfig({ ...validEnvironment(), TELEGRAM_ENABLED: "true" })).toThrow("TELEGRAM_BOT_TOKEN");
});

test("Telegram trims and deduplicates its configured group allowlist", () => {
  expect(loadConfig({ ...validEnvironment(), TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: "telegram-secret", TELEGRAM_GROUP_IDS: " -1001, -1002 , -1001, , " }).telegram).toMatchObject({ enabled: true, groupIds: ["-1001", "-1002"] });
  expect(loadConfig({ ...validEnvironment(), TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: "telegram-secret" }).telegram.groupIds).toEqual([]);
});

test("Telegram long-poll request and response limits are bounded", () => {
  const environment = { ...validEnvironment(), TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: "telegram-secret", TELEGRAM_POLL_TIMEOUT_SECONDS: "1", TELEGRAM_REQUEST_TIMEOUT_MS: "1001", TELEGRAM_MAX_RESPONSE_BYTES: "3" };
  expect(loadConfig(environment).telegram).toMatchObject({ pollTimeoutSeconds: 1, requestTimeoutMs: 1001, maxResponseBytes: 3 });
  expect(() => loadConfig({ ...environment, TELEGRAM_POLL_TIMEOUT_SECONDS: "0" })).toThrow("TELEGRAM_POLL_TIMEOUT_SECONDS");
  expect(() => loadConfig({ ...environment, TELEGRAM_REQUEST_TIMEOUT_MS: "0" })).toThrow("TELEGRAM_REQUEST_TIMEOUT_MS");
  expect(() => loadConfig({ ...environment, TELEGRAM_REQUEST_TIMEOUT_MS: "1000" })).toThrow("TELEGRAM_REQUEST_TIMEOUT_MS");
  expect(() => loadConfig({ ...environment, TELEGRAM_MAX_RESPONSE_BYTES: "0" })).toThrow("TELEGRAM_MAX_RESPONSE_BYTES");
});

test("shared originals configuration accepts the neutral setting and legacy WhatsApp fallback", () => {
  expect(loadConfig(validEnvironment()).originals).toEqual({ dir: expect.stringContaining("data/originals"), maxAttachmentBytes: 20 * 1024 * 1024 });
  expect(loadConfig({ ...validEnvironment(), ORIGINALS_DIR: "./shared-originals", WHATSAPP_ORIGINALS_DIR: "./legacy-originals", MAX_ATTACHMENT_BYTES: "10" }).originals).toEqual({ dir: expect.stringContaining("shared-originals"), maxAttachmentBytes: 10 });
});

test("image preprocessing is disabled by default and validates its timeout", () => {
  expect(loadConfig(validEnvironment()).imagePreprocessing).toEqual({ enabled: false, timeoutMs: 8_000 });
  expect(loadConfig({ ...validEnvironment(), IMAGE_PREPROCESSING_ENABLED: "true", IMAGE_PREPROCESSING_TIMEOUT_MS: "9" }).imagePreprocessing).toEqual({ enabled: true, timeoutMs: 9 });
  expect(() => loadConfig({ ...validEnvironment(), IMAGE_PREPROCESSING_ENABLED: "yes" })).toThrow("IMAGE_PREPROCESSING_ENABLED");
  expect(() => loadConfig({ ...validEnvironment(), IMAGE_PREPROCESSING_TIMEOUT_MS: "0" })).toThrow("IMAGE_PREPROCESSING_TIMEOUT_MS");
});

test("Google projections are opt-in and service-account credentials are shape-validated without exposing values", () => {
  expect(loadConfig({ ...validEnvironment(), GOOGLE_ENABLED: "false" }).google).toMatchObject({ enabled: false, credentialJson: null });
  expect(() => loadConfig({ APP_DATA_DIR: "./data", WHATSAPP_GROUP_ID: "group", WHATSAPP_AUTH_PATH: "./auth", MISTRAL_API_KEY: "key", MISTRAL_MODEL: "model", AZURE_ENABLED: "false", REVIEW_USERNAME: "reviewer", REVIEW_PASSWORD: "token", GOOGLE_ENABLED: "true" })).toThrow("GOOGLE_SERVICE_ACCOUNT_JSON");
  expect(() => readServiceAccountCredential('{"client_email":"service@example.test"}')).toThrow("requires client_email and private_key");
});

test("Google authentication mode defaults to service accounts and selects exactly one credential path", () => {
  expect(loadConfig({ ...validEnvironment(), GOOGLE_ENABLED: "true" }).google).toMatchObject({ enabled: true, authMode: "service_account", credentialJson: expect.stringContaining("service-account.json") });
  expect(loadConfig({ ...validEnvironment(), GOOGLE_ENABLED: "true", GOOGLE_AUTH_MODE: "user_oauth", GOOGLE_OAUTH_CREDENTIAL_JSON: "./oauth.json" }).google).toMatchObject({ enabled: true, authMode: "user_oauth", credentialJson: expect.stringContaining("oauth.json") });
  expect(() => loadConfig({ ...validEnvironment(), GOOGLE_ENABLED: "true", GOOGLE_AUTH_MODE: "user_oauth", GOOGLE_OAUTH_CREDENTIAL_JSON: "" })).toThrow("GOOGLE_OAUTH_CREDENTIAL_JSON");
  expect(() => loadConfig({ ...validEnvironment(), GOOGLE_ENABLED: "true", GOOGLE_AUTH_MODE: "unknown" })).toThrow("GOOGLE_AUTH_MODE");
  expect(loadConfig({ ...validEnvironment(), GOOGLE_ENABLED: "false", GOOGLE_AUTH_MODE: "user_oauth" }).google).toMatchObject({ enabled: false, authMode: "disabled", credentialJson: null });
});

test("documented Google projection configuration enables the configured ledger tab", () => {
  expect(loadConfig({ ...validEnvironment(), GOOGLE_ENABLED: "true", GOOGLE_SHEET_NAME: "Accounting Ledger" }).google).toEqual({ enabled: true, authMode: "service_account", credentialJson: expect.stringContaining("service-account.json"), driveFolderId: "folder", sheetId: "sheet", sheetName: "Accounting Ledger", requestTimeoutMs: 60_000, maxResponseBytes: 2 * 1024 * 1024 });
});

test("validation configuration supplies deterministic Phase 3 defaults", () => {
  expect(loadConfig(validEnvironment()).validation).toEqual({ currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 });
  expect(() => loadConfig({ ...validEnvironment(), MAX_FUTURE_INVOICE_DAYS: "-1" })).toThrow("MAX_FUTURE_INVOICE_DAYS");
});

test("standalone validation configuration preserves production defaults and overrides", () => {
  expect(loadValidationConfig({ CURRENCY_ROUNDING_TOLERANCE: "0.02", MAX_FUTURE_INVOICE_DAYS: "7" })).toEqual({ currencyRoundingTolerance: 0.02, maxFutureInvoiceDays: 7 });
});

test("configuration validates byte and provider timeout limits", () => {
  expect(loadConfig({ ...validEnvironment(), MAX_ATTACHMENT_BYTES: "10", MISTRAL_MAX_RESPONSE_BYTES: "11", MISTRAL_REQUEST_TIMEOUT_MS: "12" })).toMatchObject({ whatsapp: { maxAttachmentBytes: 10 }, mistral: { maxResponseBytes: 11, requestTimeoutMs: 12 } });
  expect(() => loadConfig({ ...validEnvironment(), MAX_ATTACHMENT_BYTES: "0" })).toThrow("MAX_ATTACHMENT_BYTES");
  expect(() => loadConfig({ ...validEnvironment(), MISTRAL_REQUEST_TIMEOUT_MS: "0" })).toThrow("MISTRAL_REQUEST_TIMEOUT_MS");
});

test("Azure fallback validates credentials without exposing them and defaults its threshold to 0.80", () => {
  expect(loadConfig(validEnvironment()).azure).toEqual({ enabled: false, endpoint: null, apiKey: null, maxResponseBytes: 2 * 1024 * 1024, requestTimeoutMs: 60_000, pollIntervalMs: 500, fallbackConfidenceThreshold: 0.80 });
  const secret = "azure-secret-must-not-appear";
  expect(loadConfig({ ...validEnvironment(), AZURE_ENABLED: "true", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://azure.example.test", AZURE_DOCUMENT_INTELLIGENCE_API_KEY: secret })).toMatchObject({ azure: { enabled: true, endpoint: "https://azure.example.test", fallbackConfidenceThreshold: 0.80 } });
  try {
    loadConfig({ ...validEnvironment(), AZURE_ENABLED: "true", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://azure.example.test" });
    throw new Error("expected Azure credential validation to fail");
  } catch (error) {
    expect(String(error)).toContain("AZURE_DOCUMENT_INTELLIGENCE_API_KEY");
    expect(String(error)).not.toContain(secret);
  }
  expect(() => loadConfig({ ...validEnvironment(), OCR_FALLBACK_CONFIDENCE_THRESHOLD: "1.01" })).toThrow("OCR_FALLBACK_CONFIDENCE_THRESHOLD");
});

test("documented Azure response and polling limits retain their defaults and validation bounds", () => {
  expect(loadConfig(validEnvironment()).azure).toMatchObject({ maxResponseBytes: 2 * 1024 * 1024, requestTimeoutMs: 60_000, pollIntervalMs: 500 });
  expect(loadConfig({ ...validEnvironment(), AZURE_MAX_RESPONSE_BYTES: "1", AZURE_REQUEST_TIMEOUT_MS: "1", AZURE_POLL_INTERVAL_MS: "0" }).azure).toMatchObject({ maxResponseBytes: 1, requestTimeoutMs: 1, pollIntervalMs: 0 });
  expect(() => loadConfig({ ...validEnvironment(), AZURE_MAX_RESPONSE_BYTES: "0" })).toThrow("AZURE_MAX_RESPONSE_BYTES");
  expect(() => loadConfig({ ...validEnvironment(), AZURE_REQUEST_TIMEOUT_MS: "0" })).toThrow("AZURE_REQUEST_TIMEOUT_MS");
  expect(() => loadConfig({ ...validEnvironment(), AZURE_POLL_INTERVAL_MS: "-1" })).toThrow("AZURE_POLL_INTERVAL_MS");
});

test("Azure-only mode does not require Mistral credentials", () => {
  const environment = { ...validEnvironment(), MISTRAL_ENABLED: "false", AZURE_ENABLED: "true", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://azure.example.test", AZURE_DOCUMENT_INTELLIGENCE_API_KEY: "azure-secret" };
  delete (environment as Partial<typeof environment>).MISTRAL_API_KEY;
  delete (environment as Partial<typeof environment>).MISTRAL_MODEL;
  expect(loadConfig(environment).mistral).toMatchObject({ apiKey: null, model: null });
  expect(() => loadConfig({ ...environment, AZURE_ENABLED: "false" })).toThrow("At least one extraction provider must be enabled");
});

test("structured logger redacts secret-valued fields", () => {
  const lines: string[] = [];
  createLogger("debug", (line) => lines.push(line)).info("provider configured", { mistralApiKey: "do-not-log", nested: { authToken: "also-secret" } });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("[REDACTED]");
  expect(lines[0]).not.toContain("do-not-log");
  expect(lines[0]).not.toContain("also-secret");
});
