import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillDatabase } from "../src/database";
import { handleRequest } from "../src/http";
import { createMonitorHandler, parseCustomers } from "../src/monitor";
import type { AppConfig } from "../src/config";
import type { DashboardMetrics } from "../src/contracts";

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
    expect(await response.json()).toEqual({ metrics: { receivedBills: 0, approvedBills: 0, failedBills: 0, retryableJobs: 0, permanentFailureJobs: 0 } });
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
    return Response.json({ metrics });
  };
  const handler = createMonitorHandler(customers, "owner", "password123456789", fetcher);
  const url = "http://localhost/";
  expect((await handler(new Request(url))).status).toBe(401);
  expect((await handler(new Request(url, { headers: { authorization: "Basic " + btoa("owner:wrong") } }))).status).toBe(401);
  expect(seen).toEqual([]);
  const response = await handler(new Request(url, { headers: { authorization: "Basic " + btoa("owner:password123456789") } }));
  const page = await response.text();
  expect(page).toContain("1 of 2 online");
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
  const page = await (await handler(new Request("http://localhost/", { headers: { authorization: "Basic " + btoa("owner:password123456789") } }))).text();
  expect(page).toContain("0 of 1 online");
});
