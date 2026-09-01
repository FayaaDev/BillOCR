import { expect, test } from "bun:test";
import { loadAzureConfig, loadConfig, loadValidationConfig } from "../src/config";
import { createLogger } from "../src/logger";
import { readServiceAccountCredential } from "../src/google-projections";

const validEnvironment = () => ({
  APP_DATA_DIR: "./data", WHATSAPP_GROUP_ID: "group", WHATSAPP_AUTH_PATH: "./auth",
  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://azure.example.test", AZURE_DOCUMENT_INTELLIGENCE_API_KEY: "azure-secret",
  GOOGLE_SERVICE_ACCOUNT_JSON: "./service-account.json", GOOGLE_DRIVE_FOLDER_ID: "folder", GOOGLE_SHEET_ID: "sheet",
  REVIEW_USERNAME: "reviewer", REVIEW_PASSWORD: "review-secret",
});

test("configuration allows WhatsApp to be disabled for test environments", () => {
  expect(loadConfig({ ...validEnvironment(), WHATSAPP_ENABLED: "false" }).whatsapp.enabled).toBe(false);
});

test("configuration permits an active WhatsApp connection without an ingestion group", () => {
  const environment: Record<string, string> = { ...validEnvironment() };
  delete environment.WHATSAPP_GROUP_ID;
  expect(loadConfig(environment).whatsapp).toMatchObject({ enabled: true, groupId: null });
});

test("image preprocessing is disabled by default and validates its timeout", () => {
  expect(loadConfig(validEnvironment()).imagePreprocessing).toEqual({ enabled: false, timeoutMs: 8_000 });
  expect(loadConfig({ ...validEnvironment(), IMAGE_PREPROCESSING_ENABLED: "true", IMAGE_PREPROCESSING_TIMEOUT_MS: "9" }).imagePreprocessing).toEqual({ enabled: true, timeoutMs: 9 });
  expect(() => loadConfig({ ...validEnvironment(), IMAGE_PREPROCESSING_ENABLED: "yes" })).toThrow("IMAGE_PREPROCESSING_ENABLED");
  expect(() => loadConfig({ ...validEnvironment(), IMAGE_PREPROCESSING_TIMEOUT_MS: "0" })).toThrow("IMAGE_PREPROCESSING_TIMEOUT_MS");
});

test("Google projections are opt-in and service-account credentials are shape-validated without exposing values", () => {
  expect(loadConfig({ ...validEnvironment(), GOOGLE_ENABLED: "false" }).google).toMatchObject({ enabled: false, credentialJson: null });
  expect(() => loadConfig({ APP_DATA_DIR: "./data", WHATSAPP_GROUP_ID: "group", WHATSAPP_AUTH_PATH: "./auth", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://azure.example.test", AZURE_DOCUMENT_INTELLIGENCE_API_KEY: "azure-secret", REVIEW_USERNAME: "reviewer", REVIEW_PASSWORD: "token", GOOGLE_ENABLED: "true" })).toThrow("GOOGLE_SERVICE_ACCOUNT_JSON");
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

test("configuration validates byte and Azure timeout limits", () => {
  expect(loadConfig({ ...validEnvironment(), MAX_ATTACHMENT_BYTES: "10", AZURE_MAX_RESPONSE_BYTES: "11", AZURE_REQUEST_TIMEOUT_MS: "12" })).toMatchObject({ whatsapp: { maxAttachmentBytes: 10 }, azure: { maxResponseBytes: 11, requestTimeoutMs: 12 } });
  expect(() => loadConfig({ ...validEnvironment(), MAX_ATTACHMENT_BYTES: "0" })).toThrow("MAX_ATTACHMENT_BYTES");
  expect(() => loadConfig({ ...validEnvironment(), AZURE_REQUEST_TIMEOUT_MS: "0" })).toThrow("AZURE_REQUEST_TIMEOUT_MS");
});

test("Azure credentials are mandatory", () => {
  const secret = "azure-secret-must-not-appear";
  const config = loadConfig({ ...validEnvironment(), AZURE_DOCUMENT_INTELLIGENCE_API_KEY: secret });
  expect(config.azure).toEqual({ endpoint: "https://azure.example.test", apiKey: secret, maxResponseBytes: 2 * 1024 * 1024, requestTimeoutMs: 60_000, pollIntervalMs: 500 });
  try {
    loadConfig({ ...validEnvironment(), AZURE_DOCUMENT_INTELLIGENCE_API_KEY: "" });
    throw new Error("expected Azure credential validation to fail");
  } catch (error) {
    expect(String(error)).toContain("AZURE_DOCUMENT_INTELLIGENCE_API_KEY");
    expect(String(error)).not.toContain(secret);
  }
  expect(() => loadConfig({ ...validEnvironment(), AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "" })).toThrow("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT");
  expect(() => loadConfig({ ...validEnvironment(), AZURE_MAX_RESPONSE_BYTES: "0" })).toThrow("AZURE_MAX_RESPONSE_BYTES");
  expect(() => loadConfig({ ...validEnvironment(), AZURE_POLL_INTERVAL_MS: "-1" })).toThrow("AZURE_POLL_INTERVAL_MS");
});

test("standalone Azure configuration does not require service settings", () => {
  expect(loadAzureConfig({ AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://azure.example.test", AZURE_DOCUMENT_INTELLIGENCE_API_KEY: "azure-secret" })).toEqual({ endpoint: "https://azure.example.test", apiKey: "azure-secret", maxResponseBytes: 2 * 1024 * 1024, requestTimeoutMs: 60_000, pollIntervalMs: 500 });
});

test("structured logger redacts secret-valued fields", () => {
  const lines: string[] = [];
  createLogger("debug", (line) => lines.push(line)).info("provider configured", { azureApiKey: "do-not-log", nested: { authToken: "also-secret" } });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("[REDACTED]");
  expect(lines[0]).not.toContain("do-not-log");
  expect(lines[0]).not.toContain("also-secret");
});
