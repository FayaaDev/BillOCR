import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";
import { readServiceAccountCredential } from "../src/google-projections";

const validEnvironment = () => ({
  APP_DATA_DIR: "./data", WHATSAPP_GROUP_ID: "group", WHATSAPP_AUTH_PATH: "./auth",
  MISTRAL_API_KEY: "mistral-secret", MISTRAL_MODEL: "mistral-ocr-latest",
  GOOGLE_SERVICE_ACCOUNT_JSON: "./service-account.json", GOOGLE_DRIVE_FOLDER_ID: "folder", GOOGLE_SHEET_ID: "sheet",
  REVIEW_USERNAME: "reviewer", REVIEW_PASSWORD: "review-secret",
});

test("configuration rejects an invalid stricter handwritten confidence threshold", () => {
  expect(() => loadConfig({ ...validEnvironment(), CONFIDENCE_THRESHOLD: "0.9", HANDWRITTEN_CONFIDENCE_THRESHOLD: "0.8" })).toThrow("HANDWRITTEN_CONFIDENCE_THRESHOLD");
});

test("configuration allows WhatsApp to be disabled for test environments", () => {
  expect(loadConfig({ ...validEnvironment(), WHATSAPP_ENABLED: "false" }).whatsapp.enabled).toBe(false);
});

test("Google projections are opt-in and service-account credentials are shape-validated without exposing values", () => {
  expect(loadConfig({ ...validEnvironment(), GOOGLE_ENABLED: "false" }).google).toMatchObject({ enabled: false, credentialJson: null });
  expect(() => loadConfig({ APP_DATA_DIR: "./data", WHATSAPP_GROUP_ID: "group", WHATSAPP_AUTH_PATH: "./auth", MISTRAL_API_KEY: "key", MISTRAL_MODEL: "model", REVIEW_USERNAME: "reviewer", REVIEW_PASSWORD: "token", GOOGLE_ENABLED: "true" })).toThrow("GOOGLE_SERVICE_ACCOUNT_JSON");
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
  expect(loadConfig(validEnvironment()).validation).toEqual({ confidenceThreshold: 0.85, handwrittenConfidenceThreshold: 0.92, currencyRoundingTolerance: 0.01, maxFutureInvoiceDays: 30 });
  expect(() => loadConfig({ ...validEnvironment(), MAX_FUTURE_INVOICE_DAYS: "-1" })).toThrow("MAX_FUTURE_INVOICE_DAYS");
});

test("configuration validates byte and provider timeout limits", () => {
  expect(loadConfig({ ...validEnvironment(), MAX_ATTACHMENT_BYTES: "10", MISTRAL_MAX_RESPONSE_BYTES: "11", MISTRAL_REQUEST_TIMEOUT_MS: "12" })).toMatchObject({ whatsapp: { maxAttachmentBytes: 10 }, mistral: { maxResponseBytes: 11, requestTimeoutMs: 12 } });
  expect(() => loadConfig({ ...validEnvironment(), MAX_ATTACHMENT_BYTES: "0" })).toThrow("MAX_ATTACHMENT_BYTES");
  expect(() => loadConfig({ ...validEnvironment(), MISTRAL_REQUEST_TIMEOUT_MS: "0" })).toThrow("MISTRAL_REQUEST_TIMEOUT_MS");
});

test("structured logger redacts secret-valued fields", () => {
  const lines: string[] = [];
  createLogger("debug", (line) => lines.push(line)).info("provider configured", { mistralApiKey: "do-not-log", nested: { authToken: "also-secret" } });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("[REDACTED]");
  expect(lines[0]).not.toContain("do-not-log");
  expect(lines[0]).not.toContain("also-secret");
});
