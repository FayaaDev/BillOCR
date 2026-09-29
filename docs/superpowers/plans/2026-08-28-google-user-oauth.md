# Google User OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the bill ledger authenticate Drive and Sheets as a personal Gmail user with an offline refresh token, while retaining existing service-account support.

**Architecture:** Add a credential union to the existing Google REST client and select it through `GOOGLE_AUTH_MODE`. A local one-time CLI uses the installed-app loopback flow with state and PKCE, then writes a standard `authorized_user` credential file with mode `0600`; the service only consumes that file and never logs its contents.

**Tech Stack:** Bun/TypeScript, Google OAuth 2.0 REST endpoints, Drive v3, Sheets v4, Bun tests.

---

### Task 1: OAuth credential support

**Files:**
- Modify: `src/backend/google-projections.ts`
- Test: `test/google-projections.test.ts`

- [ ] Write a failing test proving an `authorized_user` JSON document exchanges its refresh token at `https://oauth2.googleapis.com/token` using `grant_type=refresh_token`, `client_id`, and `client_secret`, then sends only the returned bearer access token to Drive.
- [ ] Add a strict `readGoogleCredential` parser accepting the existing service-account shape or `{type:"authorized_user",client_id,client_secret,refresh_token,token_uri?}` and rejecting incomplete values without including credential values in errors.
- [ ] Refactor `GoogleRestClient.accessToken()` to retain the existing JWT flow for service accounts and use the refresh-token grant for authorized users. Keep token caching, response limits, deadlines, and error sanitization unchanged.
- [ ] Run `bun test test/google-projections.test.ts`; expect all tests to pass.

### Task 2: Configuration and composition

**Files:**
- Modify: `src/backend/config.ts`
- Modify: `src/backend/server.ts`
- Modify: `test/config-logger.test.ts`
- Modify: affected typed `AppConfig` fixtures under `test/`

- [ ] Add failing configuration tests for `GOOGLE_AUTH_MODE=service_account` and `GOOGLE_AUTH_MODE=user_oauth`, including missing-file-setting errors and disabled Google behavior.
- [ ] Model Google authentication as a discriminated configuration: disabled, enabled service account with `GOOGLE_SERVICE_ACCOUNT_JSON`, or enabled user OAuth with `GOOGLE_OAUTH_CREDENTIAL_JSON`.
- [ ] Make `server.ts` read only the selected credential file and pass it to `createGoogleAdapters`; dependency-injected adapters must continue to avoid credential reads in offline tests.
- [ ] Run `bun run typecheck` and focused config/server tests; expect success.

### Task 3: One-time loopback authorization CLI

**Files:**
- Create: `src/backend/google-oauth.ts`
- Modify: `package.json`
- Test: `test/google-oauth.test.ts`

- [ ] Test parsing the Google Desktop client JSON, PKCE/state validation, token response validation, refusal to overwrite an existing credential, and atomic `0600` publication without exposing tokens.
- [ ] Implement `bun run google:oauth` using `GOOGLE_OAUTH_CLIENT_JSON` as input and `GOOGLE_OAUTH_CREDENTIAL_JSON` as output. Bind only `127.0.0.1` on an ephemeral port, request Drive and Sheets scopes with `access_type=offline` and `prompt=consent`, validate state, exchange the callback code with the PKCE verifier, and write `{type:"authorized_user",client_id,client_secret,refresh_token,token_uri}` atomically with mode `0600`.
- [ ] Print only the authorization URL, safe status messages, and recovery instructions; never print authorization codes, client secrets, access tokens, or refresh tokens.
- [ ] Run `bun test test/google-oauth.test.ts`; expect success.

### Task 4: Operator documentation and deployment mapping

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docker-compose.yml`

- [ ] Document creating a Google Cloud Desktop OAuth client, configuring the consent-screen test user, running `bun run google:oauth` locally, switching to `GOOGLE_AUTH_MODE=user_oauth`, sharing/choosing the Drive folder and spreadsheet under that same Gmail user, and restarting/retrying jobs.
- [ ] Document that refresh-token credentials are secrets, must remain outside source control, and may be revoked from the Google account.
- [ ] Map the OAuth credential file into `/run/secrets` for Compose without removing service-account compatibility.
- [ ] Verify `.env`, `secrets/`, token files, and generated bundles remain ignored/excluded.

### Task 5: Full verification

- [ ] Run `bun run typecheck && bun test && bun run verify-build` in the required order.
- [ ] Confirm `dist/server.js` and `dist/ops.js` are generated and no live Google calls occur in tests.
- [ ] Review all changed files for accidental credential/token logging and unrelated edits.
