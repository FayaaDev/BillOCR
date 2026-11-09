import { closeSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ReadStream, WriteStream } from "node:tty";
import type { EventEmitter } from "node:events";
import { readZohoRegion, zohoRegions, type ZohoRegion } from "./zoho-region";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Client = { clientId: string; clientSecret: string };
export type ZohoCredential = { client_id: string; client_secret: string; refresh_token: string; token_uri: string; api_domain: string };
class SetupError extends Error {}
function fail(message: string): never { throw new SetupError(message); }
// OAuth values must not contain whitespace or control characters.
// eslint-disable-next-line no-control-regex
function validString(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\s\x00-\x1f\x7f]/.test(value); }
function refuseExisting(output: string): void {
  try { lstatSync(output); } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    fail("Zoho OAuth output could not be checked");
  }
  fail("Zoho OAuth refuses to overwrite an existing credential file");
}

/** Raw TTY input never echoes the grant code or accepts it from shell arguments. */
export function readHiddenGrantCode(input: ReadStream = process.stdin, output: WriteStream = process.stderr, signals: Pick<EventEmitter, "on" | "removeListener"> = process, timeoutMs = 300_000): Promise<string> {
  if (!input.isTTY || !output.isTTY) fail("Zoho OAuth requires an interactive terminal");
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw; const wasPaused = input.isPaused();
    let code = ""; let finished = false;
    const timer = setTimeout(() => finish(new SetupError("Zoho OAuth grant input timed out")), timeoutMs);
    const cancel = () => finish(new SetupError("Zoho OAuth setup cancelled"));
    const end = () => finish(new SetupError("Zoho OAuth grant input ended"));
    function finish(error?: Error) {
      if (finished) return; finished = true;
      clearTimeout(timer);
      input.removeListener("data", data); input.removeListener("end", end); input.removeListener("error", end);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) signals.removeListener(signal, cancel);
      try { input.setRawMode(wasRaw); if (wasPaused) input.pause(); output.write("\n"); } catch { error = new SetupError("Zoho OAuth terminal restoration failed"); }
      if (error) reject(error); else if (!validString(code)) reject(new SetupError("Zoho OAuth grant code is invalid")); else resolve(code);
    }
    function data(chunk: Buffer | string) {
      for (const character of chunk.toString()) {
        if (character === "\x03" || character === "\x04" || character === "\x1b") { cancel(); return; }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\x7f" || character === "\b") code = code.slice(0, -1);
        else code += character;
        if (code.length > 8192) { finish(new SetupError("Zoho OAuth grant code is invalid")); return; }
      }
    }
    try {
      input.setRawMode(true);
      input.on("data", data); input.on("end", end); input.on("error", end);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) signals.on(signal, cancel);
      output.write("Paste Zoho Self Client grant code for the selected region (hidden), then press Enter: "); input.resume();
    } catch { finish(new SetupError("Zoho OAuth terminal input failed")); }
  });
}

export async function exchangeZohoAuthorizationCode(client: Client, code: string, fetcher: Fetcher = fetch, options: { timeoutMs?: number; maxResponseBytes?: number; region?: ZohoRegion } = {}): Promise<ZohoCredential> {
  let region: ZohoRegion;
  try { region = readZohoRegion(options.region); } catch { fail("ZOHO_REGION must be sa or us"); }
  const { tokenUri, apiDomain, label } = zohoRegions[region];
  if (!validString(client.clientId) || !validString(client.clientSecret) || !validString(code)) fail("Zoho OAuth client credentials or grant code are invalid");
  const timeoutMs = options.timeoutMs ?? 60_000; const maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) fail("Zoho OAuth exchange limits are invalid");
  const controller = new AbortController();
  let abort!: () => void;
  const timedOut = new Promise<never>((_, reject) => { abort = () => { controller.abort(); reject(new SetupError("Zoho OAuth token exchange timed out")); }; });
  const timer = setTimeout(abort, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await Promise.race([fetcher(tokenUri, { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.clientId, client_secret: client.clientSecret, code }) }), timedOut]);
    if (!response.ok) { void response.body?.cancel().catch(() => {}); fail("Zoho OAuth token exchange failed"); }
    if (Number(response.headers.get("content-length")) > maxResponseBytes) { void response.body?.cancel().catch(() => {}); fail("Zoho OAuth token response too large"); }
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) for (;;) {
      const next = await Promise.race([reader.read(), timedOut]); if (next.done) break;
      size += next.value.byteLength; if (size > maxResponseBytes) fail("Zoho OAuth token response too large"); chunks.push(next.value);
    }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { fail("Zoho OAuth token response was invalid"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("Zoho OAuth token response was invalid");
    const token = body as Record<string, unknown>;
    // Only fixed diagnostics are safe: provider error descriptions may contain credentials.
    if (token.error !== undefined) {
      switch (token.error) {
        case "invalid_code": fail("Zoho OAuth token exchange failed: grant code is invalid, expired, or already used");
        case "invalid_client": fail("Zoho OAuth token exchange failed: client ID or client region does not match");
        case "invalid_client_secret": fail("Zoho OAuth token exchange failed: client secret does not match");
        case "invalid_grant": fail("Zoho OAuth token exchange failed: authorization grant was rejected");
        case "invalid_scope": fail("Zoho OAuth token exchange failed: requested scopes were rejected");
        default: fail("Zoho OAuth token response was invalid: provider rejected authorization");
      }
    }
    if (!validString(token.refresh_token)) fail("Zoho OAuth token response was invalid: missing or invalid refresh_token");
    if (!validString(token.access_token)) fail("Zoho OAuth token response was invalid: missing or invalid access_token");
    if (token.token_type !== "Bearer") fail("Zoho OAuth token response was invalid: missing or invalid token_type");
    if (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) fail("Zoho OAuth token response was invalid: missing or invalid expires_in");
    if (token.api_domain !== apiDomain) fail(`Zoho OAuth token response is not a ${label} API endpoint`);
    return { client_id: client.clientId, client_secret: client.clientSecret, refresh_token: token.refresh_token, token_uri: tokenUri, api_domain: apiDomain };
  } catch (error) {
    if (error instanceof SetupError) throw error;
    return fail("Zoho OAuth token exchange failed");
  } finally {
    clearTimeout(timer); controller.abort();
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

/** Publish a complete private file with atomic no-clobber link(2), like Google OAuth. */
export function publishZohoCredential(output: string, credential: ZohoCredential): void {
  refuseExisting(output);
  const temporary = `${output}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    const fd = openSync(temporary, "wx", 0o600); created = true;
    try { writeFileSync(fd, `${JSON.stringify(credential)}\n`); } finally { closeSync(fd); }
    linkSync(temporary, output);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") fail("Zoho OAuth refuses to overwrite an existing credential file");
    fail("Zoho OAuth credential could not be saved");
  } finally { if (created) unlinkSync(temporary); }
}

export async function runZohoOAuth(env: Record<string, string | undefined> = Bun.env, output: (line: string) => void = console.log, fetcher: Fetcher = fetch, readCode: () => Promise<string> = readHiddenGrantCode): Promise<void> {
  let region: ZohoRegion;
  try { region = readZohoRegion(env.ZOHO_REGION); } catch { fail("ZOHO_REGION must be sa or us"); }
  const destination = env.ZOHO_OAUTH_CREDENTIAL_JSON ?? "secrets/zoho-authorized-user.json";
  if (!destination.trim()) fail("ZOHO_OAUTH_CREDENTIAL_JSON must not be empty");
  refuseExisting(destination);
  const clientId = env.Client_ID; const clientSecret = env.Client_Secret;
  if (!validString(clientId) || !validString(clientSecret)) fail("Client_ID and Client_Secret are required and must be valid");
  const code = await readCode();
  refuseExisting(destination);
  const credential = await exchangeZohoAuthorizationCode({ clientId, clientSecret }, code, fetcher, { region });
  publishZohoCredential(destination, credential);
  output("Zoho OAuth credential saved privately. Configure ZOHO_ENABLED and destinations separately.");
}
export function zohoOAuthSetupError(error: unknown): string { return error instanceof SetupError ? error.message : "Zoho OAuth setup failed"; }
if (import.meta.main) {
  if (process.argv.length > 2) { console.error("Zoho OAuth accepts no command-line arguments"); process.exitCode = 1; }
  else void runZohoOAuth().catch((error) => { console.error(zohoOAuthSetupError(error)); process.exitCode = 1; });
}
