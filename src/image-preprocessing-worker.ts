import { ANALYSIS_MAX_EDGE, MAX_DECODED_PIXELS, MAX_DERIVATIVE_BYTES, OUTPUT_MAX_EDGE, OUTPUT_TARGET_LONG_EDGE, WORKING_MAX_EDGE, type ImagePreprocessingRequestMode } from "./image-preprocessing";

type OpenCv = any;
type Request = { bytes: ArrayBuffer; mimeType: string; mode: ImagePreprocessingRequestMode };
type Success = { ok: true; bytes: ArrayBuffer; mode: "sharp" | "opencv"; width: number; height: number };

let sharpDependency: Promise<typeof import("sharp").default> | undefined;
let cvDependency: Promise<OpenCv> | undefined;

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("initialization timeout")), milliseconds);
    void promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function readyCv(value: OpenCv): Promise<OpenCv> {
  const cv = value?.default ?? value;
  if (cv?.Mat) return cv;
  if (typeof cv?.then === "function") return withTimeout(Promise.resolve(cv), 10_000);
  return withTimeout(new Promise<OpenCv>((resolve, reject) => {
    if (!cv) return reject(new Error("missing OpenCV"));
    const finish = () => { if (cv.Mat) resolve(cv); };
    const previous = cv.onRuntimeInitialized;
    cv.onRuntimeInitialized = () => { try { previous?.(); } finally { finish(); } };
    queueMicrotask(finish);
  }), 10_000);
}

function loadSharp(): Promise<typeof import("sharp").default> {
  sharpDependency ??= import("sharp").then((module) => module.default);
  return sharpDependency;
}

function loadCv(): Promise<OpenCv> {
  cvDependency ??= import("@techstark/opencv-js").then(readyCv);
  return cvDependency;
}

function safeDelete(value: { delete(): void } | undefined): void { try { value?.delete(); } catch { /* cleanup is best effort */ } }

function orderedCorners(points: Array<[number, number]>, longEdge: number): Array<[number, number]> | null {
  if (points.length !== 4) return null;
  const sums = points.map(([x, y]) => x + y);
  const diffs = points.map(([x, y]) => x - y);
  const tl = points[sums.indexOf(Math.min(...sums))]!;
  const br = points[sums.indexOf(Math.max(...sums))]!;
  const tr = points[diffs.indexOf(Math.max(...diffs))]!;
  const bl = points[diffs.indexOf(Math.min(...diffs))]!;
  if (new Set([tl, tr, br, bl].map((point) => point.join(","))).size !== 4) return null;
  const ordered = [tl, tr, br, bl];
  const distance = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (ordered.some((point, index) => distance(point, ordered[(index + 1) % 4]!) < longEdge * 0.05)) return null;
  if (distance(tl, br) < longEdge * 0.15 || distance(tr, bl) < longEdge * 0.15) return null;
  const cross = (a: [number, number], b: [number, number], c: [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (cross(tl, tr, br) * cross(tr, br, bl) <= 0) return null;
  return ordered;
}

/** Allocation bound: 8MP decode, 600px analysis, and 1800x1800 RGBA working, warp, and output buffers. This bounds dimensions and serial JobWorker concurrency, not process RSS. */
function rectify(cv: OpenCv, analysis: Uint8Array, analysisWidth: number, analysisHeight: number, working: Uint8Array, workingWidth: number, workingHeight: number): { bytes: Uint8Array; width: number; height: number } | null {
  let source: any; let gray: any; let blurred: any; let edges: any; let kernel: any; let merged: any; let contours: any; let hierarchy: any; let workingMat: any; let sourcePoints: any; let destinationPoints: any; let transform: any; let warped: any;
  try {
    source = cv.matFromImageData({ data: analysis, width: analysisWidth, height: analysisHeight });
    gray = new cv.Mat(); blurred = new cv.Mat(); edges = new cv.Mat(); merged = new cv.Mat();
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 50, 150);
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.morphologyEx(edges, merged, cv.MORPH_CLOSE, kernel);
    cv.dilate(merged, merged, kernel, new cv.Point(-1, -1), 1);
    contours = new cv.MatVector(); hierarchy = new cv.Mat();
    cv.findContours(merged, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const candidates: Array<{ index: number; area: number }> = [];
    for (let index = 0; index < contours.size(); index++) {
      let contour: any;
      try { contour = contours.get(index); candidates.push({ index, area: cv.contourArea(contour) }); } finally { safeDelete(contour); }
    }
    candidates.sort((a, b) => b.area - a.area);
    const longEdge = Math.max(analysisWidth, analysisHeight);
    for (const candidate of candidates.slice(0, 200)) {
      let contour: any; let approximation: any;
      try {
        contour = contours.get(candidate.index);
        const perimeter = cv.arcLength(contour, true);
        approximation = new cv.Mat(); cv.approxPolyDP(contour, approximation, 0.02 * perimeter, true);
        if (!cv.isContourConvex(approximation) || approximation.rows !== 4 || candidate.area / (analysisWidth * analysisHeight) < 0.25 || candidate.area / (analysisWidth * analysisHeight) > 0.98) continue;
        const raw = approximation.data32S;
        const points: Array<[number, number]> = [];
        for (let point = 0; point < 4; point++) points.push([raw[point * 2]!, raw[point * 2 + 1]!]);
        const corners = orderedCorners(points, longEdge);
        if (!corners) continue;
        const scaled = corners.map(([x, y]) => [x * workingWidth / analysisWidth, y * workingHeight / analysisHeight] as [number, number]);
        const distance = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
        const naturalWidth = Math.max(1, Math.round(Math.max(distance(scaled[0]!, scaled[1]!), distance(scaled[2]!, scaled[3]!))));
        const naturalHeight = Math.max(1, Math.round(Math.max(distance(scaled[0]!, scaled[3]!), distance(scaled[1]!, scaled[2]!))));
        const scale = Math.min(1, WORKING_MAX_EDGE / Math.max(naturalWidth, naturalHeight));
        const width = Math.max(1, Math.round(naturalWidth * scale));
        const height = Math.max(1, Math.round(naturalHeight * scale));
        workingMat = cv.matFromImageData({ data: working, width: workingWidth, height: workingHeight });
        sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, scaled.flat());
        destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]);
        transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
        warped = new cv.Mat(height, width, cv.CV_8UC4, new cv.Scalar(255, 255, 255, 255));
        cv.warpPerspective(workingMat, warped, transform, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
        return { bytes: new Uint8Array(warped.data), width, height };
      } finally { safeDelete(approximation); safeDelete(contour); }
    }
    return null;
  } finally {
    safeDelete(warped); safeDelete(transform); safeDelete(destinationPoints); safeDelete(sourcePoints); safeDelete(workingMat); safeDelete(hierarchy); safeDelete(contours); safeDelete(merged); safeDelete(kernel); safeDelete(edges); safeDelete(blurred); safeDelete(gray); safeDelete(source);
  }
}

export type ImagePreprocessingLoaders = { loadSharp: () => Promise<typeof import("sharp").default>; loadCv: () => Promise<OpenCv> };

export async function preprocessImage(request: Request, loaders: ImagePreprocessingLoaders = { loadSharp, loadCv }): Promise<Success> {
  const sharp = await loaders.loadSharp();
  const bytes = new Uint8Array(request.bytes);
  const decoded = sharp(bytes, { limitInputPixels: MAX_DECODED_PIXELS, failOn: "warning" }).autoOrient();
  const metadata = await decoded.metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_DECODED_PIXELS) throw new Error("invalid dimensions");
  const originalLongEdge = Math.max(metadata.width, metadata.height);
  const { data: working, info } = await decoded.clone().resize({ width: WORKING_MAX_EDGE, height: WORKING_MAX_EDGE, fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let source: Uint8Array<ArrayBufferLike> = new Uint8Array(working); let width = info.width; let height = info.height; let mode: "sharp" | "opencv" = "sharp";
  if (request.mode !== "sharp") {
    let cv: OpenCv | null = null;
    try { cv = await loaders.loadCv(); } catch { /* Geometry is optional. */ }
    if (cv) {
      const { data: analysis, info: analysisInfo } = await sharp(working, { raw: { width, height, channels: info.channels } }).resize({ width: ANALYSIS_MAX_EDGE, height: ANALYSIS_MAX_EDGE, fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let rectified: { bytes: Uint8Array; width: number; height: number } | null = null;
      try {
        rectified = rectify(cv, analysis, analysisInfo.width, analysisInfo.height, working, width, height);
      } catch {
        // Geometry is optional: rectify() has released its OpenCV allocations, so retain the sharp path.
      }
      if (rectified) { source = rectified.bytes; width = rectified.width; height = rectified.height; mode = "opencv"; }
    }
  }
  const tile = Math.max(8, Math.floor(Math.max(width, height) / 16));
  const final = await sharp(source, { raw: { width, height, channels: 4 } }).clahe({ width: tile, height: tile, maxSlope: 2 }).normalise({ lower: 1, upper: 99 }).sharpen({ sigma: 0.6, m1: 0.4, m2: 0.2 }).resize({ width: OUTPUT_TARGET_LONG_EDGE, height: OUTPUT_TARGET_LONG_EDGE, fit: "inside", kernel: "lanczos3", withoutEnlargement: originalLongEdge >= OUTPUT_MAX_EDGE }).png({ compressionLevel: 9 }).toBuffer();
  const finalMetadata = await sharp(final).metadata();
  if (!finalMetadata.width || !finalMetadata.height || finalMetadata.width > OUTPUT_MAX_EDGE || finalMetadata.height > OUTPUT_MAX_EDGE || final.length > MAX_DERIVATIVE_BYTES) throw new Error("invalid output");
  return { ok: true, bytes: final.buffer.slice(final.byteOffset, final.byteOffset + final.byteLength), mode, width: finalMetadata.width, height: finalMetadata.height };
}

const workerScope = globalThis as typeof globalThis & { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<unknown>) => void) | null };
workerScope.onmessage = (event) => {
  void (async () => {
    try {
      const request = event.data as Request;
      if (!request || !(request.bytes instanceof ArrayBuffer) || (request.mode !== "auto" && request.mode !== "sharp" && request.mode !== "opencv")) throw new Error("invalid request");
      const response = await preprocessImage(request);
      workerScope.postMessage(response, [response.bytes]);
    } catch {
      workerScope.postMessage({ ok: false });
    }
  })();
};
