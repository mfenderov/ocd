#!/usr/bin/env bash
# The cutover: hand Telegram to the brain.
#
# Telegram keeps ONE webhook per bot and the last writer wins. The Go bot
# that used to live on the home box is gone, so nothing competes with the
# brain any more — the brain has to take the webhook over once, by hand,
# and nothing does it for us: not the release workflow, not the alarm.
# This script is that one step.
#
# Inputs, from the environment:
#   BRAIN_URL                the public origin of the brain, e.g. https://brain.example.com
#   TELEGRAM_BOT_TOKEN       the bot token — a Worker secret now, not a key in ~/.ocd/env
#   TELEGRAM_WEBHOOK_SECRET  the webhook secret of the brain. Telegram sends
#                            it back as X-Telegram-Bot-Api-Secret-Token on
#                            every update, and the brain checks it there.
#
# Usage:
#   BRAIN_URL=https://brain.example.com \
#   TELEGRAM_BOT_TOKEN=123:abc \
#   TELEGRAM_WEBHOOK_SECRET=s3cret \
#     scripts/brain-webhook.sh
#
# Exits non-zero when an input is missing or when Telegram refuses the
# webhook. A webhook that was not registered is a silent outage: Telegram
# keeps delivering to whatever it had, and the brain never hears the
# owner.
set -euo pipefail

: "${BRAIN_URL:?BRAIN_URL is required: the public origin of the brain}"
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required: the bot token}"
: "${TELEGRAM_WEBHOOK_SECRET:?TELEGRAM_WEBHOOK_SECRET is required: the webhook secret}"

# The origin without a trailing slash, so the route is /tg/webhook and not
# //tg/webhook. Telegram wants an HTTPS webhook and refuses anything else
# ("HTTPS url must be provided for webhook"), so an http:// origin is not
# accepted here.
brain_url="${BRAIN_URL%/}"
case "$brain_url" in
  https://*) ;;
  *)
    echo "brain-webhook: BRAIN_URL must be an https origin, got: $BRAIN_URL" >&2
    exit 1
    ;;
esac
webhook_url="${brain_url}/tg/webhook"

# The request body. Both update kinds are allowed: without callback_query
# Telegram never delivers the button taps.
payload="$(printf '{"url":"%s","secret_token":"%s","allowed_updates":["message","callback_query"]}' \
  "$webhook_url" "$TELEGRAM_WEBHOOK_SECRET")"

# The body goes in on stdin, not in the argument list: an argument is
# readable by anyone on the box in /proc/PID/cmdline, and the secret must
# not be. The bot token stays in the URL, because that is the shape of the
# Telegram API.
if ! response="$(printf '%s' "$payload" | curl -sS --max-time 30 -w '\n%{http_code}' \
  -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  --data-binary @-)"; then
  echo "brain-webhook: could not reach Telegram" >&2
  exit 1
fi

status="${response##*$'\n'}"
body="${response%$'\n'*}"

# Telegram answers {"ok":true} when it took the webhook and {"ok":false,...}
# when it refused. Both an HTTP error and a refusal are a failed cutover.
# Telegram always puts ok first, so the match is anchored to the start of
# the body: a refusal that merely mentions "ok":true must not pass.
ok_pattern='^\{"ok"[[:space:]]*:[[:space:]]*true'
if [ "$status" != "200" ] || ! [[ "$body" =~ $ok_pattern ]]; then
  echo "brain-webhook: Telegram refused the webhook (HTTP $status)" >&2
  echo "brain-webhook: $body" >&2
  echo "brain-webhook: the brain did not take Telegram. The bot is not answering." >&2
  exit 1
fi

echo "brain-webhook: Telegram now points at $webhook_url"

# The menu: the commands Telegram offers in the chat. The brain answers
# the typed commands in worker/src/botcommands.ts (/help there is the
# text of record); these one-liners must say the same thing in fewer
# words.
#
# The menu is set on TWO scopes, and that is deliberate, not redundant:
# Telegram shows a DM the most specific scope that has commands, and an
# ancient menu once lived on all_private_chats while default carried the
# new one — the owner saw the old commands and nothing here could
# explain it. Both scopes carry the same list, so no scope can disagree.
# The group scope is deleted outright: the bot talks to exactly one
# chat — the owner's — and a group menu would be a lie.
menu='{"commands":[{"command":"start","description":"List what the fleet bot can do"},{"command":"help","description":"List what the fleet bot can do"},{"command":"fleet","description":"Every box, its state and last sync, with Open and Pair buttons"},{"command":"devices","description":"The clients that tapped in"},{"command":"faudit","description":"The fleet'"'"'s history, newest first"},{"command":"audit","description":"The fleet'"'"'s history, same as /faudit"},{"command":"frevoke","description":"Revoke one box (confirm with YES)"},{"command":"revoke","description":"Retired: points at the fleet-wide /fnuke"},{"command":"fnuke","description":"Revoke every box (confirm with YES)"},{"command":"enrollcode","description":"A one-time code for a new box"},{"command":"status","description":"The primary box'"'"'s service status"}]}'

# One scope's menu: the body goes in on stdin, as above. Nothing secret
# rides here, but the shape stays the same so the calls cannot drift
# apart. Exits nonzero when Telegram refuses or cannot be reached.
set_scope_menu() {
  local scope="$1"
  local body status response payload
  # The menu var is {"commands":[...]}; the scope goes in front of it.
  payload="{\"scope\":${scope},${menu#\{}"
  if ! response="$(printf '%s' "$payload" | curl -sS --max-time 30 -w '\n%{http_code}' \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" \
    -H 'Content-Type: application/json' \
    --data-binary @-)"; then
    echo "brain-webhook: could not reach Telegram (scope $scope)" >&2
    return 1
  fi
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if [ "$status" != "200" ] || ! [[ "$body" =~ $ok_pattern ]]; then
    echo "brain-webhook: Telegram refused the menu (HTTP $status, scope $scope)" >&2
    echo "brain-webhook: $body" >&2
    return 1
  fi
}

# A refused menu is not a failed cutover: the webhook above is
# registered and the bot answers. It is still a loud failure — a bot
# with no menu hides every command — and rerunning this script retries
# the menu alone (re-registering the same webhook changes nothing).
menu_failed=0
set_scope_menu '{"type":"default"}' || menu_failed=1
set_scope_menu '{"type":"all_private_chats"}' || menu_failed=1
if [ "$menu_failed" != "0" ]; then
  echo "brain-webhook: the webhook is registered but the menu is not. Rerun this script." >&2
  exit 1
fi
# No group menu: this bot has exactly one chat.
curl -sS --max-time 30 \
  -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMyCommands" \
  -H 'Content-Type: application/json' \
  --data '{"scope":{"type":"all_group_chats"}}' > /dev/null || true

echo "brain-webhook: Telegram shows the command menu"
