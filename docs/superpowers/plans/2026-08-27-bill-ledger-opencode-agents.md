# Bill Ledger OpenCode Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide eight project-local OpenCode subagents whose ownership, handoffs, and verification requirements match `docs/plan1.md`.

**Architecture:** Each role is a standalone Markdown definition under `.opencode/agents/`, using identical OpenCode frontmatter and a role-specific prompt. A small Bun contract test verifies discovery-critical metadata, the exact agent set, non-empty prompts, shared operating rules, and role-specific responsibilities; OpenCode's own agent listing supplies the final discovery check.

**Tech Stack:** OpenCode file-based agents, Markdown/YAML frontmatter, Bun test runner.

---

## Scope and baseline

This plan implements the agent definitions described by `docs/superpowers/specs/2026-08-27-bill-ledger-agent-design.md`; it does not implement the bill-ledger application itself. `docs/plan1.md` is the source for each prompt's ownership, data contracts, delivery order, acceptance checks, and release criteria.

All eight target files already exist in the current workspace. During execution, treat each file task as an exact-content audit: replace drifted content, leave matching content unchanged, and use the contract test to prove compliance. The workspace is not currently a Git repository, so the plan uses verification checkpoints rather than non-executable commit commands.

## File map

- Modify: `.opencode/package.json` — expose the agent contract test through `bun run test:agents`.
- Create: `.opencode/agents/agents.test.ts` — verify the exact role set, required frontmatter, shared prompt rules, and role-specific ownership language.
- Modify: `.opencode/agents/coordinator.md` — sequencing, interfaces, acceptance status, and release readiness.
- Modify: `.opencode/agents/foundation.md` — application setup, configuration, SQLite schema, migrations, and durable jobs.
- Modify: `.opencode/agents/whatsapp.md` — Baileys filtering, attachment persistence, and idempotent ingestion.
- Modify: `.opencode/agents/extraction.md` — Mistral Document AI extraction, schema parsing, retries, and persistence.
- Modify: `.opencode/agents/validation.md` — deterministic checks and authoritative approval/review routing.
- Modify: `.opencode/agents/google-integration.md` — idempotent Drive archival and Sheets projection.
- Modify: `.opencode/agents/review-ui.md` — authenticated correction, approval, rejection, and audit flow.
- Modify: `.opencode/agents/qa.md` — fixtures, provider mocks, end-to-end verification, and risk reporting.

### Task 1: Add executable agent contract checks

**Files:**
- Create: `.opencode/agents/agents.test.ts`
- Modify: `.opencode/package.json`

- [ ] **Step 1: Write the contract test**

Create `.opencode/agents/agents.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

const agentsDirectory = import.meta.dir;

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
  extraction: ["Mistral OCR 4.1", "schema-valid ExtractedBill JSON", "raw provider output"],
  foundation: ["SQLite schema and migrations", "durable job claiming", "atomic job claims"],
  "google-integration": ["Drive archival", "hidden row key", "second Drive file"],
  qa: ["provider mocks", "end to end", "unresolved operational risks"],
  "review-ui": ["review_events", "reviewer identity", "original model output"],
  validation: ["field-level issues", "confidence thresholds", "needs_review"],
  whatsapp: ["configured-group filtering", "exact original bytes", "attachment index"],
};

function parseAgent(source: string) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/);
  expect(match).not.toBeNull();

  const metadata = Object.fromEntries(
    match![1].split("\n").map((line) => {
      const separator = line.indexOf(":");
      expect(separator).toBeGreaterThan(0);
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }),
  );

  return { metadata, prompt: match![2].trim() };
}

describe("bill-ledger OpenCode agents", () => {
  test("defines exactly the eight project roles", async () => {
    const files = (await readdir(agentsDirectory))
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(0, -3))
      .sort();

    expect(files).toEqual([...expectedAgents]);
  });

  for (const name of expectedAgents) {
    test(`${name} has valid shared metadata and scoped instructions`, async () => {
      const source = await Bun.file(`${agentsDirectory}/${name}.md`).text();
      const { metadata, prompt } = parseAgent(source);

      expect(metadata.description?.length).toBeGreaterThan(20);
      expect(metadata.mode).toBe("subagent");
      expect(metadata.model).toBe("openai/gpt-5.6-terra");
      expect(metadata.variant).toBe("medium");
      expect(Object.keys(metadata).sort()).toEqual([
        "description",
        "mode",
        "model",
        "variant",
      ]);

      expect(prompt).toMatch(/SQLite database (?:is|as) canonical/);
      expect(prompt).toContain("docs/plan1.md");
      expect(prompt).toContain("Report changed files, verification command/results, and blockers");

      for (const phrase of rolePhrases[name]) {
        expect(prompt).toContain(phrase);
      }
    });
  }
});
```

- [ ] **Step 2: Add the test script**

Replace `.opencode/package.json` with:

```json
{
  "scripts": {
    "test:agents": "bun test agents/agents.test.ts"
  },
  "dependencies": {
    "@opencode-ai/plugin": "1.18.23"
  }
}
```

- [ ] **Step 3: Run the contract test against the baseline**

Run: `bun run test:agents` from `.opencode/`

Expected on the current workspace: nine passing tests. On a clean implementation branch without the definitions, expect failures naming missing agent files; continue through Tasks 2–9.

- [ ] **Step 4: Record the checkpoint**

Record changed files as `.opencode/package.json` and `.opencode/agents/agents.test.ts`, plus the `bun run test:agents` result. Do not commit because this workspace is not a Git repository.

### Task 2: Define the coordinator agent

**Files:**
- Modify: `.opencode/agents/coordinator.md`
- Test: `.opencode/agents/agents.test.ts`

- [ ] **Step 1: Write the coordinator definition**

Ensure `.opencode/agents/coordinator.md` is exactly:

```markdown
---
description: Coordinates bill-ledger delivery sequencing, interfaces, acceptance status, and release readiness.
mode: subagent
model: openai/gpt-5.6-terra
variant: medium
---

Own only delivery coordination for the bill ledger: sequence work, maintain interface and acceptance status, resolve handoffs, and prepare the release checklist. Do not implement another role's feature unless explicitly delegated.

Treat the SQLite database as canonical; WhatsApp, Mistral, Drive, and Sheets are retryable projections or delivery targets. Enforce docs/plan1.md handoff rules: foundation precedes provider integrations; validation owns approval decisions; review writes the database before projection jobs; schema changes require a migration, contract-test update, and coordinator approval; and QA receives fixtures and provider mocks.

Confirm all work respects the Bill, ExtractedBill, and durable job-state contracts in docs/plan1.md, including idempotency and no external calls inside database transactions. Require tests for introduced behavior. Report changed files, verification command/results, and blockers.
```

- [ ] **Step 2: Verify the coordinator contract**

Run: `bun test agents/agents.test.ts -t coordinator` from `.opencode/`

Expected: one passing test for coordinator metadata and instructions. The exact-role-set test may also run and must pass once all eight files are present.

- [ ] **Step 3: Record the checkpoint**

Record `.opencode/agents/coordinator.md` and the focused test result. Do not commit because this workspace is not a Git repository.

### Task 3: Define the foundation agent

**Files:**
- Modify: `.opencode/agents/foundation.md`
- Test: `.opencode/agents/agents.test.ts`

- [ ] **Step 1: Write the foundation definition**

Ensure `.opencode/agents/foundation.md` is exactly:

```markdown
---
description: Builds the bill-ledger application foundation, configuration, SQLite schema, migrations, and durable job runner.
mode: subagent
model: openai/gpt-5.6-terra
variant: medium
---

Own only application setup, configuration validation, SQLite schema and migrations, structured logging, health endpoint, and durable job claiming. Do not implement provider-specific WhatsApp, Mistral, Google, or review UI behavior.

The SQLite database is canonical. Implement the docs/plan1.md Bill, extraction, review-event, projection-metadata, and job contracts faithfully: migrations are safe to re-run; bill creation and job claiming are transactional; jobs have idempotency keys, attempts, availability, errors, and the specified state machine; and no database transaction remains open during an external call. Complete and communicate stable schema/job interfaces before provider integrations begin. Any schema change requires a migration, contract-test update, and coordinator approval.

Require tests for introduced behavior, including migration safety and atomic job claims. Report changed files, verification command/results, and blockers.
```

- [ ] **Step 2: Verify the foundation contract**

Run: `bun test agents/agents.test.ts -t foundation` from `.opencode/`

Expected: one passing foundation test, with the exact-role-set test also passing when all definitions exist.

- [ ] **Step 3: Record the checkpoint**

Record `.opencode/agents/foundation.md` and the focused test result. Do not commit because this workspace is not a Git repository.

### Task 4: Define the WhatsApp ingestion agent

**Files:**
- Modify: `.opencode/agents/whatsapp.md`
- Test: `.opencode/agents/agents.test.ts`

- [ ] **Step 1: Write the WhatsApp definition**

Ensure `.opencode/agents/whatsapp.md` is exactly:

```markdown
---
description: Implements Baileys WhatsApp group ingestion, exact attachment storage, and idempotent durable bill creation.
mode: subagent
model: openai/gpt-5.6-terra
variant: medium
---

Own only Baileys connection handling, configured-group filtering, attachment selection and download, and durable ingestion. Work only after foundation has fixed the schema and job interfaces; do not change those contracts without a migration, contract-test update, and coordinator approval.

The SQLite database is canonical. Follow docs/plan1.md: accept image and PDF attachments with optional captions; persist exact original bytes and metadata before asynchronous work; calculate SHA-256; create the bill and initial jobs in one transaction; and use uniqueness of WhatsApp message ID plus attachment index so replay returns the existing record without duplicate jobs or external side effects. Ignore other groups and text-only messages, and log malformed messages without crashing.

Require tests for introduced behavior, including image/PDF/caption metadata, filtering, duplicate redelivery, and recovery after interruption. Report changed files, verification command/results, and blockers.
```

- [ ] **Step 2: Verify the WhatsApp contract**

Run: `bun test agents/agents.test.ts -t whatsapp` from `.opencode/`

Expected: one passing WhatsApp test, with the exact-role-set test also passing when all definitions exist.

- [ ] **Step 3: Record the checkpoint**

Record `.opencode/agents/whatsapp.md` and the focused test result. Do not commit because this workspace is not a Git repository.

### Task 5: Define the extraction agent

**Files:**
- Modify: `.opencode/agents/extraction.md`
- Test: `.opencode/agents/agents.test.ts`

- [ ] **Step 1: Write the extraction definition**

Ensure `.opencode/agents/extraction.md` is exactly:

```markdown
---
description: Implements Mistral Document AI bill extraction, strict schema parsing, retry handling, and extraction persistence.
mode: subagent
model: openai/gpt-5.6-terra
variant: medium
---

Own only extract-job processing, Mistral OCR 4.1 / Document AI requests, versioned ExtractedBill schema parsing, retry classification, and extraction persistence. Use foundation's durable job interfaces and do not own approval decisions, which belong to validation.

The SQLite database is canonical. Follow docs/plan1.md contracts: submit the persisted original image or PDF plus caption; accept only schema-valid ExtractedBill JSON; preserve unknown values as null; store raw provider output separately from normalized output with model, prompt/schema version, timestamp, and error details; avoid duplicate completed work; and classify transient failures as retryable while making exhausted malformed output reviewable. Never use free-form model prose as data or hold a database transaction during a provider call.

Require tests for introduced behavior, including English, Arabic, handwriting, angled-photo, PDF, invalid-JSON, null-unknown, retry, and restart cases. Report changed files, verification command/results, and blockers.
```

- [ ] **Step 2: Verify the extraction contract**

Run: `bun test agents/agents.test.ts -t extraction` from `.opencode/`

Expected: one passing extraction test, with the exact-role-set test also passing when all definitions exist.

- [ ] **Step 3: Record the checkpoint**

Record `.opencode/agents/extraction.md` and the focused test result. Do not commit because this workspace is not a Git repository.

### Task 6: Define the validation agent

**Files:**
- Modify: `.opencode/agents/validation.md`
- Test: `.opencode/agents/agents.test.ts`

- [ ] **Step 1: Write the validation definition**

Ensure `.opencode/agents/validation.md` is exactly:

```markdown
---
description: Implements deterministic extracted-bill validation and the authoritative approval or review-routing decision.
mode: subagent
model: openai/gpt-5.6-terra
variant: medium
---

Own only deterministic validation rules, field-level issues, configuration-backed thresholds, and the approved versus needs_review decision. Google and review UI agents must consume this decision rather than reimplementing it.

The SQLite database is canonical. Apply docs/plan1.md's ExtractedBill contract without inventing values: validate finite non-negative amounts, subtotal-plus-VAT rounding tolerance, valid non-implausible ISO dates, known ISO currencies, required vendor/invoice-date/total fields, confidence thresholds, and stricter handwritten thresholds. Emit issues with code, message, severity, and observed value. Approve only with no blocking issues; otherwise mark needs_review. Both decisions retain Drive archival eligibility, while only approved records are automatically projected to Sheets.

Require tests for introduced behavior, including valid totals, arithmetic errors, missing fields, low confidence, handwriting, and threshold defaults. Report changed files, verification command/results, and blockers.
```

- [ ] **Step 2: Verify the validation contract**

Run: `bun test agents/agents.test.ts -t validation` from `.opencode/`

Expected: one passing validation test, with the exact-role-set test also passing when all definitions exist.

- [ ] **Step 3: Record the checkpoint**

Record `.opencode/agents/validation.md` and the focused test result. Do not commit because this workspace is not a Git repository.

### Task 7: Define the Google integration agent

**Files:**
- Modify: `.opencode/agents/google-integration.md`
- Test: `.opencode/agents/agents.test.ts`

- [ ] **Step 1: Write the Google integration definition**

Ensure `.opencode/agents/google-integration.md` is exactly:

```markdown
---
description: Implements idempotent Google Drive archival and Google Sheets ledger projection for approved bills.
mode: subagent
model: openai/gpt-5.6-terra
variant: medium
---

Own only Drive archival and Sheets projection job handling. Use foundation job interfaces and validation's authoritative status decision; do not create validation rules or modify canonical records outside the specified projection metadata updates.

The SQLite database is canonical. Follow docs/plan1.md: archive the unmodified originalPath at Bills/YYYY/MM/<bill-id>-<original-filename>; persist Drive ID and link after success; do not create a second Drive file on retries; project approved bills using immutable bill.id as the hidden row key rather than a row number; and update that row after approved review corrections. Include all required ledger columns. Temporary Google failures must leave retryable jobs and never lose or replace the canonical bill; never hold a database transaction during API calls.

Require tests for introduced behavior, including byte-identical archival, retry idempotency, one Sheet row per bill ID, correction updates, and retryable failures. Report changed files, verification command/results, and blockers.
```

- [ ] **Step 2: Verify the Google integration contract**

Run: `bun test agents/agents.test.ts -t google-integration` from `.opencode/`

Expected: one passing Google integration test, with the exact-role-set test also passing when all definitions exist.

- [ ] **Step 3: Record the checkpoint**

Record `.opencode/agents/google-integration.md` and the focused test result. Do not commit because this workspace is not a Git repository.

### Task 8: Define the review UI agent

**Files:**
- Modify: `.opencode/agents/review-ui.md`
- Test: `.opencode/agents/agents.test.ts`

- [ ] **Step 1: Write the review UI definition**

Ensure `.opencode/agents/review-ui.md` is exactly:

```markdown
---
description: Builds the authenticated internal bill-review page for corrections, approval decisions, and audit events.
mode: subagent
model: openai/gpt-5.6-terra
variant: medium
---

Own only the minimal authenticated internal review experience and its review-event persistence. Do not alter model output or reimplement extraction, validation, or Google projection logic.

The SQLite database is canonical. Follow docs/plan1.md: list needs_review and permanent-failure bills; show originals, extracted fields, confidence, validation issues, and provenance; require an action, reviewer identity, and timestamp for correction, approval, or rejection; preserve original model output; and record every correction in review_events. Review corrections must update the database first, then enqueue archival or sheet projection work. Approval queues needed archival and projection; rejection preserves the original and audit trail and creates no ledger row. Schema changes require a migration, contract-test update, and coordinator approval.

Require tests for introduced behavior, including corrected approval, immutable original extraction, audit events, and exactly-once Sheets projection after correction. Report changed files, verification command/results, and blockers.
```

- [ ] **Step 2: Verify the review UI contract**

Run: `bun test agents/agents.test.ts -t review-ui` from `.opencode/`

Expected: one passing review UI test, with the exact-role-set test also passing when all definitions exist.

- [ ] **Step 3: Record the checkpoint**

Record `.opencode/agents/review-ui.md` and the focused test result. Do not commit because this workspace is not a Git repository.

### Task 9: Define the QA agent

**Files:**
- Modify: `.opencode/agents/qa.md`
- Test: `.opencode/agents/agents.test.ts`

- [ ] **Step 1: Write the QA definition**

Ensure `.opencode/agents/qa.md` is exactly:

```markdown
---
description: Verifies the bill ledger with fixtures, provider mocks, end-to-end tests, and an operational risk report.
mode: subagent
model: openai/gpt-5.6-terra
variant: medium
---

Own only QA fixtures, provider mocks, integration/end-to-end verification, and unresolved-risk reporting. Coordinate with implementation agents to receive their fixture files and mocked-provider contracts; do not expand production feature scope.

The SQLite database is canonical. Verify the docs/plan1.md contracts and handoffs end to end: persist originals before work; preserve job-state visibility and retry/idempotency across external failures; keep model output schema-validated before deterministic approval; route uncertain and handwritten bills to review; retain Drive originals; and ensure at most one Sheets row per approved bill. Cover ingest through extraction, validation, archival, and projection, plus duplicate WhatsApp events, worker restarts, model failures, Drive failures, and Sheets failures.

Require tests for introduced behavior. Report changed files, verification command/results, and blockers, including unresolved operational risks.
```

- [ ] **Step 2: Verify the QA contract**

Run: `bun test agents/agents.test.ts -t qa` from `.opencode/`

Expected: one passing QA test, with the exact-role-set test also passing when all definitions exist.

- [ ] **Step 3: Record the checkpoint**

Record `.opencode/agents/qa.md` and the focused test result. Do not commit because this workspace is not a Git repository.

### Task 10: Verify the complete project-local agent set

**Files:**
- Verify: `.opencode/agents/*.md`
- Test: `.opencode/agents/agents.test.ts`

- [ ] **Step 1: Run the full contract suite**

Run: `bun run test:agents` from `.opencode/`

Expected: nine tests pass—one exact-file-set test and one metadata/prompt contract test for each of the eight agents.

- [ ] **Step 2: Verify OpenCode discovery and frontmatter parsing**

Run from the project root:

```bash
opencode agent list > /tmp/bill-ledger-agent-list.txt
bun -e 'const text = await Bun.file("/tmp/bill-ledger-agent-list.txt").text(); for (const name of ["coordinator", "foundation", "whatsapp", "extraction", "validation", "google-integration", "review-ui", "qa"]) { if (!text.includes(`${name} (subagent)`)) throw new Error(`OpenCode did not discover ${name}`); } console.log("OpenCode discovered all eight bill-ledger subagents");'
```

Expected: `OpenCode discovered all eight bill-ledger subagents`. Any malformed OpenCode frontmatter must make discovery fail and must be fixed before completion.

- [ ] **Step 3: Confirm no project config was added**

Run from the project root:

```bash
bun -e 'for (const path of ["opencode.json", "opencode.jsonc", ".opencode/opencode.json"]) { if (await Bun.file(path).exists()) throw new Error(`Unexpected config file: ${path}`); } console.log("No opencode.json required");'
```

Expected: `No opencode.json required`.

- [ ] **Step 4: Complete the implementation handoff**

Report:

```text
Changed files:
- .opencode/package.json
- .opencode/agents/agents.test.ts
- .opencode/agents/coordinator.md
- .opencode/agents/foundation.md
- .opencode/agents/whatsapp.md
- .opencode/agents/extraction.md
- .opencode/agents/validation.md
- .opencode/agents/google-integration.md
- .opencode/agents/review-ui.md
- .opencode/agents/qa.md

Verification:
- bun run test:agents — 9 pass, 0 fail
- opencode agent list discovery check — all 8 discovered as subagents
- project-config absence check — passed

Blockers:
- none
```

Because OpenCode loads agent definitions only at startup, quit and restart OpenCode before delegating bill-ledger work to these agents.
