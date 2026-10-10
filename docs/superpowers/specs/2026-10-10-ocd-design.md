# ocd Design

**Goal:** Browser-only remote access to OpenCode v2 on Windows/WSL via `oc.buyallmemes.com`, plus a small helper that mints login links on demand.

**Non-goals:** Native mobile app, Mac CLI `--server`, zero-click auto-login (phase 3).

## 1. Architecture

Browser -> Cloudflare HTTPS + Access (Google, allow self only) -> named tunnel `oc-wsl` -> WSL `127.0.0.1:49374` (opencode service). No router ports, no `0.0.0.0` bind. Second helper `ocd serve` on same box listens `127.0.0.1:49400` only, exposed as `oc.buyallmemes.com/pair` behind the same Access check.

## 2. Components

- `opencode service`: v2 background server, generated password, 30-day browser cookie via `opencode pair --url https://oc.buyallmemes.com` (5-min single use).
- `cloudflared`: Windows service, route `oc.buyallmemes.com` -> `http://localhost:49374` and `/pair` -> `http://localhost:49400`. WSL `networkingMode=mirrored` so localhost is stable.
- `ocd`: one Go binary. `ocd` opens TUI, `ocd serve` runs daemon (Telegram polling + `/pair` HTTP + SQLite), `ocd mint/devices/status` are escape hatches.
- Telegram bot: `/login [device]` replies with fresh pair link. Owner ID allowlist, silent drop for others.

## 3. Data

SQLite at `~/.ocd/ocd.db`, two tables:

- `devices(name TEXT PRIMARY KEY, platform TEXT, last_cookie_at INTEGER, expires_at INTEGER)`
- `mints(id INTEGER PRIMARY KEY, device TEXT, via TEXT, at INTEGER)`

`expires_at = last_cookie_at + 30d`. Rate cap: 5 mints per device per hour, 20 total per day. Denied mints return error, no `opencode pair` call.

## 4. Flows

- Daily: open site, pass Google if needed, straight into UI.
- New browser: open site, see OpenCode sign-in, tap `Get login link` (`/pair`) or send Telegram `/login`, open fresh link within 5 min. First opener wins the cookie.
- Expiry nudge: daemon sends Telegram reminder at 3 days left. No auto-mint.

## 5. Security

- OpenCode password stays on both hosts. Access JWT validated on `/pair` too. Telegram owner-ID gate + 1s poll (no public surface in phase 1).
- Phase 2 webhook: public `tghook.oc.buyallmemes.com/tg/<uuid>`, secret header check first (instant 403), 64KB cap, WAF 20/min/IP, UUID rotation per boot with 5-min grace, instant fallback to polling via `deleteWebhook`.
- Obscurity (random `oc-xxxx` name, UUID path) is layer only, never sole auth.

## 6. Failure handling

- Tunnel/WSL down: Cloudflare 502. Restart WSL service then `cloudflared`.
- Lockout: `opencode service set password` rotates and signs out all browsers.
- Flood: secret check before work, rate caps, kill switch to polling.
