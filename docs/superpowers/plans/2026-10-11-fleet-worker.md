# Fleet Worker API Plan (Plan 2 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker API that tracks box presence, relays mint/revoke/audit to boxes, and enforces sticky tombstones plus approve-on-sight enrollment.

**Architecture:** One Worker, one Durable Object class `FleetState` (SQLite backend) holding boxes, tokens, tombstones, pending enrollments. All box calls go to pinned hostnames only, with per-box deadlines and allSettled fan-out. No console page yet (Plan 3).

**Tech Stack:** TypeScript, vitest, wrangler 4, Durable Objects (SQLite backend).

**Spec:** `docs/superpowers/specs/2026-10-11-fleet-console-design.md`

## Global Constraints

- Node 24 (`~/sdk/node24`), wrangler 4, `worker/` dir in the ocd repo.
- Heartbeat 30s / stale 90s; seq + timestamp required, replays rejected.
- Box JSON contract (binding, from Plan 1): snake_case keys; presence `{"id","epoch","version","taps_24h"}`; revoke needs `{"confirm": true}`; mint needs `Idempotency-Key` header.
- Tombstones sticky: offline boxes get pending-revoke rows cleared only by confirmed rotation epoch.
- Enrollment approve-on-sight: unknown id or known id on new token → pending + Telegram approve/deny ping; token→id bound on approve.
- Fetch only pinned enrolled hostnames (SSRF rule); never heartbeat-supplied URLs.
- Secrets (box service tokens, Telegram bot token for pings) in Worker secrets, never in code.
- Fits Workers Paid included quotas; per-box deadline 5s reads / 15s mint.

## Review Focus

- Replay of a captured heartbeat keeps a dead box online: old seq rejected (Task 3 test pins it).
- Two boxes one id: token→id binding enforced, mismatch rejected + alerted (Task 4 test pins it).
- Retry after box timeout mints twice: idempotency key generated per console request, passed through (Task 5 test pins single key per retry chain).
- Revoke-all with a box offline: tombstone written, never silent skip (Task 6 test pins it).
- Crafted box id/URL reaches fetch: only pinned hostnames ever fetched (Task 2 test pins heartbeat-supplied URL refused).

---

### Task 1: Scaffold + FleetState skeleton

**Files:**
- Create: `worker/wrangler.toml`, `worker/package.json`, `worker/tsconfig.json`
- Create: `worker/src/index.ts`, `worker/src/state.ts`
- Test: `worker/test/scaffold.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: DO class `FleetState` with SQLite tables `boxes(id, hostname, heartbeat_token_hash, admin_token_hash, epoch, last_seq, last_seen, enrolled)`; `GET /api/backends` returns `[]` on empty state.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
// minimal fetch handler test via miniflare-style stub (see repo pattern once chosen)
describe("backends", () => {
  it("returns empty list on fresh state", async () => {
    const res = await app.fetch(new Request("http://x/api/backends"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/sdk/node24/bin:$PATH" npm test --prefix worker`
Expected: FAIL (no handler)

- [ ] **Step 3: Implement scaffold + DO + route in `worker/src/`**

Hono or bare fetch handler (builder's call, keep boring); `wrangler.toml` with `[[durable_objects.bindings]]` + SQLite `new_sqlite_classes`.

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/sdk/node24/bin:$PATH" npm test --prefix worker`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/
git commit -m "feat: worker scaffold with fleet state"
```

---

### Task 2: Heartbeat ingest with replay rejection + pinned-host fetch guard

**Files:**
- Create: `worker/src/heartbeat.ts`
- Test: `worker/test/heartbeat.test.ts`

**Interfaces:**
- Consumes: `FleetState` (Task 1).
- Produces: `POST /api/heartbeat` validates Bearer heartbeat token, rejects old seq/replayed timestamps, updates presence; helper `pinnedHostname(boxId)` used by ALL outbound calls (test: heartbeat-supplied URL never fetched).

- [ ] **Step 1: Write failing tests** (stale seq rejected; replayed timestamp rejected; unknown-hostname fetch refused)
- [ ] **Step 2: Run to verify they fail** (`npm test --prefix worker`, FAIL)
- [ ] **Step 3: Implement `worker/src/heartbeat.ts`**
- [ ] **Step 4: Run to verify they pass** (PASS)
- [ ] **Step 5: Commit** (`feat: heartbeat ingest with replay rejection`)

---

### Task 3: Enrollment approve-on-sight + Telegram ping

**Files:**
- Create: `worker/src/enroll.ts`
- Test: `worker/test/enroll.test.ts`

**Interfaces:**
- Consumes: `FleetState` (Task 1).
- Produces: unknown id OR known id on new token → `pending` row + Telegram approve/deny message (via Bot API, token from secret); `POST /api/enroll/approve|deny` resolves; approve binds token→id permanently.

- [ ] **Step 1: Write failing tests** (new id → pending + ping queued; approve binds; heartbeat with mismatched id rejected + alerted)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement `worker/src/enroll.ts`**
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** (`feat: approve-on-sight enrollment`)

---

### Task 4: Mint relay with idempotency

**Files:**
- Create: `worker/src/mint.ts`
- Test: `worker/test/mint.test.ts`

**Interfaces:**
- Consumes: pinned hostnames (Task 2), box `POST /admin/mint` contract (Idempotency-Key header, proxy URL body).
- Produces: `POST /api/backends/:id/link` generates one idempotency key per console request, passes it through, honors box 429/502 verbatim; 15s deadline; tainted-epoch boxes refused before fetch.

- [ ] **Step 1: Write failing tests** (same console retry reuses key; tainted box refused without fetch; box 429 surfaces)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement `worker/src/mint.ts`**
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** (`feat: mint relay with idempotency`)

---

### Task 5: Revoke + sticky tombstones

**Files:**
- Create: `worker/src/revoke.ts`
- Test: `worker/test/revoke.test.ts`

**Interfaces:**
- Consumes: pinned hostnames (Task 2), box `POST /admin/revoke` contract (`{"confirm": true}` → `{"epoch": N}`).
- Produces: `POST /api/backends/:id/revoke` + `POST /api/revoke-all` (server-side confirm required); offline boxes get tombstones; heartbeat epoch comparison clears them; per-box results in every response, never silent skip.

- [ ] **Step 1: Write failing tests** (offline box → tombstone row; stale-epoch heartbeat reads tainted; confirm missing → 400)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement `worker/src/revoke.ts`**
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** (`feat: revoke with sticky tombstones`)

---

### Task 6: Audit merge

**Files:**
- Create: `worker/src/audit.ts`
- Test: `worker/test/audit.test.ts`

**Interfaces:**
- Consumes: pinned hostnames (Task 2), box `GET /admin/audit?n=` contract (snake_case rows with `at` event timestamps).
- Produces: `GET /api/audit?box=&n=` parallel fan-out, 5s per-box deadline, allSettled with per-box error rows, sort by box event time, offline boxes as last-synced markers.

- [ ] **Step 1: Write failing tests** (slow box doesn't hang others; offline box marker; ordering by event time not receipt)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement `worker/src/audit.ts`**
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** (`feat: merged audit with watermarks`)
