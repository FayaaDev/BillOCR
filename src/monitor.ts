import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DashboardMetrics } from "./contracts";

export type Customer = { id: string; name: string; url: string; token: string };
const fields = ["receivedBills", "approvedBills", "failedBills", "retryableJobs", "permanentFailureJobs"] as const;
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" };

export function parseCustomers(value: unknown): Customer[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { customers?: unknown }).customers)) throw new Error("Invalid monitor customers configuration");
  const customers = (value as { customers: unknown[] }).customers;
  if (!customers.length || customers.length > 100) throw new Error("Expected 1 to 100 customers");
  const ids = new Set<string>();
  return customers.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid customer");
    const { id, name, url, token } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-z0-9-]{1,40}$/.test(id) || ids.has(id) || typeof name !== "string" || !name.trim() || name.length > 100 || typeof token !== "string" || token.length < 32 || typeof url !== "string") throw new Error("Invalid or duplicate customer configuration");
    const parsed = new URL(url);
    if (!/^(http:|https:)$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/monitor/status") throw new Error("Invalid customer status URL");
    ids.add(id);
    return { id, name, url, token };
  });
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const equal = (a: string, b: string): boolean => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type State = "ready" | "degraded" | "unavailable";
type Snapshot = { state: State; metrics?: DashboardMetrics };
type Alert = { customerId: string; timestamp: string } & (
  { event: "monitor_transition"; previous: State | "unknown"; status: State } |
  { event: "monitor_failures_increased"; failedBills: number; permanentFailureJobs: number }
);
type MonitorOptions = {
  webhookUrl?: string;
  now?: () => number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
  log?: (event: Alert | { event: "monitor_webhook_failed"; customerId: string }) => void;
};
const pollInterval = 30_000;

async function status(customer: Customer, fetcher: Fetcher, signal: AbortSignal): Promise<Snapshot> {
  try {
    const response = await fetcher(customer.url, { headers: { authorization: `Bearer ${customer.token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), redirect: "error" });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 4096) { await response.body?.cancel(); return { state: "unavailable" }; }
    const reader = response.body?.getReader();
    if (!reader) return { state: "unavailable" };
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 4096) return { state: "unavailable" }; chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const { metrics, health } = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    if (!metrics || typeof metrics !== "object" || !fields.every((field) => { const value = (metrics as Record<string, unknown>)[field]; return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; })) return { state: "unavailable" };
    // Missing or inconsistent readiness must never look healthy. Reasons stay upstream.
    const ready = health?.status === "ready" && Array.isArray(health.reasons) && health.reasons.length === 0;
    return { state: ready ? "ready" : "degraded", metrics: Object.fromEntries(fields.map((field) => [field, metrics[field]])) as DashboardMetrics };
  } catch { return { state: "unavailable" }; }
}

export function createMonitorHandler(customers: Customer[], username: string, password: string, fetcher: Fetcher = fetch, options: MonitorOptions = {}) {
  if (options.webhookUrl) {
    let url: URL;
    try { url = new URL(options.webhookUrl); } catch { throw new Error("Invalid MONITOR_ALERT_WEBHOOK_URL"); }
    if (!/^(http:|https:)$/.test(url.protocol) || url.username || url.password || url.hash) throw new Error("Invalid MONITOR_ALERT_WEBHOOK_URL");
  }
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  const controller = new AbortController();
  let results: Snapshot[] = customers.map(() => ({ state: "unavailable" }));
  let checkedAt: number | undefined;
  let active: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let stopped = false;
  const lastMetrics = new Map<string, DashboardMetrics>();
  // One pending event per kind/customer: newer events coalesce without replacing other kinds.
  const pending = new Map<string, Alert>();
  const failedDeliveries = new Set<string>();
  const emit = (alert: Alert) => {
    log(alert);
    if (options.webhookUrl) pending.set(`${alert.customerId}:${alert.event}`, alert);
  };
  const fresh = () => checkedAt !== undefined && now() - checkedAt <= pollInterval + 10_000;
  const poll = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (active) return active;
    active = (async () => {
      const next = await Promise.all(customers.map((customer) => status(customer, fetcher, controller.signal)));
      if (stopped) return;
      next.forEach((snapshot, index) => {
        const customerId = customers[index]!.id;
        const timestamp = new Date(now()).toISOString();
        const previous = checkedAt === undefined ? "unknown" : results[index]!.state;
        if (previous !== snapshot.state && !(previous === "unknown" && snapshot.state === "ready")) {
          emit({ event: "monitor_transition", customerId, previous, status: snapshot.state, timestamp });
        }
        if (snapshot.metrics) {
          const previousMetrics = lastMetrics.get(customerId);
          const { failedBills, permanentFailureJobs } = snapshot.metrics;
          if (previousMetrics && (failedBills > previousMetrics.failedBills || permanentFailureJobs > previousMetrics.permanentFailureJobs)) {
            emit({ event: "monitor_failures_increased", customerId, timestamp, failedBills, permanentFailureJobs });
          }
          lastMetrics.set(customerId, snapshot.metrics);
        }
      });
      results = next;
      checkedAt = now();
      await Promise.all([...pending.entries()].map(async ([key, alert]) => {
        try {
          const response = await fetcher(options.webhookUrl!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(alert), redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
          await response.body?.cancel();
          if (!response.ok) throw new Error("Webhook rejected");
          pending.delete(key);
          failedDeliveries.delete(key);
        } catch {
          if (!stopped && !failedDeliveries.has(key)) {
            log({ event: "monitor_webhook_failed", customerId: alert.customerId });
            failedDeliveries.add(key);
          }
        }
      }));
    })().finally(() => { active = undefined; });
    return active;
  };
  const tick = async () => {
    try { await poll(); } finally {
      if (running && !stopped) timer = schedule(() => { void tick(); }, pollInterval);
    }
  };
  const handler = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...headers, allow: "GET" } });
      const ready = running && !stopped && fresh();
      return Response.json({ status: ready ? "ready" : "unavailable" }, { status: ready ? 200 : 503, headers });
    }
    if (path !== "/") return new Response("Not found", { status: 404, headers });
    const auth = request.headers.get("authorization");
    let credentials = "";
    if (auth?.startsWith("Basic ") && auth.length < 1024) {
      try { credentials = Buffer.from(auth.slice(6), "base64").toString("utf8"); } catch { /* invalid credentials */ }
    }
    if (!equal(credentials, `${username}:${password}`)) return new Response("Authentication required", { status: 401, headers: { ...headers, "www-authenticate": 'Basic realm="Customer monitoring", charset="UTF-8"' } });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...headers, allow: "GET" } });
    const cached = !stopped && fresh() ? results : customers.map((): Snapshot => ({ state: "unavailable" }));
    const rows = customers.map((customer, index) => {
      const { state, metrics } = cached[index]!;
      return `<tr><th scope="row">${escapeHtml(customer.name)}</th><td><span class="${state === "ready" ? "online" : "offline"}">${state === "ready" ? "Ready" : state === "degraded" ? "Degraded" : "Unavailable"}</span></td>${fields.map((field) => `<td>${metrics ? metrics[field].toLocaleString("en-US") : "—"}</td>`).join("")}</tr>`;
    }).join("");
    const online = cached.filter((result) => result.state === "ready").length;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Customer monitoring · Bill Ledger</title><style>body{font:16px system-ui;background:#f5f6f8;color:#18212f;margin:0;padding:clamp(1rem,4vw,3rem)}main{max-width:1100px;margin:auto}h1{font-size:1.8rem}p{color:#4d5969}.table{overflow-x:auto;background:white;border:1px solid #dce1e6;border-radius:12px}table{width:100%;border-collapse:collapse;text-align:left;white-space:nowrap}th,td{padding:1rem;border-bottom:1px solid #e8ebee}thead{background:#edf1f4}tr:last-child th,tr:last-child td{border-bottom:0}.online{color:#0b7244}.offline{color:#ad3030}.online,.offline{font-weight:700}th[scope=row]{font-weight:600}</style></head><body><main><h1>Customer monitoring</h1><p>${online} of ${customers.length} ready · Checked ${checkedAt === undefined ? "Not yet checked" : escapeHtml(new Date(checkedAt).toISOString())} · Refreshes every 30 seconds</p><div class="table"><table><thead><tr><th scope="col">Customer</th><th scope="col">Status</th><th scope="col">Received</th><th scope="col">Approved</th><th scope="col">Failed</th><th scope="col">Retryable jobs</th><th scope="col">Permanent failures</th></tr></thead><tbody>${rows}</tbody></table></div></main></body></html>`;
    return new Response(html, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  };
  return Object.assign(handler, {
    poll,
    start: () => { if (!running && !stopped) { running = true; void tick(); } },
    stop: async () => {
      stopped = true;
      running = false;
      if (timer !== undefined) cancel(timer);
      controller.abort();
      await active;
    },
  });
}

if (import.meta.main) {
  const username = Bun.env.MONITOR_USERNAME;
  const password = Bun.env.MONITOR_PASSWORD;
  if (!username || !password || password.length < 16) throw new Error("MONITOR_USERNAME and MONITOR_PASSWORD (at least 16 characters) are required");
  const customers = parseCustomers(JSON.parse(readFileSync(Bun.env.MONITOR_CUSTOMERS_FILE ?? "/run/monitor/customers.json", "utf8")));
  const monitor = createMonitorHandler(customers, username, password, fetch, { webhookUrl: Bun.env.MONITOR_ALERT_WEBHOOK_URL });
  const server = Bun.serve({ hostname: Bun.env.APP_HOST ?? "127.0.0.1", port: Number(Bun.env.APP_PORT ?? 3000), fetch: monitor });
  monitor.start();
  const shutdown = async () => {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
    await monitor.stop();
    await server.stop(true);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
