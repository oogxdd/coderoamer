# Integration connection architecture

This document explains how CodeRoamer connects third-party accounts inside a
Sprite, the failures that shaped the current design, and the checklist for
adding another integration.

The integration UI currently supports Claude Code, Codex, GitHub, and Vercel.
The reusable implementation lives in:

- `src/services/account-auth.ts` — provider metadata, credential detection,
  login commands, prompt parsing, and the Exec WebSocket transport;
- `src/components/sprite/ConnectAccountSheet.tsx` — the user-facing login state
  machine;
- `src/components/sprite/SpriteIntegrationsTab.tsx` — status and provider list;
- `scripts/ws-proxy.js` — the web-only authenticated WebSocket bridge;
- `src/services/__tests__/account-auth.test.ts` — pure protocol, parser, and
  command tests.

## Core decision: authenticate where the credential is used

An integration connected from a Sprite's Integrations tab belongs to that
Sprite. Its login command runs inside the Sprite, and its resulting credential
is stored there.

```text
phone or web UI
    │
    │ Exec WebSocket: start command, display safe prompts, send user input
    ▼
Sprite
    │
    │ provider CLI or device-flow HTTP requests
    ▼
provider authorization page
    │
    │ token/CLI state returns to the Sprite
    ▼
Sprite credential files and environment
```

This boundary is preferable to implementing provider login directly in the
browser:

- the credential is immediately available to the CLI and Git running in the
  Sprite;
- provider CORS policy does not affect the flow;
- localhost callbacks refer to the Sprite, rather than unexpectedly referring
  to the phone or browser machine;
- the client does not need to receive and then re-upload most credentials;
- web and native exercise the same provider command and credential storage.

The client still opens the provider's authorization URL and may accept a code
that must be pasted into a remote TTY. A manually supplied GitHub PAT is also
sent to the Sprite over WebSocket stdin. Secrets must never be placed in the
exec command, URL, task name, or logs.

## Onboarding versus per-Sprite connections

Onboarding currently asks only for the Sprites API token. Claude and GitHub
device-level auth UI in onboarding and Settings is feature-gated by
`ENABLE_GLOBAL_PROVIDER_AUTH`, while its implementation and the existing
token storage/provisioning code remain in the repository. Existing saved
credentials are not deleted by this UI change.

This is intentional. A provider login shown during onboarding implies a clear
product promise: sign in once, then every newly created Sprite receives a
usable, persistent session. That promise has not yet been validated across
provider refresh-token behavior, revocation, web storage, Sprite creation
failures, and changes made independently inside one Sprite.

Until that design is reintroduced deliberately, the visible product path is:

1. sign in to CodeRoamer with a Sprites token;
2. create or open a Sprite;
3. connect each provider from that Sprite's Integrations tab.

When global provider onboarding returns, do not merely unhide the screens.
First define credential ownership, conflict precedence, refresh propagation,
revocation, retry behavior for partially provisioned Sprites, and whether a
per-Sprite reconnect should override the global credential. The retained code
is a starting point, not proof that those semantics are safe.

## Login lifecycle

`ConnectAccountSheet` uses a small state machine:

1. `starting` — capture the existing credential signature and open the exec
   socket;
2. `awaiting` — show a parsed URL and/or device code;
3. `submitting` — optionally forward a callback code to the remote CLI;
4. `success` — a new credential signature is present;
5. `error` — the command failed, timed out, or the socket closed unexpectedly.

The command's success text is not the source of truth. Before login,
`getAccountSignatures` records a provider-specific signature based on the
credential file's metadata or an environment marker. Polling succeeds only
when a non-empty signature differs from that baseline. This matters for
Reconnect: pre-existing credentials must not cause an immediate false success,
and some CLIs replace or clear their auth file while login is in progress.

If a provider writes several files, include every supported location in the
signature. Detection should remain cheap, non-secret, and safe to run whenever
the tab is refreshed.

## Current provider strategies

| Provider | Remote strategy | TTY | Completion evidence |
| --- | --- | --- | --- |
| Codex | `codex login --device-auth` | Yes | `~/.codex/auth.json` changes |
| Claude Code | `claude setup-token`, then store the emitted OAuth token in `~/.sprite_env` | Yes, wide | Claude credentials or the environment token changes |
| GitHub | Node-based OAuth device flow in the Sprite; store `GH_TOKEN` and HTTPS Git credentials | No | Git config, credential store, or environment marker changes |
| Vercel | Existing `vercel`, or `pnpm dlx`/`bunx`/`npx` fallback; persist a local shim | No | A Vercel `auth.json` changes |

These strategies are deliberately provider-specific. A useful abstraction is
the transport and lifecycle, not an assumption that every CLI has identical
prompts or flags.

### Device authorization

Device flow is the cleanest option for a headless Sprite. The Sprite requests a
short-lived device code, the app shows the user code and opens the verification
page, and the Sprite polls until authorization completes. A public OAuth client
ID is sufficient; a client secret must not be shipped in the app or Sprite.

GitHub uses a small Node script instead of automating `gh auth login` prompts.
This avoids prompt changes such as Git protocol and credential-helper
questions. The current implementation uses GitHub CLI's public OAuth client ID,
which makes the authorization equivalent to GitHub CLI login. A production
CodeRoamer-owned OAuth or GitHub App is preferable for independent branding,
scope control, revocation policy, and lifecycle ownership. Device flow must be
enabled for that app, and a newly configured client ID should be validated
against the device-code endpoint before release.

GitHub's normal OAuth device flow grants broad scopes. The fine-grained option
remains a user-created PAT. Selected-repository OAuth requires a GitHub App;
see `docs/github-repo-scoped-auth-research.md`.

### Callback-code CLIs

Claude Code displays an authorization URL and then asks for a callback code.
The UI opens the URL and forwards the pasted code to the remote TTY. Treat a
paste and the Enter key as separate writes: some terminal applications
recognize a combined `code + carriage return` frame as bracketed/pasted input
but do not submit it.

The CLI may display a final generated token and wait for confirmation. The
client can detect that token without exposing it, send Enter, and let a shell
wrapper persist it. Any displayed preview must redact the token, callback code,
authorization URL parameters, and long opaque values.

### Browser-based CLI login

Setting `BROWSER=true` prevents a remote CLI from hanging while trying to open
a browser inside the Sprite. The client extracts the printed URL and opens it
locally. Do not assume flags such as `--no-browser` exist across CLI versions;
prefer behavior that can be induced through standard environment variables and
parse the resulting URL.

### Installing a missing CLI

A login flow should not depend on a privileged or global package installation.
Global npm installation has crashed on a Sprite in practice. Vercel therefore
tries package runners already available in the environment (`pnpm dlx`,
`bunx`, then `npx`) and writes a small per-user shim after a successful login.

For a new integration, prefer this order:

1. use an already installed executable;
2. use a provider-supported standalone binary or package runner;
3. install per-user and atomically update `PATH` in `~/.sprite_env`;
4. fail with a concrete remediation message if no runner exists.

Never report an installation as connected before both login and credential
detection succeed.

## Exec WebSocket protocol

Integration login uses `/v1/sprites/{name}/exec`, not the Services API. Exec is
appropriate because login is a single interactive process and must not be
restarted or replayed by a supervisor.

The protocol has two distinct data modes:

- non-TTY output is multiplexed as `[streamId][payload]`, where stdin is stream
  `0`, stdout is `1`, stderr is `2`, and exit may be `3` or a JSON control
  event;
- PTY output can arrive as raw terminal bytes with no stream prefix, and TTY
  stdin must likewise be sent raw.

Do not blindly remove the first byte of PTY output. A leading byte such as `13`
is usually a carriage return, not a stream ID. Conversely, non-TTY stdin must
retain its leading stream `0` byte.

JSON `session_info` and `exit` messages are control events, not provider
output. After `session_info`, a TTY resize is sent again because it is the first
proof that the upstream exec session exists. Wide columns matter: terminal
wrapping can split an OAuth URL and make parsing fail.

The login socket uses a finite `max_run_after_disconnect`. This tolerates a
short browser/app interruption but does not leave abandoned authorization
processes running indefinitely.

## Web versus native

The provider behavior is mostly identical because the provider process runs in
the Sprite in both cases. The connection path differs:

- native WebSocket clients can attach the Sprites bearer token as an
  `Authorization` header;
- browser WebSockets cannot set that header, so the local `ws-proxy` accepts
  the token, removes it from the upstream URL, and adds the header server-side.

The browser-facing socket can open before the proxy has connected upstream.
The proxy must queue early client frames, particularly the initial resize, and
flush them after the upstream socket opens. Without this queue, the UI can show
“Starting sign-in” forever even though an exec session exists with a `0 × 0`
terminal.

Web testing is therefore meaningful for provider prompts, parsing, polling,
and Sprite credential storage. It does not fully test native-only behavior such
as `Linking`, app background/foreground transitions, or native WebSocket header
handling. Every new integration should get at least one native smoke test.

Run web through `npm run web`; starting Expo without `scripts/ws-proxy.js` does
not provide the required authenticated WebSocket bridge.

## Parsing and diagnostics

CLI output is an unstable interface. It contains ANSI control sequences,
spinners, repeated redraws, terminal-width wrapping, and text that changes
between versions. Parsers should:

- accumulate output rather than assume a prompt fits in one frame;
- strip ANSI before matching;
- recognize stable URL hosts, code shapes, or explicit sentinels;
- tolerate spaces inserted between device-code characters by terminal redraws;
- avoid exact full-line matches when a smaller invariant exists;
- expose pure parsing helpers with captured-output tests.

Provider-owned scripts should emit explicit sentinels such as
`@@WISP_GITHUB_CONNECTED@@` and `@@WISP_GITHUB_ERROR@@...`. Sentinels are more
reliable than parsing human-oriented CLI prose.

Development logs use `[integration:<provider>]` in the client and
`[ws-proxy:<connection>]` in the proxy. Log lifecycle and framing metadata —
socket state, frame kind, byte count, control-event type, TTY dimensions — but
never commands, query strings, provider output, OAuth URLs, codes, or tokens.
Client logs must remain `__DEV__`-gated. When adding a provider, update the
proxy's verbose-command matcher if its flow needs proxy diagnostics.

## Credential storage and security

- Write credential files with mode `0600` where CodeRoamer controls the file.
- Use a temporary file and rename for atomic updates.
- Preserve unrelated lines when updating `~/.sprite_env` or Git credentials.
- Quote shell values defensively, but prefer stdin for any user-supplied secret.
- Never include secrets in React state used for diagnostics after submission;
  clear inputs promptly and redact accumulated output.
- Treat a connected Sprite as able to use every permission granted to its
  credential. A filesystem checkpoint does not undo remote pushes, deployments,
  or account mutations.
- Prefer short-lived or repository-scoped credentials where the provider
  supports them. Explain broad scopes in the UI.
- Disconnecting an integration should eventually revoke or remove every copy,
  not merely hide its status. A full disconnect/revocation UI is still future
  work.

## Adding another integration

Before implementation, answer these questions:

1. Where must the credential live, and which exact command will consume it?
2. Does the provider support device flow, a headless browser URL, a callback
   code, a token paste, or only a local callback server?
3. Can login run without a client secret? If not, a trusted backend is required.
4. Is a TTY truly required? Prefer non-TTY for deterministic output.
5. What exact filesystem or command evidence proves login completed?
6. What permissions and token lifetime will the user grant?
7. How will reconnect, expiry, revocation, and disconnect behave?

Implementation checklist:

1. Add the provider ID and metadata to `account-auth.ts`.
2. Add a minimal `loginSpec`: command, TTY requirement, and terminal width.
3. Add credential signature detection before exposing Connected status.
4. Add prompt parsing only for information the UI must display or submit.
5. Add provider-specific UI only when the shared sheet cannot express the
   flow.
6. Add safe errors and sanitized previews; never surface indefinite
   “Starting…” after an exit or socket failure.
7. Add pure tests for captured output, command syntax, framing, and redaction.
8. Update `ws-proxy.js` diagnostic matching if needed.
9. Test first connection and reconnect on a clean Sprite.
10. Test web through the proxy and at least one native build.
11. Test denial, expired code, missing CLI, missing package runner, socket drop,
    and an already-connected account.
12. Document the scopes, credential locations, expiry behavior, and any
    provider app-registration dependency.

## Known follow-up work

- Own the production OAuth registrations instead of relying on a provider
  CLI's public client ID where applicable.
- Add explicit Disconnect actions with local cleanup and provider revocation
  guidance.
- Model expiring credentials and refresh flows rather than showing a stale
  Connected state until the next real command fails.
- Extract the transport into a smaller tested module if more providers make
  `account-auth.ts` difficult to maintain.
- Add end-to-end fixtures for fragmented ANSI/TTY recordings. Unit tests cover
  the pure protocol logic today, but UI and live provider flows remain manual.
