import { createHash } from "node:crypto";
import { fstat, read } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { closeOriginalFd, openOriginalChild, openOriginalRoot, type BeforeOpenRootComponent } from "./original-fd";

export class OriginalVerificationError extends Error {}
function magicMatches(bytes: Uint8Array, mime: string): boolean {
  const at = (...v: number[]) => v.every((item, index) => bytes[index] === item);
  return mime === "application/pdf" ? at(37, 80, 68, 70, 45) : mime === "image/png" ? at(137, 80, 78, 71, 13, 10, 26, 10) : mime === "image/jpeg" ? at(255, 216, 255) : mime === "image/webp" ? new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP" : false;
}
function statFd(fd: number): Promise<import("node:fs").Stats> {
  return new Promise((resolve, reject) => fstat(fd, (error, stats) => error ? reject(error) : resolve(stats)));
}
function readFd(fd: number, size: number): Promise<Uint8Array> {
  const buffer = Buffer.allocUnsafe(size);
  return new Promise((resolve, reject) => {
    let offset = 0;
    const next = (): void => read(fd, buffer, offset, size - offset, offset, (error, bytesRead) => {
      if (error) { reject(error); return; }
      offset += bytesRead;
      if (bytesRead && offset < size) next(); else resolve(new Uint8Array(buffer.buffer, buffer.byteOffset, offset).slice());
    });
    next();
  });
}

/** Reads one descriptor-relative direct child; callers must use these bytes rather than reopen the path. */
export async function readVerifiedOriginal(input: { path: string; root: string; maxBytes: number; sha256: string; mimeType: string; requireMagic: boolean; beforeOpenRootComponent?: BeforeOpenRootComponent; beforeOpenChild?: () => Promise<void> }): Promise<{ bytes: Uint8Array; magicMatches: boolean }> {
  const rootComponents = input.root.split("/").filter(Boolean); const target = resolve(input.path); const name = basename(target);
  if (input.root.includes("\0") || input.path.includes("\0") || !isAbsolute(input.root) || input.root !== resolve(input.root) || rootComponents.some((component) => component === "." || component === "..") || dirname(target) !== input.root || name === "." || name === "..") throw new OriginalVerificationError("original outside configured root");
  let rootFd = -1; let childFd = -1;
  try {
    rootFd = await openOriginalRoot(rootComponents, input.beforeOpenRootComponent);
    if (rootFd < 0) throw new OriginalVerificationError("original unavailable");
    await input.beforeOpenChild?.();
    childFd = openOriginalChild(rootFd, name);
    if (childFd < 0) throw new OriginalVerificationError("original unavailable");
    const stat = await statFd(childFd); if (!stat.isFile() || stat.size < 0 || stat.size > input.maxBytes) throw new OriginalVerificationError("original unavailable");
    const bytes = await readFd(childFd, stat.size);
    if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) throw new OriginalVerificationError("original hash mismatch");
    const matches = magicMatches(bytes, input.mimeType); if (input.requireMagic && !matches) throw new OriginalVerificationError("original MIME mismatch");
    return { bytes, magicMatches: matches };
  } catch (error) {
    if (error instanceof OriginalVerificationError) throw error;
    throw new OriginalVerificationError("original unavailable");
  } finally { closeOriginalFd(childFd); closeOriginalFd(rootFd); }
}
