# Brain Phase 2 — the brain owns DNS and the history, and the Go half goes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a box enrols, the Worker creates its two DNS records itself; boxes push their audit rows so `/faudit` answers from the brain's history; the Go Telegram half is deleted.

**Architecture:** A new Worker `dns.ts` module ensures the two CNAMEs through the Cloudflare API after every successful enrol (idempotent: same records, same targets). The box's 30s sweep gains an audit push with a SQLite-backed watermark, reusing the existing `audit` event type. `/faudit` switches from the live fan-out to `audit_log`; the console's `GET /api/audit` is untouched. Then `internal/tg` + `internal/hook` are deleted and `serve.go` is unwired.

**Tech Stack:** TypeScript (Cloudflare Workers + Durable Objects, vitest), Go 1.27 (net/http, modernc.org/sqlite), Cloudflare v4 API (DNS records), Telegram Bot API (unchanged from Phase 1).

**Spec:** `docs/superpowers/specs/2026-10-20-brain-architecture-design.md` — Phase 2 (`### Phase 2`) plus the box<->brain protocols. The plan argues from the spec; the spec travels with it. Phase 1's plan (`docs/superpowers/plans/2026-10-20-brain-phase1.md`) is prior art for house patterns only.

## Global Constraints

- The Cloudflare token is scoped to DNS-edit on the `buyallmemes.com` zone — zone-scoped, not hostname-scoped, because Cloudflare scopes API tokens by zone, not by record. The brain only ever writes the two CNAMEs.
- Enrolment is the commit point: a DNS failure after a successful enrol is reported ("enrolled but DNS needs you"), never rolled back.
- The brain never computes a link's expiry. The box pushes `link-expired`. Unchanged.
- The event push from a box is best-effort, off the tap's critical path, with a 3 second timeout. A brain outage must never break an already-minted session. Unchanged.
- `POST /api/events` stays box-token-only and out of the CLI scope map.
- Every Telegram reply stays HTML-escaped; every command failure stays inside the command layer.
- Go changes must be `gofmt` clean and `golangci-lint run ./cmd/... ./internal/...` must report 0 issues.
- Worker changes must pass `npx tsc --noEmit` and `npx vitest run`.
- The plan and the design document are deliberately uncommitted. Do not `git add docs/superpowers/`.
- The box's `RouteDNS` calls in `SetupTunnel` stay: both writers produce identical records, and the box's call is what keeps a fresh onboard working when the brain is unreachable. The brain is the authority that guarantees the records; the box's call is a redundant ensure, not a second owner.

## Review Focus

1. **The brain is down (or its token is wrong) at onboard time.** Enrolment still commits; the box reports "enrolled but DNS needs you". — Task 3 pins the failing-DNS enrol path.
2. **A box re-enrols with a different tunnel id.** The brain must move both CNAMEs to the new target, not create duplicates. — Task 2 pins update-in-place.
3. **A box that enrolled before `tunnel_id` existed (home, mac).** Empty tunnel id: refuse loudly and skip, never create a record pointing nowhere. — Task 3 pins the empty-tunnel-id skip.
4. **Audit rows with identical (box, at, action) collapse in the dedup key.** Disclosed, accepted, pinned so it cannot silently change. — Task 5 pins the collapse.
5. **A token without DNS scope (or an expired one).** The error must name the missing scope, never swallowed into a bare 500. — Task 2 pins the 403 path.

---

## File structure

**Worker (new):**
- `worker/src/dns.ts` — the Cloudflare DNS writer plus tests in `worker/test/dns.test.ts`.

**Worker (modified):**
- `worker/src/state.ts` — `FleetEnv` gains the DNS token and zone id; the enrol paths call the DNS ensure; `/faudit` reads `audit_log`.
- `worker/src/enroll.ts` — the enrol handlers take the DNS deps; the response gains `dns: "ok" | "skipped: <reason>" | "failed: <reason>"`.
- `worker/wrangler.toml` — `CLOUDFLARE_ZONE_ID` as a plain var. The token arrives as a secret, never in the file.

**Go (modified):**
- `internal/store/links.go` — audit rows gain `rowid` on read (`RecentAuditSince`); the watermark lives in the existing `meta` table.
- `internal/cli/serve.go` — the sweep pushes audit rows newer than the watermark; all `tg.`/`hook.` wiring goes.

**Go (deleted):** `internal/tg/` (8 files), `internal/hook/` (2 files).

**Docs (modified):** `docs/architecture.md`, `docs/runbook-home.md`, `docs/runbook-mac.md`.

---

### Task 1: The Cloudflare token and the Worker secrets

**Files:**
- Modify: `worker/wrangler.toml` (add `CLOUDFLARE_ZONE_ID` var; value pinned in Step 1)
- None in git for the token: it arrives via `wrangler secret put`, never in a file.

**Interfaces:**
- Consumes: nothing.
- Produces: a Worker that can call the Cloudflare API as a zone-scoped DNS writer. Later tasks read `CLOUDFLARE_DNS_TOKEN` (secret) and `CLOUDFLARE_ZONE_ID` (var) from the Worker's env.

- [ ] **Step 1: Resolve the zone id**

Run: list zones via the Cloudflare API and pick `buyallmemes.com`.

Expected: exactly one zone. Record its id — every later step uses this value verbatim.

- [ ] **Step 2: Create the token**

Create a token named `ocd-brain-dns` with Zone/DNS/Write on exactly that zone id, nothing else.

Expected: the API returns a token value. It is shown once — pipe it straight into Step 3, never into chat, logs, or a file.

- [ ] **Step 3: Store the token and the zone id**

Run `wrangler secret put CLOUDFLARE_DNS_TOKEN` in `worker/` (paste once, never printed), and add `CLOUDFLARE_ZONE_ID = "<id from Step 1>"` to `wrangler.toml [vars]`.

Expected: `wrangler secret list` shows the name; the value itself is never printed.

- [ ] **Step 4: Prove the scope with a read-only call**

List the zone's DNS records with the new token.

Expected: 200 with the record list. A 403 here means the scope is wrong — stop, do not continue to Task 2.

- [ ] **Step 5: Commit**

```bash
git add worker/wrangler.toml
git commit -m "chore(worker): the brain's zone id for the DNS it owns"
```

---

### Task 2: The brain's DNS writer

**Files:**
- Create: `worker/src/dns.ts`
- Create: `worker/test/dns.test.ts`

**Interfaces:**
- Consumes: nothing (besides `fetch`).
- Produces:
  ```ts
  // The two hostnames the brain owns for one box, and where they point.
  export interface BoxDns {
    tapHost: string;    // oc-tap-<box>.buyallmemes.com
    uiHost: string;     // oc-<box>.buyallmemes.com
    target: string;     // <tunnel-id>.cfargotunnel.com
  }
  export type DnsOutcome =
    | { ok: true; created: string[]; updated: string[] }
    | { ok: false; reason: string };
  export async function ensureBoxDns(deps: {
    fetcher?: typeof fetch;
    zoneId: string;
    token: string;
  }, box: BoxDns): Promise<DnsOutcome>;
  ```
  Both records are `type: "CNAME"`, `proxied: true`, `ttl: 1` (automatic). The function lists the zone's records once, then creates what is missing and patches what points elsewhere. A record pointing at the right target is left alone. The reason never carries the token.

- [ ] **Step 1: Write the failing test for the create path**

In `worker/test/dns.test.ts`: a fake fetcher whose zone has no records for the box. Call `ensureBoxDns` with box `{tapHost: "oc-tap-mac.buyallmemes.com", uiHost: "oc-mac.buyallmemes.com", target: "tun-1.cfargotunnel.com"}`. Assert two POSTs to `/zones/<zone>/dns_records`, each `type CNAME`, `proxied true`, right name and content, result `{ok: true, created: [both], updated: []}`, and `Authorization: Bearer` on every call.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npx vitest run test/dns.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `ensureBoxDns` in `worker/src/dns.ts`**

Signature exactly as in the Interfaces block. List, then POST the missing and PATCH the stale. A non-2xx rejects with an error naming the status and the API's error code — never the token.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd worker && npx vitest run test/dns.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for update-in-place, no-op, and 403**

In the same file: (a) a record pointing at an old tunnel → one PATCH, `updated: [name]`, still exactly one record per name afterwards; (b) both records already correct → no POST, no PATCH; (c) the API answers 403 → rejection names the 403 and the API code, contains neither the token nor the word "token".

- [ ] **Step 6: Run them to verify they fail**

Run: `cd worker && npx vitest run test/dns.test.ts`
Expected: FAIL — only the create path exists.

- [ ] **Step 7: Implement the three paths**

Same file.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd worker && npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add worker/src/dns.ts worker/test/dns.test.ts
git commit -m "feat(worker): the brain writes the two CNAMEs a box needs"
```

---

### Task 3: The enrolment creates the DNS records

**Files:**
- Modify: `worker/src/enroll.ts`
- Modify: `worker/src/state.ts`
- Modify: `worker/test/enroll.test.ts` (extend)

**Interfaces:**
- Consumes: `ensureBoxDns` from Task 2; `tunnel_id` already on the pending row and the box row (Phase 1 fix wave — verify, do not re-add).
- Produces: every enrol response carries `dns: "ok" | "skipped: <reason>" | "failed: <reason>"`. The box row is always written first — DNS never blocks enrolment and never rolls it back.

- [ ] **Step 1: Write the failing test for the happy path**

In `worker/test/enroll.test.ts`: a claim with `tunnel_id: "tun-9"` on the pending row and a fake Cloudflare API behind `ensureBoxDns`'s deps. Assert the enrol response is `enrolled` **and** carries `dns: "ok"`, and that both CNAMEs were created for `oc-<box>` / `oc-tap-<box>` pointing at `tun-9.cfargotunnel.com`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npx vitest run test/enroll.test.ts`
Expected: FAIL — no DNS step runs on enrol.

- [ ] **Step 3: Wire the DNS ensure into both enrol paths**

In `worker/src/enroll.ts`: after the box row is written (the fast path and the claim path — check both write sites), call `ensureBoxDns` with the zone id + token from the Worker's env and the box's `tunnel_id`. A rejection becomes `dns: "failed: <reason>"` on the response; the enrol status stays `enrolled`.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd worker && npx vitest run test/enroll.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for empty tunnel id and failing DNS**

In the same file: (a) a claim whose pending row has `tunnel_id: ""` (a box that enrolled before the field existed — home and mac today) → enrol succeeds, response carries `dns` starting with `"skipped:"`, and the Cloudflare API is never called; (b) the API 403s → enrol succeeds and the response carries `dns` starting with `"failed:"` and naming the 403.

- [ ] **Step 6: Run them to verify they fail**

Run: `cd worker && npx vitest run test/enroll.test.ts`
Expected: FAIL — no skip, no failure report.

- [ ] **Step 7: Implement the skip and the failure report**

Same files. The skip reason names the box (`no tunnel id recorded for <box> — re-enrol to bind one`).

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd worker && npx vitest run && npx tsc --noEmit`
Expected: PASS (whole suite), no type errors.

- [ ] **Step 9: Commit**

```bash
git add worker/src/enroll.ts worker/src/state.ts worker/test/enroll.test.ts
git commit -m "feat(worker): every enrolment leaves with its DNS ensured"
```

---

### Task 4: The box pushes its audit rows

**Files:**
- Modify: `internal/store/links.go` (add `RecentAuditSince(rowid)`)
- Modify: `internal/cli/serve.go` (the sweep pushes audit rows too)

**Interfaces:**
- Consumes: `boxagent.Event{Type: "audit", ...}` and `boxagent.PushEvents` (Phase 1).
- Produces: after each sweep, every local audit row has been offered to the brain exactly once per successful push. Watermark is max `rowid` pushed, kept in the existing `meta` table (same pattern as `heartbeat_seq`).

- [ ] **Step 1: Write the failing test for the watermark read**

In the store's audit test file: insert three audit rows, assert `RecentAuditSince(0)` returns all three in rowid order, then assert `RecentAuditSince(<second rowid>)` returns only the third.

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./internal/store/ -run TestRecentAuditSince -v`
Expected: FAIL — `undefined`.

- [ ] **Step 3: Implement `RecentAuditSince` in `internal/store/links.go`**

`SELECT rowid, at, actor, action, device, ip, result, ua FROM audit WHERE rowid > ? ORDER BY rowid LIMIT ?` (cap the batch at 100, like the link sweep's batch of 50 — pick the constant and name it). Watermark key `audit_watermark`, default 0.

- [ ] **Step 4: Run it to verify it passes**

Run: `go test ./internal/store/ -run TestRecentAuditSince -v`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the sweep**

In `serve_internal_test.go` style: a store with two audit rows and a fake brain that answers 200. Run one sweep. Assert both rows arrived as `audit` events with their fields intact, and that a second sweep sends nothing (the watermark advanced).

- [ ] **Step 6: Run it to verify it fails**

Run: `go test ./internal/cli/ -run TestSweepPushesAuditRows -v`
Expected: FAIL — the sweep sends no audit events.

- [ ] **Step 7: Extend the sweep**

In `internal/cli/serve.go`: after the dead-link push, read the watermark from `meta`, push `RecentAuditSince(watermark)` as one events batch (same 3s push, same best-effort rule as the link push), and on success write back the max rowid. On failure the watermark stays and the next sweep retries. A box with no brain configured pushes nothing (existing guard covers both).

- [ ] **Step 8: Write the failing test for the dedup collapse, then make it pass**

Two audit rows in the same second for one box arrive at the brain; assert the table holds one row (Review Focus item 4 — disclosed behavior, pinned so it cannot silently change). This test lives on the Worker side (`worker/test/events.test.ts` pattern); run it with `cd worker && npx vitest run test/events.test.ts`.

- [ ] **Step 9: Run both suites green, then commit**

Run: `go test ./... -count=1` and `cd worker && npx vitest run`
Expected: PASS both.
```bash
git add internal/store/links.go internal/cli/serve.go internal/store/*_test.go internal/cli/*_test.go worker/test/events.test.ts
git commit -m "feat(box): the sweep pushes audit rows, newest-watermark first"
```

---

### Task 5: `/faudit` reads the brain's history

**Files:**
- Modify: `worker/src/state.ts` (the `/faudit` command's `audit` dep — find where Phase 1 wired the fan-out)
- Modify: `worker/test/botcommands.test.ts` (extend)

**Interfaces:**
- Consumes: `audit_log` rows as written by the ingest (Phase 1 Task 9, unchanged).
- Produces: `/faudit [box]` answers from `audit_log`, including rows for boxes that are offline or no longer enrolled. The console's `GET /api/audit` keeps fanning out — do not touch `worker/src/audit.ts` or its route.

- [ ] **Step 1: Write the failing test**

In `worker/test/botcommands.test.ts`: seed `audit_log` with rows for an offline box and a box that is not enrolled, with no live box behind them. Run `/faudit`. Assert the reply lists the rows. Then `/faudit <box>` and assert only that box's rows.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npx vitest run test/botcommands.test.ts`
Expected: FAIL — the fan-out returns an error marker instead of the rows.

- [ ] **Step 3: Switch the source**

Point the implementation at `audit_log` (parameterized box filter, `ORDER BY at DESC`, limit). Leave `fetchAudits` and the console's `GET /api/audit` route exactly as they are — different tool, different contract.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd worker && npx vitest run test/botcommands.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the empty history, make it pass, run the suite**

`/faudit` for a box with no rows answers "No audit rows." Then: `cd worker && npx vitest run && npx tsc --noEmit` — PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add worker/src/state.ts worker/test/botcommands.test.ts
git commit -m "feat(worker): /faudit answers from the brain's own history"
```

---

### Task 6: The Go half goes

**Files:**
- Delete: `internal/tg/` (9 files), `internal/hook/` (2 files).
- Modify: `internal/cli/serve.go` (remove the Telegram wiring only).
- Modify: `go.mod`/`go.sum` (via `go mod tidy`).

**Interfaces:**
- Consumes: nothing.
- Produces: `go build ./...` with no Telegram code anywhere; the daemon log no longer mentions telegram at all.

- [ ] **Step 1: Delete the two packages and unwire serve.go**

Delete `internal/tg/` and `internal/hook/` (`git rm -r`). In `internal/cli/serve.go`: remove `tg.Start`, `SetWebhook`/`DeleteWebhook`, `Dispatch`/`DispatchCallback`, the webhook mux, the hook secret/path generation, and the OCD_TG_*/OCD_WEBHOOK_BASE/OCD_GROUP_ID env reads. Everything else stays: `/pair`, `/_oc/*`, heartbeat, link sweep, audit push.

- [ ] **Step 2: Tidy and verify the build**

Run: `go mod tidy && gofmt -l ./cmd ./internal && go build ./... && go vet ./...`
Expected: clean on all four — and `grep -rn go-telegram go.mod` empty.

- [ ] **Step 3: Run the full Go suite and the linter**

Run: `go test ./... -count=1` and `golangci-lint run ./cmd/... ./internal/...`
Expected: PASS, 0 issues. Deleted tests go with their packages; nothing else may break.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat!: the Go bot is gone; the brain owns Telegram"
```

The `!` is deliberate: any out-of-tree script importing `internal/tg` breaks. Nothing in the repo does (verified: only `serve.go` imported it).

---

### Task 7: Docs and cutover

**Files:**
- Modify: `docs/architecture.md`, `docs/runbook-home.md`, `docs/runbook-mac.md`.

**Interfaces:**
- Consumes: everything above.
- Produces: docs that describe the system as it is — no Telegram on any box, the brain owns DNS and history, `/faudit` reads the brain.

- [ ] **Step 1: Update the three docs**

`docs/architecture.md`: the bot lives in the Worker; the Worker owns Telegram, DNS and history; the box serves `/pair`, `/_oc/*`, heartbeats and event pushes — and nothing else. `docs/runbook-home.md`: lose the Telegram-on-the-box steps (already half-true since the cutover); the daemon is heartbeat + pair + box API + sweeps. `docs/runbook-mac.md`: unchanged except where it mentions the box-side bot (if it does — check first, do not invent edits).

- [ ] **Step 2: Verify no stale references remain**

Run: `grep -rn "internal/tg\|internal/hook\|OCD_TG_TOKEN\|OCD_WEBHOOK_BASE" docs/ internal/ cmd/ --include="*.go" --include="*.md" | grep -v CHANGELOG | grep -v superpowers`
Expected: no hits outside `docs/superpowers/` (the plan and the spec are deliberate history) and `scripts/boot.sh` if it references the old env keys — if it does, that reference goes too, in this task.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md docs/runbook-home.md docs/runbook-mac.md scripts/boot.sh
git commit -m "docs: the brain owns the bot, the DNS and the history"
```

- [ ] **Step 4: Create the Cloudflare token (operator step, needs the owner watching)**

Covered by Task 1 — this step just confirms it happened: `CLOUDFLARE_DNS_TOKEN` in the Worker secrets, `CLOUDFLARE_ZONE_ID` in `wrangler.toml [vars]`. No token value in chat, logs, or files. Record only its ID in the ledger.

- [ ] **Step 5: Rebuild the box and restart the daemon**

```bash
go build -ldflags "-s -w -X github.com/mfenderov/ocd/internal/boxadmin.Version=<new tag>" -o ~/.local/bin/ocd ./cmd/ocd
systemctl --user restart ocd-serve.service
```

Expected: active, log shows no Telegram lines, heartbeat on, both sweeps on.

- [ ] **Step 6: Prove the whole loop live**

In Telegram: `/link` → tap → open → the ✅ edit lands. Then `/faudit` shows the tap. Then check DNS: both CNAMEs per box point at its tunnel id. `git push` already happened in the release flow — nothing left unpushed.

## Self-Review

**1. Spec coverage.** DNS token + creation (Tasks 1-2, operator steps in Task 4) — wait, token creation is manual API/dashboard work folded into Tasks 1-2's environment, no code task needed. Correction: Task 1's Step 2 IS the creation step, run by the executor with the owner watching. ✓ Boxes push audit rows (Task 4) ✓. `/faudit` from the brain, console fan-out unchanged (Task 5 + explicit no-change) ✓. Go half deleted, bot token out of env, docs updated (Tasks 6-7) ✓. The "bot token leaves `~/.ocd/env`" clause is already satisfied (Phase 1 cutover removed the keys — Task 7's verification step is the live-env check, not a second removal).

**2. Step scan.** Every test step names its file, its assertions and its runner; every code step names the file, the signature or the exact behavior, and the values. The two "only if the compiler proves" clauses (RouteDNS deletion — dropped, box keeps its calls per Global Constraints; store-method deletion — not in this plan at all) were removed: the box keeps `RouteDNS` (Global Constraints ruling) and the plan deletes only whole dead packages plus serve.go wiring, all named exactly.

**3. Type consistency.** `ensureBoxDns` returns `{created, updated, unchanged}` string arrays; Task 3 maps them to the enrol response's `dns` field (a status string per record). `BoxDns` field names match the enrol body's `hostname`/`tunnel_id` by construction in Task 3's test. `RecentAuditSince(rowid)` returns rows in rowid order; the sweep pushes them as one batch.

**4. Review Focus.** Item 1 → Task 3 (failed-DNS enrol). Item 2 → Task 2 (update-in-place). Item 3 → Task 2 (empty-tunnel skip is Task 3's skip — wait, correction: empty tunnel id means the DNS ensure must refuse; that check lives in Task 2's `ensureBoxDns` (empty `target` → reject) AND Task 3's guard (skip before calling). Both pinned. Item 4 → Task 4 Step 8 (same-second collapse pinned). Item 5 → Task 2 Step 5 (403 names the scope).

**5. Proportion.** The spec's Phase 2 section is ~40 lines; this plan is the task decomposition, not a transcript. No function bodies, only signatures, test names with assertions, and commands. Each step is one action with a checkable result.
