export type AdminOverview = {
  metrics: { received: number; approved: number; failed: number; retryableJobs: number; permanentFailureJobs: number };
  whatsapp: { state: "connecting" | "connected" | "awaiting_pairing" | "unavailable"; canPair: boolean; configuredGroupId: string | null; groups: Array<{ id: string; name: string | null }>; csrf: string };
  telegram: { enabled: boolean; groupIds: string[] };
  zip: { available: boolean; maxCompressedBytes: number; csrf: string };
};
export type AdminZipStatus = { batch: { id: string; originalFilename: string; state: "queued" | "processing" | "completed" | "failed" }; counts: { total: number; queued: number; processing: number; complete: number; notInvoice: number; rejected: number; failed: number }; items: Array<{ entryPath: string; state: "queued" | "processing" | "complete" | "not_invoice" | "rejected" | "failed"; errorCode: string | null; billId: string | null }> };

const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

/** Parses the deliberately small, safe payload used by the authenticated admin UI. */
export function parseAdminOverview(value: unknown): AdminOverview | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const metrics = record.metrics;
  const whatsapp = record.whatsapp;
  const telegram = record.telegram;
  const zip = record.zip;
  if (!metrics || typeof metrics !== "object" || !whatsapp || typeof whatsapp !== "object" || !telegram || typeof telegram !== "object" || !zip || typeof zip !== "object") return null;
  const metric = metrics as Record<string, unknown>;
  const channel = whatsapp as Record<string, unknown>;
  const upload = zip as Record<string, unknown>;
  const telegramChannel = telegram as Record<string, unknown>;
  const received = count(metric.received); const approved = count(metric.approved); const failed = count(metric.failed); const retryableJobs = count(metric.retryableJobs); const permanentFailureJobs = count(metric.permanentFailureJobs);
  const state = channel.state;
  const configuredGroupId = channel.configuredGroupId === null ? null : text(channel.configuredGroupId); const csrf = text(channel.csrf);
  const maxCompressedBytes = count(upload.maxCompressedBytes); const zipCsrf = text(upload.csrf);
  if (received === null || approved === null || failed === null || retryableJobs === null || permanentFailureJobs === null || (state !== "connecting" && state !== "connected" && state !== "awaiting_pairing" && state !== "unavailable") || typeof channel.canPair !== "boolean" || (channel.configuredGroupId !== null && !configuredGroupId) || !csrf || !Array.isArray(channel.groups) || typeof telegramChannel.enabled !== "boolean" || !Array.isArray(telegramChannel.groupIds) || typeof upload.available !== "boolean" || maxCompressedBytes === null || maxCompressedBytes < 1 || !zipCsrf) return null;
  const groups: AdminOverview["whatsapp"]["groups"] = [];
  for (const group of channel.groups) {
    if (!group || typeof group !== "object") return null;
    const item = group as Record<string, unknown>; const id = text(item.id);
    const name = item.name ?? item.subject;
    if (!id || (name !== null && name !== undefined && typeof name !== "string")) return null;
    groups.push({ id, name: name as string | null });
  }
  const groupIds: string[] = [];
  for (const groupId of telegramChannel.groupIds) { const id = text(groupId); if (!id || id.length > 512) return null; groupIds.push(id); }
  return { metrics: { received, approved, failed, retryableJobs, permanentFailureJobs }, whatsapp: { state, canPair: channel.canPair, configuredGroupId, groups, csrf }, telegram: { enabled: telegramChannel.enabled, groupIds }, zip: { available: upload.available, maxCompressedBytes, csrf: zipCsrf } };
}

export function parseAdminZipStatus(value: unknown): AdminZipStatus | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>; const batch = record.batch; const counts = record.counts;
  if (!batch || typeof batch !== "object" || !counts || typeof counts !== "object" || !Array.isArray(record.items)) return null;
  const batchRecord = batch as Record<string, unknown>; const countRecord = counts as Record<string, unknown>;
  const id = text(batchRecord.id); const originalFilename = text(batchRecord.originalFilename); const state = batchRecord.state;
  if (!id || !originalFilename || (state !== "queued" && state !== "processing" && state !== "completed" && state !== "failed")) return null;
  const parsedCounts = {} as AdminZipStatus["counts"];
  for (const key of ["total", "queued", "processing", "complete", "notInvoice", "rejected", "failed"] as const) { const value = count(countRecord[key]); if (value === null) return null; parsedCounts[key] = value; }
  const items: AdminZipStatus["items"] = [];
  for (const item of record.items) {
    if (!item || typeof item !== "object") return null;
    const entry = item as Record<string, unknown>; const entryPath = text(entry.entryPath); const itemState = entry.state; const errorCode = entry.errorCode; const billId = entry.billId;
    if (!entryPath || (itemState !== "queued" && itemState !== "processing" && itemState !== "complete" && itemState !== "not_invoice" && itemState !== "rejected" && itemState !== "failed") || (errorCode !== null && typeof errorCode !== "string") || (billId !== null && typeof billId !== "string")) return null;
    items.push({ entryPath, state: itemState, errorCode: errorCode as string | null, billId: billId as string | null });
  }
  return { batch: { id, originalFilename, state }, counts: parsedCounts, items };
}

export function adminZipTerminal(status: AdminZipStatus): boolean { return status.batch.state === "completed" || status.batch.state === "failed"; }

export function whatsappPairingView(state: AdminOverview["whatsapp"]["state"], canPair: boolean): "connected" | "waiting" | "qr" | "start" | "unavailable" {
  if (state === "connected") return "connected";
  if (state === "connecting") return "waiting";
  if (state === "awaiting_pairing") return "qr";
  return canPair ? "start" : "unavailable";
}
