# The brain is the brain — design

Date: 2026-10-20. Status: approved by owner. Do not build beyond this
document without re-approval; do not commit this file.

## Intent

Today the Telegram bot lives inside `ocd serve` on the home box. That
is the only piece of the system that depends on a specific machine: if
home is down, the Mac is unreachable even though it is healthy.

End state: the **Cloudflare Worker is the brain** — it owns the bot, the
fleet state, and the history. A **box is a dumb worker**: it serves pair
links, mints tap codes, reports liveness, and nothing else. Boxes plug in
and out freely — home, mac, a cloud VM. The fleet is a pool you reach
with `/link`, and no box depends on another box.

Owner's words: "the brain should be the brain, and the boxes should be
as dumb as possible — because that simplifies onboarding." And: the
Worker is part of Cloudflare, the owner controls it, and its API token
can be revoked and scoped.

## Goals

- The bot works as long as Cloudflare is up, regardless of box state.
- Any healthy box is reachable in one tap: `/link` → buttons → open.
- A new box joins with: one command, one Telegram round trip, one paste.
- The brain holds the full history of the fleet, including offline boxes.
- Boxes hold only what they physically must: identity, tap codes,
  editor pairing.
- Onboarding asks for exactly one thing: the box name. Everything else
  derives or automates.

## Non-goals

- Multi-tenant or shared fleets. One owner.
- A web console. Telegram is the UI.
- Box-to-box communication. The brain is the only hub.
- Replacing the Durable Object store or the box protocol wholesale.
- Touching opencode itself. The editor is a black box behind a port.

## Constraints

- Telegram webhooks need a public HTTPS URL with a valid certificate:
  `workers.dev` qualifies.
- The Worker already holds sealed admin tokens for every box, so it can
  already call any box. That power does not change; only its location
  does.
- A tap code is bound to a box (the brain binds the box to the token
  presented at enrollment), so **a box must mint its own tap codes**.
  The brain cannot mint them without rotating the box's identity.
- Already-minted sessions must survive a brain outage: the tap link is
  served by the box and the editor by opencode, neither of which needs
  the brain.

## Decided by the owner

1. **The brain is a Cloudflare Worker** (Worker + Durable Object).
2. **The brain keeps history** — source of truth for the fleet's story.
3. **Boxes are as dumb as possible.**
4. **Reuse the same Telegram bot token** — existing chats keep working.
5. **Box names are `home` and `mac`** — hostnames follow one convention:
   editor `oc-<box>.buyallmemes.com`, tap `oc-tap-<box>.buyallmemes.com`.
   The primary box's short `oc.buyallmemes.com` goes away.
6. **The brain owns DNS.** Onboarding asks only for the name; the brain
   creates the two DNS records itself via a Cloudflare API token scoped
   to exactly those hostname patterns. Revocable, least-privilege.
7. **Suspected-offline, once.** No heartbeat for 90s → the brain pings
   the box's daemon directly; no (or bad) reply → one "I suspect
   `<box>` is offline" DM, one recovery DM when it heartbeats again.
   Never repeated while down.
8. **DM-only.** No shared group. The bot talks to the owner chat and
   nothing else, so no user-id gating layer is needed.
9. **Onboarding is fail-fast.** Enroll is the commit point. Anything that
   fails before it leaves no trace worth cleaning (pending rows expire in
   15 minutes; DNS for never-enrolled boxes is garbage-collected). Anything
   that fails after it is reported as "enrolled but X needs you", never
   rolled back — a half-working enrolled box beats an orphaned one.
10. **Bare `ocd` starts onboarding** on a fresh box (asks for the name),
    reports identity on an onboarded one.
11. **Home migrates first** (2026-10-20). The home box is migrated onto the
    brain and proves it; only then does the Mac onboard, on the clean path.
    Each phase is its own release and leaves the system working.

## My calls (veto any of them)

- **Inbound path:** Telegram webhooks to `POST /tg/webhook` on the Worker,
  verified with Telegram's `X-Telegram-Bot-Api-Secret-Token` header. A
  Worker has no startup hook, and the Durable Object is alive from the
  brain's first deploy, so the webhook is registered by one explicit
  script — `scripts/brain-webhook.sh` — and never automatically.
- **Command handling lives in the Durable Object**, because every command
  needs fleet state and at most one of them mutates it. The DO is already
  the serialization point for the fleet.
- **Link feedback (✅ logged in / ⌛️ expired) is kept.** The box pushes
  link events to the brain; the brain edits the message it owns.
- **Boxes push events; the brain never polls them.** One endpoint
  (`POST /api/events`) carries link-used / link-expired / audit rows.
- **The Go Telegram half is deleted** (`internal/tg`, `internal/hook`)
  at cutover. Until then both can run; at cutover the box's bot stops.
- **The home box's migration to `oc-home.*`**: new DNS records, tunnel
  rename `oc-wsl` → `oc-home`, re-enroll the box under the new hostname.
  The old names are kept as redirects for a week, then dropped.
- **Service install is silent on macOS** once the box is enrolled: the
  whole point is zero questions after the paste. The removal command is
  printed. Linux prints the equivalent systemd unit instead of guessing.
- **Cloudflared login is the one interactive fallback**: if the box has
  no tunnel login and no `CLOUDFLARE_API_TOKEN`, onboard launches
  `cloudflared tunnel login` (browser flow) instead of failing. Cloudflared
  itself must already be installed; the wizard says exactly how
  (`brew install cloudflare/cloudflare/cloudflared`) and stops there.

### Calls made while planning Phase 1 (2026-10-20, after the builder check)

- **The webhook secret is one value in one place**: the Worker secret
  `TELEGRAM_WEBHOOK_SECRET`, sent as Telegram's `secret_token` and
  verified from the `X-Telegram-Bot-Api-Secret-Token` header. The route
  carries no secret in its path.
- **The box decides when a link dies** and pushes `link-expired`; the brain
  never computes an expiry and never knows the link TTL.
- **The brain's gate is the chat id**, not the user id: drop any update
  whose chat id is not `TELEGRAM_OWNER_CHAT_ID`. In a DM they are the same
  number, and the Worker holds no user id.
- **One alarm does the sweeping** (every 30s): prune, expire, detect a
  silent box. A DO alarm is the only scheduler a Worker has.
- **The event push is best-effort and never blocks a tap.** A brain outage
  must not break an already-minted session.
- **`/status` gets a new box endpoint** (`/_oc/status`); `/revoke` is
  retired in favour of `/frevoke <box> YES`.
- **"The primary box" is a Worker setting**, not a schema fact.
- **The Cloudflare token is zone-scoped, not hostname-scoped** — Cloudflare
  does not offer record-level scoping. It is still narrower than today's
  `cert.pem`, which is a whole-account login.
- **The old hostnames are routes, not redirects**: they keep serving the
  same services for a week, as extra ingress rules on the same tunnel.
- **The console's `/api/audit` keeps fanning out to the boxes**; the bot's
  `/faudit` reads the brain's own `audit_log`. Two tools, two questions.

## Target architecture

```
📱 You ──Telegram──► ☁️ brain (Worker + DO) ──relay──► boxes
                           │ bot, state, history         │ /pair, /_oc/*, heartbeat
                           └──push events ◄── boxes ─────┘
```

## The brain's responsibilities

| Area | Detail |
|---|---|
| Bot (inbound) | webhook → owner-chat check → commands |
| Bot (outbound) | messages, inline keyboards, message edits, callback answers |
| Fleet state | boxes, pending enrollments, tombstones, denials, CLI tokens (existing tables) |
| History (new) | audit rows, link registry (token → box, message id, state) |
| Enrollment | issue code → pending row (trusted) → claim; approve/deny links (existing) |
| DNS (new) | create `oc-<box>` + `oc-tap-<box>` records via a scoped API token, after the enrolment |
| Relay | `/_oc/mint`, `/_oc/audit`, `/_oc/revoke` (existing), `/_oc/presence` and `/_oc/status` (new) |
| Liveness | heartbeat ingestion, presence probe, one suspected-offline ping + one recovery ping |
| Sweeping | one DO alarm every 30s: prune, expire links, detect a silent box |

## The box's responsibilities

| Area | Detail |
|---|---|
| `/pair` | consume a tap code, run `opencode pair --url`, redirect (existing) |
| `/_oc/mint` | mint a tap code for its box, return the URL (existing) |
| `/_oc/audit`, `/_oc/revoke`, `/_oc/presence` | keep for the brain's relays (existing) |
| `/_oc/status` | the OpenCode service status (new) |
| `POST /api/events` | push link-used / link-expired / audit rows to the brain (new) |
| heartbeat | report liveness (existing) |
| local store | identity, tap codes, editor pairing (small, inherent) |
| **no** Telegram | no bot token, no webhook route, no polling |

## Commands (owner-facing, DM only)

| Command | Behaviour |
|---|---|
| `/link` | menu of boxes with inline buttons; tap → mint → "Open" button |
| `/flink <box>` | same as tapping, without the menu |
| `/login` | the primary box, one tap |
| `/fleet` | status of every box, online/offline, last seen |
| `/faudit [box]` | history from the brain, including offline boxes |
| `/frevoke <box> YES` | revoke one box (tombstone) |
| `/fnuke YES` | revoke every box |
| `/enrollcode <box>` | issue a one-time code for a new box |
| `/status` | relayed to the primary box: its OpenCode service status |

Retired at the cutover, because a fleet command already covers them:
`/devices` (→ `/fleet`), `/audit` (→ `/faudit`), `/revoke` (→ `/frevoke
<box> YES`; the brain's revoke also tombstones, which the Go one did not —
the stricter behaviour is the right one for "kill every session").

"The primary box" is a Worker setting (`PRIMARY_BOX`, default `home`), not
a schema fact: `boxes` has no primary flag and must not grow one.

The brain owns the messages, so it owns the button flow: every tap answers
with `answerCallbackQuery` and edits or replaces the message it owns.

## The box↔brain protocols

Everything the two sides must agree on. Where the Go box and the Worker
disagree, the build breaks at runtime, not at compile time — so these are
written down here.

### Enrolment (box → brain)

`POST /api/enroll` gains one field:

```json
{ "id": "mac", "hostname": "oc-tap-mac.buyallmemes.com",
  "enroll_token": "<the code>", "admin_token": "<sealed>",
  "tunnel_id": "<cloudflared tunnel id>", "quiet": true }
```

`tunnel_id` is the box's cloudflared tunnel id, empty when the box has no
tunnel (a box that skips the tunnel). The brain stores it on the pending row
and on the box row. The brain creates the DNS records **after** a successful
enrolment, using that id — so a box that never enrols never gets DNS and
there is nothing to garbage-collect. A box that enrols but whose tunnel is
missing gets no DNS; it is reported, not rolled back.

### Events (box → brain)

`POST /api/events`, authenticated with the box's heartbeat token (the same
secret the heartbeat uses), with the box id in the body so the brain can
check the token against that box:

```json
{ "id": "mac", "events": [
  { "type": "link-used",   "token": "<tap token>", "ip": "1.2.3.4", "ua": "..." },
  { "type": "link-expired", "token": "<tap token>" },
  { "type": "audit", "at": 1700000000, "actor": "web:1.2.3.4", "action": "tapped",
    "device": "", "ip": "1.2.3.4", "result": "ok", "ua": "..." }
] }
```

Rules:

- The push is **best-effort and off the tap's critical path**: it runs
  after the redirect is prepared, with a 3s timeout, and a failure is logged,
  never surfaced to the tapper. An already-minted session must survive a
  brain outage.
- The push is **idempotent per event**: `link-used` and `link-expired` are
  keyed by the token (the brain ignores an event for a token it has already
  marked), and an audit row is keyed by box + at + action + token, so a
  retry does not duplicate it.
- The brain ignores events for tokens it does not know (the box's own
  `/login` links are not brain links).

### Link expiry — one source of truth

The **box** decides when a link dies and tells the brain ("link-expired").
The brain never computes expiry itself and never needs to know the link
TTL. The box pushes it from its own link table: an unused token older than
the TTL. The brain's message says "single use" and no duration, so no
constant is duplicated in two places.

### The mint relay (brain → box)

Unchanged: `POST /api/backends/:id/link` → the box's `/_oc/mint` → the URL.
The brain parses the token out of the URL and records the link.

### The presence relay (brain → box)

New on the brain side. The box already serves `/_oc/presence`
(`{id, epoch, version, taps_24h}`), but the Worker has no route for it.
The brain needs it: a box that stops heartbeating is probed directly before
the owner is told it is offline. The probe gets a **3s deadline** — the
mint relay's 15s is far too long to hold a request open on a dead box.

### The box's status relay (brain → box)

New on the box side: `/_oc/status` returns the OpenCode service status
(the local `opencode service status` output). The brain relays it for
`/status`. Without it the brain cannot answer "is my editor up?".

### The Telegram update shape (Telegram → brain)

`POST /tg/webhook` with the `X-Telegram-Bot-Api-Secret-Token` header. One
value, one place: the Worker secret `TELEGRAM_WEBHOOK_SECRET`, which is
also the `secret_token` given to Telegram's `setWebhook`. The path carries
no secret.

The brain accepts `["message", "callback_query"]` in `allowed_updates`.

The gate: **drop any update whose chat id is not
`TELEGRAM_OWNER_CHAT_ID`**, silently, including group messages. In a DM
the chat id is the user id, so the chat id *is* the sender check. The Go
bot's group support (`OCD_GROUP_ID`) is retired with it.

Update ids are recorded in `seen_updates` and pruned after 24 hours, so a
retried `/link` cannot mint two links.

## Data model changes (Durable Object)

Existing tables, with two changes: `boxes` gains `tunnel_id` and
`suspected_offline` (1 = the owner was told), and `pending` gains
`tunnel_id`. The claim path builds the box row out of the pending row, so
both must carry the tunnel id.

New:

```sql
-- Every tap link the brain has handed out.
CREATE TABLE IF NOT EXISTS links(
  token TEXT PRIMARY KEY,      -- the tap token
  box_id TEXT NOT NULL,        -- which box mints it
  chat_id INTEGER NOT NULL,    -- where the message was sent
  message_id INTEGER NOT NULL, -- so the brain can edit it later
  state TEXT NOT NULL,         -- issued | used | expired
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, -- the box tells the brain when the link dies
  used_at INTEGER NOT NULL DEFAULT 0,
  used_ip TEXT NOT NULL DEFAULT '',
  used_ua TEXT NOT NULL DEFAULT '',
  edited INTEGER NOT NULL DEFAULT 0
);

-- The fleet's history, ingested from the boxes.
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  box_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  tainted INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT ''
);

-- Telegram update ids already handled: a retried /link must not mint two
-- links, and a retried tap must not mint a second one.
CREATE TABLE IF NOT EXISTS seen_updates(
  update_id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL
);
```

Retention: `seen_updates` is pruned after 24 hours, `links` after 24 hours
(the box prunes its own link tokens on the same schedule), `audit_log`
keeps everything (it is the fleet's history).

### Sweeping

One Durable Object alarm, every 30 seconds, does all the periodic work:
prune `seen_updates` and `links`, mark the links whose box reported them
expired, and look for boxes that stopped heartbeating. The DO's alarm is
the only scheduler available to a Worker, so nothing else may assume a
timer.

## Flows

### Reach a box (session)

1. You send `/link` → brain replies with a button per box (offline ones
   marked, tapping one explains rather than failing).
2. You tap a box → brain relays `/_oc/mint` → the box mints a tap code
   and returns the URL → the brain registers the link (token, message id)
   and replies with an "Open" button.
3. You tap it → the box consumes the code, runs `opencode pair --url`,
   and redirects you into that box's editor.
4. The box pushes `link-used` → the brain edits the message to "✅ logged in"
   and appends to `audit_log`.

### Enroll a box (new machine)

1. On the machine: bare `ocd` → it asks for one thing, the box name →
   it prints the Telegram command (`/enrollcode <box>`).
2. You send it → the brain issues a code (trusted pending row) and shows
   the exact paste-ready command `ocd onboard <box> <code>`. Positional,
   not flags: the owner asked for a command with nothing to fill in.
3. You paste it → the box claims the pending row, writes env + tunnel
   config + service, and reports done. (If cloudflared was never logged
   in, onboarding launches the login first.)

### History

- Boxes push audit rows as they happen; the brain appends them to
  `audit_log` and answers `/faudit` from it. Offline or replaced boxes
  keep their history.

## Migration and cutover — home first, then the Mac

The owner changed the order on 2026-10-20: **the home machine is migrated
first** and proves the brain, then the Mac onboards on the clean path. Home
is the guinea pig because it carries the legacy (the old names, the `oc-wsl`
tunnel, the Go bot); the Mac is the clean case and should not have to absorb
the migration's risk.

Each phase is one release. Every phase leaves the system working.

### Phase 1 — the brain takes the bot

**The order inside the phase matters. Three releases, and the third one is
the only irreversible-looking step.**

**1a — the boxes learn to talk (a box release).** The box pushes its events
(`POST /api/events`: link-used, link-expired, audit rows) and answers
`/_oc/status`. The push is off the tap's critical path. The Go bot's
`allowed_updates` is fixed. The env loader learns single quotes. Deployed on
home; the Mac takes it later, and until then its links simply do not get
the "✅ logged in" edit — which is what happens today anyway, because the
edit comes from the home box's own store.

**1b — the brain learns to talk (a Worker release, not live yet).** The
Telegram client, the `POST /tg/webhook` route, the gate, the dedup, the
commands, the buttons, the links table, the event ingest, the presence
relay, the offline detection and the alarm sweeper. The Telegram webhook
still points at the home box, so nothing changes for the owner.

The brain is tested by posting updates to its route directly and reading
the bot's answers in Telegram. No live change yet.

**1c — the flip (a box release, and the only risky step).** The home box's
`~/.ocd/env` loses `OCD_TG_TOKEN`, `OCD_OWNER_ID`, `OCD_WEBHOOK_BASE` and
`OCD_GROUP_ID`, and `ocd serve` is restarted. The box stops registering the
Telegram webhook; the brain registers it.

**The webhook fight.** Both the home box and the brain register the same
bot's webhook, and Telegram keeps one per bot — last writer wins. The home
box registers on **every** `ocd serve` start, so if the Telegram env keys
were still there, the next restart (a WSL reboot, `Restart=always`) would
silently point Telegram back at the box and the brain would go quiet with
no error on either side. That is why the flip removes the keys in the same
step.

**Registering the webhook is one explicit step, never automatic.** A Worker
has no startup hook, and the DO is alive from the brain's first deploy — the
boxes heartbeat every 30 seconds — so a registration inside the release
workflow or on the DO alarm would point Telegram at the Worker *before* the
home box has stopped competing, and the box would take it back on its next
restart. The cutover runs `scripts/brain-webhook.sh` by hand instead. The
Go half's deletion in Phase 2 removes the only competitor, so nothing needs
to re-assert the webhook afterwards.

**The rollback** is not one call: the Go bot's webhook URL carries a random
path and a random secret, both regenerated on every boot, so no URL can be
written down. The rollback is: put the four env keys back into
`~/.ocd/env`, restart `ocd serve` on home, and the box registers a fresh
webhook — the brain goes quiet and the Go half takes over again. That is
why the Go half stays in the tree through Phase 1.

### Phase 2 — the brain owns DNS and the history, and the Go half goes

A Cloudflare API token becomes a Worker secret. **It cannot be scoped to
hostname patterns — Cloudflare scopes API tokens by zone, not by record.**
The real scope is "DNS edit on `buyallmemes.com`", which is narrower than
today (the boxes hold a `cert.pem`, which is a whole-account login) but
wider than the design promised. The brain only ever writes the two CNAMEs.

The brain creates the records after a successful enrolment, using the
tunnel id the box reported. `proxied: true`, pointing at
`<tunnel-id>.cfargotunnel.com`.

The boxes push their audit rows; the brain keeps them in `audit_log`, so
the bot's `/faudit` answers for offline and replaced boxes too. **This
lands in Phase 2, not Phase 1:** in Phase 1 the brain's `audit_log` is
written but read by nobody, and `/faudit` keeps fanning out to the live
boxes. The box side pushes only `link-used` and `link-expired` until
then. The console's `GET /api/audit` keeps fanning out to the boxes — it
is a "ask the live box now" tool and its response shape (with the
per-box error markers) is a contract the Go client depends on.

The Go half is deleted, the bot token leaves `~/.ocd/env`, and the runbooks
and the architecture page are updated.

### Phase 3 — home's naming migration

The tunnel `oc-wsl` is renamed `oc-home` (the tunnel id does not change, so
the DNS records that point at it stay valid). The brain creates
`oc-home.buyallmemes.com` and `oc-tap-home.buyallmemes.com`. The box's
`config.yml` serves the old and the new names together — four ingress rules
— so `oc.buyallmemes.com` keeps working. That is a **route**, not a
redirect: the old names keep serving the same services.

This needs a box release: today's `renderTunnelConfig` writes two ingress
rules and `EnsureTunnelConfig` refuses to overwrite a config that differs,
so the re-enrolment would fail before it enrolled. The new config writes
the **new tap rule first**, and `TapHostFromConfig` prefers the host that
matches the box's own id, so a routine `ocd repair` cannot revert
`OCD_PUBLIC_URL` to the old tap host.

The tunnel rename touches three more places: `systemd/ocd-tunnel.service`,
`scripts/boot.sh`, and `~/.cloudflared/config.yml`.

Home re-enrols under the new tap host; the Worker rebinds it.

The old names and the old ingress rules are dropped after the Mac is on.

### Phase 4 — the Mac onboards

The Mac onboards fresh: `brew upgrade --cask mfenderov/tap/ocd`, then
`/enrollcode mac` in Telegram, then paste `ocd onboard mac <code>`. It never
had the legacy names, so this is the clean path the brain was built for.

## Known defects found while planning (fixed on the way)

1. **The inline buttons never worked.** The webhook was registered with
   `allowed_updates: ["message"]`, so Telegram never delivered a
   `callback_query`. The handlers were registered, but no tap ever reached
   them. One line in `internal/tg/webhook_api.go`, and the brain requests
   both types.
2. **The env loader does not strip single quotes.** `~/.ocd/env` holds
   `OCD_TG_TOKEN='881…'`; systemd strips them, but `LoadEnvFile` only
   unquotes with `strconv.Unquote`, which handles double quotes only. The
   Go reader therefore sees a token with quotes in it.
3. **The Go bot's polling mode answers only `/login`** — the library
   matches by prefix and only that one handler is registered for polling.
   Irrelevant once the Go half is gone, but it means the polling fallback
   was never a real fallback.

## Claims this document used to make that were wrong

- There is no `/mint` command in the Go bot; the surface is `/link`,
  `/login`, `/devices`, `/audit`, `/status`, `/revoke`, `/fleet`, `/flink`,
  `/frevoke`, `/fnuke`, `/faudit`, `/enrollcode`.
- The Worker has **no** presence relay today: the box serves
  `/_oc/presence`, but there is no route and no DO handler. The relay is
  new work.
- The Worker holds a sealed admin token for every box **enrolled since the
  admin token existed**. A box enrolled before that feature has none, and
  every relay to it fails with `misconfigured`.
- The buttons are broken in webhook mode (the deployed mode) but not in
  polling mode, where `allowed_updates` does not apply.

## Open questions

None. All my calls above are marked; veto any of them.
