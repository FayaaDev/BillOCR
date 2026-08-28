import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const pairingQrFilename = "pairing-qr.token";
export function pairingQrPath(authPath: string): string { return join(authPath, pairingQrFilename); }

export class PairingQrTokenStore {
  private desired: string | undefined;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly authPath: string) {}

  set(token: string): Promise<boolean> {
    this.desired = token;
    return this.enqueue(async () => {
      if (this.desired !== token) return false;
      await mkdir(this.authPath, { recursive: true, mode: 0o700 });
      const target = pairingQrPath(this.authPath);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, token, { mode: 0o600, flag: "wx" });
        await rename(temporary, target);
      } finally { await rm(temporary, { force: true }); }
      return this.desired === token;
    });
  }

  clear(): Promise<void> {
    this.desired = undefined;
    return this.enqueue(async () => { await rm(pairingQrPath(this.authPath), { force: true }); });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface PairingQrRenderDependencies {
  stat(path: string): Promise<{ mode: number; isFile(): boolean }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  render(token: string): void;
}

export async function renderStoredPairingQr(authPath: string, dependencies: PairingQrRenderDependencies = { stat, readFile, render: () => undefined }): Promise<void> {
  const path = pairingQrPath(authPath);
  const details = await dependencies.stat(path);
  if (!details.isFile() || (details.mode & 0o077) !== 0) throw new Error("WhatsApp pairing QR token has unsafe permissions");
  const token = await dependencies.readFile(path, "utf8");
  if (!token) throw new Error("No WhatsApp pairing QR is available");
  dependencies.render(token);
}
