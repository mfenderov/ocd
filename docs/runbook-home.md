# Home Box Runbook (oc.buyallmemes.com)

Live stack: `opencode service` (49374) + `cloudflared` tunnel `oc-wsl` +
`ocd serve` (49400) + `@ocd_bambot` (webhook push). Autostart: Task
Scheduler `ocd-boot` at logon → `scripts/boot.sh`.

## Daily use

- `/login` in the bot DM → tap link → browser/app session (30 days).
- `/status`, `/devices`, `/audit` for state and trail.
- `/revoke YES` kills every session everywhere (then `/login` fresh).

## It broke: in order

1. Open `https://oc.buyallmemes.com` — 200 with UI means tunnel+backend
   fine, problem is Telegram/bot side. 502 means WSL side down.
2. On the box: `tail -n 20 ~/.ocd/boot.log` — every boot logs OK/FAIL
   per stage plus `/healthz` verification.
3. Manual recovery: `bash ~/dev/ocd/scripts/boot.sh` (idempotent,
   start-missing-only, exit 0). Then re-check the site.
4. No 🟢 ping after a boot you expected = daemon never started.

## Full reinstall (new disk)

1. Install Go toolchain, opencode v2, cloudflared; clone this repo.
2. Restore the newest `~/.ocd/backups/ocd-backup-*.tar.gz` over `/`
   (paths inside are absolute): env, `ocd.db`, and `~/.cloudflared/`
   (tunnel credentials + DNS routes survive — no Cloudflare redo).
3. `go build -o ~/.local/bin/ocd ./cmd/ocd`, create `ocd-boot` logon
   task (see Mac runbook's Windows section pattern), reboot, expect 🟢.
4. Still dark: fresh `cloudflared tunnel login` + recreate tunnel and
   DNS routes, then `cloudflared tunnel route dns` for both hostnames.

## Off-disk copies (owner's job, monthly)

Copy the newest backup tarball to USB or password manager. Same-disk
backups survive deletion and corruption, not disk death or theft.
