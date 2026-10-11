# Fleet Ops Console Design

## Intent and why

The phone-plus-Telegram setup already runs one backend well. As backends
multiply (home PC live, work Mac next, cloud box later), tapping per-box
bots and scrolling per-box audits stops scaling. This project adds one
standalone ops console on the owner's domain plus a REST API and a CLI
around it: presence, tap-links, revoke, and audit for the whole fleet in
one place. (Owner call: bots stay — the console complements them, and
every box keeps working standalone if the console is down.)

## Goals

- One glanceable fleet board: every backend online/offline, last seen,
  last tap.
- Mint a tap-link for any backend from console or CLI.
- Per-box revoke plus a global nuke, from console or CLI.
- Central audit view across boxes (reads; boxes remain the source of truth).
- CLI with full parity for the above, no SSH anywhere.

## Non-goals

- Execution stays on the boxes. The console never runs prompts or tools.
- No multi-user, no teams, no roles. Single owner, same as today.
- No replacement for box-level auth (pair links, owner-gated bots).

## Anti-goals

- Long-lived secrets in browsers. Web uses short sessions only.
- Console outage must never take boxes down. Degraded console = blind
  operator, not dead fleet.
- No new always-on server to nurse. Serverless only.

## Constraints

- Workers Paid ($5/mo base) already owned; whole design must fit inside
  its included quotas (fleet traffic is trivial against 10M req/mo).
- Minting executes only on the owning box (`opencode pair` is local).
- Telegram one-consumer-per-bot rule unchanged; bots keep working as now.
- Subdomains stay single-level (`*.buyallmemes.com` wildcard covers one).
- Secrets in env/keychain, never in the repo (established ocd rule).

## Architecture (decided)

- Cloudflare Worker hosts the API and serves the console page. Stateless
  compute; tiny state (presence, client tokens metadata) in KV or DO.
- Presence via box heartbeats: each `ocd serve` POSTs every ~30s; Worker
  marks stale boxes offline. No polling fan-out.
- Actions ride existing tunnels: Worker calls each box's daemon admin
  endpoints over its public tap/UI hostname with a per-box service token.
  No persistent sockets, no mesh.
- New box-side work (does not exist today): today the daemon exposes only
  `/pair` taps and `/healthz`. The console needs one new authed admin
  listener per box serving mint / revoke / audit-read / presence. Token
  provisioning and rotation ship with it.
- Mint flow (existing, reused): box runs `opencode pair --url`, parses the
  first URL from stdout, wraps it in a one-time proxy token (10-min TTL).
  Worker `POST …/link` relays this with its own timeout and surfaces
  box errors verbatim; concurrent mints are safe (single SQLite writer).
- Audit merge (my call): Worker fans out in parallel, sorts by Worker
  receipt time (box clocks skew), offline boxes omitted with an explicit
  marker row. Pagination is per-request `n`, no cursors.
- Revoke confirm is enforced server-side, not just in UI/CLI.
- Global nuke is fail-fast (owner decision): per-box results reported,
  offline boxes marked untouched, operator re-runs. No queued kill orders.
- Enrollment is instant-join (owner decision): first heartbeat with a valid
  token registers the box. Allowlist deferred until a token ever leaks.
- Web console behind Cloudflare Access (Google login). CLI uses scoped
  per-client API tokens, OS-keychain stored, one-command rotation.
- Access allowlist email: owner to supply before deploy (open item).

## API sketch (decided)

- `GET /api/backends` — id, online, last seen, last tap, version.
- `POST /api/backends/:id/link` — returns tap-link (Worker relays box mint).
- `POST /api/backends/:id/revoke` — box-local password rotation.
- `POST /api/revoke-all` — every box, with explicit confirm flag.
- `GET /api/audit?box=&n=` — merged trail, boxes authoritative.
- `POST /api/heartbeat` — box-to-Worker, service-token authed.

## Left to the builder

- TS framework choice and KV-vs-DO call (either fits; keep it boring).
- CLI shape: extend `ocd` with fleet subcommands vs new binary (my call:
  extend `ocd`, one tool).
- Page hostname (owner decision; suggestion held, not made — anything but
  `status`, per owner).
- Heartbeat interval and stale threshold (my call: 30s / 90s defaults).
