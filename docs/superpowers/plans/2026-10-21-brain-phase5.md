# Brain Phase 5 — the components, and the arrows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The brain's parts are separated, and every dependency points the way it should: the transport knows the application, the application knows the domain, the domain knows only its own ports.

**Architecture:** Not clean architecture — no entities with behaviour, no repositories, no use-case objects. Three rules instead:

1. **The domain names its own ports.** A use case says what it needs ("tell the owner something", "point these two names at this tunnel", "ask this box for its status"), and the adapter that provides it is wired in from the outside.
2. **The adapters implement the ports; the domain never imports an adapter.** The port lives in the domain; the implementation lives next to the transport it speaks to.
3. **No cycles.** The import graph is a tree of layers, not a web of peers. A cycle means two modules are really one module, or a third one is missing.

The Go half already satisfies these: `cmd/ocd` → `internal/cli` → the use cases → `internal/store` and `internal/boxagent`, and the rule that an inner package must not import `internal/cli` is a lint. The store is bound to SQLite on purpose — the store *is* the domain's own model, there is no second implementation coming, and the tests are fast. That stays.

## Global Constraints

- **No behaviour changes.** The brain answers the same requests, in the same order, with the same replies. This is a move, not a rewrite.
- **The domain keeps its logic.** Moving a function to another module must not change what it does. The 351 brain tests are the proof; a test that changes its expectations is a red flag.
- **The wiring stays in one place.** `worker/src/state.ts` is the composition root: it is where the concrete adapters are handed to the domain. It is allowed to import everything.
- The plan stays uncommitted. Do not `git add docs/superpowers/`.
- Worker changes must pass `npm run typecheck`, `npm test`, `npm run test:tools`, `npm run lint` and `npm run knip`, and the CRAP bar must still hold.

## Review Focus

1. **A port that is really a port.** A port is what the domain needs, in the domain's words. A port that mentions the adapter's type, its HTTP shape, or its client's methods is the adapter wearing a port's name.
2. **A cycle broken, not hidden.** When two modules import each other today, the fix is a third module that holds what they share — not a re-export that leaves the cycle in place.
3. **The wiring in one place.** The concrete implementations are created in `state.ts` and nowhere else. A domain module that constructs a Telegram client or reads an endpoint table has the arrow backwards again.

## The violations, measured

The domain reaching for an outbound adapter:

| domain module | reaches for |
|---|---|
| `audit` | `boxapi` — the endpoint table |
| `mint` | `boxapi` — the endpoint table |
| `revoke` | `boxapi` — the endpoint table |
| `bot` | `telegram` — the client factory, the client type |
| `botcommands` | `telegram` — the escaping helper, the client type |
| `enroll` | `dns` — the writer; `telegram` — the factory, the escaping helper, the error type |
| `events` | `telegram` — the escaping helper, the client type |
| `liveness` | `telegram` — the escaping helper, the client type |

And the cycles they cause:

- `mint` → `boxapi` → `enroll` → `heartbeat` → `mint`
- `audit` → `boxapi` → `enroll`, `revoke` → `boxapi` → `enroll`

---

### Task 1: The domain names its ports

**Files:**
- New: `worker/src/ports.ts` — the ports the domain needs, in the domain's words.
- Modify: `worker/src/telegram.ts`, `worker/src/dns.ts`, `worker/src/boxapi.ts` — the adapters, which implement the ports.
- Modify: the eight domain modules listed above — they import the ports, not the adapters.
- Modify: `worker/src/state.ts` — the wiring, where the adapters are handed in.
- Test: `worker/test/architecture.test.ts` — the rule, as a test.

**Interfaces:**
- Consumes: what each use case actually asks of the outside world.
- Produces: a domain that names its needs and nothing else.

- [ ] **Step 1: Write the failing architecture test**

The test must fail before the move: no module under `worker/src/` that is not the transport (`index.ts`), the composition root (`state.ts`) or the route table (`routes.ts`) may import `telegram`, `dns` or `boxapi`. Name the offending import when it fails.

- [ ] **Step 2: Name the ports**

`worker/src/ports.ts` holds what the domain needs, said in the domain's words:

- the notifier: "tell the owner this" — the function the use cases already take ✓ (`NotifyFn` ✓ — it lives in `enroll.ts` today ✓ and moves here ✓).
- the Telegram client: what `bot`, `botcommands`, `events` and `liveness` use it for ✓ — the operations they call ✓, and nothing more ✓.
- the text helper: the HTML escaping ✓ — a pure function about text ✓, not about Telegram ✓. It may live in its own module ✓ or with the ports ✓; your call, and say why ✓.
- the DNS writer: "point these two names at this tunnel" ✓ — the shape the enrolment already uses ✓.
- the box relay: "ask this box for this" ✓ — and the endpoint table ✓ (the paths are the protocol the domain speaks ✓, so the table belongs with the port ✓, not only with the adapter ✓).

- [ ] **Step 3: Make the adapters implement the ports**

`telegram.ts`, `dns.ts` and `boxapi.ts` import the ports they implement ✓ — the arrow points from the adapter to the port ✓ — and keep their behaviour ✓.

- [ ] **Step 4: Move the domain onto the ports**

The eight modules import the ports ✓. `createTelegramClient` — the factory — is constructed in `state.ts` only ✓, and the domain receives the client it needs ✓ (as it already receives the notifier ✓).

- [ ] **Step 5: Verify**

```bash
cd worker
npm run typecheck && npm test && npm run test:tools
npm run lint && npm run knip
npm run coverage && npm run crap -- -c coverage/coverage-final.json -max 10
```

- [ ] **Step 6: Commit**

```bash
git add worker/src worker/test
git commit -m "refactor(worker): the domain names its ports, the adapters keep them"
```

---

### Task 2: No cycles

**Files:**
- Modify: `worker/src/mint.ts`, `worker/src/boxapi.ts`, `worker/src/enroll.ts`, `worker/src/heartbeat.ts`, `worker/src/audit.ts`, `worker/src/revoke.ts` — and the module that holds what they share.
- New: the module that holds the shared vocabulary ✓.
- Test: `worker/test/architecture.test.ts` — the graph, as a test.

**Interfaces:**
- Consumes: the import graph, as it is.
- Produces: a graph with no cycles ✓.

- [ ] **Step 1: Write the failing test**

The test walks the import graph of `worker/src/` and fails when it finds a cycle ✓, naming the modules in it ✓. It must find the cycle that exists today ✓ — if it does not, the test is not looking at the right thing ✓.

- [ ] **Step 2: Break the cycles**

The cycles are a symptom: two modules each need something the other holds ✓. The fix is a third module that holds what they share ✓ — the vocabulary they both speak ✓ — and both depend on it ✓.

Do not break a cycle with a re-export that leaves the import in place ✓ — the graph must be a tree of layers ✓, not a web with extra edges ✓.

- [ ] **Step 3: Verify**

The same commands as Task 1 ✓, plus the architecture test ✓ (it now passes ✓).

- [ ] **Step 4: Commit**

```bash
git add worker/src worker/test
git commit -m "refactor(worker): the import graph has no cycles"
```

---

### Task 3: The rule, in the docs

**Files:**
- Modify: `docs/architecture.md` — the section "How the code is kept clean" ✓.

- [ ] **Step 1: Say what the rules are**

The three rules at the top of this plan, in the page's voice ✓ — and the fact that the architecture test enforces two of them ✓ (the adapters ✓ and the cycles ✓) and that the Go's inner packages are lint-enforced ✓.

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: the components, and the arrows between them"
```

## Self-Review

**1. Spec coverage.** The owner's ask: separate the main components ✓ (Task 1: the domain, the ports, the adapters, the wiring ✓) and make the dependency point the right way ✓ (Task 1's rule ✓, Task 2's cycles ✓, the gate in the architecture test ✓). The Go half was already sound ✓ and is left alone ✓ — with the reason written down ✓.

**2. Step scan.** Every test step names its file and what it asserts; every code step names the files and the behaviour. The commands are the ones the repository already runs ✓.

**3. Type consistency.** The ports in `worker/src/ports.ts` are the shapes the adapters already implement ✓, so the wiring hands over the same values it does today ✓. `NotifyFn` moves from `enroll.ts` to the ports module ✓ and every importer follows ✓.

**4. Review Focus.** Item 1 → Task 1's step 2 ✓. Item 2 → Task 2's step 2 ✓. Item 3 → Task 1's step 4 ✓ (the factory is constructed in `state.ts` only ✓).

**5. Proportion.** The plan names the arrows to turn and the rule to enforce. It does not prescribe the shape of the ports — the implementer reads the use cases and names them.
