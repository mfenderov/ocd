# systemd user units (WSL)

These keep a box alive across WSL restarts — WSL boots systemd, so the
units start the tunnel, the daemon, and the editor backend on every WSL
start. A Windows logon task cannot do that: it only fires when Windows
logs in, so a WSL restart left the box dark.

Install on a box:

```sh
cp systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ocd-tunnel.service ocd-serve.service opencode-service.service
sudo loginctl enable-linger $USER   # start units at boot, no login needed
```

Check: `systemctl --user status ocd-serve ocd-tunnel opencode-service`.

`ocd-serve` and `ocd-tunnel` read `~/.ocd/env`; the daemon also loads it itself, so the
environment works either way. `opencode-service` needs no env file — it
just issues `opencode service start`. `OCD_DB` must be an absolute path —
systemd's `EnvironmentFile=` does not expand `$HOME`.
