# systemd user units (WSL)

These keep a box alive across WSL restarts — WSL boots systemd, so the
units start the tunnel and the daemon on every WSL start. A Windows
logon task cannot do that: it only fires when Windows logs in, so a WSL
restart left the box dark.

Install on a box:

```sh
cp systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ocd-tunnel.service ocd-serve.service
```

Check: `systemctl --user status ocd-serve ocd-tunnel`.

Both units read `~/.ocd/env`; the daemon also loads it itself, so the
environment works either way. `OCD_DB` must be an absolute path —
systemd's `EnvironmentFile=` does not expand `$HOME`.
