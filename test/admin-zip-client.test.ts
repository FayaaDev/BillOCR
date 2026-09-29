import { expect, test } from "bun:test";
import { ZipUploadSession, zipUploadControlDisabled, type ZipUploadRequest } from "../src/frontend/admin-zip-client";
import type { AdminZipStatus } from "../src/frontend/admin-dashboard";

const pending = (id = "batch-1"): AdminZipStatus => ({ batch: { id, originalFilename: "bills.zip", state: "queued" }, counts: { total: 1, queued: 1, processing: 0, complete: 0, notInvoice: 0, rejected: 0, failed: 0 }, items: [{ entryPath: "invoice.pdf", state: "queued", errorCode: null, billId: null }] });
const complete = (id = "batch-1"): AdminZipStatus => ({ ...pending(id), batch: { id, originalFilename: "bills.zip", state: "completed" }, counts: { total: 1, queued: 0, processing: 0, complete: 1, notInvoice: 0, rejected: 0, failed: 0 }, items: [{ entryPath: "invoice.pdf", state: "complete", errorCode: null, billId: "bill-1" }] });

class Request implements ZipUploadRequest {
  status = 0; response: unknown = null; responseType: XMLHttpRequestResponseType = ""; onload: ((...args: any[]) => unknown) | null = null; onerror: ((...args: any[]) => unknown) | null = null;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  headers = new Map<string, string>(); body: Blob | null = null; method = ""; url = "";
  open(method: string, url: string): void { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string): void { this.headers.set(name, value); }
  send(body: Blob): void { this.body = body; }
}

test("ZIP client keeps a stable source ID across an XHR retry and sends CSRF headers", () => {
  const requests: Request[] = [];
  const session = new ZipUploadSession({ createSourceId: () => "opaque-upload-id", createRequest: () => { const request = new Request(); requests.push(request); return request; }, fetchStatus: async () => null, schedule: setTimeout, cancel: clearTimeout, onProgress: () => undefined, onUploading: () => undefined, onStatus: () => undefined, onError: () => undefined });
  const file = new File(["zip"], "فواتير.zip", { type: "application/zip" });
  session.submit(file, "csrf-token"); requests[0]!.onerror?.();
  session.submit(file, "csrf-token");
  for (const request of requests) {
    expect(request.method).toBe("POST"); expect(request.url).toBe("/admin/api/zip"); expect(request.responseType).toBe("json");
    expect(request.headers).toEqual(new Map([["content-type", "application/zip"], ["x-csrf-token", "csrf-token"], ["x-upload-id", "opaque-upload-id"], ["x-upload-filename", encodeURIComponent(file.name)]]));
  }
});

test("ZIP client fetches initial status, polls non-terminal batches, and stops once terminal", async () => {
  const requests: Request[] = []; const timers: Array<() => void> = []; const ids: string[] = []; const statuses: AdminZipStatus[] = [];
  const queue = [pending(), complete()];
  const session = new ZipUploadSession({ createSourceId: () => "opaque-upload-id", createRequest: () => { const request = new Request(); requests.push(request); return request; }, fetchStatus: async (id) => { ids.push(id); return queue.shift() ?? null; }, schedule: (callback) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; }, cancel: () => undefined, onProgress: () => undefined, onUploading: () => undefined, onStatus: (status) => statuses.push(status), onError: () => undefined });
  session.submit(new File(["zip"], "bills.zip"), "csrf-token");
  requests[0]!.status = 202; requests[0]!.response = { batch: { id: "batch-1" } }; requests[0]!.onload?.();
  await Promise.resolve(); await Promise.resolve();
  expect(ids).toEqual(["batch-1"]); expect(statuses).toEqual([pending()]); expect(timers).toHaveLength(1);
  timers[0]!(); await Promise.resolve(); await Promise.resolve();
  expect(ids).toEqual(["batch-1", "batch-1"]); expect(statuses).toEqual([pending(), complete()]); expect(timers).toHaveLength(1);
});

test("ZIP client retries a failed status poll instead of erroring", async () => {
  const requests: Request[] = []; const timers: Array<() => void> = []; const errors: string[] = []; const statuses: AdminZipStatus[] = [];
  const queue: Array<AdminZipStatus | null> = [pending(), null, complete()];
  const session = new ZipUploadSession({ createSourceId: () => "opaque-upload-id", createRequest: () => { const request = new Request(); requests.push(request); return request; }, fetchStatus: async () => queue.shift() ?? null, schedule: (callback) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; }, cancel: () => undefined, onProgress: () => undefined, onUploading: () => undefined, onStatus: (status) => statuses.push(status), onError: () => errors.push("error") });
  session.submit(new File(["zip"], "bills.zip"), "csrf-token");
  requests[0]!.status = 202; requests[0]!.response = { batch: { id: "batch-1" } }; requests[0]!.onload?.();
  await Promise.resolve(); await Promise.resolve();
  timers[0]!(); await Promise.resolve(); await Promise.resolve();
  timers[1]!(); await Promise.resolve(); await Promise.resolve();
  expect(errors).toEqual([]); expect(statuses).toEqual([pending(), complete()]);
});

test("ZIP client ignores a stale poll after reset starts a new upload session", async () => {
  let resolveFirst: ((status: AdminZipStatus | null) => void) | undefined;
  const requests: Request[] = []; const statuses: AdminZipStatus[] = []; const timers: Array<() => void> = [];
  const session = new ZipUploadSession({ createSourceId: () => `upload-${requests.length}`, createRequest: () => { const request = new Request(); requests.push(request); return request; }, fetchStatus: (id) => id === "batch-a" ? new Promise((resolve) => { resolveFirst = resolve; }) : Promise.resolve(pending("batch-b")), schedule: (callback) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; }, cancel: () => undefined, onProgress: () => undefined, onUploading: () => undefined, onStatus: (status) => statuses.push(status), onError: () => undefined });
  const file = new File(["zip"], "bills.zip");
  session.submit(file, "csrf"); requests[0]!.status = 202; requests[0]!.response = { batch: { id: "batch-a" } }; requests[0]!.onload?.();
  await Promise.resolve();
  session.reset();
  session.submit(file, "csrf"); requests[1]!.status = 202; requests[1]!.response = { batch: { id: "batch-b" } }; requests[1]!.onload?.();
  await Promise.resolve(); await Promise.resolve();
  resolveFirst?.(complete("batch-a"));
  await Promise.resolve(); await Promise.resolve();
  expect(statuses).toEqual([pending("batch-b")]);
  expect(timers).toHaveLength(1);
});

test("ZIP upload control is disabled while Azure ingestion is unavailable", () => {
  expect(zipUploadControlDisabled(false, true, false)).toBe(true);
  expect(zipUploadControlDisabled(true, true, false)).toBe(false);
});
