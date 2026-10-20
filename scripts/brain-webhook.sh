#!/usr/bin/env bash
# The cutover: hand Telegram to the brain.
#
# Telegram keeps ONE webhook per bot and the last writer wins. The home box
# registers its own webhook on every `ocd serve` start, so the brain has to
# take the webhook over once, deliberately, after the box has stopped
# competing. Nothing does it for us: not the release workflow, not the
# alarm. This script is that one step.
#
# Inputs, from the environment:
#   BRAIN_URL                the public origin of the brain, e.g. https://brain.example.com
#   TELEGRAM_BOT_TOKEN       the bot token (the one still in ~/.ocd/env)
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
# webhook. A webhook that was not registered is a silent outage: the next
# step of the cutover would look like it worked while the bot is still on
# the old box.
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
  echo "brain-webhook: the brain did not take Telegram. The bot is still on the old box." >&2
  exit 1
fi

echo "brain-webhook: Telegram now points at $webhook_url"
