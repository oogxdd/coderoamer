# Connecting the app to any remote machine

This document describes:
1. How to run `remote-agent` on a Linux machine.
2. How to expose it securely over HTTPS/WSS.
3. What to change in the app to support both Sprites and generic remote connections.

---

## 1. Run the daemon

### Quick install (on the remote machine)

```bash
# Clone the repo or copy the remote-agent/ folder, then:
bash remote-agent/install.sh
```

The script installs Node dependencies, generates an `AGENT_TOKEN`, writes a
systemd user service, and starts it on port **8765**.

Manual start (no systemd):

```bash
cd remote-agent
npm install
AGENT_TOKEN=$(openssl rand -hex 32) PORT=8765 node index.js
```

Print the token you'll need for the app:

```bash
grep AGENT_TOKEN ~/.remote-agent/.env
```

---

## 2. Expose the daemon over HTTPS/WSS

The app connects over HTTPS + WSS. Plain HTTP on an open port is fine on a
LAN, but you'll want TLS for anything internet-reachable.

### Option A — Tailscale Funnel (easiest, zero config)

```bash
tailscale funnel 8765
```

Tailscale gives you a `https://<machine>.ts.net` URL and handles certs. The
app connects to `https://<machine>.ts.net/v1/...`.

### Option B — Caddy reverse proxy (self-hosted, auto-TLS)

```bash
# Install Caddy, then add to your Caddyfile:
your.domain.com {
  reverse_proxy localhost:8765
}
```

Caddy auto-fetches a Let's Encrypt cert. The app uses `https://your.domain.com/v1/...`.

### Option C — nginx + certbot

```nginx
server {
  listen 443 ssl;
  server_name your.domain.com;
  ssl_certificate     /etc/letsencrypt/live/your.domain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/your.domain.com/privkey.pem;

  location / {
    proxy_pass         http://localhost:8765;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade    $http_upgrade;   # required for WebSocket
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host       $host;
  }
}
```

### Option D — LAN only (no TLS)

If the phone and machine are on the same network (or the same Tailscale
tailnet without Funnel), `http://192.168.x.y:8765` is fine for development.
The app will need `http://` and `ws://` instead of `https://` and `wss://`.

---

## 3. App changes

The app currently hardcodes two Sprites base URLs:

| File | Constant | Value |
|---|---|---|
| `src/services/api.ts` | `BASE_URL` | `https://api.sprites.dev/v1` |
| `src/services/exec-poc.ts` | `EXEC_HTTP_BASE` | `https://api.sprites.dev/v1` |
| `src/services/exec-poc.ts` | `EXEC_WS_BASE` | `wss://api.sprites.dev/v1` |

The remote-agent speaks the **exact same URL paths** (`/sprites/:name/services/:svc`, etc.),
so no logic changes are needed — only the base URLs and the token source need
to become per-connection instead of global.

### Step 1 — Connection model

Add a `Connection` type and a storage helper:

```typescript
// src/models/connection.ts

export type ConnectionType = 'sprites' | 'remote';

export interface Connection {
  id: string;           // local UUID
  type: ConnectionType;
  /** Display name (e.g. "my MacBook" or a sprite name). */
  name: string;
  /** https://… base URL *without* the /v1 suffix. */
  baseUrl?: string;     // only for 'remote' connections
  token: string;        // spritesToken for 'sprites'; AGENT_TOKEN for 'remote'
}
```

Store connections in `expo-secure-store` (same pattern as the existing `loadToken`).
One connection can be marked as the active one in `AsyncStorage`.

### Step 2 — Parameterize api.ts

Replace the module-level constant with a function that accepts a connection:

```typescript
// src/services/api.ts  (simplified diff)

- const BASE_URL = 'https://api.sprites.dev/v1';
+ function baseUrl(conn: Connection): string {
+   if (conn.type === 'remote') return `${conn.baseUrl}/v1`;
+   return 'https://api.sprites.dev/v1';
+ }
+
+ async function getToken(conn: Connection): Promise<string> {
+   return conn.token; // already loaded by caller
+ }
```

Threads `conn` through `apiRequest`, `streamService`, `streamServiceLogs`, etc.

For Sprites connections the token is the Sprites API token (Bearer auth);
for remote connections it's the `AGENT_TOKEN` (same Bearer auth — the daemon
uses the same header format).

### Step 3 — Parameterize exec-poc.ts

```typescript
// src/services/exec-poc.ts  (simplified diff)

- const EXEC_HTTP_BASE = 'https://api.sprites.dev/v1';
- const EXEC_WS_BASE   = 'wss://api.sprites.dev/v1';
+ // Derived from connection at connect() time:
+ // httpBase = conn.type === 'remote' ? `${conn.baseUrl}/v1` : 'https://api.sprites.dev/v1'
+ // wsBase   = httpBase.replace(/^https?/, conn.type === 'remote' ? 'ws' : 'wss')
                         // (or keep wss if baseUrl starts with https)
```

Add `connection: Connection` to `ExecConnectOptions` and derive the URL inside `connect()`.

### Step 4 — "Machine name" for remote connections

The URL paths contain `/sprites/:name/…`. For a Sprites connection `:name` is
the sprite name; for a remote connection you can use any fixed string — the
daemon ignores it. Easiest: use the connection's `name` field. No other code
needs to know the difference.

### Step 5 — Connections manager screen

Replace (or extend) the current single "API Token" auth screen with a
connections list:

```
Connections
├── + Add Sprites account   (existing flow, stores spritesToken)
└── + Add remote machine    (new: enter HTTPS URL + AGENT_TOKEN)
```

Each connection maps 1-to-1 with the current sprite detail screen — tap a
connection → see its "machines" (for Sprites, the sprite list; for remote, just
the one machine).

### Step 6 — session.ts / claude-sessions.ts

`listClaudeSessions` and `readClaudeSessionMessages` use `runExec` which calls
`api.streamService`. As long as `streamService` is parameterized (Step 2), the
session browser works unchanged for remote connections too.

---

## 4. What the daemon does NOT implement

The remote-agent only implements what the app uses for chat + terminal:

| Sprites feature | Remote-agent support |
|---|---|
| `PUT /sprites` (create sprite) | — not needed |
| `GET /sprites` (list sprites) | — not needed |
| Checkpoints (create/restore) | — not needed |
| Services API (run commands, NDJSON) | ✓ |
| Exec API (TTY, attach, list, kill) | ✓ |

If you add checkpoints support later, the pattern is the same — add routes to
`index.js` and new API functions in `api.ts`.

---

## 5. Security notes

- **Use a long random token** (`openssl rand -hex 32`). It's the only auth layer.
- **Always use HTTPS/WSS** in production — the token travels in the Authorization header on every request.
- **Firewall port 8765** so only your HTTPS reverse proxy (or Tailscale) can reach it directly.
- The daemon runs commands as whichever user starts it. Treat access to the agent as equivalent to SSH access.
