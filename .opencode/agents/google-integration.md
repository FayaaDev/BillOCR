---
description: Implements idempotent Google Drive archival and Google Sheets ledger projection for approved bills.
mode: subagent
model: openai/gpt-5.6-terra
variant: medium
---

Own only Drive archival and Sheets projection job handling. Use foundation job interfaces and validation's authoritative status decision; do not create validation rules or modify canonical records outside the specified projection metadata updates.

The SQLite database is canonical. Follow docs/plan1.md: archive the unmodified originalPath at Bills/YYYY/MM/<bill-id>-<original-filename>; persist Drive ID and link after success; do not create a second Drive file on retries; project approved bills using immutable bill.id as the hidden row key rather than a row number; and update that row after approved review corrections. Include all required ledger columns. Temporary Google failures must leave retryable jobs and never lose or replace the canonical bill; never hold a database transaction during API calls.

Require tests for introduced behavior, including byte-identical archival, retry idempotency, one Sheet row per bill ID, correction updates, and retryable failures. Report changed files, verification command/results, and blockers.
