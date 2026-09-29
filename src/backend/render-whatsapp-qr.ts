import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import qr from "qrcode-terminal";
import { renderStoredPairingQr } from "./whatsapp-pairing";

const authPath = process.env.WHATSAPP_AUTH_PATH;
if (!authPath) {
  console.error("WHATSAPP_AUTH_PATH is required");
  process.exitCode = 1;
} else {
  try {
    await renderStoredPairingQr(resolve(authPath), { stat, readFile, render: (token) => qr.generate(token, { small: true }) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to render WhatsApp pairing QR");
    process.exitCode = 1;
  }
}
