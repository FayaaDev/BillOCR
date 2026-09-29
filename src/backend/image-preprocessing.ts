export const IMAGE_PREPROCESSING_VERSION = "sharp-opencv-v1";
export const MAX_DECODED_PIXELS = 8_000_000;
export const ANALYSIS_MAX_EDGE = 600;
export const WORKING_MAX_EDGE = 1_800;
export const OUTPUT_MAX_EDGE = 1_800;
export const OUTPUT_TARGET_LONG_EDGE = 1_800;
export const MAX_DERIVATIVE_BYTES = 20 * 1024 * 1024;

function pngCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type ImagePreprocessingMode = "original" | "sharp" | "opencv";
export type ImagePreprocessingRequestMode = "auto" | "sharp" | "opencv";

export type PreprocessedImage = {
  bytes: Uint8Array;
  mimeType: "image/png";
  mode: ImagePreprocessingMode;
  width: number;
  height: number;
};

export interface ImagePreprocessor {
  preprocess(input: { bytes: Uint8Array; mimeType: string; mode?: ImagePreprocessingRequestMode }): Promise<PreprocessedImage | null>;
}

export function isPreprocessableMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase() === "image/jpeg" || mimeType.toLowerCase() === "image/png" || mimeType.toLowerCase() === "image/webp";
}

export class WorkerImagePreprocessor implements ImagePreprocessor {
  constructor(private readonly options: {
    timeoutMs: number;
    workerFactory?: () => Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;
  }) {}

  async preprocess(input: { bytes: Uint8Array; mimeType: string; mode?: ImagePreprocessingRequestMode }): Promise<PreprocessedImage | null> {
    if (!input || typeof input !== "object" || !(input.bytes instanceof Uint8Array) || typeof input.mimeType !== "string") return null;
    if (!isPreprocessableMimeType(input.mimeType)) return null;

    const workerFactory = this.options.workerFactory ?? (() => {
      const workerName = import.meta.path.endsWith(".ts") ? "image-preprocessing-worker.ts" : "image-preprocessing-worker.js";
      return new Worker(new URL(workerName, import.meta.url).href);
    });
    let worker: Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror"> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const createdWorker = workerFactory();
      worker = createdWorker;
      const bytes = new Uint8Array(input.bytes);
      return await new Promise<PreprocessedImage | null>((resolve) => {
        timeout = setTimeout(() => resolve(null), this.options.timeoutMs);
        createdWorker.onmessage = (event) => {
          const response: unknown = event.data;
          if (!this.isValidResponse(response)) return resolve(null);
          resolve({ bytes: new Uint8Array(response.bytes), mimeType: "image/png", mode: response.mode, width: response.width, height: response.height });
        };
        createdWorker.onerror = () => resolve(null);
        try {
          createdWorker.postMessage({ bytes: bytes.buffer, mimeType: input.mimeType, mode: input.mode ?? "auto" }, [bytes.buffer]);
        } catch {
          resolve(null);
        }
      });
    } catch {
      return null;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
      }
    }
  }

  private isValidResponse(response: unknown): response is { ok: true; bytes: ArrayBuffer; mode: "sharp" | "opencv"; width: number; height: number } {
    try {
      if (!response || typeof response !== "object") return false;
      const value = response as Record<string, unknown>;
      if (!(value.bytes instanceof ArrayBuffer)) return false;
      const bytes = new Uint8Array(value.bytes);
      const width = bytes[16]! * 2 ** 24 + bytes[17]! * 2 ** 16 + bytes[18]! * 2 ** 8 + bytes[19]!;
      const height = bytes[20]! * 2 ** 24 + bytes[21]! * 2 ** 16 + bytes[22]! * 2 ** 8 + bytes[23]!;
      const bitDepth = bytes[24];
      const colorType = bytes[25];
      const expectedCrc = bytes[29]! * 2 ** 24 + bytes[30]! * 2 ** 16 + bytes[31]! * 2 ** 8 + bytes[32]!;
      const validBitDepth = (colorType === 0 && (bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8 || bitDepth === 16))
        || ((colorType === 2 || colorType === 4 || colorType === 6) && (bitDepth === 8 || bitDepth === 16))
        || (colorType === 3 && (bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8));
      return value.ok === true
        && bytes.byteLength <= MAX_DERIVATIVE_BYTES
        && bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10
        && bytes.length >= 33 && bytes[8] === 0 && bytes[9] === 0 && bytes[10] === 0 && bytes[11] === 13 && bytes[12] === 73 && bytes[13] === 72 && bytes[14] === 68 && bytes[15] === 82
        && Number.isSafeInteger(width) && width > 0 && width <= OUTPUT_MAX_EDGE
        && Number.isSafeInteger(height) && height > 0 && height <= OUTPUT_MAX_EDGE
        && validBitDepth && bytes[26] === 0 && bytes[27] === 0 && (bytes[28] === 0 || bytes[28] === 1) && expectedCrc === pngCrc(bytes, 12, 29)
        && (value.mode === "sharp" || value.mode === "opencv")
        && typeof value.width === "number" && Number.isSafeInteger(value.width) && value.width > 0 && value.width <= OUTPUT_MAX_EDGE && value.width === width
        && typeof value.height === "number" && Number.isSafeInteger(value.height) && value.height > 0 && value.height <= OUTPUT_MAX_EDGE && value.height === height;
    } catch {
      return false;
    }
  }
}
