# Repository Instructions

## Commands

- Use Bun; the Docker image pins Bun 1.2. Install with `bun install --frozen-lockfile`.
- Required verification order: `bun run typecheck && bun test && bun run verify-build`. There is no separate lint or formatter command.
- Run one file with `bun test test/<name>.test.ts`; focus a case with `bun test test/<name>.test.ts -t '<test name>'`.
- Apply schema migrations with `bun run migrate`; start locally with `bun run start`; health is `GET http://127.0.0.1:3000/health`.
- For first-time WhatsApp auth, keep the service running and use `bun run whatsapp:qr`. The QR token is stored under `WHATSAPP_AUTH_PATH` with mode `0600` and must never be logged or committed.
- For personal Gmail OAuth, set the Desktop client input and a nonexistent credential output path, then run `bun run google:oauth` locally (not in Docker). The loopback flow writes a mode-`0600` credential and refuses overwrite.
- Local operations are `bun run ops inspect <id>`, `failed-jobs`, `retry [--include-permanent] <job-id>`, and `backup <directory>`. In the production image use `bun dist/ops.js ...`.

## Architecture and invariants

- `src/server.ts` is the composition root: HTTP, WhatsApp transport/ingestion, durable worker, extraction, validation, and Google handlers are wired there. Tests inject transports/providers through `startService` rather than contacting networks.
- SQLite is authoritative. WhatsApp is an input and Drive/Sheets are retryable projections; do not derive canonical state from provider state.
- Never hold a SQLite transaction across an external call. Job handlers must call the lease/revision guards from `JobHandlerContext` immediately before side effects and retain provider-specific idempotency.
- Validation alone controls automatic `approved` versus `needs_review`. Manual review is sticky; automatic extraction replay must not override a reviewer-superseded record.
- Sheet jobs are revision-specific, but the hidden immutable row identity is `bill.id`. Corrections update/reconcile that row; they must not append a second logical ledger row.
- Drive IDs are durably reserved before mutation. Never discard confirmed reservations. A reserved, unconfirmed ID generated under a different Google principal cannot be reused after switching service-account/OAuth identities and can produce HTTP 400; verify the remote file is absent before targeted reservation repair.
- Original attachments are immutable, flat direct children of `WHATSAPP_ORIGINALS_DIR`. Publication is no-clobber and DB SHA-256 must match disk bytes. Use `readVerifiedOriginal`; never replace it with pathname `readFile`/`stat` checks. Its descriptor-relative `openat` hardening intentionally supports Darwin and Linux only.
- Provider/model output is untrusted: keep Mistral structured-schema parsing strict, preserve raw and normalized output separately, retain size/time limits, and never use OCR prose as accounting data.
- Do not log raw Baileys/Mistral/Google errors, request bodies, auth state, QR values, or credentials. Baileys must keep its explicit silent logger.

## Schema and tests

- Schema changes are append-only entries in `src/migrations.ts`; never edit an applied migration. Update migration-count/schema tests and any contracts consumed by another phase.
- Preserve job transition history, claim-token fencing, bounded retry behavior, content/review revisions, and idempotency keys when changing database APIs.
- Tests must remain offline. Use injected Mistral/Drive/Sheets/Baileys adapters and fixtures under `test/fixtures/`; include replay/failure assertions for provider-facing changes.
- `dist/` is generated and ignored. Do not edit or commit bundles; `bun run verify-build` must produce both `dist/server.js` and `dist/ops.js`.

## Configuration and operations

- Bun auto-loads `.env`. `loadConfig` always requires WhatsApp group/auth, Mistral, and review credentials; Google file/IDs and the selected credential path are additionally required when `GOOGLE_ENABLED=true`. A real WhatsApp group JID ends in `@g.us`.
- Google auth modes are `service_account` (default, `GOOGLE_SERVICE_ACCOUNT_JSON`) and `user_oauth` (`GOOGLE_OAUTH_CREDENTIAL_JSON`). Personal-My-Drive service accounts have zero upload quota even when they can create folders; use Gmail OAuth or a properly supported Shared Drive rather than retrying the resulting 403.
- Compose remaps both Google credential filenames under `/run/secrets` and all data paths under `/data`; generate OAuth credentials on the host before starting Compose.
- Keep `.env`, `secrets/`, `data/`, WhatsApp auth, SQLite/WAL files, backups, and `dist/` out of source control and Docker build context.
- Backups are snapshot-first and copy only DB-referenced verified originals. Restore is intentionally supported only to the same absolute `WHATSAPP_ORIGINALS_DIR` recorded in the manifest.
- The review UI uses Basic auth and is local/internal only; any non-local deployment requires a TLS-terminating authenticated reverse proxy.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
