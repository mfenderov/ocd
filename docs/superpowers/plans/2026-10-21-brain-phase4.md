# Brain Phase 4 — the CRAP bar and the layers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every function in the brain and the CLI scores a CRAP of 10 or less, and the two codebases are layered so the dependencies point inward.

**Architecture:** CRAP combines how many paths a function has with how little of it the tests reach: `CRAP = CC² × (1 − coverage)³ + CC`. Since the coverage term is never negative, **CRAP ≥ CC** — so a bar of 10 forces a complexity of 10 or less in every function, and the coverage of the complex ones to near 100%. The work is therefore mostly a decomposition: the big dispatchers become route tables, the big decision trees become named paths, and the uncovered seams get tests.

**Tooling:** `gocrap` (the Go tool) and `crap` (the TypeScript twin, added in this phase, in `worker/tools/crap/`) — the same formula, the same table, the same exit code.

**Measured baseline (2026-10-21):**

| | functions | average | over 10 | worst |
|---|---|---|---|---|
| Go (`internal/`, `cmd/`) | 221 | 7.4 | 35 | `SetupTunnel` 17.7 (CC 14) |
| TypeScript (`worker/src/`) | 328 | 3.6 | 19 | `FleetState.fetch` 49.3 (CC 45), `object.fetch` 49.0 (CC 49) |
| the tool itself (`worker/tools/`) | 58 | 2.4 | 0 | — |

## Global Constraints

- **No behaviour changes.** This phase restructures and tests; it does not change what the system does. Every refactor keeps the tests green and the observable behaviour identical.
- **The gates come last.** The CI gate only goes in once the code is under the bar, so the branch never sits on a red build.
- **A function's complexity is the number of its decision points** (if, for, while, case, catch, &&, ||, ??, the ternary). Splitting a decision tree into named functions is the fix; adding `//` comments is not.
- **The coverage that counts is the tests', not the comment's.** A function that no test reaches scores as if it were untested, whatever it looks like.
- Go changes must be `gofmt` clean and `golangci-lint run ./cmd/... ./internal/...` must report 0 issues. Worker changes must pass `npx tsc --noEmit` and `npx vitest run` — and the tools' own suite, which runs in node.
- The plan and the design document stay uncommitted. Do not `git add docs/superpowers/`.

## Review Focus

1. **A dispatch that became a table.** The two routers (`FleetState.fetch`, `object.fetch`) are the worst offenders and the clearest architectural smell: a 45-case switch deciding what to do. A table of routes is both simpler and testable.
2. **A split that kept the behaviour.** Every refactor in this phase must be provably the same behaviour: the same inputs, the same outputs, the same side effects. The tests are the proof; where a test is missing, it is written first.
3. **A layer that points inward.** The brain's domain modules import the Durable Object for its types — the dependency points the wrong way. The types belong to the domain; the DO imports them.
4. **A gate that holds.** The CI must fail on a function that crosses the bar, and pass on the tree as it stands. A gate nobody trusts is worse than no gate.

## File structure

**Go (modified):** `internal/onboard/tunnel.go`, `internal/onboard/repair.go`, `internal/onboard/onboard.go`, `internal/onboard/envload.go`, `internal/onboard/prompt.go`, `internal/store/store.go`, `internal/cli/service.go`, `internal/cli/cli.go`, `internal/fleet/command.go`, `internal/fleet/fleet.go`.

**Worker (modified):** `worker/src/state.ts`, `worker/src/index.ts`, `worker/src/enroll.ts`, `worker/src/heartbeat.ts`, `worker/src/access.ts`, `worker/src/mint.ts`, `worker/src/revoke.ts`, `worker/src/boxapi.ts`, `worker/src/bot.ts`.

**Worker (new):** `worker/src/boxes.ts` — the shared types the domain and the Durable Object both speak.

**CI (modified):** `.github/workflows/ci.yml` — the two gate steps.

---

### Task 1: The Go half under the bar

**Files:**
- Modify: the Go files listed above, and their tests.
- Test: `internal/onboard/*_test.go`, `internal/cli/*_test.go`, `internal/fleet/*_test.go`, `internal/store/*_test.go`.

**Interfaces:**
- Consumes: the Go tool: `go test -coverprofile=coverage.out ./... && gocrap -c coverage.out -max 10 -exclude "*_test.go"`.
- Produces: every function at or under 10.

- [ ] **Step 1: The list of offenders**

```bash
go test -coverprofile=coverage.out ./...
gocrap -c coverage.out -max 10 -exclude "*_test.go" -v
```

Thirty-five functions are over the bar. The ones that need splitting (their complexity alone puts them over 10, whatever their coverage):

| function | CC | where |
|---|---|---|
| `SetupTunnel` | 14 | `internal/onboard/tunnel.go` |
| `RepairTunnel` | 12 | `internal/onboard/repair.go` |
| `WriteEnvFile` | 12 | `internal/onboard/onboard.go` |
| `repairRuleProblems` | 12 | `internal/onboard/repair.go` |
| `ValidateBoxID` | 11 | `internal/onboard/onboard.go` |
| `unreproducibleParts` | 10 | `internal/onboard/tunnel.go` |
| `RepairEnv` | 10 | `internal/onboard/repair.go` |
| `validEnvKey` | 10 | `internal/onboard/envload.go` |
| `ResolveEnroll` | 8 | `internal/onboard/prompt.go` |
| `auditCmd` | 8 | `internal/fleet/command.go` |
| `decodeError` | 7 | `internal/fleet/fleet.go` |

The rest are uncovered seams: `installService`, `realExec`, `EnvSummary`, `RunSpinner`, `restartSystemdUnit` (complexity 3, coverage 0 — the score of a function nobody reaches). They need a test, not a split.

- [ ] **Step 2: Split the complex ones**

Each becomes named functions with one decision each. The behaviour must not change: the same inputs, the same outputs, the same errors. Where a split is not obvious, write the test for the current behaviour first, then split.

- [ ] **Step 3: Cover the seams**

`restartSystemdUnit` runs `systemctl --user restart <unit>`. The test puts a fake `systemctl` on `PATH` and checks the command it was asked to run — the error paths and the success path. `RunSpinner` and `EnvSummary` are written for a terminal; the tests drive them with a writer and a non-terminal.

- [ ] **Step 4: Verify**

```bash
gofmt -l ./cmd ./internal ./scripts
go vet ./...
go test ./... -count=1
golangci-lint run ./cmd/... ./internal/...
go test -coverprofile=coverage.out ./... && gocrap -c coverage.out -max 10 -exclude "*_test.go"
```

The last command must pass with no violations.

- [ ] **Step 5: Commit**

```bash
git add internal/ cmd/
git commit -m "refactor(box): every function under the CRAP bar"
```

---

### Task 2: The brain under the bar

**Files:**
- Modify: the Worker files listed above, and their tests.
- Test: `worker/test/*.test.ts`.

**Interfaces:**
- Consumes: `npm run coverage && npm run crap -- -c coverage/coverage-final.json -max 10`.
- Produces: every function at or under 10.

- [ ] **Step 1: The list of offenders**

```bash
cd worker && npm run coverage
npm run crap -- -c coverage/coverage-final.json -max 10 -v
```

Nineteen functions are over the bar. The two worst are the dispatchers, and they are the same smell: a switch that decides what to do.

| function | CC | where | the smell |
|---|---|---|---|
| `object.fetch` | 49 | `worker/src/index.ts` | the edge router: a switch over every path |
| `FleetState.fetch` | 45 | `worker/src/state.ts` | the Durable Object's router: a switch over every path |
| `requestEnrollment` | 33 | `worker/src/enroll.ts` | the enrolment's three paths in one function |
| `scopeForEdgeRoute` | 23 | `worker/src/access.ts` | the scope of a route, decided by a switch |
| `parseEnrollBody` | 19 | `worker/src/enroll.ts` | the body, validated field by field |
| `parseHeartbeatBody` | 17 | `worker/src/heartbeat.ts` | the body, validated field by field |
| `scopeForDoRoute` | 15 | `worker/src/access.ts` | the scope of a route |
| `handleMintLink` | 15 | `worker/src/mint.ts` | |
| `handleHeartbeat` | 15 | `worker/src/heartbeat.ts` | |
| `isPinnedHostname` | 15 | `worker/src/enroll.ts` | the hostname rule, a chain of checks |
| `verifyAccessJwt` | 14 | `worker/src/access.ts` | |
| `revokeOneBox` | 14 | `worker/src/revoke.ts` | |
| `findJwkKey` | 12 | `worker/src/access.ts` | |
| `approveEnrollment` | 12 | `worker/src/enroll.ts` | |
| `writeBoxDns` | 11 | `worker/src/enroll.ts` | |
| `relayToBox` | 10 | `worker/src/boxapi.ts` | |
| `commandOf` | 10 | `worker/src/bot.ts` | |
| `FleetState.ensureSchema` | 9 | `worker/src/state.ts` | the schema, one statement per table |
| `FleetState.boxStatus` | 4 | `worker/src/state.ts` | uncovered |

- [ ] **Step 2: The routers become tables**

`object.fetch` and `FleetState.fetch` decide what to do by switching over every path the system has. A table of routes — a list of `{method, path, scope, handler}` — says the same thing without the switch, and the scope check moves out of the router (which is where the access rules belong, not in the dispatch). The routing table is data; the router is a lookup.

The order of the checks matters and must not change: the brain answers a request the same way, in the same order, with the same status codes.

- [ ] **Step 3: The decision trees become paths**

`requestEnrollment` carries the fast path, the claim and the pending row. Each becomes its own function with one name. The same for the parsers: a body is validated by a validator per field, each with one rule, and the whole body by calling them in order.

- [ ] **Step 4: Cover what is uncovered**

`FleetState.boxStatus` is never reached by a test. It relays to the box; the test needs a box that answers.

- [ ] **Step 5: Verify**

```bash
cd worker
npm run typecheck && npm test && npm run test:tools
npm run coverage && npm run crap -- -c coverage/coverage-final.json -max 10
```

- [ ] **Step 6: Commit**

```bash
git add worker/src worker/test
git commit -m "refactor(worker): every function under the CRAP bar"
```

---

### Task 3: The layers point inward

**Files:**
- New: `worker/src/boxes.ts` — the types the domain and the Durable Object share.
- Modify: `worker/src/state.ts` and every module that imports it for its types.
- Test: `worker/test/architecture.test.ts` — the rule, as a test.

**Interfaces:**
- Consumes: the brain's current type graph.
- Produces: a domain that does not know the Durable Object, and a rule that keeps it that way.

- [ ] **Step 1: The rule, as a test**

Nine of the brain's modules import `state.ts` — the Durable Object — for the types it declares. The Durable Object is the application's layer; the domain must not depend on it.

Write the test first: no module under `worker/src/` may import `./state` except `index.ts` (the transport, which is allowed to know the application) and `state.ts` itself. The test walks the sources and fails with the offending import named.

- [ ] **Step 2: Move the types out**

The types the domain and the Durable Object share (the box row, the pending row, the fleet's environment) move to `worker/src/boxes.ts` — a module of the domain. The Durable Object imports them; the domain imports them. Nothing imports `state.ts` for a type any more.

- [ ] **Step 3: Verify**

```bash
cd worker && npm run typecheck && npm test
```

The architecture test passes; the suite is unchanged.

- [ ] **Step 4: The Go's one duplicated rule**

`internal/onboard.DefaultDBPath` and `internal/cli`'s own copy compute the same thing — one of them says so in a comment. The CLI already imports `onboard`; it uses that one.

- [ ] **Step 5: Commit**

```bash
git add worker/src worker/test internal/
git commit -m "refactor: the domain does not depend on the Durable Object"
```

---

### Task 4: The gates

**Files:**
- Modify: `.github/workflows/ci.yml`.

**Interfaces:**
- Consumes: `gocrap` and `crap`.
- Produces: a build that fails when a function crosses the bar.

- [ ] **Step 1: The Go gate**

In the `go` job, after the tests:

```yaml
- name: the CRAP bar
  run: |
    go install github.com/mfenderov/gocrap@latest
    go test -coverprofile=coverage.out ./...
    gocrap -c coverage.out -max 10 -exclude "*_test.go"
```

- [ ] **Step 2: The brain's gate**

In the `worker` job, after the tests:

```yaml
- name: the CRAP bar
  run: |
    npm run coverage
    npm run crap -- -c coverage/coverage-final.json -max 10
```

- [ ] **Step 3: The tool's own gate**

The tool measures itself: `npm run crap:self` must pass, in the tools' own job. It is the same rule as the others, applied to the tool that applies it.

- [ ] **Step 4: Verify**

Push a branch with one function over the bar: the build must fail, and the failure must name the function. Then revert it and the build must pass.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: the CRAP bar is a gate"
```

---

### Task 5: The docs

**Files:**
- Modify: `docs/architecture.md`, and the new tool's own README.

- [ ] **Step 1: Say how to run it**

How to measure the brain and the Go half locally, what the score means, and why the bar is 10: a function's complexity alone is above 10, it can never come down.

- [ ] **Step 2: Commit**

```bash
git add docs/ worker/tools/
git commit -m "docs: the CRAP bar, and how to measure it"
```

## Self-Review

**1. Spec coverage.** The user's three asks: use gocrap for Go (Task 1's step 1 and Task 4's step 1 ✓), build the TypeScript equivalent (done, in `worker/tools/crap/`, and it measures itself ✓), bring CRAP to ~10 (Tasks 1 and 2 ✓, the gate in Task 4 ✓), and make sure the code is in the realm of clean architecture and clean code (Task 3's layers ✓, the route tables and named paths in Task 2 ✓, the duplicated rule in Task 3 ✓).

**2. Step scan.** Every test step names its file, its assertion and its runner; every code step names the file and the behaviour. The commands are the ones the tools document.

**3. Type consistency.** The brain's shared types move to `worker/src/boxes.ts` and every importer follows; the Go's database path rule has one home.

**4. Review Focus.** Item 1 → Task 2's step 2 (the routers become tables ✓). Item 2 → every step's "the tests are the proof" ✓. Item 3 → Task 3 (the architecture test ✓). Item 4 → Task 4's step 4 (the gate is proved to fail ✓).

**5. Proportion.** The plan names the functions to change and what to change about them; it does not write the code. The measurements that drive it are in the table at the top, so a task can be checked against a number rather than a feeling.
