# Bill Ledger OpenCode Agent Design

## Purpose

Provide one project-local OpenCode subagent for every role in `plan1.md` so work can be delegated with clear ownership and minimal overlap.

## Location and model

Agent definitions will live in `.opencode/agents/`. Every definition will use `mode: subagent`, `model: openai/gpt-5.6-terra`, and `variant: medium`.

## Agents

| Agent | Scope |
| --- | --- |
| coordinator | Plan sequencing, interfaces, acceptance status, and release checklist. |
| foundation | Application setup, configuration, schema, migrations, and jobs. |
| whatsapp | Baileys listener, group filtering, downloads, and durable ingestion. |
| extraction | Azure Document Intelligence extraction, schema parsing, retries, and persistence. |
| validation | Deterministic checks and approval/review decisions. |
| google-integration | Idempotent Drive archive and Sheets projection. |
| review-ui | Authenticated correction and approval page with audit events. |
| qa | Fixtures, provider mocks, end-to-end verification, and risk report. |

## Common behavior

Each agent is confined to its stated ownership, preserves the SQLite database as canonical, writes tests for behavior it introduces, and reports changed files, verification commands/results, and blockers. Prompts reinforce the data contracts and handoff rules in `plan1.md` where relevant.

## Verification

Validate all eight files have valid OpenCode frontmatter and the required shared model, variant, and subagent mode. No `opencode.json` is required because file-based agents are auto-discovered.
