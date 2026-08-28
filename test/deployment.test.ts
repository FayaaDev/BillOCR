import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("production image ships both bundles and prepares named-volume mount points before dropping privileges", () => {
  const root = join(import.meta.dir, ".."); const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8"); const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  expect(packageJson.scripts.build).toContain("src/server.ts src/ops.ts"); expect(packageJson.scripts.build).toContain("src/review-client.tsx"); expect(packageJson.scripts["verify-build"]).toContain("dist/server.js"); expect(packageJson.scripts["verify-build"]).toContain("dist/ops.js"); expect(packageJson.scripts["verify-build"]).toContain("dist/review/client.js"); expect(packageJson.scripts["verify-build"]).toContain("dist/review/client.css");
  expect(dockerfile).toContain("COPY --from=build --chown=bun:bun /app/dist ./dist"); expect(dockerfile).toContain("/data /data/originals /data/whatsapp-auth");
  expect(dockerfile.indexOf("chown -R bun:bun /app /data /run/secrets")).toBeLessThan(dockerfile.indexOf("USER bun"));
});
