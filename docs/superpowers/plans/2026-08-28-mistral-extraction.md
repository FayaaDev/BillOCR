# Mistral Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably extract versioned bill JSON from persisted originals without making validation approval decisions.

**Architecture:** A Mistral HTTP adapter receives original image/PDF bytes as a data URL and requests only structured annotation. The extraction handler validates that annotation, atomically persists provenance and normalized output, and uses durable job retries for classified failures.

**Tech Stack:** Bun, TypeScript, SQLite, Mistral OCR HTTP API, Bun test.

---

### Task 1: Add schema, provider, and persistence boundaries
- [ ] Define strict `ExtractedBill` runtime validation and JSON schema.
- [ ] Implement injectable Mistral OCR adapter and error classification.
- [ ] Add extraction persistence and bill status methods to SQLite.

### Task 2: Add durable extraction processing
- [ ] Build an extract job handler that fences calls with `assertLease`, avoids duplicate completed work, and routes exhausted malformed output to review.
- [ ] Register the handler in the service using the configured provider.

### Task 3: Verify mock-driven behavior
- [ ] Test document variants, strict rejection/null preservation, retry classes/exhaustion, restart idempotency, and secret-safe logs.
- [ ] Run typecheck, tests, and build.

## Provider idempotency limitation

The handler forwards the durable job idempotency key as `Idempotency-Key` on every Mistral request and reuses it on replay. Mistral's OCR endpoint does not guarantee generic idempotency support, so a process crash after Mistral accepts a request but before SQLite commits the response can still incur a duplicate provider request. SQLite persistence occurs before job completion; once committed, replay returns the canonical extraction without another call.
