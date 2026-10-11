# Multi-Backend Distribution Design

**Goal:** Same tap-to-login from one phone for N backends (home Windows box,
work Mac, later a cloud box). One shared Telegram group, one bot per box.

**Non-goals:** Shared single bot (Telegram allows exactly one consumer per
bot: webhook XOR one poller). Cross-box proxying (couples availability).
Cloudflare Worker gateway (deferred; revisit only if group UX fails).

## 1. Topology per box

Each backend is a full clone of the home setup, fully independent:

- `opencode service` on loopback (v2, generated password, 30-day cookies).
- `cloudflared` named tunnel, one per box, same Cloudflare account.
- `ocd serve`: Telegram consumer (polling or webhook) + `/pair` tap handler
  + SQLite (proxy tokens, audit). Same binary, per-box env.
- Own Telegram bot token (BotFather, ~2 min each).

Either box dies, the others never notice. No shared state anywhere.

## 2. Naming

Single-level subdomains only (wildcard `*.buyallmemes.com` covers one level;
`tap.oc` failed issuance for this reason, proven 2026-10-10):

- Home: `oc.buyallmemes.com` (UI/app), `oc-tap.buyallmemes.com` (taps).
- Work Mac: `mac.buyallmemes.com`, `oc-tap-mac.buyallmemes.com`.
- Cloud box N: `oc-<name>.buyallmemes.com`, `oc-tap-<name>.buyallmemes.com`.

## 3. Shared group mode

- One solo-member Telegram group (owner only, forever). Every box bot joins.
- Trigger with addressed commands: `/login@ocd_home`, `/login@ocd_work`.
  Only the named bot answers; others ignore (prefix match keeps working).
- Gate change (small): allow chat ID == owner DM **or** `ALLOWED_GROUP_ID`
  env. Everything else (proxy links, receipts, sweeper, audit) unchanged.
- DMs keep working as today. A new backend = new bot + one invite, no code.

## 4. Mac specifics

- Full admin assumed (confirmed). `opencode` v2 on macOS, `cloudflared`
  darwin build, ocd cross-compiled `GOOS=darwin GOARCH=arm64`.
- Boot persistence via launchd plist (Mac equivalent of the logon task).
- Lid-closed sleeps the Mac (tunnel dead). Mitigations: `systemsetup
  -setcomputersleep Never` on adapter, keep lid open or accept
  work-hours-only reachability. Bot reports unreachable clearly; nothing
  to fix in code.

## 5. Webhook per box

Each bot keeps its own webhook to its own tap host with rotating UUID path
+ secret, as built for home. Rotation per daemon boot, polling fallback
when `OCD_WEBHOOK_BASE` unset. No cross-box webhook sharing (impossible
per Telegram's one-consumer rule).

## 6. Audit and control

- Audit stays per box (`/audit` in the right chat answers for that box).
  The group gives a unified *view* by scrolling one chat, not one query.
- `/revoke YES` stays per box (server password rotation is box-local).
  Cross-box nuke is deliberately absent: run it twice, once per chat.

## 7. Rollout order

1. Group-gate change on home ocd + create group + invite home bot.
2. Mac clone (tunnel, DNS, daemon, bot, launchd), invite to group.
3. Cloud box later = repeat step 2. Gateway only if this fails in practice.
