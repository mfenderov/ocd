# Mac Backend Runbook

Clone the home setup onto a Mac with full admin rights. ~30 minutes.
Nothing here changes the home box.

## 0. Collect

- New bot from BotFather → `OCD_TG_TOKEN` (name it `ocd_<box>`, e.g. `ocd_mac`).
- Your Telegram numeric ID → `OCD_OWNER_ID` (same value as home).
- Box id, lowercase, no spaces → `OCD_BOX_ID` (e.g. `mac`).
- Cloudflare account with `buyallmemes.com` (same account as home).

## 1. opencode v2

Install opencode, then in a terminal on the Mac:

```sh
opencode service start
opencode service status   # want http://127.0.0.1:49374
```

Keep hostname `127.0.0.1`. Never `0.0.0.0`.

## 2. Tunnel + DNS

```sh
brew install cloudflared
cloudflared tunnel login          # browser authorize, once
cloudflared tunnel create oc-mac
cloudflared tunnel route dns oc-mac mac.buyallmemes.com
cloudflared tunnel route dns oc-mac oc-tap-mac.buyallmemes.com
```

`~/.cloudflared/config.yml` (single-level names only — the wildcard
covers one level; `tap.mac` will NOT get a certificate):

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /Users/<you>/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: oc-tap-mac.buyallmemes.com
    service: http://127.0.0.1:49400
  - hostname: mac.buyallmemes.com
    service: http://127.0.0.1:49374
  - service: http_status:404
```

Run it (launchd plist next step uses the same command):

```sh
cloudflared tunnel --config ~/.cloudflared/config.yml run oc-mac
```

## 3. ocd daemon

```sh
GOOS=darwin GOARCH=arm64 go build -o ~/.local/bin/ocd ./cmd/ocd
```

`~/.ocd/env` (chmod 600):

```sh
OCD_TG_TOKEN='<mac-bot-token>'
OCD_OWNER_ID='<same-id-as-home>'
OCD_BOX_ID='mac'
OCD_PAIR_URL='https://mac.buyallmemes.com'
OCD_PUBLIC_URL='https://oc-tap-mac.buyallmemes.com/pair'
OCD_GROUP_ID='<shared-group-chat-id>'
OCD_BOT_NAME='ocd_mac'
```

Start once by hand: `ocd serve` (needs `opencode` on PATH).

## 4. Boot persistence (launchd)

`~/Library/LaunchAgents/com.ocd.serve.plist` running
`~/.local/bin/ocd serve` with the env file, `RunAtLoad`, `KeepAlive`.
Same for the tunnel (`cloudflared tunnel run oc-mac`).

## 5. Sleep policy (honest limits)

A lid-closed MacBook sleeps; no software prevents that. Choose one:

- Docked clamshell at the desk (display + power) — stays reachable.
- Otherwise accept work-hours reachability; the bot reports unreachable
  clearly and nothing breaks.

```sh
sudo systemsetup -setcomputersleep Never   # on adapter, lid open
```

## 6. Join the group

Create the solo-member Telegram group, invite both bots. In the group,
addressed commands only: `/login@ocd_bambot`, `/login@ocd_mac`. Bare
`/login` in the group is ignored by design (avoids double fire); DMs
keep working bare (a suffixed command pasted into a DM is dropped —
retype it bare). Never invite anyone else.
