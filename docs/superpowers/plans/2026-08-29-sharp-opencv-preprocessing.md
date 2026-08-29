# Sharp/OpenCV Photo Preprocessing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, bounded in-memory image preprocessing derivative before Mistral OCR so handwritten bill photos are easier to read while the persisted original remains immutable.

**Architecture:** `createExtractJobHandler` continues to obtain the attachment only through `readVerifiedOriginal`, then asks an injected `ImagePreprocessor` for a PNG derivative. A dedicated Worker performs all Sharp/OpenCV CPU work and is terminated on timeout; any preprocessing failure returns the exact verified bytes to Mistral. PDFs bypass preprocessing and no derivative is written or persisted. New job keys durably select the original or preprocessing policy, while the provider idempotency key includes the selected input SHA-256 so byte-identical replay reuses a key and different request bytes never reuse one key.

**Tech Stack:** Bun 1.2, TypeScript, `sharp@0.35.4`, `@techstark/opencv-js@5.0.0-release.1` (OpenCV WASM), Bun Worker, Bun test, Docker `oven/bun:1.2-slim`.

---

## Scope and non-goals

`sharp@0.35.4` and `@techstark/opencv-js@5.0.0-release.1` are exact, pinned dependencies. Revalidate that those exact versions and their Bun behavior are still available when implementing; do not float either version. Do **not** use native `@u4/opencv4nodejs`: it has no Bun compatibility guarantee and adds native OpenCV compilation, linking, and runtime-library burden. The WASM package is reproducible in the current `oven/bun:1.2-slim` image.

This phase has no database migration, candidate persistence, multi-pass OCR, original-file writes, or automatic currency removal. The preprocessing version is both release metadata and the suffix in newly created extraction job keys:

```ts
export const IMAGE_PREPROCESSING_VERSION = "sharp-opencv-v1";
```

**Measured provider baseline:** the prior bounded live evaluation routed both fixtures to `needs_review`. `example3` differed in `invoiceNumber`, `invoiceDate`, `subtotal`, `total`, and `description`. `example4` differed in `vendorName`, `invoiceNumber`, `invoiceDate`, `currency`, `subtotal`, `total`, and `description`. The authorized gate in Task 5 reruns `original` alongside both derivatives because provider behavior can change.

## File map

| File | Responsibility |
| --- | --- |
| `package.json`, `bun.lock` | Pin preprocessing dependencies and bundle the worker entrypoint. |
| `Dockerfile` | Prove installed production dependencies can import from the slim image. |
| `docker-compose.yml` | Enforce a production container memory ceiling for the image Worker and service. |
| `src/config.ts` | Add only the enabled flag and worker timeout setting. |
| `src/image-preprocessing.ts` | Public interface, constants, source/dist-safe Worker client, MIME bypass/fallback policy, and safe metadata. |
| `src/image-preprocessing-worker.ts` | Isolated Sharp/OpenCV decode, page detection/rectification, enhancement, and PNG encoding. |
| `src/extraction.ts` | Inject preprocessing after verified-original read, select request bytes, hash them into provider idempotency, and call Mistral. |
| `src/whatsapp-ingestion.ts` | Persist the selected input policy in newly created extraction job idempotency keys. |
| `src/server.ts` | Compose the enabled production preprocessor and permit injected test preprocessor. |
| `src/evaluate-approved-examples.ts` | Authorized-only three-variant, two-fixture evaluator. |
| `test/image-preprocessing.test.ts` | Offline synthetic-image and Worker failure/bounds tests. |
| `test/extraction.test.ts`, `test/config-logger.test.ts`, `test/server.test.ts`, `test/whatsapp-ingestion.test.ts`, `test/evaluate-approved-examples.test.ts`, `test/deployment.test.ts` | Injection, lease/idempotency, config, durable input policy, evaluator output, and static deployment coverage. |
| `.env.example`, `README.md` | Disabled-by-default settings, operational contract, version, constraints, and release gate. |

### Task 1: Prove dependency and runtime compatibility before adding production behavior

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `Dockerfile`
- Modify: `test/deployment.test.ts`

- [ ] **Step 1: Add the exact dependencies and worker build output contract.**

Update `package.json` so dependencies contain exact strings and the build has the worker as an independent entrypoint:

```json
"dependencies": {
  "@techstark/opencv-js": "5.0.0-release.1",
  "sharp": "0.35.4"
},
"scripts": {
  "build": "bun build src/server.ts src/ops.ts src/image-preprocessing.ts src/image-preprocessing-worker.ts --target bun --outdir dist --external sharp --external @techstark/opencv-js && rm -rf dist/review && bun build src/review-client.tsx --target browser --outdir dist/review && mv dist/review/review-client.js dist/review/client.js && mv dist/review/review-client.css dist/review/client.css",
  "verify-build": "bun run build && test -f dist/server.js && test -f dist/ops.js && test -f dist/image-preprocessing.js && test -f dist/image-preprocessing-worker.js && test -f dist/review/client.js && test -f dist/review/client.css"
}
```

Keep every existing dependency and script field; merge these entries rather than replacing the object. Regenerate and verify the lockfile with the repository's pinned Bun version:

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/app" -w /app oven/bun:1.2 bun add --exact sharp@0.35.4 @techstark/opencv-js@5.0.0-release.1
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/app" -w /app oven/bun:1.2 bun install --frozen-lockfile
```

Expected: both commands exit 0, `package.json` contains exact versions, and the second command makes no lockfile changes.

- [ ] **Step 2: Add a failing local compatibility-spike test before writing the worker.**

In `test/deployment.test.ts`, add an offline subprocess test that imports both modules and exercises every OpenCV API needed by the production algorithm:

```ts
test("Bun imports Sharp and OpenCV WASM APIs required by preprocessing", async () => {
  const process = Bun.spawn(["bun", "-e", `
    import sharp from "sharp";
    import cvModule from "@techstark/opencv-js";
    const timeout = Bun.sleep(10_000).then(() => { throw new Error("OpenCV initialization timeout"); });
    const ready = cvModule instanceof Promise ? cvModule : cvModule.Mat ? Promise.resolve(cvModule) : new Promise((resolve) => {
      let settled = false; const finish = () => { if (!settled) { settled = true; resolve(cvModule); } };
      cvModule.onRuntimeInitialized = finish; queueMicrotask(() => { if (cvModule.Mat) finish(); });
    });
    const cv = await Promise.race([ready, timeout]);
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: "white" } }).png().toBuffer();
    const source = cv.matFromImageData({ data: new Uint8ClampedArray(8 * 8 * 4), width: 8, height: 8 });
    const gray = new cv.Mat(); const edges = new cv.Mat(); const warped = new cv.Mat(); const contours = new cv.MatVector(); const hierarchy = new cv.Mat();
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY); cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0); cv.Canny(gray, edges, 50, 150);
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const points = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0, 7,0, 7,7, 0,7]); const transform = cv.getPerspectiveTransform(points, points);
    cv.warpPerspective(source, warped, transform, new cv.Size(8, 8), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255,255,255,255));
    for (const item of [transform, points, hierarchy, contours, warped, edges, gray, source]) item.delete();
    if (png.byteLength === 0) process.exit(1);
  `], { stdout: "pipe", stderr: "pipe" });
  expect(await process.exited).toBe(0);
});
```

- [ ] **Step 3: Run the local compatibility spike.**

Run: `bun test test/deployment.test.ts -t 'Bun imports Sharp and OpenCV WASM APIs required by preprocessing'`

Expected: FAIL before installing the pinned packages, then PASS after the lockfile update. If it fails after installation, stop: capture only the sanitized exit status and module/API name, then resolve Bun/WASM initialization before implementing preprocessing.

- [ ] **Step 4: Confirm Sharp’s exact enhancement API with a small local assertion.**

Extend the same test’s subprocess script with this exact operation:

```ts
const enhanced = await sharp(png, { limitInputPixels: 8_000_000, failOn: "warning" })
  .clahe({ width: 8, height: 8, maxSlope: 2 })
  .normalise({ lower: 1, upper: 99 })
  .sharpen({ sigma: 0.6, m1: 0.4, m2: 0.2 })
  .png({ compressionLevel: 9 })
  .toBuffer();
if (enhanced.byteLength === 0) process.exit(1);
```

Run: `bun test test/deployment.test.ts -t 'Bun imports Sharp and OpenCV WASM APIs required by preprocessing'`

Expected: PASS. This is the compatibility decision for the restrained, color-preserving CLAHE/normalization chain; do not substitute undocumented Sharp calls.

- [ ] **Step 5: Add the Docker import smoke and production runtime dependencies.**

Keep `sharp` and `@techstark/opencv-js` in `dependencies`, not `devDependencies`, because bundled output intentionally externalizes them. Add this Docker assertion after the production install:

```dockerfile
RUN bun -e 'Promise.all([import("sharp"),import("@techstark/opencv-js")]).then(async([,m])=>{const x=m.default;const ready=x instanceof Promise?x:x.Mat?Promise.resolve(x):new Promise(r=>{let s=false;const f=()=>{if(!s){s=true;r(x)}};x.onRuntimeInitialized=f;queueMicrotask(()=>{if(x.Mat)f()})});const cv=await Promise.race([ready,Bun.sleep(10000).then(()=>{throw new Error("timeout")})]);const mat=new cv.Mat();mat.delete()}).catch(()=>process.exit(1))'
```

Add a test that checks `dist/image-preprocessing-worker.js` after `bun run verify-build`; ensure the existing deployment build assertions now include it.

- [ ] **Step 6: Run the source and Docker compatibility checks.**

Run: `bun run verify-build && docker build -t bill-ledger-preprocessing-smoke .`

Expected: `verify-build` creates `dist/server.js`, `dist/ops.js`, `dist/image-preprocessing.js`, and `dist/image-preprocessing-worker.js`; Docker exits 0 and its import layer succeeds in `oven/bun:1.2-slim`.

### Task 2: Define the bounded preprocessing contract and configuration

**Files:**
- Create: `src/image-preprocessing.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `test/config-logger.test.ts`

- [ ] **Step 1: Write failing config tests for only the two public controls.**

Append to `test/config-logger.test.ts`:

```ts
test("image preprocessing is disabled by default and validates its timeout", () => {
  expect(loadConfig(validEnvironment()).imagePreprocessing).toEqual({ enabled: false, timeoutMs: 8_000 });
  expect(loadConfig({ ...validEnvironment(), IMAGE_PREPROCESSING_ENABLED: "true", IMAGE_PREPROCESSING_TIMEOUT_MS: "9" }).imagePreprocessing).toEqual({ enabled: true, timeoutMs: 9 });
  expect(() => loadConfig({ ...validEnvironment(), IMAGE_PREPROCESSING_ENABLED: "yes" })).toThrow("IMAGE_PREPROCESSING_ENABLED");
  expect(() => loadConfig({ ...validEnvironment(), IMAGE_PREPROCESSING_TIMEOUT_MS: "0" })).toThrow("IMAGE_PREPROCESSING_TIMEOUT_MS");
});
```

- [ ] **Step 2: Run the config test to establish the failure.**

Run: `bun test test/config-logger.test.ts -t 'image preprocessing is disabled by default'`

Expected: FAIL because `imagePreprocessing` does not exist on `AppConfig`.

- [ ] **Step 3: Add the exact public types, fixed bounds, and config shape.**

Add to `src/image-preprocessing.ts`:

```ts
export const IMAGE_PREPROCESSING_VERSION = "sharp-opencv-v1";
export const MAX_DECODED_PIXELS = 8_000_000;
export const ANALYSIS_MAX_EDGE = 600;
export const WORKING_MAX_EDGE = 1_800;
export const OUTPUT_MAX_EDGE = 1_800;
export const OUTPUT_TARGET_LONG_EDGE = 1_800;
export const MAX_DERIVATIVE_BYTES = 20 * 1024 * 1024;
export type ImagePreprocessingMode = "original" | "sharp" | "opencv";
export type ImagePreprocessingRequestMode = "auto" | "sharp" | "opencv";
export type PreprocessedImage = { bytes: Uint8Array; mimeType: "image/png"; mode: ImagePreprocessingMode; width: number; height: number };
export interface ImagePreprocessor { preprocess(input: { bytes: Uint8Array; mimeType: string; mode?: ImagePreprocessingRequestMode }): Promise<PreprocessedImage | null>; }
export const isPreprocessableMimeType = (mimeType: string): boolean => ["image/jpeg", "image/png", "image/webp"].includes(mimeType.toLowerCase());
```

Add `imagePreprocessing: { enabled: boolean; timeoutMs: number }` to `AppConfig`, and in `loadConfig` return:

```ts
imagePreprocessing: {
  enabled: boolean(env, "IMAGE_PREPROCESSING_ENABLED", false),
  timeoutMs: integer(env, "IMAGE_PREPROCESSING_TIMEOUT_MS", 8_000, 1),
},
```

Add this disabled-by-default block after Mistral settings in `.env.example`:

```dotenv
# In-memory OCR photo derivative. Originals are never modified or stored as derivatives.
IMAGE_PREPROCESSING_ENABLED=false
IMAGE_PREPROCESSING_TIMEOUT_MS=8000
```

- [ ] **Step 4: Implement the Worker client’s fallback boundary.**

In `src/image-preprocessing.ts`, implement `WorkerImagePreprocessor`. It must return `null` for non-JPEG/PNG/WebP inputs, create exactly one Worker per image, post a transferable copy of the input, and terminate the Worker in `finally`. Resolve the source and bundled entry explicitly:

```ts
const workerName = import.meta.path.endsWith(".ts") ? "image-preprocessing-worker.ts" : "image-preprocessing-worker.js";
const defaultWorkerFactory = () => new Worker(new URL(workerName, import.meta.url).href);
```

The constructor accepts `{ timeoutMs: number; workerFactory?: () => Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror"> }` so timeout, malformed-response, and oversize-response behavior is testable without a real Worker. The client must resolve `null` on Worker error, malformed response, timeout, or derivative longer than `MAX_DERIVATIVE_BYTES`; it must never log bytes, image contents, raw errors, or provider data.

Use this concrete message contract:

```ts
type WorkerRequest = { bytes: ArrayBuffer; mimeType: string; mode: "auto" | "sharp" | "opencv" };
type WorkerResponse = { ok: true; bytes: ArrayBuffer; mode: "sharp" | "opencv"; width: number; height: number } | { ok: false };
```

`preprocess` defaults missing `input.mode` to `"auto"`. Production omits it. The evaluator passes `"sharp"` and `"opencv"`; `"opencv"` still falls back to Sharp if no quadrilateral passes confidence, returning mode `"sharp"`.

- [ ] **Step 5: Run the configuration tests.**

Run: `bun test test/config-logger.test.ts`

Expected: PASS, including the new defaults and invalid-value rejection.

### Task 3: Implement isolated, bounded Sharp/OpenCV transformation

**Files:**
- Create: `src/image-preprocessing-worker.ts`
- Create: `test/image-preprocessing.test.ts`

- [ ] **Step 1: Write offline synthetic fixtures and failing contract tests.**

In `test/image-preprocessing.test.ts`, generate all images in memory using Sharp; do not add binary fixtures. Start with these tests and helpers:

```ts
import { expect, test } from "bun:test";
import sharp from "sharp";
import { WorkerImagePreprocessor } from "../src/image-preprocessing";

const photo = async () => sharp({ create: { width: 900, height: 600, channels: 3, background: "#d8d8d8" } })
  .composite([{ input: Buffer.from('<svg width="900" height="600"><polygon points="180,90 760,130 700,510 145,455" fill="white" stroke="black" stroke-width="8"/><text x="260" y="260" font-size="42">TOTAL 70</text></svg>') }])
  .jpeg().toBuffer();

const preprocess = (timeoutMs = 8_000) => new WorkerImagePreprocessor({ timeoutMs });

test("preprocesses a perspective bill to bounded PNG without mutating input", async () => {
  const input = new Uint8Array(await photo()); const before = new Uint8Array(input);
  const result = await preprocess().preprocess({ bytes: input, mimeType: "image/jpeg" });
  expect(input).toEqual(before); expect(result?.mimeType).toBe("image/png");
  expect(result?.bytes.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(result?.width).toBeLessThanOrEqual(1_800); expect(result?.height).toBeLessThanOrEqual(1_800);
});

test("bypasses PDFs exactly", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7");
  expect(await preprocess().preprocess({ bytes, mimeType: "application/pdf" })).toBeNull();
});
```

Add explicit tests for EXIF orientation (a 90° tagged JPEG yields upright dimensions), perspective page coverage (the transformed white page occupies at least 90% of output pixels), a blank/no-contour PNG (mode `"sharp"`), malformed bytes (`null`), an 8,000,001-pixel image (`null`), a Worker response over 20 MiB (`null` through the injected Worker factory), timeout (`null` and the worker’s `terminate` spy called once), and no writes to a temporary originals directory (snapshot its directory entries before and after). Add a deterministic 600×600 alternating-noise/checkerboard input and assert it completes or safely returns `null` within 8 seconds under a subprocess/container memory ceiling rather than exhausting the parent test process. These tests must inspect only dimensions/PNG signature/pixel aggregates, never log image bytes.

- [ ] **Step 2: Run the preprocessing tests to establish the initial failure.**

Run: `bun test test/image-preprocessing.test.ts`

Expected: FAIL because the worker module and `WorkerImagePreprocessor` do not yet exist.

- [ ] **Step 3: Implement safe decode, scaling, and OpenCV resource cleanup in the Worker.**

In `src/image-preprocessing-worker.ts`, dynamically import the two external dependencies once per Worker and implement `loadOpenCv` with the same 10-second timeout, Promise-export handling, callback registration, and post-registration `queueMicrotask` readiness recheck used by Task 1. Await it before installing/servicing `self.onmessage`; if initialization fails, reply `{ ok: false }` to any request without error details. Then decode only via:

```ts
const oriented = sharp(bytes, { limitInputPixels: 8_000_000, failOn: "warning" }).autoOrient();
const metadata = await oriented.metadata();
if (!metadata.width || !metadata.height || metadata.width * metadata.height > 8_000_000) throw new Error("invalid image dimensions");
const working = oriented.resize({ width: 1_800, height: 1_800, fit: "inside", withoutEnlargement: true });
```

Make a separate analysis image from the oriented image capped at 600 pixels on its longest edge. Convert analysis RGBA pixels to `cv.Mat`, then execute exactly:

```ts
cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
cv.Canny(blurred, edges, 50, 150);
const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
cv.morphologyEx(edges, merged, cv.MORPH_CLOSE, kernel);
cv.dilate(merged, merged, kernel, new cv.Point(-1, -1), 1);
cv.findContours(merged, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
```

Delete `kernel` and `merged` with every other OpenCV allocation. `RETR_EXTERNAL`, reduced analysis resolution, close/dilate merging, and `CHAIN_APPROX_SIMPLE` reduce contour materialization before the existing 200-candidate inspection cap; the adversarial stress and container ceiling verify the remaining native/WASM allocation risk.

When `request.mode === "sharp"`, skip grayscale, contours, and perspective rectification completely; enhance the full oriented working image and return mode `"sharp"`. For `"auto"` and `"opencv"`, run the same geometry path: for each contour, calculate `cv.contourArea`, `cv.arcLength`, and `cv.approxPolyDP`. Accept the largest contour only when it is convex, has four points, area ratio in `[0.25, 0.98]`, non-self-intersecting ordered corners, all edge lengths are at least 5% of analysis long edge, and its two diagonals are each at least 15% of that edge. Order points as top-left, top-right, bottom-right, bottom-left using sum/difference, map them by `workingWidth / analysisWidth` and `workingHeight / analysisHeight`, and rectify with `cv.getPerspectiveTransform` plus `cv.warpPerspective` into an RGBA white page. Return mode `"opencv"` when rectified; otherwise enhance the full oriented image and return mode `"sharp"`. This makes production `auto` byte-equivalent to the evaluator's forced `opencv` request for the same dependency versions and input.

Every OpenCV allocation must be declared before use and deleted in one `finally`, including `Mat`, `MatVector`, contour Mats obtained with `contours.get(i)`, kernel, points, transform, and destination. Delete each contour Mat inside the loop's own `finally` and all outer allocations in the function `finally`. The `finally` must run on malformed input and OpenCV exceptions. Inspect at most the 200 largest external contours after area sorting. Document the allocation estimate for the 8-megapixel Sharp input cap, 600-pixel analysis cap, and 1800-pixel RGBA working/output caps; this is a dimensional/concurrency bound, not a guaranteed JavaScript RSS ceiling. Only one preprocessing Worker may exist because the durable `JobWorker` handles one claimed job at a time. Run the Docker Worker smoke with `--memory=256m`; production Compose uses a 512 MiB service ceiling.

- [ ] **Step 4: Implement restrained color-preserving enhancement and output validation.**

Use the rectified page, or the full working image when no reliable quadrilateral exists, as the Sharp input. Apply the API verified in Task 1, with a small tile width/height proportionate to image dimensions but never below 8:

```ts
const enhanced = sharp(pageRgba, { raw: { width, height, channels: 4 }, failOn: "warning" })
  .clahe({ width: Math.max(8, Math.floor(width / 16)), height: Math.max(8, Math.floor(height / 16)), maxSlope: 2 })
  .normalise({ lower: 1, upper: 99 })
  .sharpen({ sigma: 0.6, m1: 0.4, m2: 0.2 })
  .resize({ width: 1_800, height: 1_800, fit: "inside", kernel: sharp.kernel.lanczos3, withoutEnlargement: false })
  .png({ compressionLevel: 9 });
```

Only permit the enlargement when the input long edge is below 1800; otherwise retain its capped size. Read final metadata and reject output without positive dimensions, dimensions over 1800, or bytes over 20 MiB. Do not threshold, binarize, desaturate, or otherwise erase colored handwriting. Reply `{ ok: false }` for every caught error, without serializing error text.

- [ ] **Step 5: Run the image test file and inspect resource/fallback behavior.**

Run: `bun test test/image-preprocessing.test.ts`

Expected: PASS. The perspective test reports `mode: "opencv"`; blank/no-contour and forced OpenCV mode report `mode: "sharp"`; malformed, decompression-limit, oversize, and timeout cases return `null`; the temporary originals directory remains unchanged.

### Task 4: Wire preprocessing into extraction without changing durability semantics

**Files:**
- Modify: `src/extraction.ts`
- Modify: `src/server.ts`
- Modify: `src/whatsapp-ingestion.ts`
- Modify: `test/extraction.test.ts`
- Modify: `test/server.test.ts`
- Modify: `test/whatsapp-ingestion.test.ts`

- [ ] **Step 1: Write failing extraction tests for successful derivative, fallback, lease fencing, and replay identity.**

Add an injectable fake to `test/extraction.test.ts`:

```ts
const derivative = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const preprocessor = { preprocess: async () => ({ bytes: derivative, mimeType: "image/png" as const, mode: "sharp" as const, width: 10, height: 10 }) };
```

Create one test where the provider receives `derivative` and `mimeType: "image/png"`, another where `preprocess` returns `null` or throws and the provider receives the byte-for-byte verified original and original MIME, and a PDF test where the fake’s `preprocess` call count is zero. Assert the original file bytes and SHA-256 remain unchanged in all cases.

Add a fence test with a `context.assertLease` spy whose sequence is recorded; it must observe an assertion immediately before `provider.extract`, after preprocessing returns. Assert byte-identical first-run/replay inputs produce the same provider key, derivative and original-fallback bytes produce different keys, and the provider key never embeds raw bytes.

Add an explicit crash/replay limitation test: first make preprocessing return a derivative and the provider throw after recording its request, then make preprocessing return `null` on replay. Assert the second call uses the verified original and a different input-hash key. This may incur two provider calls, but it must never send different bytes under one idempotency key.

- [ ] **Step 2: Run the new extraction cases to verify they fail.**

Run: `bun test test/extraction.test.ts -t 'preprocess'`

Expected: FAIL because `createExtractJobHandler` has no preprocessor parameter and passes the original directly to the provider.

- [ ] **Step 3: Extend the handler with a default no-op preprocessor and exact call ordering.**

Import `ImagePreprocessor` and `isPreprocessableMimeType` in `src/extraction.ts`; add this no-op value:

```ts
const noImagePreprocessor: ImagePreprocessor = { preprocess: async () => null };
```

Extend `createExtractJobHandler` by one final optional parameter, `preprocessor: ImagePreprocessor = noImagePreprocessor`, preserving every existing call site. Preprocess only jobs whose durable key ends with `:${IMAGE_PREPROCESSING_VERSION}`; existing jobs without the suffix remain original-input jobs after deployment. Immediately after the successful `readVerifiedOriginal` call, use only its returned bytes:

```ts
let providerBytes = bytes;
let providerMimeType = bill.mimeType;
if (job.idempotencyKey.endsWith(`:${IMAGE_PREPROCESSING_VERSION}`) && isPreprocessableMimeType(bill.mimeType)) {
  try {
    const derivative = await preprocessor.preprocess({ bytes, mimeType: bill.mimeType });
    if (derivative) { providerBytes = derivative.bytes; providerMimeType = derivative.mimeType; }
  } catch { /* preprocessing is an optional local transform; exact verified bytes remain selected */ }
}
const inputHash = createHash("sha256").update(providerBytes).digest("hex");
const providerIdempotencyKey = `${context.idempotencyKey}:input:${inputHash}`;
context.assertLease();
const result = await provider.extract({ bytes: providerBytes, mimeType: providerMimeType, caption: bill.caption, idempotencyKey: providerIdempotencyKey });
```

This derivation preserves provider idempotency for identical request bytes and prevents one key from representing both a derivative and fallback original after timeout/failure. Do not persist mode/dimensions, do not alter `EXTRACTION_PROMPT_VERSION`, and do not add image/raw/provider error logging. The comment is the complete rationale for the intentional catch; no error object is read or logged.

- [ ] **Step 4: Compose only when the feature is enabled and retain service injection.**

In `src/server.ts`, construct `new WorkerImagePreprocessor({ timeoutMs: config.imagePreprocessing.timeoutMs })` regardless of the new-job feature flag, because durable jobs already tagged `:sharp-opencv-v1` must retain their policy after rollback. No Worker starts until such a job calls it. Extend the existing `startService` dependency input with optional `imagePreprocessor?: ImagePreprocessor` and prefer it over the config-created implementation so tests remain offline. Pass that selected instance into `createExtractJobHandler`; use `config.imagePreprocessing.enabled` only to pass `IMAGE_PREPROCESSING_VERSION` versus `"original"` into `WhatsAppIngestionService` for newly created jobs.

In `src/whatsapp-ingestion.ts`, add an `extractionInputVersion: "original" | typeof IMAGE_PREPROCESSING_VERSION` constructor option and create new extraction jobs with:

```ts
{ type: "extract", idempotencyKey: `extract:${manifest.id}:${this.extractionInputVersion}` }
```

Add ingestion tests proving disabled/new jobs end in `:original`, enabled/new jobs end in `:sharp-opencv-v1`, and replay/reconciliation never rewrites an existing job key. This uses the already-durable idempotency key rather than a schema migration.

Add a `test/server.test.ts` case that starts the service with a fake image preprocessor and a fake Mistral provider, enqueues a PNG fixture, and asserts the fake was called for a tagged job. Add the disabled-config case proving newly ingested jobs use `:original` and the provider receives original bytes even though a lazy preprocessor instance is available. Add a rollback case proving an existing `:sharp-opencv-v1` job still invokes preprocessing when the current new-job flag is disabled.

- [ ] **Step 5: Run focused durability and server tests.**

Run: `bun test test/extraction.test.ts && bun test test/server.test.ts`

Expected: PASS. Successful preprocessing changes only the provider input; failure is byte-identical original fallback; PDF bypasses; lease assertion occurs immediately before the external side effect; byte-identical retry/replay keys remain stable; different input bytes have different provider keys.

#### Provider idempotency limitation

No input selection is persisted before the external call in this phase. If Mistral accepts a derivative and the process crashes before SQLite persists the response, a later attempt whose preprocessing times out can send the verified original under a different input-hash key, resulting in a duplicate bill request. This is preferable to reusing one key for different bodies and is consistent with the repository's existing documented Mistral idempotency limitation. Eliminating the duplicate possibility requires a database migration or durable derivative persistence and is explicitly deferred; the crash/replay test above locks in the bounded behavior.

### Task 5: Make the approved-example evaluator a safe, deterministic A/B gate

**Files:**
- Modify: `src/evaluate-approved-examples.ts`
- Modify: `test/evaluate-approved-examples.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing evaluator-output tests.**

Add a pure exported formatter/runner dependency seam and test it with fake preprocessing/provider implementations. Assert it emits precisely six records for two fixtures × three variants, each record has only `fixture`, `variant`, `differences`, `decision`, `issues`, `mode`, and `dimensions`, and no bytes, OCR text, response, model, error, credential, or idempotency key fields.

Use this expected shape:

```ts
expect(lines).toEqual(expect.arrayContaining([
  expect.objectContaining({ fixture: "example3.json", variant: "original", mode: "original", dimensions: null }),
  expect.objectContaining({ fixture: "example3.json", variant: "sharp", mode: "sharp", dimensions: { width: expect.any(Number), height: expect.any(Number) } }),
  expect.objectContaining({ fixture: "example3.json", variant: "opencv", mode: expect.stringMatching(/^(opencv|sharp)$/), dimensions: { width: expect.any(Number), height: expect.any(Number) } }),
]));
```

- [ ] **Step 2: Run the evaluator test to establish failure.**

Run: `bun test test/evaluate-approved-examples.test.ts -t 'three variants'`

Expected: FAIL because the evaluator currently emits one record per fixture and has no variant metadata.

- [ ] **Step 3: Implement exactly three variants and sanitized, unique provider keys.**

In `src/evaluate-approved-examples.ts`, process `const variants = ["original", "sharp", "opencv"] as const` for each existing fixture. Use the original fixture bytes unchanged for `original`; call `WorkerImagePreprocessor` in forced `sharp` and `opencv` modes for the other two. If a transform returns `null`, emit a local `needs_review` result with an issue `{ code: "evaluator_preprocessing_failure", field: null }` and do not call Mistral for that variant, preserving the no-leak output schema.

For each provider call construct only this sanitized key:

```ts
const idempotencyKey = `approved-evaluation:${EXTRACTION_PROMPT_VERSION}:${runToken}:${name}:${variant}`;
```

Require exactly six provider calls when both transformations succeed. Print only:

```ts
console.log(JSON.stringify({ fixture: name, variant, differences: evaluation.differences, decision: evaluation.decision, issues: evaluation.issues, mode, dimensions }));
```

Never print/save a derivative, raw OCR, provider response body, caught error, credentials, or run token. Keep `if (import.meta.main)` but prepend a hard authorization guard:

```ts
if (Bun.env.APPROVED_EXAMPLE_EVALUATION_AUTHORIZED !== "true") throw new Error("Set APPROVED_EXAMPLE_EVALUATION_AUTHORIZED=true to run live approved-example evaluation");
```

- [ ] **Step 4: Add the release decision rule to the README.**

Document `IMAGE_PREPROCESSING_VERSION=sharp-opencv-v1` as release/job-policy metadata (not an environment setting), `IMAGE_PREPROCESSING_ENABLED=false`, the 8,000 ms timeout, JPEG/PNG/WebP-only derivative behavior, PDF passthrough, no original writes, and the three evaluation modes. State that production always uses fixed `auto` behavior, equivalent to the evaluator's `opencv` request (rectify when a reliable quadrilateral exists, otherwise Sharp-only). A release may enable production only when that `opencv`/auto candidate has zero false approvals, fewer than the baseline 12 aggregate exact-field differences, and no more than 5 differences for `example3` or 7 for `example4`; otherwise leave production disabled. The Sharp-only result is diagnostic and cannot be selected by configuration in this phase.

- [ ] **Step 5: Run offline evaluator tests only.**

Run: `bun test test/evaluate-approved-examples.test.ts`

Expected: PASS without provider traffic. Do **not** run `bun run evaluate:approved-examples` unless explicit authorization is supplied.

### Task 6: Document release, rollout, and rollback; then run the complete verification sequence

**Files:**
- Modify: `README.md`
- Modify: `test/deployment.test.ts`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add a concrete rollout checklist to README.**

Add this operational sequence verbatim in the preprocessing section:

```markdown
1. Keep `IMAGE_PREPROCESSING_ENABLED=false`; deploy and confirm `bun run verify-build` plus the container import/health smoke. Existing jobs retain their durable `:original` policy.
2. With written authorization, run `APPROVED_EXAMPLE_EVALUATION_AUTHORIZED=true bun run evaluate:approved-examples`; retain only its six sanitized JSON decision lines in the release record.
3. Enable only when the fixed `opencv`/auto candidate passes the gate. Newly ingested jobs receive `:sharp-opencv-v1`; existing `:original` jobs remain original-input jobs, so rollout does not change their request bytes.
4. Monitor `needs_review` rate and extraction processing latency against the pre-enable interval.
5. To roll back, first pause ingestion and the worker, record jobs already carrying `:sharp-opencv-v1`, set `IMAGE_PREPROCESSING_ENABLED=false`, and restart. Existing preprocessing-policy jobs remain deterministic derivative/fallback jobs and new jobs use `:original`; do not rewrite job keys. The input SHA-256 suffix prevents one provider key from being reused for different bytes.
```

- [ ] **Step 2: Define post-build Worker and container health smoke coverage without providers.**

Keep `test/deployment.test.ts` limited to static assertions that do not require `dist/`, because repository verification runs tests before build. After `verify-build`, run a built-artifact smoke through this command on the host and then inside the production container:

```bash
bun -e 'import sharp from "sharp"; import { WorkerImagePreprocessor } from "./dist/image-preprocessing.js"; const bytes=await sharp({create:{width:64,height:64,channels:3,background:"white"}}).png().toBuffer(); const result=await new WorkerImagePreprocessor({timeoutMs:8000}).preprocess({bytes,mimeType:"image/png",mode:"sharp"}); if(!result||result.bytes[0]!==137)process.exit(1)'
```

The container health smoke starts the service with `WHATSAPP_ENABLED=false`, `GOOGLE_ENABLED=false`, test-only required configuration, and an empty database, waits for `GET /health` to return 200, and stops it. No extraction jobs exist, so it cannot send WhatsApp, Mistral, Drive, or Sheets requests.

Add `mem_limit: 512m` to the `bill-ledger` service in `docker-compose.yml`. Add a static deployment assertion for that exact value and run `docker compose config` during the Docker verification step so unsupported/invalid Compose syntax fails before rollout.

- [ ] **Step 3: Run required final verification in repository order.**

Run: `bun run typecheck && bun test && bun run verify-build`

Expected: all commands exit 0; build creates `dist/server.js`, `dist/ops.js`, `dist/image-preprocessing.js`, and `dist/image-preprocessing-worker.js` while external `sharp` and `@techstark/opencv-js` remain runtime imports.

- [ ] **Step 4: Run Docker build/import/health smoke and whitespace validation.**

Run the host built-artifact command from Step 2, then:

```bash
docker build -t bill-ledger-preprocessing-smoke .
docker run --rm --memory=256m --entrypoint bun bill-ledger-preprocessing-smoke -e 'import sharp from "sharp"; import { WorkerImagePreprocessor } from "./dist/image-preprocessing.js"; const bytes=await sharp({create:{width:64,height:64,channels:3,background:"white"}}).png().toBuffer(); const result=await new WorkerImagePreprocessor({timeoutMs:8000}).preprocess({bytes,mimeType:"image/png",mode:"sharp"}); if(!result||result.bytes[0]!==137)process.exit(1)'
docker run --rm --name bill-ledger-preprocessing-health -e APP_HOST=127.0.0.1 -e APP_PORT=3000 -e APP_DATA_DIR=/data -e WHATSAPP_ENABLED=false -e WHATSAPP_GROUP_ID=test@g.us -e WHATSAPP_AUTH_PATH=/data/whatsapp-auth -e MISTRAL_API_KEY=test -e MISTRAL_MODEL=test -e GOOGLE_ENABLED=false -e REVIEW_USERNAME=test -e REVIEW_PASSWORD=test -e IMAGE_PREPROCESSING_ENABLED=true bill-ledger-preprocessing-smoke sh -c 'bun dist/server.js & pid=$!; bun -e '\''for(let i=0;i<50;i++){try{const r=await fetch("http://127.0.0.1:3000/health");if(r.ok){process.exit(0)}}catch{}await Bun.sleep(100)}process.exit(1)'\''; code=$?; kill $pid; wait $pid || true; exit $code'
docker compose config >/dev/null
git diff --check
```

Expected: the Docker build-time layer initializes both external modules, the runtime container returns HTTP 200 without creating a provider job, the process stops, and `git diff --check` prints nothing.

## Research sources

- Sharp install guidance: https://sharp.pixelplumbing.com/install/
- Sharp API (`autoOrient`, input limits, `clahe`, `normalise`, `sharpen`, resize, PNG): https://sharp.pixelplumbing.com/api-operation/ and https://sharp.pixelplumbing.com/api-resize/
- OpenCV.js image processing and contours: https://docs.opencv.org/4.x/df/d24/tutorial_js_image_display.html and https://docs.opencv.org/4.x/d5/dae/tutorial_js_contours_begin.html
- OpenCV perspective transform API: https://docs.opencv.org/4.x/da/d54/group__imgproc__transform.html
- `@techstark/opencv-js` package: https://www.npmjs.com/package/@techstark/opencv-js
- `@techstark/opencv-js` source/release information: https://github.com/TechStark/opencv-js

## Self-review

- [x] **Spec coverage:** Tasks 1–3 cover pinned dependencies, Bun/Docker proof, WASM readiness, source/dist Worker resolution, external bundling, decode/time/size/pixel bounds, Sharp/OpenCV pipeline, cleanup, modes, and no colored-handwriting destruction. Tasks 2 and 4 cover configuration, immutable verified-original ordering, Worker termination/fallback, PDF bypass, durable input policy, lease fencing, and input-hash idempotency. Tasks 5–6 cover the measured baseline, six-call authorized evaluator, output redaction, fixed-auto release gate, retry-safe rollout/rollback, docs, and final verification.
- [x] **Scope check:** The plan explicitly excludes persistence, database migrations, multi-pass OCR, original writes, and currency removal.
- [x] **Placeholder scan:** No `TBD`, `TODO`, deferred implementation marker, or unspecified test/code step is used; the unmeasured live baseline is explicitly and truthfully stated because this plan must not call providers.
- [x] **Type consistency:** `ImagePreprocessor.preprocess`, its optional request mode, `PreprocessedImage`, `WorkerImagePreprocessor`, modes (`original`, `sharp`, `opencv`), `IMAGE_PREPROCESSING_VERSION`, Worker factory, and config names are identical throughout the tasks.
- [x] **Repository-policy check:** No commit step is included; commits require explicit authorization.
