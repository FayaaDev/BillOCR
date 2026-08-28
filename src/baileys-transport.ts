import { DisconnectReason, downloadMediaMessage, makeWASocket, normalizeMessageContent, useMultiFileAuthState, type WAMessage } from "baileys";
import type { Logger } from "./logger";
import type { IncomingWhatsAppMessage } from "./whatsapp-ingestion";
import { PairingQrTokenStore } from "./whatsapp-pairing";

export interface WhatsAppTransport { start(onMessage: (message: IncomingWhatsAppMessage) => Promise<void>): Promise<void>; stop(): Promise<void>; }
type Socket = { ev: { on(event: string, listener: (...args: any[]) => void): void; off?(event: string, listener: (...args: any[]) => void): void }; end(error?: Error): void };
type Auth = { state: unknown; saveCreds: () => Promise<void> };
export interface SilentPinoLogger { level: string; child(bindings: Record<string, unknown>): SilentPinoLogger; trace(object: unknown, message?: string): void; debug(object: unknown, message?: string): void; info(object: unknown, message?: string): void; warn(object: unknown, message?: string): void; error(object: unknown, message?: string): void; fatal(object: unknown, message?: string): void; }
const noop = (): void => undefined;
export const silentBaileysLogger: SilentPinoLogger = { level: "silent", child: () => silentBaileysLogger, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
export interface BaileysDependencies { loadAuth(path: string): Promise<Auth>; createSocket(config: { auth: unknown; markOnlineOnConnect: boolean; logger: SilentPinoLogger }): Socket; }

const productionDependencies: BaileysDependencies = {
  loadAuth: useMultiFileAuthState,
  createSocket: (config) => makeWASocket(config as Parameters<typeof makeWASocket>[0]),
};

export class BaileysTransport implements WhatsAppTransport {
  private socket: Socket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private generation = 0;
  private startup: Promise<void> | undefined;
  private connecting: Promise<void> | undefined;
  private removeSocketListeners: (() => void) | undefined;
  private readonly pairingQr: PairingQrTokenStore;

  constructor(private readonly authPath: string, private readonly logger: Logger, private readonly reconnectDelayMs = 2_000, private readonly dependencies: BaileysDependencies = productionDependencies) { this.pairingQr = new PairingQrTokenStore(authPath); }

  async start(onMessage: (message: IncomingWhatsAppMessage) => Promise<void>): Promise<void> {
    if (!this.stopped && (this.connecting || this.socket || this.reconnectTimer)) {
      await this.startup;
      return;
    }
    this.stopped = false;
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
    await this.pairingQr.clear();
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
        if (update.qr) void this.pairingQr.set(update.qr).then((saved) => { if (saved && this.active(generation) && this.socket === socket) this.logger.info("WhatsApp pairing QR ready", { code: "whatsapp_pairing_qr_ready" }); }).catch(() => this.logger.warn("WhatsApp pairing QR could not be saved", { code: "whatsapp_pairing_qr_save_failed" }));
        if (update.connection === "open") { void this.pairingQr.clear(); this.logger.info("WhatsApp connection opened"); }
        if (update.connection !== "close" || !this.active(generation) || this.socket !== socket) return;
        void this.pairingQr.clear();
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) { this.logger.error("WhatsApp account logged out; reconnect disabled until credentials are restored"); return; }
        this.release(socket);
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
  const accepted = Boolean(image?.mimetype?.toLowerCase().startsWith("image/") || document?.mimetype?.toLowerCase() === "application/pdf");
  return { id: message.key.id, groupId: message.key.remoteJid, senderId: message.key.participant ?? message.key.remoteJid, timestamp: Number(message.messageTimestamp ?? 0), caption: image?.caption ?? document?.caption ?? null, attachments: media && accepted ? [{ kind: image ? "image" : "document", mimeType: media.mimetype, filename: document?.fileName ?? null, caption: image?.caption ?? document?.caption ?? null, download: async () => downloadMediaMessage(message, "stream", {}) as Promise<AsyncIterable<Uint8Array>> }] : [] };
}
