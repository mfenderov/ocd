# Mac Backend Runbook

A second box, on macOS. One command does the work:

```sh
brew install --cask mfenderov/tap/ocd    # ocd itself
brew install cloudflare/cloudflare/cloudflared
```

Then send `/enrollcode mac` to the Telegram bot. It replies with a code and
the exact command to paste here:

```sh
ocd onboard mac <code>
```

That is the whole onboarding. `ocd` creates the tunnel, routes DNS, writes
`~/.ocd/env` (chmod 600), enrolls the box, and installs a launchd login
service. If `cloudflared` was never authorized on this Mac, `ocd` opens the
browser login for you.

Bare `ocd` does the same thing, asking for the name first:

```
$ ocd
Name this machine
> mac

Send this to your Telegram bot:

  /enrollcode mac

Then paste the code it replies with:
> <paste from Telegram>
✓ Box mac is in the fleet.
```

The code is single-use and lives 15 minutes. The bot sends exactly one
message; there is no approve link to tap.

## What you end up with

- `ocd serve` on port 49400 (pair + box API), supervised by launchd
  (`~/Library/LaunchAgents/dev.ocd.serve.plist`), started at login.
- Tunnel `oc-<box>` in `~/.cloudflared/config.yml`, routing
  `oc-tap-<box>.buyallmemes.com` (tap links) and `oc-<box>.buyallmemes.com`.
  `ocd serve` supervises cloudflared itself (`OCD_MANAGE_TUNNEL=1`).
- No Telegram bot on this box. The single bot lives on the primary box;
  a second bot would fight it over updates. This box still answers the
  fleet API and mints tap links on request.

## opencode v2 (the editor this box serves)

```sh
opencode service start
opencode service status   # want http://127.0.0.1:49374
```

Keep hostname `127.0.0.1`. Never `0.0.0.0`. The UI hostname in the tunnel
config points at this port.

## Sleep policy (honest limits)

A lid-closed MacBook sleeps; no software prevents that. Choose one:

- Docked clamshell at the desk (display + power) — stays reachable.
- Otherwise accept work-hours reachability; the fleet reports it
  unreachable clearly and nothing breaks.

```sh
sudo systemsetup -setcomputersleep Never   # on adapter, lid open
```

## Checking it

- `/fleet` in the primary bot's DM lists every box with live state.
- `/flink <box>` mints a tap link for that box.
- On the Mac: `curl -s https://oc-tap-<box>.buyallmemes.com/healthz` → `ok`.
