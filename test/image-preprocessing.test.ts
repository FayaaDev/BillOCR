import { afterAll, describe, expect, jest, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { WorkerImagePreprocessor } from "../src/backend/image-preprocessing";
import { preprocessImage } from "../src/backend/image-preprocessing-worker";

const preprocessor = new WorkerImagePreprocessor({ timeoutMs: 10_000 });
jest.setTimeout(60_000);

afterAll(async () => { /* Workers are terminated by the factory after every request. */ });

async function photographedBill(): Promise<Uint8Array> {
  const page = `<svg width="900" height="600" xmlns="http://www.w3.org/2000/svg"><polygon points="180,90 760,130 700,510 145,455" fill="white" stroke="black" stroke-width="8"/><text x="350" y="310" font-size="48">TOTAL 70</text></svg>`;
  return new Uint8Array(await sharp({ create: { width: 900, height: 600, channels: 3, background: "#d8d8d8" } }).composite([{ input: Buffer.from(page) }]).png().toBuffer());
}

async function photographedBillWithColoredInk(): Promise<Uint8Array> {
  const page = `<svg width="900" height="600" xmlns="http://www.w3.org/2000/svg"><polygon points="180,90 760,130 700,510 145,455" fill="white" stroke="black" stroke-width="8"/><path d="M260 250 C330 180 390 330 470 235 S590 325 660 235" fill="none" stroke="#e91e63" stroke-width="18" stroke-linecap="round"/><text x="310" y="390" fill="#0066cc" font-size="58" font-style="italic">paid</text></svg>`;
  return new Uint8Array(await sharp({ create: { width: 900, height: 600, channels: 3, background: "#d8d8d8" } }).composite([{ input: Buffer.from(page) }]).png().toBuffer());
}

function pngSignature(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

const monitorScript = (limitKiB: number, command: string[]) => `const child = Bun.spawn(${JSON.stringify(command)}, { stdout: "ignore", stderr: "ignore" }); let exited = false; let exitCode = 1; void child.exited.then((code) => { exited = true; exitCode = code; }); while (!exited) { const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(child.pid)], { stdout: "pipe", stderr: "ignore" }); const rss = Number.parseInt((await new Response(ps.stdout).text()).trim(), 10); await ps.exited; if (Number.isFinite(rss) && rss > ${limitKiB}) { child.kill(); await child.exited; process.exit(86); } await Bun.sleep(10); } process.exit(exitCode);`;

async function runMemoryLimited(limitKiB: number, script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "-e", monitorScript(limitKiB, [process.execPath, "-e", script])], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

function respondingWorker(response: unknown, onTerminate: () => void): Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror"> {
  const worker: Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror"> = {
    onmessage: null,
    onerror: null,
    postMessage(_message: unknown, _transfer?: Transferable[] | StructuredSerializeOptions) { queueMicrotask(() => worker.onmessage?.call(worker as Worker, new MessageEvent("message", { data: response }))); },
    terminate() { onTerminate(); },
  };
  return worker;
}

describe("WorkerImagePreprocessor", () => {
  test("preprocesses a synthetic photograph without mutating its input", async () => {
    const input = await photographedBill();
    const before = new Uint8Array(input);
    const result = await preprocessor.preprocess({ bytes: input, mimeType: "image/png" });
    expect(input).toEqual(before);
    expect(result).not.toBeNull();
    expect(pngSignature(result!.bytes)).toBe(true);
    expect(result!.width).toBeLessThanOrEqual(1800);
    expect(result!.height).toBeLessThanOrEqual(1800);
    const forced = await preprocessor.preprocess({ bytes: before, mimeType: "image/png", mode: "opencv" });
    expect(forced).not.toBeNull();
    expect(forced!.mode).toBe(result!.mode);
    expect(forced!.bytes).toEqual(result!.bytes);
  });

  test("bypasses PDFs exactly", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45]);
    expect(await preprocessor.preprocess({ bytes, mimeType: "application/pdf" })).toBeNull();
    expect(bytes).toEqual(new Uint8Array([37, 80, 68, 70, 45]));
  });

  test("returns null for a null runtime request", async () => {
    expect(await preprocessor.preprocess(null as unknown as { bytes: Uint8Array; mimeType: string })).toBeNull();
    expect(await preprocessor.preprocess({} as { bytes: Uint8Array; mimeType: string })).toBeNull();
  });

  test("honours EXIF 90-degree orientation", async () => {
    const jpeg = new Uint8Array(await sharp({ create: { width: 80, height: 40, channels: 3, background: "white" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer());
    const result = await preprocessor.preprocess({ bytes: jpeg, mimeType: "image/jpeg", mode: "sharp" });
    expect(result).not.toBeNull();
    expect(result!.height).toBeGreaterThan(result!.width);
  });

  test("falls back to Sharp when OpenCV initialization or rectification fails", async () => {
    const bytes = await photographedBill();
    let cvCalls = 0;
    const loaders = { loadSharp: async () => sharp, loadCv: async () => { cvCalls++; throw new Error("offline CV failure"); } };
    const sharpOnly = await preprocessImage({ bytes: new Uint8Array(bytes).buffer, mimeType: "image/png", mode: "sharp" }, loaders);
    expect(cvCalls).toBe(0);
    expect(sharpOnly.mode).toBe("sharp");
    for (const mode of ["auto", "opencv"] as const) {
      const result = await preprocessImage({ bytes: new Uint8Array(bytes).buffer, mimeType: "image/png", mode }, loaders);
      expect(result.mode).toBe("sharp");
      expect(pngSignature(new Uint8Array(result.bytes))).toBe(true);
    }
    expect(cvCalls).toBe(2);
    const rectificationFailure = await preprocessImage({ bytes: new Uint8Array(bytes).buffer, mimeType: "image/png", mode: "opencv" }, { loadSharp: async () => sharp, loadCv: async () => ({ matFromImageData() { throw new Error("offline rectification failure"); } }) });
    expect(rectificationFailure.mode).toBe("sharp");
    expect(pngSignature(new Uint8Array(rectificationFailure.bytes))).toBe(true);
  });

  test("rectifies the white page to cover most output pixels", async () => {
    const result = await preprocessor.preprocess({ bytes: await photographedBill(), mimeType: "image/png", mode: "opencv" });
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("opencv");
    const { data, info } = await sharp(result!.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let white = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) if (data[offset]! > 200 && data[offset + 1]! > 200 && data[offset + 2]! > 200) white++;
    expect(white / (info.width * info.height)).toBeGreaterThanOrEqual(0.9);
  });

  test("retains chroma from colored handwriting", async () => {
    const result = await preprocessor.preprocess({ bytes: await photographedBillWithColoredInk(), mimeType: "image/png", mode: "sharp" });
    expect(result).not.toBeNull();
    const { data, info } = await sharp(result!.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let chromatic = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      const maximum = Math.max(data[offset]!, data[offset + 1]!, data[offset + 2]!);
      const minimum = Math.min(data[offset]!, data[offset + 1]!, data[offset + 2]!);
      if (maximum - minimum > 45) chromatic++;
    }
    expect(chromatic / (info.width * info.height)).toBeGreaterThan(0.002);
  });

  test("reports the decoded dimensions of an oversized input derivative", async () => {
    const input = new Uint8Array(await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#d8d8d8" } }).png().toBuffer());
    const result = await preprocessor.preprocess({ bytes: input, mimeType: "image/png", mode: "sharp" });
    expect(result).not.toBeNull();
    const metadata = await sharp(result!.bytes).metadata();
    expect(metadata.width).toBe(result!.width);
    expect(metadata.height).toBe(result!.height);
    expect(metadata.width!).toBeLessThanOrEqual(1800);
    expect(metadata.height!).toBeLessThanOrEqual(1800);
  });

  test("returns sharp output for a blank image and null for malformed or oversized input", async () => {
    const blank = new Uint8Array(await sharp({ create: { width: 90, height: 60, channels: 3, background: "#d8d8d8" } }).png().toBuffer());
    expect((await preprocessor.preprocess({ bytes: blank, mimeType: "image/png", mode: "opencv" }))?.mode).toBe("sharp");
    expect(await preprocessor.preprocess({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" })).toBeNull();
    const oversized = new Uint8Array(await sharp({ create: { width: 8_000_001, height: 1, channels: 3, background: "white" } }).png().toBuffer());
    expect(await preprocessor.preprocess({ bytes: oversized, mimeType: "image/png" })).toBeNull();
  });

  test("validates worker PNG responses, times out, and terminates once", async () => {
    let terminates = 0;
    const validBytes = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer()).buffer;
    const oversizedValidBytes = new Uint8Array(await sharp({ create: { width: 1801, height: 1, channels: 3, background: "white" } }).png().toBuffer()).buffer;
    const valid = new WorkerImagePreprocessor({ timeoutMs: 100, workerFactory: () => respondingWorker({ ok: true, bytes: validBytes, mode: "sharp", width: 1, height: 1 }, () => terminates++) });
    expect(await valid.preprocess({ bytes: new Uint8Array([1]), mimeType: "image/png" })).not.toBeNull();
    const malformed = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]).buffer;
    const badCrc = new Uint8Array(validBytes.slice(0));
    badCrc[29] = badCrc[29]! ^ 1;
    for (const response of [
      { ok: true, bytes: malformed, mode: "sharp", width: 1, height: 1 },
      { ok: true, bytes: badCrc.buffer, mode: "sharp", width: 1, height: 1 },
      { ok: true, bytes: validBytes, mode: "invalid", width: 1, height: 1 },
      { ok: true, bytes: validBytes, mode: "sharp", width: Number.NaN, height: 1 },
      { ok: true, bytes: validBytes, mode: "sharp", width: Infinity, height: 1 },
      { ok: true, bytes: validBytes, mode: "sharp", width: Number.MAX_SAFE_INTEGER + 1, height: 1 },
      { ok: true, bytes: validBytes, mode: "sharp", width: 2, height: 1 },
      { ok: true, bytes: oversizedValidBytes, mode: "sharp", width: 1801, height: 1 },
      { ok: true, bytes: new ArrayBuffer(20 * 1024 * 1024 + 1), mode: "sharp", width: 1, height: 1 },
    ]) {
      const invalid = new WorkerImagePreprocessor({ timeoutMs: 100, workerFactory: () => respondingWorker(response, () => terminates++) });
      expect(await invalid.preprocess({ bytes: new Uint8Array([1]), mimeType: "image/png" })).toBeNull();
    }
    expect(terminates).toBe(10);
    terminates = 0;
    const stalled = new WorkerImagePreprocessor({ timeoutMs: 1, workerFactory: () => ({ postMessage() {}, terminate() { terminates++; }, onmessage: null, onerror: null }) });
    expect(await stalled.preprocess({ bytes: new Uint8Array([1]), mimeType: "image/png" })).toBeNull();
    expect(terminates).toBe(1);
  });

  test("does not alter a temporary originals directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bill-originals-"));
    try {
      const before = await readdir(directory);
      await preprocessor.preprocess({ bytes: await photographedBill(), mimeType: "image/png", mode: "sharp" });
      expect(await readdir(directory)).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("bounds checkerboard preprocessing time in a memory-limited subprocess", async () => {
    const script = `import sharp from "sharp"; import { WorkerImagePreprocessor } from "./src/backend/image-preprocessing.ts"; const svg = '<svg width="600" height="600" xmlns="http://www.w3.org/2000/svg"><pattern id="p" width="2" height="2" patternUnits="userSpaceOnUse"><rect width="1" height="1" fill="black"/><rect x="1" y="1" width="1" height="1" fill="black"/></pattern><rect width="600" height="600" fill="white"/><rect width="600" height="600" fill="url(#p)"/></svg>'; const result = await new WorkerImagePreprocessor({ timeoutMs: 7000 }).preprocess({ bytes: new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer()), mimeType: "image/png" }); if (result && !Buffer.from(result.bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) process.exit(1);`;
    const started = performance.now();
    const result = await runMemoryLimited(768 * 1024, script);
    expect(performance.now() - started).toBeLessThan(8_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  }, 10_000);

  test("external monitor kills a deterministic cap breach", async () => {
    const result = await runMemoryLimited(1, "setTimeout(() => {}, 1_000)");
    expect(result.exitCode).toBe(86);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  }, 10_000);
});
