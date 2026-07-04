# Multi-provider VMs: Sprites + Custom VPS (AWS / home server)

Status: **handoff spec — nothing in this doc is implemented yet.** Written for a
fresh session (possibly a different, more capable model) with no memory of the
conversation that produced it. Read this whole file, then read the files it
points to, before writing any code.

This is a description of the problem and the reasoning behind a few
already-made calls, not a rigid step list. The workstream breakdown in §3 is
by area, not a mandated order — reuse the existing foundation in §1 rather
than duplicating it, but otherwise if you find a better approach than what's
sketched below, take it and note why you deviated.

## 0. What's being asked for (the actual requirements)

The app's sprite list screen is conceptually a **list of VMs**. Today it only
lists Sprites. The user wants:

1. On the VM list screen, "Add" lets you choose **Add Sprite** (existing flow)
   or **Add Custom VPS** (new).
2. A Custom VPS connection can be exposed to the app over **Tailscale** or
   **Cloudflare Tunnel** — both should be supported, selectable in the add flow.
3. A clear guide — ideally a script — for making an arbitrary VPS expose the
   **same API shape Sprites exposes**, so the rest of the app (chat, terminal,
   session browser) works against it unmodified.
4. Custom VPS support should cover two concrete cases:
   - **One default cloud provider (e.g. AWS)**: the app can *programmatically
     create* the VM, and ideally *programmatically put it to sleep* (stop) and
     wake it (start).
   - **A literal home server** (the user's own machine at home): same daemon,
     but no public IP / no programmatic power control — different networking
     story, no sleep/wake.
5. Comprehensive documentation for all of the above (both user-facing setup
   guides and engineering docs), matching this repo's existing `docs/` style
   (see `docs/codex-chat-transport-architecture.md` for tone/format — dense,
   technical, decisions + rationale, not tutorial fluff).

The user explicitly does **not** want a ttyd-in-a-webview style integration for
this — they want the actual structured Sprites-shaped API (exec/services/fs),
not a terminal-sharing proxy.

## 1. Critical: this is already ~70% built. Read it first.

**`remote-agent/`** in this repo is a working Node daemon (`node-pty` + `ws`)
that already speaks the exact same wire protocol Sprites exposes, so the app
can point at *any* Linux machine instead of `api.sprites.dev`. It exists
today, is not a proposal. Files:

- `remote-agent/index.js` — the daemon. Implements:
  - `PUT/GET/DELETE /sprites/:name/services/:svc` (+ `/logs`) — supervised
    command execution, NDJSON stream, matches `ServiceLogEvent` shape exactly.
  - `GET /sprites/:name/exec` (list sessions), `WS /sprites/:name/exec?cmd=...`
    (new PTY session), `WS /sprites/:name/exec/:sessionId` (attach + scrollback
    replay), `POST /sprites/:name/exec/:sessionId/kill`.
  - Bearer token auth (`AGENT_TOKEN` env var) on both HTTP and WS.
  - The `:name` path segment is accepted but ignored (single-machine daemon).
- `remote-agent/install.sh` — installs Node if missing, copies the daemon to
  `~/.remote-agent`, generates `AGENT_TOKEN`, writes a **systemd user service**
  (auto-starts on boot/reboot — this is what makes "wake" viable later: as long
  as the OS boots, the API is already listening).
- `remote-agent/MIGRATION.md` — **the actual plan for the app-side changes**,
  written by a previous session, not yet executed. It already specifies:
  - A `Connection` type (`src/models/connection.ts`, not yet created):
    ```typescript
    export type ConnectionType = 'sprites' | 'remote';
    export interface Connection {
      id: string;
      type: ConnectionType;
      name: string;
      baseUrl?: string;   // only for 'remote'
      token: string;      // spritesToken or AGENT_TOKEN
    }
    ```
  - Parameterizing `src/services/api.ts`'s `BASE_URL` constant and
    `src/services/exec-poc.ts`'s `EXEC_HTTP_BASE`/`EXEC_WS_BASE` constants into
    functions of a `Connection` instead of module-level constants.
  - A "Connections" screen replacing the single auth screen.
  - Four documented exposure options: Tailscale Funnel, Caddy reverse proxy,
    nginx+certbot, or plain LAN HTTP for dev.
  - An explicit non-goal list (§4): checkpoints and sprite CRUD are **not**
    implemented by remote-agent and are marked "not needed."

**Build on this instead of starting a parallel design.** Broadly, the job is
to (a) finish what MIGRATION.md already specifies, (b) extend the
`Connection` model and daemon to cover AWS-backed and home-server cases,
(c) build the "Add Custom VPS" UI, (d) write the AWS create/sleep/wake layer,
(e) wire Tailscale/Cloudflare Tunnel selection into the guided setup, (f)
write the comprehensive docs. Treat `MIGRATION.md`'s steps 1–6 as a starting
point to diff against, not a spec to re-derive from zero — but if its
`Connection` shape or approach turns out to be the wrong fit once you're
actually implementing this, changing it is fine as long as the reasoning is
recorded somewhere (commit message, updated doc, whatever fits).

## 2. Wire protocol reference (ground truth: `src/services/api.ts`)

Any daemon (remote-agent as-is, or an AWS-bootstrapped instance) must speak
this exactly, since the RN client already implements the parsing side:

- **Exec WS**, `wss://<base>/v1/sprites/{name}/exec?cmd=...&path=...&tty=...&stdin=...&cols=...&rows=...&max_run_after_disconnect=...`:
  binary frames prefixed with a stream-id byte (`1`=stdout, `2`=stderr,
  `3`=exit+remainder), plus JSON text frames `{type:'session_info', session_id}`
  and `{type:'exit', exit_code}`. Client-side parsing:
  `src/services/api.ts:602-695` (`streamExec`) and `src/services/exec-poc.ts`.
  Stdin is sent as a binary frame with a leading `0x00` byte
  (`makeExecStdinFrame`, `api.ts:487`).
- **Exec attach**: `wss://<base>/v1/sprites/{name}/exec/{sessionId}` — replays
  scrollback then behaves like a live session.
- **Exec list/kill**: `GET /sprites/{name}/exec`, `POST /sprites/{name}/exec/{sessionId}/kill`.
- **Services**: `PUT /sprites/{name}/services/{svc}` (body: `ServiceRequest`
  — `{cmd, args?, needs?, http_port?}`), response is a chunked NDJSON stream of
  `ServiceLogEvent` (`{type: 'stdout'|'stderr'|'exit'|'error'|'complete'|'started'|'stopping'|'stopped', data?, exit_code?}`).
  `GET .../logs` replays + streams. `DELETE` kills it. See `src/models/service.ts`.
- **Filesystem**: `PUT /sprites/{name}/fs/write?path=...&workingDir=...&mode=...&mkdir=...`
  with the raw file bytes as the body, response `{path, size, mode}`
  (`src/services/api.ts:225-261`, `SpriteFileWriteResult`). **remote-agent does
  not implement this yet** — see §3.4.
- **Sprite-only, not in remote-agent and not needed there**: `GET/POST/DELETE /sprites`,
  `PUT /sprites/{name}` (`url_settings.auth`, used by the ttyd bootstrap flow),
  checkpoints (`GET/POST /sprites/{name}/checkpoint(s)`, restore).

Auth on every request: `Authorization: Bearer <token>` — Sprites token or
`AGENT_TOKEN`, identical header shape, so `getToken()`-equivalent logic can
stay provider-agnostic.

## 3. Workstreams

### 3.1 Connection model (client)

Extend, don't replace, the `Connection` shape from `MIGRATION.md`. It needs a
`backing` discriminant beyond `sprites | remote` so the UI/lifecycle code can
tell *how* a remote connection is hosted (matters for §3.6's sleep/wake, and
for which setup instructions to show):

```typescript
// 'existing' covers both a home server and any VPS you already have running
// remote-agent — same daemon, same code path. Home vs. "some other VPS" is
// purely a UI-copy / default-tunnel-suggestion distinction at add-time (see
// §3.2, §3.7), not a separate backing — don't add a fourth enum value for it.
export type ConnectionBacking = 'sprite' | 'existing' | 'aws-ec2';

export interface Connection {
  id: string;
  backing: ConnectionBacking;
  name: string;               // display name
  baseUrl?: string;           // https://... , unset for 'sprite'
  token: string;              // spritesToken or AGENT_TOKEN
  tunnel?: 'tailscale' | 'cloudflare' | 'none';
  aws?: { region: string; instanceId: string };  // only for 'aws-ec2'
}
```

Storage: list of connections, same secure-store pattern as `src/services/auth.ts`'s
`loadToken`/`saveToken` (today there's a single global `spritesToken`; this
becomes an array). `AuthContext` (`src/contexts/AuthContext.tsx`) currently
models exactly one global auth state — decide whether it's replaced by a
`ConnectionsContext` or extended; either way every screen that currently calls
`api.listSprites()` / `api.getSprite()` etc. assuming the global token needs to
thread the active `Connection` through instead.

### 3.2 UI changes

- `src/app/(app)/index.tsx` (currently `DashboardScreen`, sprite list + FAB) —
  generalize to list VMs across all connections (or keep per-connection lists
  if that's a cleaner IA — worth deciding explicitly, not defaulting silently).
- `src/components/dashboard/CreateSpriteSheet.tsx` (144 lines, `onCreate(name)`
  callback) — extend into a chooser: **Add Sprite** (existing behavior) vs
  **Add Custom VPS**, which branches into the sub-flow below.
- New "Add Custom VPS" flow, sub-choices:
  1. **Backing**: "AWS (create new)" vs "Existing machine" (home server or any
     VPS you already have running `remote-agent`).
  2. If "Existing machine": choose **Tailscale** or **Cloudflare Tunnel**
     (informational — determines which setup script/instructions are shown),
     then input `baseUrl` + `AGENT_TOKEN` (pasted after running the install
     script on the machine — see §3.5).
  3. If "AWS (create new)": AWS credential input + region + (fixed sane
     default instance type, or a small picker) + a "Launch" action — see §3.6.
- `src/app/(app)/sprite/[name].tsx` (1299 lines) has a Checkpoints tab
  (`CheckpointsList`, line ~947) and calls `updateSpriteUrlAuth`/`getSprite`
  from the ttyd bootstrap flow (`src/app/(app)/ttyd-terminal.tsx:387-392`) —
  **both are Sprites-only REST endpoints remote-agent doesn't implement.**
  These must be conditionally hidden/disabled for non-`sprite` connections,
  not left to fail silently against a 404.

### 3.3 `api.ts` / `exec-poc.ts` parameterization

Follow `MIGRATION.md` §Step 2/3 (`baseUrl(conn)`, thread `conn` through
`apiRequest`/`streamService`/`streamServiceLogs`/`streamExec`/etc.) — it's
already spelled out there with diffs, don't re-derive.

**Decided: custom connections (byo-vps/aws-ec2) are native-only, no web
support.** Web isn't a target for this feature at all — don't touch
`src/app/api/[...path]+api.ts` (it stays exactly as-is, hardcoded to
`https://api.sprites.dev`, used only for `sprite` connections) and don't add
CORS handling to the daemon for this purpose. `Platform.OS === 'web'` code
paths in `api.ts`/`exec-poc.ts` can just fall through to the existing
Sprites-only behavior, or explicitly branch to "unsupported" for non-`sprite`
connections — either is fine, just don't spend effort making custom
connections reachable from a browser.

### 3.4 remote-agent daemon extensions

- **Decided: port the daemon to Go, don't keep it in Node.** The current
  `node-pty` dependency is a native addon (node-gyp compiled) — on an
  arbitrary target machine (random VPS distro, or an ARM home server like a
  Raspberry Pi) this risks missing prebuilt bindings or a missing build
  toolchain at install time, exactly the class of failure this feature can't
  afford in a one-shot install script. Go (`creack/pty` + `gorilla/websocket`
  or `nhooyr.io/websocket`) compiles to a single static binary you can
  cross-compile from the dev machine (`GOOS=linux GOARCH=arm64 go build`) with
  zero runtime/toolchain dependency on the target — a better fit for "install
  this on any Linux box, including a Raspberry Pi." It's a different language
  from the rest of this (TypeScript/RN) codebase, but the daemon is small
  (~465 lines in its current Node form) and has no shared code with the app,
  so the cross-language boundary costs little. Keep the exact same wire
  protocol (§2) — this is a reimplementation of the transport, not a redesign.
- **Add `PUT /sprites/:name/fs/write`**, mirroring `writeSpriteFile`'s contract
  (query params `path`/`workingDir`/`mode`/`mkdir`, raw body bytes, JSON
  response `{path, size, mode}`). Needed because
  `src/services/audio-transcription.ts:133` calls `api.writeSpriteFile` for the
  sprite-side Whisper transcription path — without this, that feature silently
  breaks on remote/AWS/home connections.
- Checkpoints: leave out per `MIGRATION.md` §4 ("not needed") unless the user
  asks later — filesystem-snapshot semantics don't map cleanly onto a daemon
  running on a machine you don't otherwise manage.
- **Sleep/wake is explicitly not the daemon's job.** It's a property of the
  hosting layer: AWS EC2 stop/start (§3.6), or "the user turned their computer
  on/off" for home servers (§3.7). The daemon's only responsibility is to be
  running and reachable the instant the underlying machine/instance is up —
  which `install.sh`'s systemd unit (`Restart=always`, `WantedBy=default.target`)
  already provides.

### 3.5 Tailscale / Cloudflare Tunnel guided setup

`MIGRATION.md` §2 already documents four manual exposure options. The new
requirement is to make this **part of the in-app guided flow**, not just
static docs to follow by hand. Since the app has no ability to execute
commands on a remote machine on the user's behalf (no SSH client embedded —
this was deliberately scoped out earlier as a separate, heavier feature), the
realistic v1 scope is a **copy-a-script, paste-the-result** wizard, the same
pattern Coder/Portainer/etc. use for self-hosted onboarding:

1. Extend `remote-agent/install.sh` with a `--tunnel=tailscale|cloudflare|none`
   flag (or a follow-up prompt) that, when set:
   - `tailscale`: installs Tailscale if missing, runs
     `tailscale funnel 8765`, and at the end prints the resulting
     `https://<machine>.ts.net/v1` URL alongside the generated `AGENT_TOKEN`.
   - `cloudflare`: installs `cloudflared`, runs a quick/named tunnel pointed at
     `localhost:8765`, prints the resulting public URL + token.
   - `none`: today's behavior (prints the bare token, LAN-only), for users who
     already have their own reverse proxy (Caddy/nginx per `MIGRATION.md` §2
     options B/C).
2. In-app, the "Existing machine" screen shows the exact one-liner to copy
   (`curl ... | bash -s -- --tunnel=tailscale`, or equivalent), with a text
   field to paste back the resulting URL + token once the user has run it.
3. **Explicit non-goal**: the app SSHing into the VPS itself to run the
   installer with zero copy-paste. That's a materially bigger feature (embed
   an SSH client in React Native — evaluated and set aside earlier as a
   separate, heavier undertaking) and is out of scope here unless requested.

### 3.6 AWS integration (the one default cloud provider)

Scope: create an EC2 instance running remote-agent via bootstrap, then
list/stop/start it through the `Connection` model (`backing: 'aws-ec2'`,
`aws: {region, instanceId}`).

- **Bootstrap** (`user_data` / cloud-init on instance launch): install Node,
  fetch/copy `remote-agent/`, run `install.sh` non-interactively with a
  **pre-generated** `AGENT_TOKEN`, so the app already knows the token before
  the instance finishes booting (don't make the user round-trip a token out of
  the instance). Reuse the same `--tunnel=` flag from §3.5 in the bootstrap
  script so AWS-backed and manually-added VPS connections share one
  installer, not two.
- **Networking**: a default-VPC EC2 instance gets a public IP, but port 8765
  still needs TLS and shouldn't be open to the world. Recommend defaulting the
  AWS path to **Tailscale** as well (sidesteps needing a domain/cert per
  throwaway instance) and locking the security group to deny inbound 8765
  entirely, relying solely on the outbound tunnel.
- **Sleep/wake — use the EC2 Stop/Start Instances API, not an OS-level
  shutdown.** This matters because AWS actually stops compute billing while an
  instance is `stopped` (unlike e.g. Lightsail, which bills the flat plan rate
  regardless of power state — confirmed in prior research this doc's author
  did before writing this spec). Wake = `StartInstances` + poll
  `DescribeInstances`/health-check the tunnel URL until the daemon answers.
  **Reuse the existing cold-start UX pattern** already in the app:
  `src/app/(app)/index.tsx:81-96` (`handlePress`, `wakingSprites` state) shows
  a spinner and blocks navigation while a cold Sprite wakes via `runExec`;
  the AWS-backed equivalent is the same UX shape driven by `StartInstances` +
  poll instead.
- **Decided: user pastes their own scoped IAM access key/secret**, stored in
  SecureStore exactly like `spritesToken`/`claudeToken` today — no broker/
  backend. Consistent with how every other credential in this app already
  works, and appropriate for a single-user app (a broker's value is mostly
  about not equally trusting many different users' devices, which doesn't
  apply here).

  The residual risk (compromised device/keychain → attacker can spin up/tear
  down EC2 instances) is bounded, not open-ended, **but only if the IAM
  policy is scoped tightly**. Ship this exact policy shape as a first-class
  part of the documentation deliverable (real JSON, not prose describing
  one):
  - Actions limited to exactly `ec2:RunInstances`, `ec2:StopInstances`,
    `ec2:StartInstances`, `ec2:DescribeInstances`, `ec2:TerminateInstances`,
    `ec2:CreateTags`.
  - Resource-tag-restricted (e.g. `aws:RequestTag`/`aws:ResourceTag` condition
    on a fixed tag like `ManagedBy=sprites-rn-manager`) and single-region
    (`aws:RequestedRegion` condition).
  - **Also restrict `ec2:InstanceType`** via condition to the specific small
    type(s) actually used (`t4g.nano`/`t3.micro`). Tag-scoping alone doesn't
    stop a leaked key from calling `RunInstances` with an expensive instance
    type — the tag only exists *after* creation, so the instance-type
    condition is the part that actually caps cost exposure.
  - Recommend the user also set an AWS Budget/billing alarm independently of
    the IAM policy, as a second safety net that doesn't rely on the policy
    being airtight.

### 3.7 Home server

Same daemon (`remote-agent` + `install.sh`), no AWS API involved, `backing: 'existing'`
(see the note in §3.1 — home server and "any other VPS you already run" share
one backing value; only the suggested default tunnel differs).

- No programmatic sleep/wake: a home machine is fully on or fully off.
  Wake-on-LAN exists in principle but is fragile over WAN without another
  always-on relay device on the same LAN — **explicitly out of scope**,
  document the limitation rather than half-implementing it.
- Recommend **Tailscale** as the default suggested tunnel for this case
  specifically (avoids exposing the home IP/router at all); Cloudflare Tunnel
  as the documented alternative for users who'd rather have a public URL than
  toggle a VPN on their phone.

## 4. Documentation deliverables

- User-facing setup guides, one per path: "Add a custom VPS" (generic Linux
  box you already have), "Add an AWS-backed VM," "Add your home machine" —
  each ending in a copy-pasteable command block and the exact fields to paste
  back into the app.
- The AWS IAM policy JSON (§3.6) as its own reviewable artifact, not buried in
  prose.
- Update `remote-agent/MIGRATION.md` from "plan" to "implemented" once done —
  `AGENTS.md` itself says "When that migration lands, update this doc," and
  `AGENTS.md`'s own architecture section (`remote-agent/` description) and
  "Further reading" list need the same update.
- Update `README.md`'s connection-modes section to mention multi-provider
  connections alongside the existing chat/session-browser/terminal/ttyd modes.

## 5. Explicit non-goals (say so if asked, don't silently build them)

- Fully automated, zero-copy-paste VPS provisioning (would require an
  embedded SSH client — a materially separate feature).
- Checkpoints on remote-agent-backed connections.
- Self-hosted Firecracker/microVM-style sub-second sleep/wake for the VPS
  path — AWS EC2 stop/start (tens-of-seconds wake) is the deliberately chosen
  middle ground here, not an oversight. True microVM snapshot-resume needs
  bare-metal/KVM access most cloud VPS instances don't expose to the guest,
  and is a multi-week undertaking on its own.
- Providers beyond AWS (GCP/Azure/Hetzner/etc.) — not requested now, but keep
  `ConnectionBacking` an extensible union (not a hardcoded two-way branch) so
  adding one later doesn't force a model rewrite.
- Web-platform support for custom connections is unresolved (see §3.3) — pick
  native-only-for-v1 or extend the proxy safely, but make the choice visible
  in a commit/PR description, not implicit.

## 6. Testing plan — two stages, don't conflate them

**Implementation and credentialed end-to-end testing are separate steps.**
Whoever codes this will *not* have AWS or DigitalOcean credentials in hand
while writing it — those get handed over afterward, as a deliberate follow-up.
Don't block implementation on acquiring an AWS/DO account, and don't write
the code in a way that only becomes testable once real credentials exist.

### 6a. Self-verifiable now, no credentials needed

This is what should actually happen during implementation:

- **Go daemon**: fully testable on localhost. Run it locally, hit it with a
  plain WS/HTTP client (or point a local dev build of the app at
  `http://localhost:8765`) to exercise exec/services/fs — no cloud, no
  tunnel, no account needed. This is most of §3.4's surface.
- **AWS control-plane code** (`RunInstances`/`StopInstances`/`StartInstances`/
  `DescribeInstances` calls, retry/poll logic, error handling): write it
  against **LocalStack**, which mocks the AWS API and accepts dummy
  credentials — no real AWS account required. This proves "the code calls AWS
  correctly, handles errors, polls state correctly." It does *not* prove a
  real instance boots and the daemon comes up on it — that's 6b.
- **Tailscale/Cloudflare Tunnel install-script logic**: the script itself can
  be smoke-tested against a local VM/container/spare Linux box if one's
  available, or reviewed carefully if not — but a full pass showing the
  tunnel actually produces a reachable public URL needs a real machine (6b).
- App-side UI/connection-model work (§3.1–3.3): normal RN dev-loop testing,
  no external infra involved at all.

Ship the implementation once 6a is solid, with the AWS/tunnel/DigitalOcean
passes below written up as a **checklist for the follow-up step**, not left
implicit.

### 6b. Follow-up, once credentials are provided separately

This happens after — either the user runs it, or hands over credentials for
a subsequent pass. Two real-infrastructure checks:

- **AWS**: real (or dedicated test) account, IAM credentials scoped to the
  §3.6 policy (validates the policy is actually sufficient, not just
  written). Launch on a cheap/free-tier instance (`t4g.nano`/`t3.micro`) →
  confirm user-data bootstrap installs the daemon + tunnel → confirm the
  app's connection goes live once boot+tunnel finish → exercise chat/exec
  for real → Sleep (`StopInstances`) → confirm unreachable and the instance
  shows `stopped` (billing paused), not just OS-shutdown-but-still-metered →
  Wake (`StartInstances`) → confirm reconnect → terminate when done.
- **"Existing machine" path, mimicked with a DigitalOcean droplet**:
  repeatedly testing against an actual home machine is impractical, so a
  cheap hourly-billed droplet stands in for "a plain Linux box I can reach."
  This path has no programmatic sleep/wake by design (§3.7) — don't test
  power-cycling the droplet via DigitalOcean's own API, that's not what's
  being validated. Sequence: spin up the droplet → run the install script
  with `--tunnel=tailscale`, confirm a reachable URL+token → repeat with
  `--tunnel=cloudflare` so both §3.5 options get exercised → paste into the
  app's "Add Custom VPS → Existing machine" flow → confirm chat/exec/
  services/terminal work like a Sprite connection → confirm Checkpoints and
  the ttyd-bootstrap flow are correctly hidden for this connection type
  (§3.2) → destroy the droplet(s) afterward.

## 7. Background context (appendix, not requirements)

Before this spec was written, broader research compared Sprites against
Fly.io Machines, E2B, Vercel Sandbox, Daytona, and Cloudflare Containers
(microVM-style sleep/wake platforms), plus CRIU and self-hosted Firecracker as
build-your-own sleep/wake options, and Tailscale vs Cloudflare Tunnel as
exposure mechanisms (including a security comparison against sniffing on
public wifi, and SSH-vs-custom-API as transport/protocol choices). That
research is what narrowed the ask down to "AWS EC2 stop/start" and
"Tailscale-first" above — it's background rationale, not additional scope.
Not required reading to implement this spec.
