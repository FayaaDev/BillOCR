import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("production image ships both bundles and prepares named-volume mount points before dropping privileges", () => {
  const root = join(import.meta.dir, ".."); const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8"); const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  expect(packageJson.scripts.build).toContain("src/server.ts src/ops.ts src/image-preprocessing.ts src/image-preprocessing-worker.ts"); expect(packageJson.scripts.build).toContain("--external sharp --external @techstark/opencv-js"); expect(packageJson.scripts.build).toContain("src/review-client.tsx"); expect(packageJson.scripts["verify-build"]).toContain("dist/server.js"); expect(packageJson.scripts["verify-build"]).toContain("dist/ops.js"); expect(packageJson.scripts["verify-build"]).toContain("dist/image-preprocessing.js"); expect(packageJson.scripts["verify-build"]).toContain("dist/image-preprocessing-worker.js"); expect(packageJson.scripts["verify-build"]).toContain("dist/review/client.js"); expect(packageJson.scripts["verify-build"]).toContain("dist/review/client.css");
  expect(dockerfile).toContain("COPY --from=build --chown=bun:bun /app/dist ./dist"); expect(dockerfile).toContain("/data /data/originals /data/whatsapp-auth");
  expect(dockerfile).toContain('Promise.all([import("sharp"),import("@techstark/opencv-js")])');
  expect(dockerfile).not.toContain("Bun.sleep(10_000)");
  expect(dockerfile).toContain("clearTimeout(t)");
  expect(dockerfile.indexOf("chown -R bun:bun /app /data /run/secrets")).toBeLessThan(dockerfile.indexOf("USER bun"));
});

test("deployment resource and preprocessing worker contracts are static", () => {
  const root = join(import.meta.dir, ".."); const compose = readFileSync(join(root, "docker-compose.yml"), "utf8"); const worker = readFileSync(join(root, "src/image-preprocessing-worker.ts"), "utf8");
  expect(compose).toContain("mem_limit: 512m");
  expect(compose).toContain("ORIGINALS_DIR: /data/originals");
  expect(compose).not.toMatch(/telegram[^\n]*:\/data\//i);
  expect(worker).toContain('type Success = { ok: true; bytes: ArrayBuffer; mode: "sharp" | "opencv"; width: number; height: number };');
  expect(worker).toContain("workerScope.postMessage(response, [response.bytes])");
  expect(worker).toContain("workerScope.postMessage({ ok: false })");
});

test("environment sample documents both user OAuth credential paths", () => {
  const environment = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
  expect(environment).toContain("# GOOGLE_OAUTH_CLIENT_JSON=./secrets/google-oauth-client.json");
  expect(environment).toContain("# GOOGLE_OAUTH_CREDENTIAL_JSON=./secrets/google-authorized-user.json");
});
