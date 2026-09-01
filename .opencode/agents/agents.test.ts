import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

const expectedAgents = [
  "coordinator",
  "extraction",
  "foundation",
  "google-integration",
  "qa",
  "review-ui",
  "validation",
  "whatsapp",
] as const;

const rolePhrases: Record<(typeof expectedAgents)[number], readonly string[]> = {
  coordinator: ["sequence work", "release checklist", "handoff rules"],
  extraction: ["schema-valid ExtractedBill JSON", "raw provider output"],
  foundation: ["SQLite schema and migrations", "durable job claiming", "atomic job claims"],
  "google-integration": ["Drive archival", "hidden row key", "second Drive file"],
  qa: ["provider mocks", "end to end", "unresolved operational risks"],
  "review-ui": ["review_events", "reviewer identity", "original model output"],
  validation: ["field-level issues", "confidence thresholds", "needs_review"],
  whatsapp: ["configured-group filtering", "exact original bytes", "attachment index"],
};

function parseAgentPrompt(content: string) {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const match = normalizedContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*\S)\s*$/);

  if (!match) {
    throw new Error("Expected frontmatter followed by a non-empty prompt body");
  }

  const frontmatter = Object.fromEntries(
    match[1].split("\n").map((line) => {
      const [key, ...value] = line.split(":");
      return [key, value.join(":").trim()];
    }),
  );

  return { frontmatter, body: match[2] };
}

describe("agent prompt contracts", async () => {
  test("contains exactly the expected agents", async () => {
    const files = await readdir(import.meta.dir);
    const agents = files
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(0, -3))
      .sort();

    expect(agents).toEqual(expectedAgents);
  });

  for (const agent of expectedAgents) {
    test(`${agent} has the required metadata and prompt contract`, async () => {
      const content = await Bun.file(`${import.meta.dir}/${agent}.md`).text();
      const { frontmatter, body } = parseAgentPrompt(content);

      expect(frontmatter.description.length).toBeGreaterThan(20);
      expect(frontmatter.mode).toBe("subagent");
      expect(frontmatter.model).toBe("openai/gpt-5.6-terra");
      expect(frontmatter.variant).toBe("medium");
      expect(Object.keys(frontmatter).sort()).toEqual([
        "description",
        "mode",
        "model",
        "variant",
      ]);
      expect(body).toMatch(/SQLite database (?:is|as) canonical/);
      expect(body).toContain("plan1.md");
      expect(body).toContain("Report changed files, verification command/results, and blockers");

      for (const phrase of rolePhrases[agent]) {
        expect(body).toContain(phrase);
      }
    });
  }
});
