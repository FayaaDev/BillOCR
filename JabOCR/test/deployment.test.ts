import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { loadConfig } from "../src/backend/config";
import { createReviewAuth, handleLoginRequest } from "../src/backend/review-auth";
import { handleReviewRequest } from "../src/backend/review-ui";
import { handleAdminRequest } from "../src/backend/admin-ui";
import { BillDatabase } from "../src/db/database";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppSidebar } from "../src/frontend/components/app-sidebar";
import { SidebarProvider } from "../src/frontend/components/ui/sidebar";

const root = join(import.meta.dir, "..");
const sample = parseEnv(readFileSync(join(root, ".env.example"), "utf8"));
const compose = Bun.YAML.parse(readFileSync(join(root, "docker-compose.yml"), "utf8")) as {
  name: string;
  networks?: unknown;
  services: Record<string, {
    build?: string;
    platform?: string;
    ports?: string[];
    environment: Record<string, string | number>;
    depends_on?: Record<string, { condition: string }>;
  }>;
};
const app = compose.services["bill-ledger"]!;
const environment = {
  ...sample,
  ...Object.fromEntries(Object.entries(app.environment).map(([key, value]) => [key, String(value)])),
  REVIEW_ORIGIN: `https://${sample.APP_DOMAIN}`,
};

test("standalone defaults load without messaging, Google credentials, or a monitor", () => {
  const config = loadConfig(environment);
  expect(config.azure.enabled).toBe(true);
  expect(config.mistral.apiKey).toBeNull();
  expect(config.whatsapp.enabled).toBe(false);
  expect(config.telegram.enabled).toBe(false);
  expect(config.google.enabled).toBe(false);
  expect(config.monitorToken).toBeUndefined();
  expect(config.originals.dir).toBe("/data/originals");
  expect(config.review.origin).toBe("https://bills.example.com");
});

test("all optional integrations accept customer-owned settings", () => {
  const config = loadConfig({
    ...environment,
    WHATSAPP_ENABLED: "true", WHATSAPP_GROUP_ID: "1234567890@g.us",
    TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_GROUP_IDS: "-1001234567890",
    GOOGLE_ENABLED: "true", GOOGLE_DRIVE_FOLDER_ID: "test-folder", GOOGLE_SHEET_ID: "test-sheet",
  });
  expect(config.whatsapp.groupId).toBe("1234567890@g.us");
  expect(config.telegram.groupIds).toEqual(["-1001234567890"]);
  expect(config.google.authMode).toBe("user_oauth");
  expect(config.google.credentialJson).toBe("/run/secrets/google-authorized-user.json");
  expect(() => loadConfig({ ...environment, REVIEW_ORIGIN: "https://127.0.0.1" })).toThrow("REVIEW_ORIGIN");
});

test("only HTTPS proxy publishes ports and it can start before WhatsApp pairing", () => {
  expect(compose.name).toBe("jabocr");
  expect(compose.networks).toBeUndefined();
  expect(app.build).toBe(".");
  expect(app.platform).toBe("linux/amd64");
  expect(app.ports).toBeUndefined();
  expect(app.environment.REVIEW_ORIGIN).toBe("https://${APP_DOMAIN:?Set APP_DOMAIN in .env}");
  expect(compose.services.caddy!.ports).toEqual(["80:80", "443:443"]);
  expect(compose.services.caddy!.depends_on?.["bill-ledger"]?.condition).toBe("service_started");
  const proxy = readFileSync(join(root, "Caddyfile"), "utf8");
  expect(proxy).toContain("{$APP_DOMAIN}");
  expect(proxy).toContain("reverse_proxy bill-ledger:3000");
  expect(proxy).toContain("header_up Host {host}");
});

test("login and dashboard use Advanced Elements branding and the supplied favicon", async () => {
  const config = loadConfig(environment); const auth = createReviewAuth(config);
  const brand = "Advanced Elements Billing System"; const logo = "/review/assets/jabocrlogo.png";
  const login = await handleLoginRequest(new Request(`${config.review.origin}/login`), config, auth);
  const failed = await handleLoginRequest(new Request(`${config.review.origin}/login`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "invalid", password: "invalid", return: "/admin" }),
  }), config, auth);
  expect(failed.status).toBe(401);
  for (const response of [login, failed]) {
    const html = await response.text();
    expect(html).toContain(brand);
    expect(html).toContain(`src="${logo}"`);
    expect(html).toContain(`rel="icon" href="${logo}"`);
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self'");
  }
  const session = auth.login(config.review.username, config.review.password, new Request(`${config.review.origin}/login`))!;
  const headers = { cookie: auth.cookie(session, new Request(`${config.review.origin}/login`)).split(";")[0]! };
  const database = new BillDatabase(":memory:");
  try {
    for (const response of [
      await handleAdminRequest(new Request(`${config.review.origin}/admin`, { headers }), config, undefined, undefined, auth),
      await handleReviewRequest(new Request(`${config.review.origin}/review`, { headers }), database, config, undefined, auth),
    ]) {
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`<title>${brand}</title>`);
      expect(html).toContain(`rel="icon" href="${logo}"`);
    }
    const sidebar = renderToStaticMarkup(createElement(SidebarProvider, null, createElement(AppSidebar, { view: "dashboard", logoutCsrf: "test" })));
    expect(sidebar).toContain(brand);
    expect(sidebar).toContain(`src="${logo}"`);
    expect(sidebar).toContain('lang="en" dir="ltr"');
  } finally { database.close(); }
});

test("only the supplied logo is public and it retains host enforcement", async () => {
  const config = loadConfig(environment); const auth = createReviewAuth(config); const database = new BillDatabase(":memory:");
  const assetDir = join(root, "assets"); const url = `${config.review.origin}/review/assets/jabocrlogo.png`;
  try {
    const response = await handleReviewRequest(new Request(url), database, config, assetDir, auth);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(readFileSync(join(assetDir, "jabocrlogo.png"))));
    const session = auth.login(config.review.username, config.review.password, new Request(`${config.review.origin}/login`))!;
    const cookie = auth.cookie(session, new Request(url)).split(";")[0]!;
    expect((await handleReviewRequest(new Request(url, { headers: { cookie } }), database, config, assetDir, auth)).status).toBe(200);
    expect((await handleReviewRequest(new Request(url, { headers: { host: "wrong.example.com" } }), database, config, assetDir, auth)).status).toBe(403);
    expect((await handleReviewRequest(new Request(url), database, config, join(root, "missing-branding"), auth)).status).toBe(404);
    for (const path of ["/review/assets/client.js", "/review/assets/favicon.png", "/review/api/bills"]) {
      expect((await handleReviewRequest(new Request(`${config.review.origin}${path}`), database, config, assetDir, auth)).status).toBe(401);
    }
  } finally { database.close(); }
});
