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
  log WARN "no ~/.ocd/env, the daemon starts with defaults (heartbeat off)"
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

# Stage 3: dispenser daemon. The binary is the only thing it needs: the
# DB path defaults to ~/.ocd/ocd.db, and the brain is optional — without
# OCD_WORKER_URL the daemon still serves /pair (and /_oc/* when the
# admin token is set) and logs "heartbeat off".
if [ ! -x "$HOME/.local/bin/ocd" ]; then
  log FAIL "daemon skipped: ~/.local/bin/ocd missing"
elif pgrep -f "ocd serve" >/dev/null 2>&1; then
  log OK "daemon already running"
else
  export OCD_DB="${OCD_DB:-$HOME/.ocd/ocd.db}" OCD_PAIR_URL="${OCD_PAIR_URL:-https://oc.buyallmemes.com}" \
    OCD_PUBLIC_URL="${OCD_PUBLIC_URL:-https://oc-tap.buyallmemes.com/pair}" \
    OCD_NO_CAP="${OCD_NO_CAP:-}" OCD_PAIR_OPEN="${OCD_PAIR_OPEN:-}" \
    OCD_ADMIN_TOKEN="${OCD_ADMIN_TOKEN:-}" OCD_WORKER_URL="${OCD_WORKER_URL:-}" \
    OCD_HEARTBEAT_TOKEN="${OCD_HEARTBEAT_TOKEN:-}" OCD_ENROLL_TOKEN="${OCD_ENROLL_TOKEN:-}" \
    OCD_BOX_ID="${OCD_BOX_ID:-}"
  if nohup "$HOME/.local/bin/ocd" serve >>"$LOG" 2>&1 & then
    log OK "daemon started pid $!"
  else
    log FAIL "daemon failed to launch"
  fi
fi

log BOOT "=== boot done ==="

# Fleet admin + heartbeat: the daemon logs its own on/off lines above, but
# echo config presence here too so the boot log always shows the state even
# when the daemon stage was skipped. Values are never logged.
if [ -n "${OCD_ADMIN_TOKEN:-}" ]; then
  log OK "admin on"
else
  log OK "admin off (OCD_ADMIN_TOKEN unset)"
fi
if [ -n "${OCD_WORKER_URL:-}" ]; then
  log OK "heartbeat on"
else
  log OK "heartbeat off (OCD_WORKER_URL unset)"
fi

# Verify: each stage must answer. A started-but-deaf process is FAIL, not OK.
# The daemon needs a moment to bind its port before it answers.
if command -v curl >/dev/null 2>&1; then
  ok=""
  for _ in 1 2 3 4 5 6; do
    if [ "$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:49400/healthz 2>/dev/null)" = "200" ]; then
      ok=1
      break
    fi
    sleep 5
  done
  if [ -n "$ok" ]; then
    log OK "daemon answers /healthz"
  else
    log FAIL "daemon does not answer /healthz (check log above)"
  fi
else
  log FAIL "curl missing, cannot verify daemon"
fi
if [ "$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:49374/ 2>/dev/null)" = "200" ]; then
  log OK "opencode answers locally"
else
  log FAIL "opencode does not answer locally"
fi
exit 0
