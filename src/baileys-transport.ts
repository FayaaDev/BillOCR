import { DisconnectReason, downloadMediaMessage, makeWASocket, normalizeMessageContent, useMultiFileAuthState, type WAMessage } from "baileys";
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import type { Logger } from "./logger";
import { isSupportedDocumentMimeType, isSupportedImageMimeType } from "./attachment-mime";
import type { IncomingWhatsAppMessage } from "./whatsapp-ingestion";
import { PairingQrTokenStore, renderStoredPairingQr } from "./whatsapp-pairing";

export interface WhatsAppTransport { start(onMessage: (message: IncomingWhatsAppMessage) => Promise<void>): Promise<void>; stop(): Promise<void>; }
export type WhatsAppConnectionState = "unavailable" | "connecting" | "awaiting_pairing" | "connected";
export interface WhatsAppConnectionStatus { state: WhatsAppConnectionState; canPair: boolean; }
export interface RenderedWhatsAppQr { body: Uint8Array; contentType: "image/svg+xml"; }
export interface WhatsAppGroup { id: string; subject: string; }
export interface WhatsAppGroupDiscovery { available: boolean; groups: readonly WhatsAppGroup[]; }
/** Narrow capability intended for an authenticated HTTP adapter; it never exposes the socket or a QR token. */
export interface WhatsAppAdminOperations { status(): WhatsAppConnectionStatus; pairingQr(): Promise<RenderedWhatsAppQr | null>; groups(): Promise<WhatsAppGroupDiscovery>; startPairing(): Promise<void>; cancelPairing(): Promise<void>; }
export interface WhatsAppAdminTransport extends WhatsAppTransport, WhatsAppAdminOperations {}
type Socket = { ev: { on(event: string, listener: (...args: any[]) => void): void; off?(event: string, listener: (...args: any[]) => void): void }; end(error?: Error): void; groupFetchAllParticipating?(): Promise<Record<string, { id?: string; subject?: string }>> };
type Auth = { state: unknown; saveCreds: () => Promise<void> };
export interface SilentPinoLogger { level: string; child(bindings: Record<string, unknown>): SilentPinoLogger; trace(object: unknown, message?: string): void; debug(object: unknown, message?: string): void; info(object: unknown, message?: string): void; warn(object: unknown, message?: string): void; error(object: unknown, message?: string): void; fatal(object: unknown, message?: string): void; }
const noop = (): void => undefined;
export const silentBaileysLogger: SilentPinoLogger = { level: "silent", child: () => silentBaileysLogger, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
export interface BaileysDependencies { loadAuth(path: string): Promise<Auth>; createSocket(config: { auth: unknown; markOnlineOnConnect: boolean; logger: SilentPinoLogger }): Socket; }

const productionDependencies: BaileysDependencies = {
  loadAuth: useMultiFileAuthState,
  createSocket: (config) => makeWASocket(config as Parameters<typeof makeWASocket>[0]),
};

const require = createRequire(import.meta.url);
type QrCode = { addData(value: string): void; make(): void; getModuleCount(): number; isDark(row: number, column: number): boolean; };
type QrCodeConstructor = new (typeNumber: number, errorCorrectionLevel: number) => QrCode;
const QRCode = require("qrcode-terminal/vendor/QRCode") as QrCodeConstructor;
const errorCorrection = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel") as { L: number };

function renderQrSvg(token: string): RenderedWhatsAppQr {
  const qr = new QRCode(-1, errorCorrection.L);
  qr.addData(token);
  qr.make();
  const size = qr.getModuleCount();
  const cells: string[] = [];
  for (let row = 0; row < size; row += 1) for (let column = 0; column < size; column += 1) if (qr.isDark(row, column)) cells.push(`<rect x="${column}" y="${row}" width="1" height="1"/>`);
  return { contentType: "image/svg+xml", body: new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 ${size + 8} ${size + 8}" shape-rendering="crispEdges"><rect x="-4" y="-4" width="${size + 8}" height="${size + 8}" fill="#fff"/><g fill="#000">${cells.join("")}</g></svg>`) };
}

export class BaileysTransport implements WhatsAppAdminTransport {
  private socket: Socket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private generation = 0;
  private startup: Promise<void> | undefined;
  private connecting: Promise<void> | undefined;
  private removeSocketListeners: (() => void) | undefined;
  private readonly pairingQrStore: PairingQrTokenStore;
  private onMessage: ((message: IncomingWhatsAppMessage) => Promise<void>) | undefined;
  private connectionState: WhatsAppConnectionState = "unavailable";
  private unpairing: Promise<void> | undefined;

  constructor(private readonly authPath: string, private readonly logger: Logger, private readonly reconnectDelayMs = 2_000, private readonly dependencies: BaileysDependencies = productionDependencies) { this.pairingQrStore = new PairingQrTokenStore(authPath); }

  async start(onMessage: (message: IncomingWhatsAppMessage) => Promise<void>): Promise<void> {
    if (!this.stopped && (this.connecting || this.socket || this.reconnectTimer)) {
      await this.startup;
      return;
    }
    this.onMessage = onMessage;
    this.stopped = false;
    this.connectionState = "connecting";
    const generation = ++this.generation;
    this.startup = this.beginConnect(generation, onMessage);
    await this.startup;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.socket) this.release(this.socket);
    await this.startup;
    await this.pairingQrStore.clear();
    this.connectionState = "unavailable";
  }

  status(): WhatsAppConnectionStatus { return { state: this.connectionState, canPair: true }; }
  async pairingQr(): Promise<RenderedWhatsAppQr | null> {
    if (this.connectionState !== "awaiting_pairing") return null;
    try { return await renderStoredPairingQr(this.authPath, { stat, readFile, render: renderQrSvg }); } catch { return null; }
  }
  async groups(): Promise<WhatsAppGroupDiscovery> {
    if (this.connectionState !== "connected" || !this.socket?.groupFetchAllParticipating) return { available: false, groups: [] };
    try {
      const groups = await this.socket.groupFetchAllParticipating();
      return { available: true, groups: Object.entries(groups).map(([id, group]) => ({ id: group.id ?? id, subject: group.subject ?? "" })).sort((left, right) => left.id.localeCompare(right.id)) };
    } catch {
      this.logger.warn("WhatsApp group discovery failed", { code: "whatsapp_group_discovery_failed" });
      return { available: false, groups: [] };
    }
  }
  async startPairing(): Promise<void> {
    if (this.connectionState !== "unavailable" || !this.onMessage) throw new Error("WhatsApp pairing cannot be started");
    await this.start(this.onMessage);
  }
  async cancelPairing(): Promise<void> {
    if (this.unpairing) return this.unpairing;
    if (this.connectionState !== "awaiting_pairing") throw new Error("WhatsApp pairing is not active");
    const handler = this.onMessage;
    const socket = this.socket;
    if (this.stopped || !handler || !socket) throw new Error("WhatsApp admin operation unavailable");
    this.unpairing = (async () => {
      await this.stop();
    })().finally(() => { this.unpairing = undefined; });
    return this.unpairing;
  }

  private active(generation: number): boolean { return !this.stopped && generation === this.generation; }
  private beginConnect(generation: number, onMessage: (message: IncomingWhatsAppMessage) => Promise<void>): Promise<void> {
    if (this.connecting) return this.connecting;
    const connecting = this.connect(generation, onMessage);
    this.connecting = connecting;
    void connecting.finally(() => { if (this.connecting === connecting) this.connecting = undefined; });
    return connecting;
  }
  private scheduleReconnect(generation: number, onMessage: (message: IncomingWhatsAppMessage) => Promise<void>): void {
    if (!this.active(generation) || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.active(generation)) this.startup = this.beginConnect(generation, onMessage);
    }, this.reconnectDelayMs);
  }
  private release(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.removeSocketListeners?.();
    this.removeSocketListeners = undefined;
    socket.end(undefined);
  }
  private async connect(generation: number, onMessage: (message: IncomingWhatsAppMessage) => Promise<void>): Promise<void> {
    if (!this.active(generation)) return;
    try {
      const { state, saveCreds } = await this.dependencies.loadAuth(this.authPath);
      if (!this.active(generation)) return;
      const socket = this.dependencies.createSocket({ auth: state, markOnlineOnConnect: false, logger: silentBaileysLogger });
      if (!this.active(generation)) { socket.end(undefined); return; }
      if (this.socket) this.release(this.socket);
      this.socket = socket;
      const onCreds = () => { void saveCreds().catch(() => this.logger.warn("WhatsApp credentials could not be saved", { code: "whatsapp_credentials_save_failed" })); };
      const onMessages = (event: { messages: WAMessage[]; type: string }) => {
        if (!this.active(generation) || this.socket !== socket || event.type !== "notify") return;
        for (const message of event.messages) void onMessage(normalize(message)).catch(() => this.logger.warn("WhatsApp message handling failed", { code: "whatsapp_message_handling_failed" }));
      };
      const onConnection = (update: { connection?: string; qr?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } } }) => {
        if (!this.active(generation) || this.socket !== socket) return;
        if (update.qr) void this.pairingQrStore.set(update.qr).then((saved) => {
          if (!saved || !this.active(generation) || this.socket !== socket || this.connectionState === "connected") return;
          this.connectionState = "awaiting_pairing";
          this.logger.info("WhatsApp pairing QR ready", { code: "whatsapp_pairing_qr_ready" });
        }).catch(() => this.logger.warn("WhatsApp pairing QR could not be saved", { code: "whatsapp_pairing_qr_save_failed" }));
        if (update.connection === "open") { this.connectionState = "connected"; void this.pairingQrStore.clear(); this.logger.info("WhatsApp connection opened"); }
        if (update.connection !== "close" || !this.active(generation) || this.socket !== socket) return;
        void this.pairingQrStore.clear();
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) { this.release(socket); this.connectionState = "unavailable"; this.logger.error("WhatsApp account logged out; reconnect disabled until credentials are restored"); return; }
        this.release(socket);
        this.connectionState = "connecting";
        this.logger.warn("WhatsApp connection closed; scheduling reconnect", { code: "whatsapp_connection_closed", statusCode });
        this.scheduleReconnect(generation, onMessage);
      };
      socket.ev.on("creds.update", onCreds);
      socket.ev.on("messages.upsert", onMessages);
      socket.ev.on("connection.update", onConnection);
      this.removeSocketListeners = () => {
        socket.ev.off?.("creds.update", onCreds);
        socket.ev.off?.("messages.upsert", onMessages);
        socket.ev.off?.("connection.update", onConnection);
      };
    } catch {
      if (!this.active(generation)) return;
      this.logger.warn("WhatsApp connection setup failed; scheduling reconnect", { code: "whatsapp_connection_setup_failed" });
      this.scheduleReconnect(generation, onMessage);
    }
  }
}

export function normalize(message: WAMessage): IncomingWhatsAppMessage {
  const content = normalizeMessageContent(message.message);
  const image = content?.imageMessage;
  const document = content?.documentMessage;
  const media = image ?? document;
  const accepted = Boolean(media && (image ? isSupportedImageMimeType(media.mimetype) : isSupportedDocumentMimeType(media.mimetype)));
  return { id: message.key.id, groupId: message.key.remoteJid, senderId: message.key.participant ?? message.key.remoteJid, timestamp: Number(message.messageTimestamp ?? 0), caption: image?.caption ?? document?.caption ?? null, attachments: media && accepted ? [{ kind: image ? "image" : "document", mimeType: media.mimetype, filename: document?.fileName ?? null, caption: image?.caption ?? document?.caption ?? null, download: async () => downloadMediaMessage(message, "stream", {}) as Promise<AsyncIterable<Uint8Array>> }] : [] };
}
