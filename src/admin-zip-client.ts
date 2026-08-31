import { adminZipTerminal, type AdminZipStatus } from "./admin-dashboard";

export interface ZipUploadRequest {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  status: number;
  response: unknown;
  responseType: XMLHttpRequestResponseType;
  onload: ((...args: any[]) => unknown) | null;
  onerror: ((...args: any[]) => unknown) | null;
  upload: { onprogress: ((event: ProgressEvent) => void) | null };
}

export interface ZipUploadSessionOptions {
  createSourceId(): string;
  createRequest(): ZipUploadRequest;
  fetchStatus(batchId: string): Promise<AdminZipStatus | null>;
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
  onProgress(progress: number | null): void;
  onUploading(uploading: boolean): void;
  onStatus(status: AdminZipStatus): void;
  onError(): void;
}

export function zipUploadControlDisabled(available: boolean, hasFile: boolean, uploading: boolean): boolean {
  return !available || !hasFile || uploading;
}

/** Retains one opaque source ID until its batch reaches a terminal status. */
export class ZipUploadSession {
  #sourceId: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #generation = 0;

  constructor(private readonly options: ZipUploadSessionOptions) {}

  submit(file: File, csrf: string): void {
    const generation = ++this.#generation;
    const sourceId = this.#sourceId ??= this.options.createSourceId();
    const request = this.options.createRequest();
    this.clearTimer();
    this.options.onUploading(true);
    this.options.onProgress(0);
    request.open("POST", "/admin/api/zip");
    request.responseType = "json";
    request.setRequestHeader("content-type", "application/zip");
    request.setRequestHeader("x-csrf-token", csrf);
    request.setRequestHeader("x-upload-id", sourceId);
    request.setRequestHeader("x-upload-filename", encodeURIComponent(file.name));
    request.upload.onprogress = (event) => { if (this.current(generation) && event.lengthComputable) this.options.onProgress(Math.round((event.loaded / event.total) * 100)); };
    request.onload = () => {
      if (!this.current(generation)) return;
      this.options.onUploading(false);
      this.options.onProgress(null);
      const batchId = request.response && typeof request.response === "object" && "batch" in request.response && (request.response as { batch?: { id?: unknown } }).batch?.id;
      if (request.status !== 202 || typeof batchId !== "string") return this.options.onError();
      void this.refresh(batchId, generation);
    };
    request.onerror = () => { if (this.current(generation)) { this.options.onUploading(false); this.options.onProgress(null); this.options.onError(); } };
    request.send(file);
  }

  reset(): void { this.#generation += 1; this.#sourceId = null; this.clearTimer(); }

  async refresh(batchId: string, generation = this.#generation): Promise<void> {
    try {
      const status = await this.options.fetchStatus(batchId);
      if (!this.current(generation)) return;
      if (!status) return this.options.onError();
      this.options.onStatus(status);
      if (adminZipTerminal(status)) { this.#sourceId = null; this.clearTimer(); return; }
      this.clearTimer();
      this.#timer = this.options.schedule(() => { void this.refresh(batchId, generation); }, 2_000);
    } catch { if (this.current(generation)) this.options.onError(); }
  }

  dispose(): void { this.#generation += 1; this.clearTimer(); }

  private current(generation: number): boolean { return generation === this.#generation; }

  private clearTimer(): void {
    if (this.#timer !== null) this.options.cancel(this.#timer);
    this.#timer = null;
  }
}
