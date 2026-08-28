import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthorizationRequest, exchangeAuthorizationCode, parseDesktopClientJson, publishAuthorizedUserCredential, runGoogleOAuth, validateCallback } from "../src/google-oauth";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

test("OAuth helpers parse desktop clients, use PKCE/state, and reject invalid callbacks without secret output", async () => {
  const client = parseDesktopClientJson(JSON.stringify({ installed: { client_id: "desktop-client", client_secret: "desktop-secret", auth_uri: "https://accounts.example/auth", token_uri: "https://accounts.example/token", redirect_uris: ["http://localhost"] } }));
  const request = createAuthorizationRequest(client, "http://127.0.0.1:9876/callback", () => new Uint8Array(32).fill(7));
  const url = new URL(request.authorizationUrl);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "desktop-client", redirect_uri: "http://127.0.0.1:9876/callback", response_type: "code", access_type: "offline", prompt: "consent", code_challenge_method: "S256" });
  expect(url.searchParams.get("state")).toBe(request.state);
  expect(url.searchParams.get("code_challenge")).not.toBe(request.verifier);
  expect(validateCallback(new URL(`http://localhost/callback?state=${request.state}&code=one-time-code`), request.state)).toBe("one-time-code");
  expect(() => validateCallback(new URL("http://localhost/callback?state=wrong&code=one-time-code"), request.state)).toThrow("state validation failed");
  await expect(exchangeAuthorizationCode(client, "http://127.0.0.1:9876/callback", request.verifier, "one-time-code", async (input, init) => {
    expect(String(input)).toBe("https://accounts.example/token");
    expect(new URLSearchParams(String(init?.body))).toEqual(new URLSearchParams({ code: "one-time-code", client_id: "desktop-client", client_secret: "desktop-secret", redirect_uri: "http://127.0.0.1:9876/callback", grant_type: "authorization_code", code_verifier: request.verifier }));
    return Response.json({ refresh_token: "refresh-secret" });
  })).resolves.toEqual({ type: "authorized_user", client_id: "desktop-client", client_secret: "desktop-secret", refresh_token: "refresh-secret", token_uri: "https://accounts.example/token" });
});

test("OAuth credential publication is atomic, private, and refuses overwrite", () => {
  const directory = mkdtempSync(join(tmpdir(), "bill-oauth-")); directories.push(directory);
  const output = join(directory, "authorized-user.json");
  const credential = { type: "authorized_user" as const, client_id: "desktop-client", client_secret: "desktop-secret", refresh_token: "refresh-secret", token_uri: "https://oauth2.example/token" };
  publishAuthorizedUserCredential(output, credential);
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(credential);
  expect(statSync(output).mode & 0o777).toBe(0o600);
  expect(() => publishAuthorizedUserCredential(output, credential)).toThrow("refuses to overwrite");
  expect(existsSync(`${output}.tmp`)).toBe(false);
});

test("loopback flow closes its callback server after success without printing credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bill-oauth-loopback-")); directories.push(directory);
  const clientPath = join(directory, "client.json"); const outputPath = join(directory, "credential.json"); const lines: string[] = [];
  writeFileSync(clientPath, JSON.stringify({ installed: { client_id: "desktop-client", client_secret: "desktop-secret", auth_uri: "https://accounts.example/auth", token_uri: "https://accounts.example/token" } }));
  const running = runGoogleOAuth({ GOOGLE_OAUTH_CLIENT_JSON: clientPath, GOOGLE_OAUTH_CREDENTIAL_JSON: outputPath }, (line) => lines.push(line), async () => Response.json({ refresh_token: "refresh-secret" }), 1_000);
  for (let attempt = 0; lines.length === 0 && attempt < 50; attempt += 1) await Bun.sleep(2);
  const authorizationUrl = new URL(lines[0]!.split("\n")[1]!); const callback = new URL(authorizationUrl.searchParams.get("redirect_uri")!); callback.searchParams.set("state", authorizationUrl.searchParams.get("state")!); callback.searchParams.set("code", "one-time-code");
  const wrongState = new URL(callback); wrongState.searchParams.set("state", "wrong");
  const missingCode = new URL(callback); missingCode.searchParams.delete("code");
  for (const invalid of [new URL("/wrong", callback), wrongState, missingCode]) {
    const response = await fetch(invalid); expect(response.status).toBeGreaterThanOrEqual(400); expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  }
  const valid = await fetch(callback); expect(valid.status).toBe(200); expect(valid.headers.get("cache-control")).toBe("no-store"); expect(valid.headers.get("referrer-policy")).toBe("no-referrer");
  await running;
  await expect(fetch(callback)).rejects.toThrow();
  expect(lines.join("\n")).not.toContain("desktop-secret"); expect(lines.join("\n")).not.toContain("refresh-secret");
});

test("authorization-code exchange bounds declared and streamed responses and aborts hung fetches", async () => {
  const client = parseDesktopClientJson(JSON.stringify({ installed: { client_id: "desktop-client", client_secret: "desktop-secret", auth_uri: "https://accounts.example/auth", token_uri: "https://accounts.example/token" } }));
  await expect(exchangeAuthorizationCode(client, "http://127.0.0.1/callback", "verifier", "code", async () => new Response("x".repeat(20), { headers: { "content-length": "20" } }), { timeoutMs: 100, maxResponseBytes: 10 })).rejects.toThrow("Google OAuth token response too large");
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(11)); controller.close(); } });
  await expect(exchangeAuthorizationCode(client, "http://127.0.0.1/callback", "verifier", "code", async () => new Response(body), { timeoutMs: 100, maxResponseBytes: 10 })).rejects.toThrow("Google OAuth token response too large");
  await expect(exchangeAuthorizationCode(client, "http://127.0.0.1/callback", "verifier", "code", async (_input, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })), { timeoutMs: 1, maxResponseBytes: 10 })).rejects.toThrow("Google OAuth token exchange timed out");
});

test("loopback server closes and writes no credential when token exchange fails safely", async () => {
  const failures: Array<{ expected: string; fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>; options: { timeoutMs: number; maxResponseBytes: number } }> = [
    { expected: "Google OAuth token response too large", fetcher: async () => new Response("x".repeat(20), { headers: { "content-length": "20" } }), options: { timeoutMs: 100, maxResponseBytes: 10 } },
    { expected: "Google OAuth token exchange timed out", fetcher: async (_input, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })), options: { timeoutMs: 1, maxResponseBytes: 10 } },
  ];
  for (const [index, failure] of failures.entries()) {
    const directory = mkdtempSync(join(tmpdir(), `bill-oauth-token-${index}-`)); directories.push(directory);
    const clientPath = join(directory, "client.json"); const outputPath = join(directory, "credential.json"); const lines: string[] = [];
    writeFileSync(clientPath, JSON.stringify({ installed: { client_id: "desktop-client", client_secret: "desktop-secret", auth_uri: "https://accounts.example/auth", token_uri: "https://accounts.example/token" } }));
    const running = runGoogleOAuth({ GOOGLE_OAUTH_CLIENT_JSON: clientPath, GOOGLE_OAUTH_CREDENTIAL_JSON: outputPath }, (line) => lines.push(line), failure.fetcher, 1_000, failure.options);
    for (let attempt = 0; lines.length === 0 && attempt < 50; attempt += 1) await Bun.sleep(2);
    const authorizationUrl = new URL(lines[0]!.split("\n")[1]!); const callback = new URL(authorizationUrl.searchParams.get("redirect_uri")!); callback.searchParams.set("state", authorizationUrl.searchParams.get("state")!); callback.searchParams.set("code", "one-time-code");
    expect((await fetch(callback)).status).toBe(200); await expect(running).rejects.toThrow(failure.expected);
    expect(existsSync(outputPath)).toBe(false); await expect(fetch(callback)).rejects.toThrow();
  }
});

test("loopback flow closes its callback server after authorization timeout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bill-oauth-timeout-")); directories.push(directory);
  const clientPath = join(directory, "client.json"); const outputPath = join(directory, "credential.json"); const lines: string[] = [];
  writeFileSync(clientPath, JSON.stringify({ installed: { client_id: "desktop-client", client_secret: "desktop-secret", auth_uri: "https://accounts.example/auth", token_uri: "https://accounts.example/token" } }));
  await expect(runGoogleOAuth({ GOOGLE_OAUTH_CLIENT_JSON: clientPath, GOOGLE_OAUTH_CREDENTIAL_JSON: outputPath }, (line) => lines.push(line), fetch, 1)).rejects.toThrow("authorization timed out");
  const authorizationUrl = new URL(lines[0]!.split("\n")[1]!); const callback = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
  await expect(fetch(callback)).rejects.toThrow(); expect(existsSync(outputPath)).toBe(false);
});
