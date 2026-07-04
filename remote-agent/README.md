# remote-agent

A single-binary daemon that speaks the Sprites **exec + services + filesystem**
wire protocol, so the app can point at any Linux machine (a VPS, an AWS EC2
instance, or a home server) instead of `api.sprites.dev`.

Written in Go so it cross-compiles to one static, dependency-free binary — no
Node/`node-gyp`/toolchain on the target (see `docs/custom-vm-providers.md` §3.4).
The `:name` path segment is accepted but ignored (one machine per daemon).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `PUT` | `/sprites/:name/services/:svc` | run a command, stream NDJSON `ServiceLogEvent`s |
| `GET` | `/sprites/:name/services/:svc` | service status |
| `GET` | `/sprites/:name/services/:svc/logs` | replay + stream logs |
| `DELETE` | `/sprites/:name/services/:svc` | stop the service |
| `GET` | `/sprites/:name/services` | list services |
| `GET` | `/sprites/:name/exec` | list live TTY sessions |
| `WS` | `/sprites/:name/exec?cmd=…&cols=&rows=` | new PTY session |
| `WS` | `/sprites/:name/exec/:sessionId` | attach (replays scrollback) |
| `POST` | `/sprites/:name/exec/:sessionId/kill` | kill a session |
| `PUT` | `/sprites/:name/fs/write?path=…` | write a file (raw body bytes) |

An optional leading `/v1` is accepted, so the app's `${baseUrl}/v1` base works.
Auth is `Authorization: Bearer $AGENT_TOKEN` on every HTTP and WS request (WS also
accepts `?token=` for clients that can't set headers).

Exec output is framed with a stream-id byte (`1`=stdout) to match the app's exec
parser; `session_info` and `exit` are JSON text frames. Stdin is a binary frame,
optionally prefixed with `0x00`.

## Build & run

```bash
# Build a static binary for the current machine:
CGO_ENABLED=0 go build -o remote-agent .

# Or cross-compile for both common server arches into dist/:
bash build.sh

# Run:
AGENT_TOKEN=$(openssl rand -hex 32) PORT=8765 ./remote-agent

# Test (spins the daemon up in-process and exercises exec/services/fs):
go test ./...
```

## Install on a machine

```bash
bash install.sh    # obtains the binary, generates a token, installs a systemd user unit
```

Then expose it over HTTPS/WSS (Tailscale Funnel, Cloudflare Tunnel, or a reverse
proxy) and add it in the app under **Add Custom VPS**. See
`docs/custom-vm-providers.md` and `MIGRATION.md`.
