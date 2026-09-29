import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase } from "../src/db/database";
import { handleRequest } from "../src/backend/http";
import { createMonitorHandler, parseCustomers } from "../src/backend/monitor";
import type { AppConfig } from "../src/backend/config";
import type { DashboardMetrics } from "../src/backend/contracts";

const token = "a".repeat(40);
const customers = parseCustomers({ customers: [{ id: "one", name: '<img src=x>', url: "http://one:3000/monitor/status", token }, { id: "two", name: "Two", url: "http://two:3000/monitor/status", token: "b".repeat(40) }] });
const metrics = { receivedBills: 2, approvedBills: 1, failedBills: 0, retryableJobs: 1, permanentFailureJobs: 0 };

test("monitor endpoint discloses only metrics to the configured token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monitor-"));
  const db = new BillDatabase(join(dir, "db.sqlite"));
  const config = { monitorToken: token } as AppConfig;
  try {
    const url = "http://localhost/monitor/status";
    expect((await handleRequest(new Request(url), db, config)).status).toBe(401);
    expect((await handleRequest(new Request(url, { headers: { authorization: `Bearer ${token}x` } }), db, config)).status).toBe(401);
    const response = await handleRequest(new Request(url, { headers: { authorization: `Bearer ${token}` } }), db, config);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ metrics: { receivedBills: 0, approvedBills: 0, failedBills: 0, retryableJobs: 0, permanentFailureJobs: 0 } });
    expect((await handleRequest(new Request(url, { method: "POST", headers: { authorization: `Bearer ${token}` } }), db, config)).status).toBe(405);
    expect((await handleRequest(new Request(url), db, { ...config, monitorToken: undefined })).status).toBe(401);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("separate customer databases and tokens keep monitoring isolated", async () => {
  const dirs = [mkdtempSync(join(tmpdir(), "customer-one-")), mkdtempSync(join(tmpdir(), "customer-two-"))];
  const databases = dirs.map((dir) => new BillDatabase(join(dir, "db.sqlite")));
  try {
    databases[0]!.createBillWithInitialJobs({ id: "one", whatsappMessageId: "one", whatsappGroupId: "group", whatsappSenderId: "sender", attachmentIndex: 0, receivedAt: new Date().toISOString(), mimeType: "image/png", originalPath: join(dirs[0]!, "one.png"), contentSha256: "c".repeat(64) }, []);
    const url = "http://localhost/monitor/status";
    const first = await handleRequest(new Request(url, { headers: { authorization: `Bearer ${token}` } }), databases[0], { monitorToken: token } as AppConfig);
    const secondConfig = { monitorToken: "b".repeat(40) } as AppConfig;
    expect((await handleRequest(new Request(url, { headers: { authorization: `Bearer ${token}` } }), databases[1], secondConfig)).status).toBe(401);
    const second = await handleRequest(new Request(url, { headers: { authorization: `Bearer ${secondConfig.monitorToken}` } }), databases[1], secondConfig);
    expect((await first.json() as { metrics: DashboardMetrics }).metrics.receivedBills).toBe(1);
    expect((await second.json() as { metrics: DashboardMetrics }).metrics.receivedBills).toBe(0);
  } finally { databases.forEach((database) => database.close()); dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })); }
});

test("dashboard authenticates and separates online, failed and malformed customers", async () => {
  const seen: string[] = [];
  const fetcher = async (input: string, init: RequestInit) => {
    seen.push(`${input} ${new Headers(init?.headers).get("authorization")}`);
    if (String(input).includes("two")) return new Response("unavailable", { status: 503 });
    return Response.json({ metrics, health: { status: "ready", reasons: [] } });
  };
  const handler = createMonitorHandler(customers, "owner", "password123456789", fetcher);
  const url = "http://localhost/";
  expect((await handler(new Request(url))).status).toBe(401);
  expect((await handler(new Request(url, { headers: { authorization: "Basic " + btoa("owner:wrong") } }))).status).toBe(401);
  expect(seen).toEqual([]);
  await handler.poll();
  const response = await handler(new Request(url, { headers: { authorization: "Basic " + btoa("owner:password123456789") } }));
  const page = await response.text();
  expect(page).toContain("1 of 2 ready");
  expect(page).toContain("&lt;img src=x&gt;");
  expect(page).not.toContain('<img src=x>');
  expect(page).toContain("Unavailable");
  expect(page).not.toContain(token);
  expect(seen).toEqual([`http://one:3000/monitor/status Bearer ${token}`, `http://two:3000/monitor/status Bearer ${"b".repeat(40)}`]);
  expect((await handler(new Request(url, { method: "POST", headers: { authorization: "Basic " + btoa("owner:password123456789") } }))).status).toBe(405);
});

test("dashboard bounds and rejects invalid upstream data and duplicate customers", async () => {
  expect(() => parseCustomers({ customers: [customers[0], customers[0]] })).toThrow();
  expect(() => parseCustomers({ customers: [{ ...customers[0], url: "file:///etc/passwd" }] })).toThrow();
  expect(() => parseCustomers({ customers: [{ ...customers[0], token: "short" }] })).toThrow();
  const handler = createMonitorHandler([customers[0]!], "owner", "password123456789", async () => Response.json({ metrics: { ...metrics, approvedBills: -1 } }));
  await handler.poll();
  const page = await (await handler(new Request("http://localhost/", { headers: { authorization: "Basic " + btoa("owner:password123456789") } }))).text();
  expect(page).toContain("0 of 1 ready");
});

const dashboardRequest = () => new Request("http://localhost/", { headers: { authorization: "Basic " + btoa("owner:password123456789") } });
const healthRequest = () => new Request("http://localhost/health");

function clock() {
  let time = 0;
  let scheduled: (() => void) | undefined;
  const options = {
    now: () => time,
    schedule: ((callback: () => void, delay: number) => {
      expect(delay).toBe(30_000);
      scheduled = callback;
      return 1;
    }) as unknown as typeof setTimeout,
    cancel: (() => { scheduled = undefined; }) as typeof clearTimeout,
  };
  return { options, advance: (ms: number) => { time += ms; }, scheduled: () => Boolean(scheduled), fire: () => { const callback = scheduled; scheduled = undefined; callback?.(); } };
}

test("poll loop runs without browsers, caches results, exposes freshness and cleans up", async () => {
  const time = clock();
  let calls = 0;
  const handler = createMonitorHandler(customers, "owner", "password123456789", async () => {
    calls++;
    return Response.json({ metrics, health: { status: "ready", reasons: [] } });
  }, time.options);
  expect((await handler(healthRequest())).status).toBe(503);
  handler.start();
  handler.start();
  await handler.poll();
  expect(calls).toBe(2);
  expect(time.scheduled()).toBe(true);
  const health = await handler(healthRequest());
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: "ready" });
  expect(await (await handler(dashboardRequest())).text()).toContain("2 of 2 ready");
  expect(calls).toBe(2);
  time.advance(30_000);
  time.fire();
  await handler.poll();
  expect(calls).toBe(4);
  time.advance(40_001);
  expect((await handler(healthRequest())).status).toBe(503);
  expect(await (await handler(dashboardRequest())).text()).toContain("0 of 2 ready");
  await handler.stop();
  expect(time.scheduled()).toBe(false);
  handler.start();
  await handler.poll();
  expect(calls).toBe(4);
  expect((await handler(healthRequest())).status).toBe(503);
  expect((await handler(new Request("http://localhost/health", { method: "POST" }))).status).toBe(405);
});

test("degraded and missing health stay distinct from unavailable without exposing reasons", async () => {
  const time = clock();
  const logs: unknown[] = [];
  let payload: unknown = { metrics, health: { status: "degraded", reasons: [`secret ${token} <script>`] } };
  const handler = createMonitorHandler([customers[0]!], "owner", "password123456789", async () => Response.json(payload), { ...time.options, log: (event) => logs.push(event) });
  handler.start();
  await handler.poll();
  let page = await (await handler(dashboardRequest())).text();
  expect(page).toContain("Degraded");
  expect(page).not.toContain("Unavailable");
  expect(page).not.toContain(token);
  expect(JSON.stringify(logs)).not.toContain("secret");
  // Customer failures do not make the monitor's own functioning loop unready.
  expect((await handler(healthRequest())).status).toBe(200);
  for (const health of [undefined, {}, { status: "ready" }, { status: "ready", reasons: ["inconsistent"] }, { status: "bogus", reasons: [] }]) {
    payload = { metrics, health };
    await handler.poll();
    page = await (await handler(dashboardRequest())).text();
    expect(page).toContain("Degraded");
  }
  expect(logs).toHaveLength(1);
  await handler.stop();
});

test("transition alerts recover, retry failed webhooks and never flood delivered states", async () => {
  const time = clock();
  const logs: Array<Record<string, unknown>> = [];
  const deliveries: Array<Record<string, unknown>> = [];
  let state = "ready";
  let failWebhook = true;
  const handler = createMonitorHandler([customers[0]!], "owner", "password123456789", async (url, init) => {
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url === "https://alerts.invalid/hook?secret=private") {
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      expect(init.method).toBe("POST");
      deliveries.push(JSON.parse(String(init.body)));
      if (failWebhook) throw new Error(`private ${token}`);
      return new Response(null, { status: 204 });
    }
    if (state === "unavailable") return new Response("secret", { status: 503 });
    return Response.json({ metrics, health: { status: state, reasons: state === "ready" ? [] : [token] } });
  }, { ...time.options, webhookUrl: "https://alerts.invalid/hook?secret=private", log: (event) => logs.push(event) });
  await handler.poll();
  expect(logs).toEqual([]);
  state = "degraded";
  await handler.poll();
  await handler.poll();
  expect(deliveries).toHaveLength(2);
  expect(logs.map((event) => event.event)).toEqual(["monitor_transition", "monitor_webhook_failed"]);
  failWebhook = false;
  await handler.poll();
  await handler.poll();
  expect(deliveries).toHaveLength(3);
  state = "unavailable";
  await handler.poll();
  state = "ready";
  await handler.poll();
  await handler.poll();
  expect(deliveries.map((event) => event.status)).toEqual(["degraded", "degraded", "degraded", "unavailable", "ready"]);
  expect(logs.filter((event) => event.event === "monitor_transition").map((event) => [event.previous, event.status])).toEqual([["ready", "degraded"], ["degraded", "unavailable"], ["unavailable", "ready"]]);
  expect(Object.keys(deliveries[0]!).sort()).toEqual(["customerId", "event", "previous", "status", "timestamp"]);
  expect(JSON.stringify({ logs, deliveries })).not.toMatch(/private|secret|aaaaa|receivedBills|reasons/);
  await handler.stop();
});

test("failed stale webhook is replaced by recovery and HTTP rejection is retried", async () => {
  const delivered: string[] = [];
  let state = "degraded";
  let reject = true;
  const handler = createMonitorHandler([customers[0]!], "owner", "password123456789", async (url, init) => {
    if (url === "https://alerts.invalid/") {
      delivered.push(JSON.parse(String(init.body)).status);
      return new Response(null, { status: reject ? 500 : 204 });
    }
    return Response.json({ metrics, health: { status: state, reasons: [] } });
  }, { webhookUrl: "https://alerts.invalid/", log: () => {} });
  await handler.poll();
  state = "ready";
  reject = false;
  await handler.poll();
  await handler.poll();
  expect(delivered).toEqual(["degraded", "ready"]);
  await handler.stop();
});

test("failure count increases alert once without degrading readiness or alerting historical counts", async () => {
  const time = clock();
  const logs: Array<Record<string, unknown>> = [];
  const deliveries: Array<Record<string, unknown>> = [];
  let counts = { ...metrics, failedBills: 5, permanentFailureJobs: 3 };
  const handler = createMonitorHandler([customers[0]!], "owner", "password123456789", async (url, init) => {
    if (url === "https://alerts.invalid/") {
      deliveries.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    return Response.json({ metrics: counts, health: { status: "ready", reasons: [] } });
  }, { ...time.options, webhookUrl: "https://alerts.invalid/", log: (event) => logs.push(event) });
  await handler.poll();
  expect(logs).toEqual([]);
  expect(deliveries).toEqual([]);
  counts = { ...counts, failedBills: 6 };
  await handler.poll();
  await handler.poll();
  expect(logs).toEqual([{ event: "monitor_failures_increased", customerId: "one", timestamp: new Date(0).toISOString(), failedBills: 6, permanentFailureJobs: 3 }]);
  expect(deliveries).toEqual(logs);
  counts = { ...counts, permanentFailureJobs: 4 };
  await handler.poll();
  await handler.poll();
  expect(deliveries).toHaveLength(2);
  expect(deliveries[1]).toMatchObject({ failedBills: 6, permanentFailureJobs: 4 });
  counts = { ...counts, failedBills: 2, permanentFailureJobs: 1 };
  await handler.poll();
  expect(logs).toHaveLength(2);
  expect(await (await handler(dashboardRequest())).text()).toContain("1 of 1 ready");
  await handler.stop();
});

test("pending failure and readiness alerts coalesce independently and both survive recovery", async () => {
  const deliveries: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];
  let counts = { ...metrics };
  let state = "ready";
  let reject = true;
  const handler = createMonitorHandler([customers[0]!], "owner", "password123456789", async (url, init) => {
    if (url === "https://alerts.invalid/") {
      deliveries.push(JSON.parse(String(init.body)));
      return new Response(null, { status: reject ? 503 : 204 });
    }
    if (state === "unavailable") return new Response(null, { status: 503 });
    return Response.json({ metrics: counts, health: { status: state, reasons: [] } });
  }, { webhookUrl: "https://alerts.invalid/", log: (event) => logs.push(event) });
  await handler.poll();
  counts = { ...counts, failedBills: 1 };
  state = "degraded";
  await handler.poll();
  expect(deliveries.map((event) => event.event)).toEqual(["monitor_transition", "monitor_failures_increased"]);
  state = "unavailable";
  await handler.poll();
  // Counts use the last valid sample, including across unavailable polls.
  state = "ready";
  counts = { ...counts, failedBills: 2, permanentFailureJobs: 1 };
  reject = false;
  deliveries.length = 0;
  await handler.poll();
  expect(deliveries).toHaveLength(2);
  expect(deliveries[0]).toMatchObject({ event: "monitor_transition", previous: "unavailable", status: "ready" });
  expect(deliveries[1]).toMatchObject({ event: "monitor_failures_increased", failedBills: 2, permanentFailureJobs: 1 });
  await handler.poll();
  expect(deliveries).toHaveLength(2);
  expect(logs.filter((event) => event.event === "monitor_failures_increased")).toHaveLength(2);
  expect(logs.filter((event) => event.event === "monitor_transition").map((event) => event.status)).toEqual(["degraded", "unavailable", "ready"]);
  await handler.stop();
});

test("upstream bodies are bounded and malformed data is unavailable", async () => {
  for (const response of [
    new Response("x", { headers: { "content-length": "4097" } }),
    new Response("x".repeat(4097)),
    new Response("not json"),
    Response.json(null),
    Response.json({ metrics: { ...metrics, receivedBills: "2" } }),
  ]) {
    const logs: unknown[] = [];
    const handler = createMonitorHandler([customers[0]!], "owner", "password123456789", async () => response, { log: (event) => logs.push(event) });
    await handler.poll();
    expect(await (await handler(dashboardRequest())).text()).toContain("Unavailable");
    expect(logs).toHaveLength(1);
    await handler.stop();
  }
});

test("stop aborts in-flight fetch and overlapping polls share one request", async () => {
  let signal: AbortSignal | undefined;
  let calls = 0;
  const time = clock();
  const handler = createMonitorHandler([customers[0]!], "owner", "password123456789", async (_url, init) => {
    calls++;
    signal = init.signal!;
    return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  }, time.options);
  handler.start();
  const first = handler.poll();
  expect(handler.poll()).toBe(first);
  expect(calls).toBe(1);
  await handler.stop();
  expect(signal!.aborted).toBe(true);
  expect(time.scheduled()).toBe(false);
  expect((await handler(healthRequest())).status).toBe(503);
});

test("webhook URL validation never includes configured secrets", () => {
  for (const webhookUrl of ["invalid-secret", "file:///secret", "https://user:secret@alerts.invalid/", "https://alerts.invalid/#secret"]) {
    expect(() => createMonitorHandler(customers, "owner", "password123456789", async () => new Response(), { webhookUrl })).toThrow("Invalid MONITOR_ALERT_WEBHOOK_URL");
  }
});

test("upstream and webhook timeouts release the poll for a later retry", async () => {
  await Promise.all([false, true].map(async (webhook) => {
    let hang = true;
    let aborted = false;
    const logs: Array<Record<string, unknown>> = [];
    const handler = createMonitorHandler([customers[0]!], "owner", "password123456789", async (url, init) => {
      if (hang && (webhook ? url === "https://alerts.invalid/" : true)) {
        return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => {
          aborted = true;
          reject(new Error(`secret ${token}`));
        }, { once: true }));
      }
      return Response.json({ metrics, health: { status: webhook ? "degraded" : "ready", reasons: [] } });
    }, { webhookUrl: webhook ? "https://alerts.invalid/" : undefined, log: (event) => logs.push(event) });
    await handler.poll();
    expect(aborted).toBe(true);
    expect(logs.some((event) => event.event === (webhook ? "monitor_webhook_failed" : "monitor_transition"))).toBe(true);
    hang = false;
    await handler.poll();
    expect(JSON.stringify(logs)).not.toContain(token);
    await handler.stop();
  }));
});
