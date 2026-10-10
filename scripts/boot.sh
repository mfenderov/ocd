# OCD boot script: brings the remote-access stack up in order.
# Runs at Windows logon via Task Scheduler (task "ocd-boot").
# Secrets live in ~/.ocd/env (chmod 600), never in the repo.
#
# Failure policy: stages are independent. A failing stage logs FAIL and
# the script continues with the rest. This script never stops or kills
# anything and never exits nonzero because of one bad stage.
set -u
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"
LOG="$HOME/.ocd/boot.log"
mkdir -p "$HOME/.ocd" 2>/dev/null || true

log() { echo "$(date -u +%FT%TZ) [$1] $2" >>"$LOG"; }

if [ -f "$HOME/.ocd/env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$HOME/.ocd/env"; set +a || log WARN "env file failed to source, continuing with defaults"
else
  log WARN "no ~/.ocd/env, daemon stage will be skipped"
fi

log BOOT "=== boot start ==="

# Stage 1: editor backend. Failure here still allows tunnel+daemon boot;
# they will serve 502 until the backend returns, and recover on their own.
if "$HOME/.opencode/bin/opencode" service start >>"$LOG" 2>&1; then
  log OK "opencode service start accepted"
else
  log FAIL "opencode service start (tunnel/daemon continue anyway)"
fi

# Stage 2: tunnel. Outbound-only; reconnects by itself on network churn.
if pgrep -f "cloudflared tunnel run oc-wsl" >/dev/null 2>&1; then
  log OK "tunnel already running"
elif command -v cloudflared >/dev/null 2>&1; then
  if nohup cloudflared tunnel run oc-wsl >>"$LOG" 2>&1 & then
    log OK "tunnel started pid $!"
  else
    log FAIL "tunnel failed to launch"
  fi
else
  log FAIL "cloudflared not on PATH"
fi

# Stage 3: dispenser daemon. Needs secrets; skipped cleanly without them.
if [ -z "${OCD_TG_TOKEN:-}" ] || [ -z "${OCD_OWNER_ID:-}" ]; then
  log FAIL "daemon skipped: OCD_TG_TOKEN/OCD_OWNER_ID unset (service+tunnel unaffected)"
elif [ ! -x "$HOME/.local/bin/ocd" ]; then
  log FAIL "daemon skipped: ~/.local/bin/ocd missing"
elif pgrep -f "ocd serve" >/dev/null 2>&1; then
  log OK "daemon already running"
else
  export OCD_DB="${OCD_DB:-$HOME/.ocd/ocd.db}" OCD_PAIR_URL="${OCD_PAIR_URL:-https://oc.buyallmemes.com}" \
    OCD_PUBLIC_URL="${OCD_PUBLIC_URL:-https://oc-tap.buyallmemes.com/pair}" \
    OCD_NO_CAP="${OCD_NO_CAP:-}" OCD_PAIR_OPEN="${OCD_PAIR_OPEN:-}"
  if nohup "$HOME/.local/bin/ocd" serve >>"$LOG" 2>&1 & then
    log OK "daemon started pid $!"
  else
    log FAIL "daemon failed to launch"
  fi
fi

log BOOT "=== boot done ==="
exit 0
