import { expect, test } from "bun:test";
import { handleRequest } from "../src/http";

test("health endpoint reports service readiness", async () => {
  const response = await handleRequest(new Request("http://localhost/health"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
