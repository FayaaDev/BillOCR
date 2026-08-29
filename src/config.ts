import { resolve } from "node:path";
import { realpathSync } from "node:fs";

export type GoogleConfig =
  | { enabled: false; authMode: "disabled"; credentialJson: null; driveFolderId: null; sheetId: null; sheetName: string; requestTimeoutMs: number; maxResponseBytes: number }
  | { enabled: true; authMode: "service_account" | "user_oauth"; credentialJson: string; driveFolderId: string; sheetId: string; sheetName: string; requestTimeoutMs: number; maxResponseBytes: number };
export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  whatsapp: { enabled: boolean; groupId: string; authPath: string; originalsDir: string; maxAttachmentBytes: number };
  mistral: { apiKey: string; model: string; maxResponseBytes: number; requestTimeoutMs: number };
  google: GoogleConfig;
  review: { username: string; password: string };
  validation: { confidenceThreshold: number; handwrittenConfidenceThreshold: number; currencyRoundingTolerance: number; maxFutureInvoiceDays: number };
  jobs: { maxAttempts: number; retryBaseMs: number; retryMaxMs: number; leaseMs: number };
}

export type Env = Record<string, string | undefined>;
const levels = new Set(["debug", "info", "warn", "error"]);

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${key}`);
  return value;
}
function integer(env: Env, key: string, fallback: number, minimum: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${key} must be an integer >= ${minimum}`);
  return value;
}
function number(env: Env, key: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${key} must be between ${minimum} and ${maximum}`);
  return value;
}
function boolean(env: Env, key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${key} must be true or false`);
}

/** Resolve this controlled directory once after it has been created; readers never realpath request/DB paths. */
export function canonicalOriginalsDir(path: string): string { return realpathSync(resolve(path)); }

/** Validation settings shared by the service and bounded live evaluator. */
export function loadValidationConfig(env: Env = Bun.env): AppConfig["validation"] {
  const confidenceThreshold = number(env, "CONFIDENCE_THRESHOLD", 0.85, 0, 1);
  const handwrittenConfidenceThreshold = number(env, "HANDWRITTEN_CONFIDENCE_THRESHOLD", 0.92, 0, 1);
  if (handwrittenConfidenceThreshold < confidenceThreshold) throw new Error("HANDWRITTEN_CONFIDENCE_THRESHOLD must be >= CONFIDENCE_THRESHOLD");
  return {
    confidenceThreshold,
    handwrittenConfidenceThreshold,
    currencyRoundingTolerance: number(env, "CURRENCY_ROUNDING_TOLERANCE", 0.01, 0, Number.MAX_SAFE_INTEGER),
    maxFutureInvoiceDays: integer(env, "MAX_FUTURE_INVOICE_DAYS", 30, 0),
  };
}

/** Validates all configuration, including settings consumed by later provider phases. */
export function loadConfig(env: Env = Bun.env): AppConfig {
  const dataDir = resolve(required(env, "APP_DATA_DIR"));
  const logLevel = env.APP_LOG_LEVEL ?? "info";
  if (!levels.has(logLevel)) throw new Error("APP_LOG_LEVEL must be debug, info, warn, or error");
  const retryBaseMs = integer(env, "JOB_RETRY_BASE_MS", 1_000, 1);
  const retryMaxMs = integer(env, "JOB_RETRY_MAX_MS", 300_000, retryBaseMs);
  const confidenceThreshold = number(env, "CONFIDENCE_THRESHOLD", 0.85, 0, 1);
  const handwrittenConfidenceThreshold = number(env, "HANDWRITTEN_CONFIDENCE_THRESHOLD", 0.92, 0, 1);
  if (handwrittenConfidenceThreshold < confidenceThreshold) throw new Error("HANDWRITTEN_CONFIDENCE_THRESHOLD must be >= CONFIDENCE_THRESHOLD");
  return {
    host: env.APP_HOST ?? "127.0.0.1",
    port: integer(env, "APP_PORT", 3_000, 1),
    dataDir,
    databasePath: resolve(env.APP_DATABASE_PATH ?? `${dataDir}/bill-ledger.sqlite`),
    logLevel: logLevel as AppConfig["logLevel"],
    whatsapp: { enabled: boolean(env, "WHATSAPP_ENABLED", true), groupId: required(env, "WHATSAPP_GROUP_ID"), authPath: resolve(required(env, "WHATSAPP_AUTH_PATH")), originalsDir: resolve(env.WHATSAPP_ORIGINALS_DIR ?? `${dataDir}/originals`), maxAttachmentBytes: integer(env, "MAX_ATTACHMENT_BYTES", 20 * 1024 * 1024, 1) },
    mistral: { apiKey: required(env, "MISTRAL_API_KEY"), model: required(env, "MISTRAL_MODEL"), maxResponseBytes: integer(env, "MISTRAL_MAX_RESPONSE_BYTES", 2 * 1024 * 1024, 1), requestTimeoutMs: integer(env, "MISTRAL_REQUEST_TIMEOUT_MS", 60_000, 1) },
    google: (() => {
      const enabled = boolean(env, "GOOGLE_ENABLED", false);
      const requestTimeoutMs = integer(env, "GOOGLE_REQUEST_TIMEOUT_MS", 60_000, 1); const maxResponseBytes = integer(env, "GOOGLE_MAX_RESPONSE_BYTES", 2 * 1024 * 1024, 1);
       if (!enabled) return { enabled: false, authMode: "disabled" as const, credentialJson: null, driveFolderId: null, sheetId: null, sheetName: env.GOOGLE_SHEET_NAME ?? "Ledger", requestTimeoutMs, maxResponseBytes };
       const authMode = env.GOOGLE_AUTH_MODE ?? "service_account";
       if (authMode !== "service_account" && authMode !== "user_oauth") throw new Error("GOOGLE_AUTH_MODE must be service_account or user_oauth");
       return { enabled: true, authMode, credentialJson: resolve(required(env, authMode === "service_account" ? "GOOGLE_SERVICE_ACCOUNT_JSON" : "GOOGLE_OAUTH_CREDENTIAL_JSON")), driveFolderId: required(env, "GOOGLE_DRIVE_FOLDER_ID"), sheetId: required(env, "GOOGLE_SHEET_ID"), sheetName: env.GOOGLE_SHEET_NAME ?? "Ledger", requestTimeoutMs, maxResponseBytes };
    })(),
    review: { username: required(env, "REVIEW_USERNAME"), password: required(env, "REVIEW_PASSWORD") },
    validation: loadValidationConfig(env),
    jobs: { maxAttempts: integer(env, "JOB_MAX_ATTEMPTS", 5, 1), retryBaseMs, retryMaxMs, leaseMs: integer(env, "JOB_LEASE_MS", 60_000, 1) },
  };
}
