# Home Box Runbook (oc-home.buyallmemes.com)

Live stack: `opencode service` (49374) + `cloudflared` tunnel
`7ed965a2-9828-46f6-851e-24cf1b9fedf6` + `ocd serve` (49400). The daemon
serves `/pair`, the `/_oc/*` box API (behind the admin token) and
`/healthz`, and it talks to the brain in two directions: a heartbeat to
`POST /api/heartbeat`, and one event batch every 30 seconds to
`POST /api/events` — the links that died and the audit rows that happened.

The Telegram bot (`@ocd_bambot`) is **not** on this box. It lives in the
brain — the Cloudflare Worker — and Telegram pushes its updates to
`POST /tg/webhook` on the Worker. The webhook is registered once, by
hand, with `scripts/brain-webhook.sh`; nothing re-registers it.

Autostart: **systemd user units** `ocd-tunnel.service` and
`ocd-serve.service` (templates in `systemd/`). They start on every WSL
boot, so a WSL restart alone no longer leaves the box dark. The old
Windows Task Scheduler task (`ocd-boot` → `scripts/boot.sh`) is the
fallback for a fresh Windows profile; `boot.sh` is idempotent and skips
whatever systemd already runs.

The tunnel unit runs the tunnel's **id**, not its name: renaming the
tunnel in the Cloudflare dashboard cannot stop the box. The id lives in
two places — `systemd/ocd-tunnel.service` (`ExecStart`) and
`scripts/boot.sh` (`TUNNEL_ID`) — and they must be changed together if
the tunnel is ever recreated, because a new tunnel gets a new id.

```sh
systemctl --user status ocd-serve ocd-tunnel
systemctl --user restart ocd-serve        # after a binary upgrade
```

`ocd onboard` restarts both units itself: cloudflared reads the
ingress rules at start-up (a connector that is not restarted keeps the
rules it loaded at boot), and the daemon reads `~/.ocd/env` at start-up
(a re-enrolment rotates the heartbeat and admin tokens). When a unit
cannot be restarted the onboarding says so and names it — the
enrolment itself is committed by then and never fails over a restart.

`ocd serve` loads `~/.ocd/env` itself (no sourcing needed) and reads its
DB path from `OCD_DB`, which must be an **absolute** path: systemd's
`EnvironmentFile=` does not expand `$HOME`, and a literal `$HOME` once
pointed the daemon at an empty database (fresh seq → every heartbeat
rejected as a replay).

## Hostnames

This box follows the naming convention like every other box.

- editor UI: `https://oc-home.buyallmemes.com` → 127.0.0.1:49374 (opencode)
- tap links: `https://oc-tap-home.buyallmemes.com/pair` → 127.0.0.1:49400 (daemon)

The old names still answer, and are dropped only after the Mac is on:

- editor UI: `https://oc.buyallmemes.com` → 127.0.0.1:49374 (opencode)
- tap links: `https://oc-tap.buyallmemes.com/pair` → 127.0.0.1:49400 (daemon)

`ocd repair` reads the hostnames from `~/.cloudflared/config.yml` — the
source of truth — and only fixes ports. Never let a tool invent hostnames
here.

## Daily use

- `/link` in the bot DM → buttons per box → tap one → you're in that
  machine's editor. `/login` = this box only.
- `/fleet`, `/flink <box>`, `/frevoke <box> YES`, `/fnuke YES`, `/faudit`.
- `/fnuke YES` revokes every box: every session dies, and each box is
  tombstoned until it comes back with a higher epoch. Until then the
  mint relay answers 409 `tainted` and the bot says "⚠️ Link failed".
  The answer names the outcome per box: `revoked` (it was online — it
  rotated its own epoch during the revoke, so its next heartbeat heals
  it) or `tombstoned` (it was offline, so it never got the revoke: it
  keeps its old epoch and stays unable to mint until it is back and a
  revoke reaches it again).
- `/revoke YES` is gone. It was the Go bot's *local* kill — this box's
  sessions only, nothing fleet-wide. `/fnuke YES` is the fleet-wide
  equivalent, and it means something else: it tombstones every box, not
  just this one. The brain answers an unknown command with silence, so
  an owner's muscle-memory `/revoke YES` gets no reply at all — use
  `/frevoke <box> YES` for one box.

## It broke: in order

1. `systemctl --user status ocd-serve ocd-tunnel` — a failed unit names
   the cause in `journalctl --user -u <unit>`.
2. `curl -s https://oc-home.buyallmemes.com/` — 200 means tunnel+backend are
   fine, the problem is the brain side (Telegram/Worker). 502 means the
   origin is down. 1033 means the tunnel has no connector.
3. Manual recovery: `bash ~/dev/ocd/scripts/boot.sh` (idempotent,
   start-missing-only, exit 0).
4. `ocd repair` — recomputes the derived env/tunnel values. It reloads
   the service on macOS only; on Linux the units are restarted by hand
   (`systemctl --user restart ocd-serve ocd-tunnel`). Safe to run any
   time; it never touches secrets.
5. Heartbeat rejected as "reset-looking seq" = the daemon opened a
   different database than the brain knows. Check `OCD_DB` is absolute
   and that the path holds the real `ocd.db`.

## Full reinstall (new disk)

1. Install Go toolchain, opencode v2, cloudflared; clone this repo.
2. Restore the newest `~/.ocd/backups/ocd-backup-*.tar.gz` over `/`
   (paths inside are absolute): env, `ocd.db`, and `~/.cloudflared/`
   (tunnel credentials + DNS routes survive — no Cloudflare redo).
3. `go build -o ~/.local/bin/ocd ./cmd/ocd`, install the systemd units
   (copy `systemd/*.service` to `~/.config/systemd/user/`, `systemctl
   --user daemon-reload && systemctl --user enable --now ocd-tunnel
   ocd-serve`), reboot, expect 🟢.
4. Still dark: fresh `cloudflared tunnel login` + recreate the tunnel and
   DNS routes, then `ocd repair`. A recreated tunnel has a new id — put
   it in `systemd/ocd-tunnel.service` and in `scripts/boot.sh`
   (`TUNNEL_ID`) too, or the box runs a tunnel that is no longer there.

## Off-disk copies (owner's job, monthly)

Copy the newest backup tarball to USB or password manager. Same-disk
backups survive deletion and corruption, not disk death or theft.
