import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ReadStream, WriteStream } from "node:tty";
import { exchangeZohoAuthorizationCode, publishZohoCredential, readHiddenGrantCode, runZohoOAuth, zohoOAuthSetupError } from "../src/backend/zoho-oauth";

const client = { clientId: "offline-client", clientSecret: "SECRET-client" };
const grant = "SECRET-grant";
const token = { refresh_token: "SECRET-refresh", access_token: "SECRET-access", token_type: "Bearer", expires_in: 3600, api_domain: "https://www.zohoapis.sa" };
const credential = { client_id: client.clientId, client_secret: client.clientSecret, refresh_token: token.refresh_token, token_uri: "https://accounts.zoho.sa/oauth/v2/token", api_domain: token.api_domain };
const directories: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "jabocr-zoho-")); directories.push(dir); return dir; }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const env = (destination: string) => ({ Client_ID: client.clientId, Client_Secret: client.clientSecret, ZOHO_OAUTH_CREDENTIAL_JSON: destination });
async function failure(operation: () => Promise<unknown>) {
  try { await operation(); } catch (error) {
    const message = zohoOAuthSetupError(error);
    for (const secret of [client.clientSecret, grant, token.refresh_token, token.access_token]) expect(message).not.toContain(secret);
    return message;
  }
  throw new Error("Expected offline operation to fail");
}

test("Saudi authorization_code exchange sends a form and saves only durable credentials privately", async () => {
  const dir = fixture(); const destination = join(dir, "new", "nested", "credential.json"); const output: string[] = [];
  await runZohoOAuth(env(destination), (line) => output.push(line), async (input, init) => {
    expect(String(input)).toBe(credential.token_uri);
    expect(init?.method).toBe("POST"); expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: "authorization_code", client_id: client.clientId, client_secret: client.clientSecret, code: grant });
    return Response.json(token);
  }, async () => grant);
  expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual(credential);
  expect(lstatSync(destination).mode & 0o777).toBe(0o600);
  for (const path of [join(dir, "new"), join(dir, "new", "nested")]) expect(lstatSync(path).mode & 0o777).toBe(0o700);
  expect(readdirSync(join(dir, "new", "nested"))).toEqual(["credential.json"]);
  expect(output.join("\n")).not.toContain("SECRET");
});

test("atomic publication preserves existing directory permissions and refuses existing files and dangling symlinks before input or exchange", async () => {
  const dir = fixture(); chmodSync(dir, 0o755);
  const destination = join(dir, "credential.json"); publishZohoCredential(destination, credential);
  expect(lstatSync(dir).mode & 0o777).toBe(0o755);
  const original = readFileSync(destination, "utf8");
  expect(() => publishZohoCredential(destination, { ...credential, refresh_token: "replacement" })).toThrow("refuses to overwrite");
  const dangling = join(dir, "dangling.json"); symlinkSync(join(dir, "missing"), dangling);
  let calls = 0;
  for (const path of [destination, dangling, dir]) {
    expect(await failure(() => runZohoOAuth(env(path), () => {}, async () => { calls++; return Response.json(token); }, async () => { calls++; return grant; }))).toContain("refuses to overwrite");
  }
  expect(calls).toBe(0); expect(readFileSync(destination, "utf8")).toBe(original);
});

test("output appearing during input prevents token generation; publication races cannot overwrite", async () => {
  const destination = join(fixture(), "credential.json"); let calls = 0;
  expect(await failure(() => runZohoOAuth(env(destination), () => {}, async () => { calls++; return Response.json(token); }, async () => { writeFileSync(destination, "existing"); return grant; }))).toContain("refuses to overwrite");
  expect(calls).toBe(0);
  rmSync(destination);
  expect(await failure(() => runZohoOAuth(env(destination), () => {}, async () => { writeFileSync(destination, "race"); return Response.json(token); }, async () => grant))).toContain("refuses to overwrite");
  expect(readFileSync(destination, "utf8")).toBe("race"); expect(readdirSync(join(destination, ".."))).toEqual(["credential.json"]);
});

test("malformed responses and provider/network errors never expose secrets", async () => {
  for (const response of [new Response(JSON.stringify(token), { status: 400 }), new Response(grant), Response.json(null), Response.json([]), Response.json({ ...token, error: client.clientSecret }), Response.json({ ...token, refresh_token: null }), Response.json({ ...token, access_token: "" }), Response.json({ ...token, token_type: "MAC" }), Response.json({ ...token, expires_in: "3600" }), Response.json({ ...token, expires_in: -1 }), Response.json({ ...token, refresh_token: "bad\nvalue" })]) {
    expect(await failure(() => exchangeZohoAuthorizationCode(client, grant, async () => response))).toMatch(/Zoho OAuth token (response was invalid|exchange failed)/);
  }
  expect(await failure(() => exchangeZohoAuthorizationCode(client, grant, async () => { throw new Error(client.clientSecret); }))).toBe("Zoho OAuth token exchange failed");
  expect(zohoOAuthSetupError(new Error(grant))).toBe("Zoho OAuth setup failed");
});

test("only the exact Saudi HTTPS API endpoint is accepted", async () => {
  for (const api_domain of [undefined, "https://www.zohoapis.com", "http://www.zohoapis.sa", "https://www.zohoapis.sa.evil.test", "https://evil.test", "https://user@www.zohoapis.sa", "https://www.zohoapis.sa:443", "https://www.zohoapis.sa/path", "https://www.zohoapis.sa?secret", "https://www.zohoapis.sa/#fragment"]) {
    expect(await failure(() => exchangeZohoAuthorizationCode(client, grant, async () => Response.json({ ...token, api_domain })))).toContain("not a Saudi API endpoint");
  }
});

test("exchange limits cover oversized headers, streamed bodies, stalled fetch and stalled response", async () => {
  for (const response of [new Response("small", { headers: { "content-length": "1000" } }), new Response("x".repeat(1000))]) {
    expect(await failure(() => exchangeZohoAuthorizationCode(client, grant, async () => response, { maxResponseBytes: 10 }))).toContain("too large");
  }
  expect(await failure(() => exchangeZohoAuthorizationCode(client, grant, () => new Promise(() => {}), { timeoutMs: 10 }))).toContain("timed out");
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel() { cancelled = true; } }));
  expect(await failure(() => exchangeZohoAuthorizationCode(client, grant, async () => response, { timeoutMs: 10 }))).toContain("timed out");
  expect(cancelled).toBe(true);
});

test("invalid setup, cancellation, invalid grants and write failures save nothing", async () => {
  const dir = fixture(); const destination = join(dir, "credential.json"); let calls = 0;
  const fetcher = async () => { calls++; return Response.json(token); };
  for (const settings of [{ ...env(destination), Client_ID: undefined }, { ...env(destination), Client_Secret: " " }, { ...env(destination), ZOHO_OAUTH_CREDENTIAL_JSON: "" }]) {
    await failure(() => runZohoOAuth(settings, () => {}, fetcher, async () => grant));
  }
  await failure(() => runZohoOAuth(env(destination), () => {}, fetcher, async () => { throw new Error(grant); }));
  await failure(() => runZohoOAuth(env(destination), () => {}, fetcher, async () => ""));
  expect(calls).toBe(0); expect(existsSync(destination)).toBe(false);
  const blocked = join(dir, "file"); writeFileSync(blocked, "unchanged");
  expect(() => publishZohoCredential(join(blocked, "credential.json"), credential)).toThrow();
  expect(readFileSync(blocked, "utf8")).toBe("unchanged");
  mkdirSync(destination); expect(() => publishZohoCredential(destination, credential)).toThrow("refuses to overwrite");
});

function terminal() {
  const input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, paused: true, isPaused() { return this.paused; }, setRawMode(raw: boolean) { this.isRaw = raw; }, pause() { this.paused = true; }, resume() { this.paused = false; } });
  const messages: string[] = []; const output = { isTTY: true, write(text: string) { messages.push(text); return true; } };
  const signals = new EventEmitter();
  return { input, output, messages, signals, read: (timeoutMs = 1000) => readHiddenGrantCode(input as unknown as ReadStream, output as WriteStream, signals, timeoutMs) };
}

test("hidden input handles editing, restores terminal state and removes listeners", async () => {
  const tty = terminal(); const pending = tty.read(); expect(tty.input.isRaw).toBe(true);
  tty.input.emit("data", Buffer.from(`${grant}x\x7f\r`)); expect(await pending).toBe(grant);
  expect(tty.messages.join("")).not.toContain(grant); expect(tty.input.isRaw).toBe(false); expect(tty.input.paused).toBe(true);
  expect(tty.input.listenerCount("data")).toBe(0); expect(tty.signals.eventNames()).toEqual([]);
});

test("hidden input restores on Ctrl-C, EOF, signals, timeout, invalid input and terminal failure", async () => {
  for (const event of ["ctrl-c", "end", "error", "SIGINT", "SIGTERM", "SIGHUP", "timeout", "invalid", "overflow"]) {
    const tty = terminal(); const pending = tty.read(10);
    if (event === "ctrl-c") tty.input.emit("data", Buffer.from("\x03"));
    else if (event === "end" || event === "error") tty.input.emit(event);
    else if (event.startsWith("SIG")) tty.signals.emit(event);
    else if (event === "invalid") tty.input.emit("data", Buffer.from("\r"));
    else if (event === "overflow") tty.input.emit("data", Buffer.from("x".repeat(8193)));
    await failure(() => pending);
    expect(tty.input.isRaw).toBe(false); expect(tty.input.paused).toBe(true); expect(tty.input.eventNames()).toEqual([]); expect(tty.signals.eventNames()).toEqual([]);
  }
  const tty = terminal(); tty.output.write = () => { throw new Error(grant); };
  await failure(() => tty.read()); expect(tty.input.isRaw).toBe(false);
  const nonTty = terminal(); nonTty.input.isTTY = false;
  expect(() => nonTty.read()).toThrow("interactive terminal");
});
