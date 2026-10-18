# Fleet Console + CLI Plan (Plan 3 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser console page served by the Worker plus `ocd fleet` CLI subcommands, both driving the Plan 2 API: presence board, tap-links, per-box and global revoke, merged audit.

**Architecture:** Console is one dependency-free HTML page (vanilla JS + fetch) served from Worker static assets behind Cloudflare Access; CLI extends the existing cobra tree talking to the same API with a scoped token from env/OS keychain. New Worker endpoints only for CLI token mint/rotate/revoke (console uses Access session, no tokens).

**Tech Stack:** TypeScript Worker (existing), vanilla HTML/JS page, Go 1.27 + cobra (existing), vitest + Go tests.

**Spec:** `docs/superpowers/specs/2026-10-11-fleet-console-design.md`

## Global Constraints

- Console page: no frameworks, no build step beyond the existing Worker bundle; single HTML file + inline JS.
- Access protects `/console*` and `/api/*` browser paths; CLI token endpoints need a bootstrap secret (first-token flow documented in task).
- CLI tokens: scoped (link, revoke, audit-read subsets), rotatable, revocable; stored server-side as hashes only.
- Token value shown exactly once at mint (standard).
- Console reads bodies, not HTTP codes, for per-box results (Plan 2 ruling).
- Tombstoned/offline boxes render explicitly, never silently omitted.

## Review Focus

- Console renders a tainted box as actionable (revoke pending) rather than merely red: missing this repeats the sleeper-box theater.
- CLI token with link scope cannot revoke: scope enforcement tested per scope, not just happy path.
- Token value appears in logs, error bodies, or audit rows: values must never persist anywhere but the mint response.
- Revoke-all confirm is a deliberate two-step in both surfaces: single-tap nuke must be impossible.
- Audit view shows offline-box markers with last-synced time, not gaps: silent omission is the failure.

---

### Task 1: CLI token issue/rotate/revoke endpoints

**Files:**
- Create: `worker/src/tokens.ts`
- Test: `worker/test/tokens.test.ts`

**Interfaces:**
- Consumes: FleetState DO (new `cli_tokens` table via PRAGMA-gated migration).
- Produces: `POST /api/tokens` (bootstrap secret → `{token, id, scopes}`), `POST /api/tokens/:id/rotate`, `DELETE /api/tokens/:id`; verification helper `requireScope(token, scope)` for Tasks 2-4; hashes stored (SHA-256), values shown once.

- [ ] **Step 1: Write failing tests** (mint returns value once + hash stored; wrong bootstrap secret 403; rotate invalidates old; delete kills; scope check rejects insufficient)
- [ ] **Step 2: Run to verify they fail** (`npm test --prefix worker`, FAIL)
- [ ] **Step 3: Implement `worker/src/tokens.ts` + DO table + routes**
- [ ] **Step 4: Run to verify they pass** (PASS, `tsc --noEmit` clean)
- [ ] **Step 5: Commit** (`feat: CLI token lifecycle endpoints`)

---

### Task 2: Gate mutating API routes on scopes

**Files:**
- Modify: `worker/src/index.ts` (route guards)
- Test: extend `worker/test/` per-route auth tests

**Interfaces:**
- Consumes: `requireScope` (Task 1).
- Produces: link needs `link` scope, revoke/revoke-all need `revoke`, audit/backends read need `audit`; browser Access session bypasses token check ONLY when a valid Access JWT is present (else 401 even with no token).

**Access JWT validation:** verify `Cf-Access-Jwt-Assertion` against the team's JWKS (fetch + cache), check `aud` + expiry + allowlisted email (env `ACCESS_ALLOWED_EMAIL`, unset = deny-all fail-closed).

- [ ] **Step 1: Write failing tests** (each scope rejected where insufficient; Access JWT valid/invalid/expired; unset allowlist denies)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement guards in `worker/src/index.ts`**
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** (`feat: scope + Access guards on API`)

---

### Task 3: Console page

**Files:**
- Create: `worker/static/console.html` (served at `/console`), wired in `wrangler.toml` assets
- Test: `worker/test/console.test.ts` (serve 200 + content markers, no secrets in HTML)

**Interfaces:**
- Consumes: Plan 2 API shapes (backends list, link, revoke-all, audit).
- Produces: phone-first board — name, status dot, big LOGIN tap (direct 302 navigation, no copy-paste), per-box revoke with confirm, offline/tombstoned states explicit with last-synced, audit filter-by-box.

- [ ] **Step 1: Write failing tests** (route serves HTML with markers; no token strings embedded)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement page + serving + Access protection for `/console*`**
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** (`feat: fleet console page`)

---

### Task 4: ocd fleet CLI

**Files:**
- Create: `internal/fleet/` (client + commands), extend `internal/cli/cli.go`
- Test: `internal/fleet/*_test.go` (httptest Worker stub)

**Interfaces:**
- Consumes: Plan 2 API + Task 1 token endpoints (shapes pinned in worker tests).
- Produces: `ocd fleet status|link <box>|revoke <box>|nuke|audit [--box]` reading token from `OCD_FLEET_TOKEN` env (keychain integration explicitly out of scope, documented); nuke requires `--yes` plus typed box count confirm.

- [ ] **Step 1: Write failing tests** (status table render; link prints URL; nuke without --yes refuses; 401 surfaces cleanly)
- [ ] **Step 2: Run to verify they fail** (`go test ./internal/fleet/`, FAIL undefined)
- [ ] **Step 3: Implement `internal/fleet/` + cobra wiring**
- [ ] **Step 4: Run to verify they pass** (full `go test ./...`)
- [ ] **Step 5: Commit** (`feat: ocd fleet CLI`)
