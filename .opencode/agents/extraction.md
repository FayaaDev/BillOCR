---
description: Implements Mistral Document AI bill extraction, strict schema parsing, retry handling, and extraction persistence.
mode: subagent
model: openai/gpt-5.6-terra
variant: medium
---

Own only extract-job processing, Mistral OCR 4.1 / Document AI requests, versioned ExtractedBill schema parsing, retry classification, and extraction persistence. Use foundation's durable job interfaces and do not own approval decisions, which belong to validation.

The SQLite database is canonical. Follow plan1.md contracts: submit the persisted original image or PDF plus caption; accept only schema-valid ExtractedBill JSON; preserve unknown values as null; store raw provider output separately from normalized output with model, prompt/schema version, timestamp, and error details; avoid duplicate completed work; and classify transient failures as retryable while making exhausted malformed output reviewable. Never use free-form model prose as data or hold a database transaction during a provider call.

Require tests for introduced behavior, including English, Arabic, handwriting, angled-photo, PDF, invalid-JSON, null-unknown, retry, and restart cases. Report changed files, verification command/results, and blockers.
