import { expect, test } from "bun:test";
import { BaileysTransport, normalize, silentBaileysLogger, type BaileysDependencies } from "../src/backend/baileys-transport";
import { PairingQrTokenStore, pairingQrPath, renderStoredPairingQr } from "../src/backend/whatsapp-pairing";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Logger } from "../src/backend/logger";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

test("Baileys receives a silent Pino-compatible logger whose methods emit nothing", () => {
  const output: unknown[] = [];
  const original = { log: console.log, debug: console.debug, info: console.info, warn: console.warn, error: console.error };
  Object.assign(console, { log: (...args: unknown[]) => output.push(args), debug: (...args: unknown[]) => output.push(args), info: (...args: unknown[]) => output.push(args), warn: (...args: unknown[]) => output.push(args), error: (...args: unknown[]) => output.push(args) });
  try {
    silentBaileysLogger.trace({ secret: "do-not-log" });
    silentBaileysLogger.debug({ secret: "do-not-log" });
    silentBaileysLogger.info({ secret: "do-not-log" });
    silentBaileysLogger.warn({ secret: "do-not-log" });
    silentBaileysLogger.error({ secret: "do-not-log" });
    silentBaileysLogger.fatal({ secret: "do-not-log" });
    silentBaileysLogger.child({ secret: "do-not-log" }).info({ secret: "do-not-log" });
  } finally { Object.assign(console, original); }
  expect(output).toEqual([]);
});

test("pairing QR tokens are atomically private, replaceable, and removable", async () => {
  const authPath = await mkdtemp(`${tmpdir()}/bill-ledger-auth-`);
  const store = new PairingQrTokenStore(authPath);
  await store.set("first-secret-qr");
  const tokenPath = pairingQrPath(authPath);
  expect(await readFile(tokenPath, "utf8")).toBe("first-secret-qr");
  expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
  await store.set("replacement-secret-qr");
  expect(await readFile(tokenPath, "utf8")).toBe("replacement-secret-qr");
  await store.clear();
  await expect(stat(tokenPath)).rejects.toThrow();
});

test("pairing QR rendering refuses unsafe files and passes tokens only to the renderer", async () => {
  const rendered: string[] = [];
  await expect(renderStoredPairingQr("/auth", { stat: async () => ({ isFile: () => true, mode: 0o644 }), readFile: async () => "secret-qr", render: (token) => rendered.push(token) })).rejects.toThrow("unsafe permissions");
  await renderStoredPairingQr("/auth", { stat: async () => ({ isFile: () => true, mode: 0o600 }), readFile: async () => "secret-qr", render: (token) => rendered.push(token) });
  expect(rendered).toEqual(["secret-qr"]);
});

test("stop during authentication prevents a post-stop socket from being created", async () => {
  let resolveAuth: ((value: { state: unknown; saveCreds: () => Promise<void> }) => void) | undefined;
  let sockets = 0;
  const dependencies: BaileysDependencies = {
    loadAuth: () => new Promise((resolve) => { resolveAuth = resolve; }),
    createSocket: () => { sockets += 1; return { ev: { on() {} }, end() {} }; },
  };
  const transport = new BaileysTransport("/auth", logger, 1, dependencies);
  const startup = transport.start(async () => undefined);
  const stopping = transport.stop();
  resolveAuth?.({ state: {}, saveCreds: async () => undefined });
  await Promise.all([startup, stopping]);
  expect(sockets).toBe(0);
});

test("overlapping starts during delayed authentication produce one active receiving socket", async () => {
  let resolveAuth: ((value: { state: unknown; saveCreds: () => Promise<void> }) => void) | undefined;
  let sockets = 0;
  let received = 0;
  const listeners = new Map<string, ((event: any) => void)>();
  const dependencies: BaileysDependencies = {
    loadAuth: () => new Promise((resolve) => { resolveAuth = resolve; }),
    createSocket: () => {
      sockets += 1;
      return { ev: { on: (event, listener) => listeners.set(event, listener) }, end() {} };
    },
  };
  const transport = new BaileysTransport("/auth", logger, 1, dependencies);
  const first = transport.start(async () => { received += 1; });
  const second = transport.start(async () => { received += 1; });
  resolveAuth?.({ state: {}, saveCreds: async () => undefined });
  await Promise.all([first, second]);
  listeners.get("messages.upsert")?.({ type: "notify", messages: [{ key: { id: "message", remoteJid: "group" }, messageTimestamp: 1, message: { imageMessage: { mimetype: "image/png" } } }] });
  await Bun.sleep(0);
  expect(sockets).toBe(1);
  expect(received).toBe(1);
  await transport.stop();
});

test("connection updates persist pairing QR without logging it and remove it when opened or stopped", async () => {
  const authPath = await mkdtemp(`${tmpdir()}/bill-ledger-auth-`);
  const listeners = new Map<string, ((event: any) => void)>();
  const lines: string[] = [];
  let config: any;
  const dependencies: BaileysDependencies = {
    loadAuth: async () => ({ state: {}, saveCreds: async () => undefined }),
    createSocket: (input) => { config = input; return { ev: { on: (event, listener) => listeners.set(event, listener) }, end() {} }; },
  };
  const transport = new BaileysTransport(authPath, { ...logger, info: (message, fields) => lines.push(JSON.stringify({ message, fields })) }, 60_000, dependencies);
  await transport.start(async () => undefined);
  expect(config.logger).toBe(silentBaileysLogger);
  expect(config.shouldSyncHistoryMessage).toBeUndefined();
  listeners.get("connection.update")?.({ qr: "do-not-log-qr" });
  await Bun.sleep(5);
  expect(await readFile(pairingQrPath(authPath), "utf8")).toBe("do-not-log-qr");
  expect(lines.join("\n")).toContain("whatsapp_pairing_qr_ready");
  expect(lines.join("\n")).not.toContain("do-not-log-qr");
  listeners.get("connection.update")?.({ connection: "open" });
  await Bun.sleep(5);
  await expect(stat(pairingQrPath(authPath))).rejects.toThrow();
  listeners.get("connection.update")?.({ qr: "stop-secret-qr" });
  await Bun.sleep(5);
  await transport.stop();
  await expect(stat(pairingQrPath(authPath))).rejects.toThrow();
  listeners.get("connection.update")?.({ qr: "stale-secret-qr" });
  await Bun.sleep(5);
  await expect(stat(pairingQrPath(authPath))).rejects.toThrow();
});

test("admin operations render a pairing QR without exposing its token and discover groups only when connected", async () => {
  const authPath = await mkdtemp(`${tmpdir()}/bill-ledger-auth-`);
  const listeners = new Map<string, ((event: any) => void)>();
  const transport = new BaileysTransport(authPath, logger, 60_000, {
    loadAuth: async () => ({ state: {}, saveCreds: async () => undefined }),
    createSocket: () => ({ ev: { on: (event, listener) => listeners.set(event, listener) }, end() {}, groupFetchAllParticipating: async () => ({ "group-1@g.us": { id: "group-1@g.us", subject: "Receipts" } }) }),
  });
  await transport.start(async () => undefined);
  expect(transport.status()).toEqual({ state: "connecting", canPair: true });
  expect(await transport.groups()).toEqual({ available: false, groups: [] });
  listeners.get("connection.update")?.({ qr: "secret-pairing-token" });
  expect(transport.status()).toEqual({ state: "connecting", canPair: true });
  expect(await transport.pairingQr()).toBeNull();
  await Bun.sleep(5);
  expect(transport.status()).toEqual({ state: "awaiting_pairing", canPair: true });
  const qr = await transport.pairingQr();
  expect(qr?.contentType).toBe("image/svg+xml");
  expect(new TextDecoder().decode(qr?.body)).not.toContain("secret-pairing-token");
  listeners.get("connection.update")?.({ connection: "open" });
  expect(await transport.groups()).toEqual({ available: true, groups: [{ id: "group-1@g.us", subject: "Receipts" }] });
  await transport.stop();
});

test("cancelling pairing clears the QR, then Pair now restarts without logging out or exposing a stale QR", async () => {
  const authPath = await mkdtemp(`${tmpdir()}/bill-ledger-auth-`);
  const listeners = new Map<string, ((event: any) => void)>();
  let created = 0;
  const transport = new BaileysTransport(authPath, logger, 60_000, {
    loadAuth: async () => ({ state: {}, saveCreds: async () => undefined }),
    createSocket: () => {
      created += 1;
      return { ev: { on: (event, listener) => listeners.set(`${created}:${event}`, listener) }, end() {} };
    },
  });
  await transport.start(async () => undefined);
  listeners.get("1:connection.update")?.({ qr: "cancel-secret" });
  await Bun.sleep(5);
  await transport.cancelPairing();
  expect(transport.status()).toEqual({ state: "unavailable", canPair: true });
  expect(await transport.pairingQr()).toBeNull();
  await transport.startPairing();
  expect(created).toBe(2);
  expect(transport.status()).toEqual({ state: "connecting", canPair: true });
  expect(await transport.pairingQr()).toBeNull();
  await transport.stop();
});

test("connection failures log a generic code without secret-bearing exception text", async () => {
  const lines: string[] = [];
  const secretLogger: Logger = { ...logger, warn: (message, fields) => lines.push(JSON.stringify({ message, fields })) };
  const dependencies: BaileysDependencies = {
    loadAuth: async () => { throw new Error("credential=do-not-log"); },
    createSocket: () => ({ ev: { on() {} }, end() {} }),
  };
  const transport = new BaileysTransport("/auth", secretLogger, 60_000, dependencies);
  await transport.start(async () => undefined);
  await transport.stop();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("whatsapp_connection_setup_failed");
  expect(lines[0]).not.toContain("do-not-log");
});

test("repeated close events schedule one replacement and release the old socket", async () => {
  const listeners = new Map<string, ((event: any) => void)>();
  let created = 0;
  let ended = 0;
  let removed = 0;
  const dependencies: BaileysDependencies = {
    loadAuth: async () => ({ state: {}, saveCreds: async () => undefined }),
    createSocket: () => {
      created += 1;
      return { ev: { on: (event, listener) => listeners.set(`${created}:${event}`, listener), off: () => { removed += 1; } }, end: () => { ended += 1; } };
    },
  };
  const transport = new BaileysTransport("/auth", logger, 1, dependencies);
  await transport.start(async () => undefined);
  listeners.get("1:connection.update")?.({ connection: "close" });
  listeners.get("1:connection.update")?.({ connection: "close" });
  await Bun.sleep(10);
  expect(created).toBe(2);
  expect(ended).toBe(1);
  expect(removed).toBe(3);
  await transport.stop();
});

test("wrapped media normalizes ephemeral, view-once, and document-with-caption messages", () => {
  const wrapped = (content: object) => normalize({ key: { id: "id", remoteJid: "group", participant: "sender" }, messageTimestamp: 1, message: content } as never);
  expect(wrapped({ ephemeralMessage: { message: { imageMessage: { mimetype: "image/png", caption: "ephemeral" } } } }).attachments?.[0]).toMatchObject({ kind: "image", mimeType: "image/png", caption: "ephemeral" });
  expect(wrapped({ viewOnceMessageV2: { message: { imageMessage: { mimetype: "image/jpeg", caption: "once" } } } }).attachments?.[0]).toMatchObject({ kind: "image", mimeType: "image/jpeg", caption: "once" });
  expect(wrapped({ documentWithCaptionMessage: { message: { documentMessage: { mimetype: "application/pdf", fileName: "bill.pdf", caption: "document" } } } }).attachments?.[0]).toMatchObject({ kind: "document", mimeType: "application/pdf", filename: "bill.pdf", caption: "document" });
  expect(wrapped({ documentWithCaptionMessage: { message: { documentMessage: { mimetype: "ImAgE/WeBp", fileName: "handwritten.webp", caption: "uncompressed" } } } }).attachments?.[0]).toMatchObject({ kind: "document", mimeType: "ImAgE/WeBp", filename: "handwritten.webp", caption: "uncompressed" });
  expect(wrapped({ viewOnceMessageV2: { message: { documentMessage: { mimetype: "text/plain" } } } }).attachments).toEqual([]);
});

test("normalizes JPEG, PNG, and WebP documents but rejects unsupported document media", () => {
  const document = (mimetype: string) => normalize({ key: { id: "id", remoteJid: "group", participant: "sender" }, messageTimestamp: 1, message: { documentMessage: { mimetype, fileName: "handwritten.bill", caption: "bill" } } } as never);
  for (const mimetype of ["image/jpeg", "image/png", "image/webp"]) {
    expect(document(mimetype).attachments?.[0]).toMatchObject({ kind: "document", mimeType: mimetype, filename: "handwritten.bill", caption: "bill" });
  }
  expect(document("image/gif").attachments).toEqual([]);
  expect(document("image/*").attachments).toEqual([]);
  expect(document("application/msword").attachments).toEqual([]);
  expect(document("__proto__").attachments).toEqual([]);
  expect(document("constructor").attachments).toEqual([]);
  expect(normalize({ key: { id: "id", remoteJid: "group" }, messageTimestamp: 1, message: { imageMessage: { mimetype: "image/gif" } } } as never).attachments).toEqual([]);
});

test("credential persistence rejection is handled with a generic secret-safe warning", async () => {
  const listeners = new Map<string, ((event: any) => void)>();
  const lines: string[] = [];
  const secretLogger: Logger = { ...logger, warn: (message, fields) => lines.push(JSON.stringify({ message, fields })) };
  const dependencies: BaileysDependencies = {
    loadAuth: async () => ({ state: {}, saveCreds: async () => { throw new Error("save-token=do-not-log"); } }),
    createSocket: () => ({ ev: { on: (event, listener) => listeners.set(event, listener) }, end() {} }),
  };
  const transport = new BaileysTransport("/auth", secretLogger, 60_000, dependencies);
  await transport.start(async () => undefined);
  listeners.get("creds.update")?.({});
  await Bun.sleep(0);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("whatsapp_credentials_save_failed");
  expect(lines[0]).not.toContain("do-not-log");
  await transport.stop();
});
