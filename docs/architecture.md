# ocd — architecture

One page for the whole system: what talks to what, what the Worker
actually does, and where every secret lives. Mermaid renders natively in
VS Code (right-click → "Open Preview", or Ctrl+Shift+V).

## 1. Components

```mermaid
flowchart TB
  U["📱 You<br/>Telegram · browser"]

  subgraph HOME["🏠 Home box (WSL)"]
    HD["ocd serve :49400<br/>◾ the Telegram bot lives HERE (owner-only UI)<br/>◾ /pair · /_oc/* · /webhook"]
    HE["opencode :49374<br/>the editor UI"]
  end

  subgraph MAC["💻 Mac box"]
    MD["ocd serve :49400<br/>◾ /pair · /_oc/*<br/>◾ no bot — one bot per fleet"]
    ME["opencode :31047"]
  end

  subgraph CF["☁️ Cloudflare"]
    TGAPI["Telegram API"]
    W["ocd-fleet Worker<br/>fleet brain + relay<br/>ocd-fleet.fenderovlol.workers.dev"]
    DO[("Durable Object<br/>FleetState · SQLite")]
    TUN["tunnels<br/>oc-wsl · oc-mac"]
    DNS["public hostnames<br/>oc-tap-… → daemon<br/>oc-… → opencode"]
  end

  U -->|"/link /fleet /flink /faudit …"| HD
  TGAPI <-->|"webhook + replies"| HD
  TGAPI --> U
  HD -->|"mint · audit · enroll · revoke · heartbeat"| W
  MD -->|"heartbeat"| W
  W <--> DO
  W -->|"relay /_oc/mint · /_oc/audit"| HD
  W -->|"relay /_oc/*"| MD
  U -->|"browser: oc-…"| DNS
  DNS --> TUN
  TUN --> HD
  TUN --> HE
  TUN --> MD
  TUN --> ME
```

**The three things worth internalizing**

1. **The bot is not a service of its own.** It runs *inside* `ocd serve` on
   the home box. That is why the home box is the only one with a bot (a
   second bot on the Mac would fight it over Telegram updates), and why
   "the bot" and "the home box" are the same thing.
2. **The Worker is the only shared component, and it holds all state.**
   Boxes know only themselves; the Durable Object knows every box. That
   is what makes `/fleet`, `/flink mac`, revoke-all and the audit trail
   possible. It also *relays* to boxes (`/_oc/mint`, `/_oc/audit`) using
   the box's sealed admin token.
3. **Each box publishes two hostnames pointing at two different
   processes.** `oc-tap-…` → the ocd daemon (pair links, box API),
   `oc-…` → opencode (the editor). The tap link is the handoff: daemon
   → `opencode pair --url` → your browser lands in the editor.

## 2. Session flow (remote login)

```mermaid
sequenceDiagram
  autonumber
  participant Y as You (phone)
  participant B as Bot (in ocd serve, home)
  participant W as Worker + Durable Object
  participant X as Box daemon
  participant O as OpenCode (editor)

  Y->>B: /link  (or /flink mac)
  B->>W: POST /api/backends/<box>/link
  W->>X: POST /_oc/mint  (admin token, sealed)
  X-->>W: tap token
  W-->>B: https://oc-tap-<box>/pair?t=…
  B-->>Y: [🚀 Open <box>] button
  Y->>X: GET /pair?t=…  (via tunnel)
  X->>X: consume token, one-time
  X->>O: opencode pair --url https://oc-<box>
  O-->>X: session URL
  X-->>Y: 302 → session URL
  Y->>O: editor loads
```

## 3. Enroll flow (a new box joins)

```mermaid
sequenceDiagram
  autonumber
  participant Y as You
  participant B as Bot (home)
  participant W as Worker + Durable Object
  participant N as New box

  Y->>B: /enrollcode mac
  B->>W: POST /api/enroll  (Bearer: fleet token, scope "enroll")
  Note over W: pending row: trusted=1, code=hash(code)
  W-->>B: pending
  B-->>Y: one-time code
  Y->>N: ocd onboard → paste the code
  N->>W: POST /api/enroll  (code in body)
  Note over W: claim trusted row → bind box
  W-->>N: enrolled
  N->>N: write ~/.ocd/env, tunnel, DNS, login service
```

## 4. Data model (Worker's Durable Object)

```mermaid
erDiagram
  boxes ||--o| tombstones : "id = box_id"
  boxes ||--o| pending : "id"
  boxes }o--o{ cli_tokens : "mint / rotate"
  boxes {
    TEXT id PK "box id: home, mac"
    TEXT hostname "pinned target (never from heartbeat)"
    TEXT heartbeat_token_hash "sha256 of the box's token"
    TEXT admin_token_hash "sha256 (legacy)"
    TEXT admin_token_sealed "AES-GCM, decrypted only to call the box"
    INT epoch "bumped on revoke"
    INT last_seq "replay guard"
    INT last_ts "replay guard"
    INT last_seen "worker clock"
    INT enrolled "1 = bound"
  }
  pending {
    TEXT id PK "waiting for approval"
    TEXT hostname "requested target"
    TEXT heartbeat_token_hash "the code"
    TEXT admin_token_sealed "sealed admin to install"
    INT first_seen "15 min TTL"
    INT trusted "1 = owner-issued (claimable by code)"
  }
  tombstones {
    TEXT box_id PK "revoked box"
    INT epoch "epoch to reject"
  }
  denials {
    TEXT id PK "refused enrollment"
    INT denied_at "audit trail"
  }
  cli_tokens {
    TEXT id PK "token id"
    TEXT token_hash "sha256 only"
    TEXT scopes "link,revoke,audit,enroll,manage"
    INT created_at
  }
```

```sql
CREATE TABLE boxes (
  id TEXT PRIMARY KEY, hostname TEXT NOT NULL,
  heartbeat_token_hash TEXT NOT NULL, admin_token_hash TEXT NOT NULL,
  admin_token_sealed TEXT NOT NULL DEFAULT '',
  epoch INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0, last_ts INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0, enrolled INTEGER NOT NULL DEFAULT 0);

CREATE TABLE pending (            -- an enrollment waiting for approval
  id TEXT PRIMARY KEY, hostname TEXT NOT NULL,
  heartbeat_token_hash TEXT NOT NULL, admin_token_sealed TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL DEFAULT 0, trusted INTEGER NOT NULL DEFAULT 0);

CREATE TABLE tombstones (         -- revoked boxes, blocked until they return
  box_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);

CREATE TABLE denials (            -- refused enrollments, kept for audit
  id TEXT PRIMARY KEY, denied_at INTEGER NOT NULL DEFAULT 0);

CREATE TABLE cli_tokens (         -- CLI/API tokens, hashes only
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0);
```

**What each table is really for**

- **`boxes`** — the fleet roster. One row per box. `hostname` is *pinned
  at enrollment* and never taken from a heartbeat (that is the SSRF rule:
  the Worker only ever calls the host it enrolled). `heartbeat_token_hash`
  plus `last_seq`/`last_ts` are the replay guard. `admin_token_sealed` is
  the box's admin credential, encrypted at rest and decrypted only in the
  moment of a relay call.
- **`pending`** — a box that asked to join but is not bound yet.
  `trusted=1` means the request carried the `enroll` scope (the owner
  asked for it in Telegram) → the code alone can claim it. `trusted=0` →
  only the approve link can.
- **`tombstones`** — a revoked box stays listed, with the epoch at which
  it was killed. The daemon must come back with a *higher* epoch or the
  Worker keeps refusing it. That is what makes "revoke" mean something
  for a box that is offline.
- **`denials`** — enrollments the owner refused. Tiny table, but it means
  "someone tried to enroll a box and I said no" is recorded, not lost.
- **`cli_tokens`** — the tokens the bot and CLI use, stored as SHA-256
  hashes with a scope list. `manage` is the master key; `enroll` is the
  one that marks a pending row trusted.

No secret is stored in plaintext: box tokens and CLI tokens are hashes,
the admin token is sealed, and the only plaintext secrets in the system
are the tap codes — which live in the *box's* own store
(`~/.ocd/ocd.db`), not in the Worker. That asymmetry is what makes the
tap flow safe: the Worker never learns a tap code, only its hash,
because the code is minted by the box and consumed by the box.

## 5. Hostnames and ports

| Host | Points at | Purpose |
|---|---|---|
| `oc-tap-<box>.buyallmemes.com` | box daemon `:49400` | tap links (`/pair`), box API (`/_oc/*`) |
| `oc-<box>.buyallmemes.com` | opencode `:49374` | the editor UI (the session) |
| `ocd-fleet.fenderovlol.workers.dev` | Worker | fleet API (`/api/*`) |

The primary box does not follow the `oc-<box>` convention: its real
names are `oc.buyallmemes.com` and `oc-tap.buyallmemes.com`. The tunnel
config (`~/.cloudflared/config.yml`) is the source of truth — `ocd repair`
reads hostnames from there and only fixes ports.

## 6. Who holds which secret

| Secret | Lives in | Grants |
|---|---|---|
| manage token | your password manager | mint/rotate every other token |
| fleet token | `~/.ocd/env` on the home box | `link`, `revoke`, `audit`, `enroll` |
| heartbeat token | `~/.ocd/env` on each box | that box's heartbeat (bound by the Worker) |
| admin token | `~/.ocd/env` on each box; sealed in the Worker | the Worker calling that box's API |
| Telegram bot token | `~/.ocd/env` on the home box | the bot itself |
| tap code | generated by the box, shown in Telegram | one session, one use, 15 min |

## 7. Related documents

- `docs/runbook-home.md` — the WSL box: systemd units, repair, failure triage
- `docs/runbook-mac.md` — onboarding a new box
- `internal/onboard/` — the onboarding flow (enroll, tunnel, repair, launchd)
