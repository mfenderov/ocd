# OCD backup: env, database, tunnel credentials. Secrets never leave
# this machine through this script — it writes a chmod-600 tarball to
# ~/.ocd/backups/. Copy the newest tarball off-disk yourself (USB /
# password manager); same-disk backup protects against deletion and
# corruption, not disk death. Restores are tested, see docs/runbook-home.md.
set -u
DEST="$HOME/.ocd/backups"
mkdir -p "$DEST"
STAMP="$(date -u +%FT%TZ)"
OUT="$DEST/ocd-backup-$STAMP.tar.gz"
if tar -czf "$OUT" -P "$HOME/.ocd/env" "$HOME/.ocd/ocd.db" "$HOME/.cloudflared" 2>/dev/null; then
  chmod 600 "$OUT"
  echo "wrote $OUT"
else
  echo "FAIL: tar failed, no backup written"
  exit 1
fi
ls -t "$DEST"/ocd-backup-*.tar.gz | tail -n +6 | xargs -r rm --
echo "kept newest 5"
