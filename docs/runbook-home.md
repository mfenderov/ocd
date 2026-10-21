# Home Box Runbook (oc.buyallmemes.com)

Live stack: `opencode service` (49374) + `cloudflared` tunnel `oc-wsl` +
`ocd serve` (49400). The daemon serves `/pair`, the `/_oc/*` box API
(behind the admin token) and `/healthz`, and it talks to the brain in
two directions: a heartbeat to `POST /api/heartbeat`, and one event
batch every 30 seconds to `POST /api/events` — the links that died and
the audit rows that happened.

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

```sh
systemctl --user status ocd-serve ocd-tunnel
systemctl --user restart ocd-serve        # after a binary upgrade
```

`ocd serve` loads `~/.ocd/env` itself (no sourcing needed) and reads its
DB path from `OCD_DB`, which must be an **absolute** path: systemd's
`EnvironmentFile=` does not expand `$HOME`, and a literal `$HOME` once
pointed the daemon at an empty database (fresh seq → every heartbeat
rejected as a replay).

## Hostnames (this box does NOT follow the naming convention)

- editor UI: `https://oc.buyallmemes.com` → 127.0.0.1:49374 (opencode)
- tap links: `https://oc-tap.buyallmemes.com/pair` → 127.0.0.1:49400 (daemon)

`ocd repair` reads the hostnames from `~/.cloudflared/config.yml` — the
source of truth — and only fixes ports. Never let a tool invent hostnames
here.

## Daily use

- `/link` in the bot DM → buttons per box → tap one → you're in that
  machine's editor. `/login` = this box only.
- `/fleet`, `/flink <box>`, `/frevoke <box> YES`, `/fnuke YES`, `/faudit`.
- `/fnuke YES` revokes every box: every session dies and every box
  re-enrols (then `/login` fresh).

## It broke: in order

1. `systemctl --user status ocd-serve ocd-tunnel` — a failed unit names
   the cause in `journalctl --user -u <unit>`.
2. `curl -s https://oc.buyallmemes.com/` — 200 means tunnel+backend are
   fine, the problem is the brain side (Telegram/Worker). 502 means the
   origin is down. 1033 means the tunnel has no connector.
3. Manual recovery: `bash ~/dev/ocd/scripts/boot.sh` (idempotent,
   start-missing-only, exit 0).
4. `ocd repair` — recomputes the derived env/tunnel values and reloads
   the service. Safe to run any time; it never touches secrets.
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
   DNS routes, then `ocd repair`.

## Off-disk copies (owner's job, monthly)

Copy the newest backup tarball to USB or password manager. Same-disk
backups survive deletion and corruption, not disk death or theft.
