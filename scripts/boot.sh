# OCD boot script: brings the whole remote-access stack up in order.
# Runs at Windows logon via Task Scheduler (task "ocd-boot").
# Secrets live in ~/.ocd/env (chmod 600), never in the repo.
set -u
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/sdk/go1.27.2/bin:$PATH"
LOG="$HOME/.ocd/boot.log"
mkdir -p "$HOME/.ocd"
{
echo "=== boot $(date -u +%FT%TZ) ==="
# shellcheck disable=SC1091
. "$HOME/.ocd/env"

"$HOME/.opencode/bin/opencode" service start 2>&1 | head -n 2

if ! pgrep -f "cloudflared tunnel run oc-wsl" >/dev/null; then
  nohup cloudflared tunnel run oc-wsl >>"$LOG" 2>&1 &
  echo "tunnel started pid $!"
else
  echo "tunnel already running"
fi

if ! pgrep -f "ocd serve" >/dev/null; then
  cd "$HOME" || exit 1
  nohup "$HOME/.local/bin/ocd" serve >>"$LOG" 2>&1 &
  echo "ocd started pid $!"
else
  echo "ocd already running"
fi
} >>"$LOG" 2>&1
