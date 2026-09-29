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

async function status(customer: Customer, fetcher: (url: string, init: RequestInit) => Promise<Response>): Promise<DashboardMetrics | null> {
  try {
    const response = await fetcher(customer.url, { headers: { authorization: `Bearer ${customer.token}` }, signal: AbortSignal.timeout(3000) });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 4096) { await response.body?.cancel(); return null; }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 4096) return null; chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const metrics: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))).metrics;
    if (!metrics || typeof metrics !== "object" || !fields.every((field) => { const value = (metrics as Record<string, unknown>)[field]; return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; })) return null;
    return metrics as DashboardMetrics;
  } catch { return null; }
}

export function createMonitorHandler(customers: Customer[], username: string, password: string, fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch) {
  return async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== "/") return new Response("Not found", { status: 404, headers });
    const auth = request.headers.get("authorization");
    let credentials = "";
    if (auth?.startsWith("Basic ") && auth.length < 1024) {
      try { credentials = Buffer.from(auth.slice(6), "base64").toString("utf8"); } catch { /* invalid credentials */ }
    }
    if (!equal(credentials, `${username}:${password}`)) return new Response("Authentication required", { status: 401, headers: { ...headers, "www-authenticate": 'Basic realm="Customer monitoring", charset="UTF-8"' } });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...headers, allow: "GET" } });
    const results = await Promise.all(customers.map((customer) => status(customer, fetcher)));
    const rows = customers.map((customer, index) => {
      const metrics = results[index];
      return `<tr><th scope="row">${escapeHtml(customer.name)}</th><td><span class="${metrics ? "online" : "offline"}">${metrics ? "Online" : "Unavailable"}</span></td>${fields.map((field) => `<td>${metrics ? metrics[field].toLocaleString("en-US") : "—"}</td>`).join("")}</tr>`;
    }).join("");
    const online = results.filter(Boolean).length;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Customer monitoring · Bill Ledger</title><style>body{font:16px system-ui;background:#f5f6f8;color:#18212f;margin:0;padding:clamp(1rem,4vw,3rem)}main{max-width:1100px;margin:auto}h1{font-size:1.8rem}p{color:#4d5969}.table{overflow-x:auto;background:white;border:1px solid #dce1e6;border-radius:12px}table{width:100%;border-collapse:collapse;text-align:left;white-space:nowrap}th,td{padding:1rem;border-bottom:1px solid #e8ebee}thead{background:#edf1f4}tr:last-child th,tr:last-child td{border-bottom:0}.online{color:#0b7244}.offline{color:#ad3030}.online,.offline{font-weight:700}th[scope=row]{font-weight:600}</style></head><body><main><h1>Customer monitoring</h1><p>${online} of ${customers.length} online · Checked ${escapeHtml(new Date().toISOString())} · Refreshes every 30 seconds</p><div class="table"><table><thead><tr><th scope="col">Customer</th><th scope="col">Status</th><th scope="col">Received</th><th scope="col">Approved</th><th scope="col">Failed</th><th scope="col">Retryable jobs</th><th scope="col">Permanent failures</th></tr></thead><tbody>${rows}</tbody></table></div></main></body></html>`;
    return new Response(html, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  };
}

if (import.meta.main) {
  const username = Bun.env.MONITOR_USERNAME;
  const password = Bun.env.MONITOR_PASSWORD;
  if (!username || !password || password.length < 16) throw new Error("MONITOR_USERNAME and MONITOR_PASSWORD (at least 16 characters) are required");
  const customers = parseCustomers(JSON.parse(readFileSync(Bun.env.MONITOR_CUSTOMERS_FILE ?? "/run/monitor/customers.json", "utf8")));
  Bun.serve({ hostname: Bun.env.APP_HOST ?? "127.0.0.1", port: Number(Bun.env.APP_PORT ?? 3000), fetch: createMonitorHandler(customers, username, password) });
}
