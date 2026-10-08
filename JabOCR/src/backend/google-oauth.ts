import { closeSync, existsSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { AuthorizedUser } from "./google-projections";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type DesktopClient = { clientId: string; clientSecret: string; authorizationUri: string; tokenUri: string };
export interface TokenExchangeOptions { timeoutMs?: number; maxResponseBytes?: number; }
const scopes = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets";
const defaultTokenExchangeOptions = { timeoutMs: 60_000, maxResponseBytes: 2 * 1024 * 1024 };

function requiredString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
export function parseDesktopClientJson(json: string): DesktopClient {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error("Invalid Google OAuth client JSON"); }
  const installed = parsed && typeof parsed === "object" ? (parsed as { installed?: Record<string, unknown> }).installed : undefined;
  const clientId = requiredString(installed?.client_id); const clientSecret = requiredString(installed?.client_secret); const authorizationUri = requiredString(installed?.auth_uri); const tokenUri = requiredString(installed?.token_uri);
  if (!clientId || !clientSecret || !authorizationUri || !tokenUri) throw new Error("Google OAuth client JSON requires an installed desktop client");
  return { clientId, clientSecret, authorizationUri, tokenUri };
}
function base64Url(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64url"); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("base64url"); }
function random(bytes: number): Uint8Array { const output = new Uint8Array(bytes); crypto.getRandomValues(output); return output; }
export function createAuthorizationRequest(client: DesktopClient, redirectUri: string, randomBytes: (length: number) => Uint8Array = random): { authorizationUrl: string; state: string; verifier: string } {
  const state = base64Url(randomBytes(32)); const verifier = base64Url(randomBytes(64));
  const url = new URL(client.authorizationUri); url.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirectUri, response_type: "code", scope: scopes, access_type: "offline", prompt: "consent", state, code_challenge: sha256(verifier), code_challenge_method: "S256" }).toString();
  return { authorizationUrl: url.toString(), state, verifier };
}
export function validateCallback(url: URL, expectedState: string): string {
  if (url.searchParams.get("state") !== expectedState) throw new Error("OAuth callback state validation failed");
  const code = url.searchParams.get("code"); if (!code) throw new Error("OAuth callback missing authorization code"); return code;
}
async function boundedResponseText(response: Response, maxResponseBytes: number, signal: AbortSignal): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxResponseBytes) { await response.body?.cancel(); throw new Error("Google OAuth token response too large"); }
  const reader = response.body?.getReader(); if (!reader) return "";
  let size = 0; const chunks: Uint8Array[] = [];
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => { abort = () => reject(new Error("Google OAuth token exchange timed out")); signal.addEventListener("abort", abort, { once: true }); });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxResponseBytes) { await reader.cancel(); throw new Error("Google OAuth token response too large"); }
      chunks.push(next.value);
    }
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
export async function exchangeAuthorizationCode(client: DesktopClient, redirectUri: string, verifier: string, code: string, fetcher: Fetcher = fetch, options: TokenExchangeOptions = {}): Promise<AuthorizedUser> {
  const timeoutMs = options.timeoutMs ?? defaultTokenExchangeOptions.timeoutMs; const maxResponseBytes = options.maxResponseBytes ?? defaultTokenExchangeOptions.maxResponseBytes;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response; let text: string;
  try {
    response = await fetcher(client.tokenUri, { method: "POST", signal: controller.signal, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }) });
    text = await boundedResponseText(response, maxResponseBytes, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Google OAuth token exchange timed out");
    if (error instanceof Error && error.message === "Google OAuth token response too large") throw error;
    throw new Error("Google OAuth token exchange failed");
  } finally { clearTimeout(timer); }
  if (!response.ok) throw new Error("Google OAuth token exchange failed");
  let body: unknown; try { body = JSON.parse(text); } catch { throw new Error("Google OAuth token response was invalid"); }
  const refreshToken = body && typeof body === "object" ? requiredString((body as { refresh_token?: unknown }).refresh_token) : null;
  if (!refreshToken) throw new Error("Google OAuth token response missing refresh token");
  return { type: "authorized_user", client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, token_uri: client.tokenUri };
}
/** Atomically links a private temporary file so an existing credential is never replaced. */
export function publishAuthorizedUserCredential(output: string, credential: AuthorizedUser): void {
  if (existsSync(output)) throw new Error("Google OAuth refuses to overwrite an existing credential file");
  const temporary = `${output}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600); try { writeFileSync(fd, `${JSON.stringify(credential)}\n`); } finally { closeSync(fd); }
    // link(2) is an atomic no-clobber publication on the same filesystem.
    linkSync(temporary, output); unlinkSync(temporary);
  } catch (error) { try { if (existsSync(temporary)) unlinkSync(temporary); } catch {} if (error instanceof Error && error.message.includes("EEXIST")) throw new Error("Google OAuth refuses to overwrite an existing credential file"); throw error; }
}
export async function runGoogleOAuth(env: Record<string, string | undefined> = Bun.env, output: (line: string) => void = console.log, fetcher: Fetcher = fetch, timeoutMs = 300_000, tokenExchangeOptions: TokenExchangeOptions = {}): Promise<void> {
  const input = env.GOOGLE_OAUTH_CLIENT_JSON; const destination = env.GOOGLE_OAUTH_CREDENTIAL_JSON;
  if (!input || !destination) throw new Error("GOOGLE_OAUTH_CLIENT_JSON and GOOGLE_OAUTH_CREDENTIAL_JSON are required");
  if (existsSync(destination)) throw new Error("Google OAuth refuses to overwrite an existing credential file");
  const client = parseDesktopClientJson(readFileSync(input, "utf8"));
  let resolveCode!: (code: string) => void;
  const received = new Promise<string>((resolve) => { resolveCode = resolve; });
  let state = "";
  const callbackResponse = (body: string, status = 200) => new Response(body, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { const url = new URL(request.url); if (url.pathname !== "/callback") return callbackResponse("Not found", 404); try { const code = validateCallback(url, state); setTimeout(() => resolveCode(code), 0); return callbackResponse("Authorization received. You may return to the terminal."); } catch { return callbackResponse("Authorization could not be verified.", 400); } } });
  try {
    const redirectUri = new URL("callback", server.url).toString(); const request = createAuthorizationRequest(client, redirectUri); state = request.state;
    output(`Open this URL in a browser to authorize Google Drive and Sheets access:\n${request.authorizationUrl}`);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expires = new Promise<string>((_, reject) => { timeout = setTimeout(() => reject(new Error("Google OAuth authorization timed out")), timeoutMs); });
    let code: string;
    try { code = await Promise.race([received, expires]); } finally { if (timeout) clearTimeout(timeout); }
    const credential = await exchangeAuthorizationCode(client, redirectUri, request.verifier, code, fetcher, tokenExchangeOptions);
    publishAuthorizedUserCredential(destination, credential); output("Google OAuth credential saved. Set GOOGLE_ENABLED=true and GOOGLE_AUTH_MODE=user_oauth, restart the service, then retry failed jobs.");
  } finally { server.stop(true); }
}
export function googleOAuthSetupError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "Google OAuth client JSON file not found";
  if (error instanceof Error && [
    "GOOGLE_OAUTH_CLIENT_JSON and GOOGLE_OAUTH_CREDENTIAL_JSON are required",
    "Google OAuth refuses to overwrite an existing credential file",
    "Invalid Google OAuth client JSON",
    "Google OAuth client JSON requires an installed desktop client",
    "Google OAuth authorization timed out",
    "Google OAuth token exchange timed out",
    "Google OAuth token exchange failed",
    "Google OAuth token response too large",
    "Google OAuth token response was invalid",
    "Google OAuth token response missing refresh token",
  ].includes(error.message)) return error.message;
  return "Google OAuth setup failed";
}
if (import.meta.main) void runGoogleOAuth().catch((error) => { console.error(googleOAuthSetupError(error)); process.exitCode = 1; });
