export type AdminOverview = {
  metrics: { received: number; approved: number; failed: number; retryableJobs: number; permanentFailureJobs: number };
  whatsapp: { state: "connecting" | "connected" | "awaiting_pairing" | "unavailable"; canPair: boolean; configuredGroupId: string; groups: Array<{ id: string; name: string | null }>; csrf: string };
};

const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

/** Parses the deliberately small, safe payload used by the authenticated admin UI. */
export function parseAdminOverview(value: unknown): AdminOverview | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const metrics = record.metrics;
  const whatsapp = record.whatsapp;
  if (!metrics || typeof metrics !== "object" || !whatsapp || typeof whatsapp !== "object") return null;
  const metric = metrics as Record<string, unknown>;
  const channel = whatsapp as Record<string, unknown>;
  const received = count(metric.received); const approved = count(metric.approved); const failed = count(metric.failed); const retryableJobs = count(metric.retryableJobs); const permanentFailureJobs = count(metric.permanentFailureJobs);
  const state = channel.state;
  const configuredGroupId = text(channel.configuredGroupId); const csrf = text(channel.csrf);
  if (received === null || approved === null || failed === null || retryableJobs === null || permanentFailureJobs === null || (state !== "connecting" && state !== "connected" && state !== "awaiting_pairing" && state !== "unavailable") || typeof channel.canPair !== "boolean" || !configuredGroupId || !csrf || !Array.isArray(channel.groups)) return null;
  const groups: AdminOverview["whatsapp"]["groups"] = [];
  for (const group of channel.groups) {
    if (!group || typeof group !== "object") return null;
    const item = group as Record<string, unknown>; const id = text(item.id);
    const name = item.name ?? item.subject;
    if (!id || (name !== null && name !== undefined && typeof name !== "string")) return null;
    groups.push({ id, name: name as string | null });
  }
  return { metrics: { received, approved, failed, retryableJobs, permanentFailureJobs }, whatsapp: { state, canPair: channel.canPair, configuredGroupId, groups, csrf } };
}

export function whatsappPairingView(state: AdminOverview["whatsapp"]["state"], canPair: boolean): "connected" | "waiting" | "qr" | "start" | "unavailable" {
  if (state === "connected") return "connected";
  if (state === "connecting") return "waiting";
  if (state === "awaiting_pairing") return "qr";
  return canPair ? "start" : "unavailable";
}
