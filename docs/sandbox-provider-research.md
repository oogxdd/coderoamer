# Sandbox provider research

Research date: 2026-07-24.

## Conclusion

CodeRoamer should treat the stack as three independent selections:

1. **Runtime environment** — where the repository, processes, and agent state live.
2. **Coding CLI** — the agent loop and its session format.
3. **Model provider** — selected through the coding CLI when that CLI supports it.

The runtime work should be capability-based. Trying to make every provider
pretend to be a perfect Fly Sprite would hide meaningful lifecycle and
checkpoint differences.

Recommended order:

1. Finish and harden the existing custom VM / home server branch.
2. Add E2B as the first managed provider after Sprites.
3. Treat Cloudflare Sandbox as a later, Worker-backed provider.

## The compatibility contract

The current app relies on more than “run a command in a VM.”

| Capability | Why CodeRoamer needs it |
|---|---|
| Create, list, connect, and delete environments | Dashboard and connection lifecycle |
| Persistent filesystem | Repository, CLI auth, installed tools, and transcripts survive |
| Long-running process after client disconnect | The phone can close while an agent keeps working |
| Stream stdout and stderr | Native chat event parsing |
| Process or session ID | Persist an active run across app restarts |
| List, reconnect to, and kill runs | Recovery after network changes and explicit interrupt |
| Bidirectional stdin and PTY resize | Codex app-server and the streamed terminal |
| Read/write files or run helper commands | Session browser and audio transcription |
| Snapshot/checkpoint behavior | Safety before running agents with approvals bypassed |
| Sleep/wake behavior | No always-on laptop or always-on compute bill |

Fly Sprites provide persistent ext4 storage, automatic idle/wake behavior,
detachable exec sessions, and whole-filesystem checkpoints:

- [Sprites persistence and lifecycle](https://docs.sprites.dev/concepts/lifecycle/)
- [Sprites Exec API](https://docs.sprites.dev/api/dev-latest/exec/)
- [Sprites Checkpoints API](https://docs.sprites.dev/api/dev-latest/checkpoints/)

## Provider comparison

| Capability | Sprites | Custom VM / home server | E2B | Cloudflare Sandbox |
|---|---|---|---|---|
| Persistent repository | Native persistent ext4 | Native machine filesystem | Pause/resume preserves filesystem and memory | Requires R2 mount or backup/restore across container sleep |
| Agent survives phone disconnect | Native detachable exec | `remote-agent` owns the process | Commands and PTYs can be reconnected | Background process + `keepAlive` |
| PTY, stdin, resize | Yes | Yes | Yes | Yes, through a Worker WebSocket |
| Reattach | Yes | Yes, with scrollback replay | Command and PTY reconnect APIs | Terminal replay; process logs can be fetched or streamed |
| Checkpoint semantics | In-place full filesystem rollback | Host-specific; absent in v1 | Snapshot creates another sandbox | Directory backup/restore through R2 |
| Direct mobile integration | Existing | Existing compatibility protocol | Possible, but React Native transport needs validation | No: SDK is called from a Cloudflare Worker |
| Product fit | Current baseline | Strong | Strong | Possible, but structurally different |

## E2B

### What maps cleanly

E2B already exposes most of the primitives CodeRoamer needs:

- Sandboxes can be listed, connected to, paused, resumed, and killed.
- Pause/resume preserves both filesystem and memory state.
- Commands can run in the background and can be listed, killed, and reconnected
  to by PID.
- PTYs support streaming output, stdin, resize, disconnect, and reconnect.
- Snapshots capture filesystem and memory.

Official references:

- [E2B sandbox persistence](https://e2b.dev/docs/sandbox/persistence)
- [E2B interactive PTY](https://e2b.dev/docs/sandbox/pty)
- [E2B process connect API](https://e2b.dev/docs/api-reference/process/connect)
- [E2B sandbox snapshots](https://e2b.dev/docs/sandbox/snapshots)

CodeRoamer already reconstructs chat state from the coding CLI’s on-disk
transcript before it reattaches. That reduces dependence on a provider replaying
all old stdout.

### Differences to expose

- An E2B snapshot is a reusable source for a **new** sandbox, not an in-place
  rollback of the same sandbox. The UI should call this “fork from snapshot” or
  implement an explicit environment replacement flow.
- Continuous runtime limits depend on the E2B plan. Auto-pause should be the
  default lifecycle, with a sufficiently long timeout while an agent run is
  active.
- The JavaScript SDK and its Connect transport must be tested in React Native.
  If that is unreliable, a small compatibility endpoint or a CodeRoamer agent
  baked into an E2B template is safer than leaking transport details into
  `useChat`.
- An E2B account API key controls the user’s sandboxes. Store it in native
  SecureStore and describe its scope honestly.

### Effort

- Focused proof of concept: **3–5 engineering days**.
- Production-quality provider: **2–3 weeks**.

The production estimate includes lifecycle UI, active-run recovery, snapshot
semantics, native networking validation, capability gating, error mapping, and
device tests. It does not include adding new coding CLIs.

## Cloudflare Sandbox

### What maps cleanly

The current Sandbox SDK has more relevant primitives than a generic ephemeral
container service:

- `execStream()` separates stdout/stderr and returns structured completion.
- Background processes have stable IDs, accumulated logs, streaming logs, list,
  and kill operations.
- Terminal connections are WebSockets with server-side ring-buffer replay and
  reconnection support.
- `keepAlive` prevents a container from sleeping during a long-running agent.
- Directories can be backed up to R2 and restored with copy-on-write overlays.
- S3-compatible buckets can be mounted for persistent data.

Official references:

- [Cloudflare Sandbox SDK overview](https://developers.cloudflare.com/sandbox/)
- [Background processes](https://developers.cloudflare.com/sandbox/guides/background-processes/)
- [Terminal reconnection and buffering](https://developers.cloudflare.com/sandbox/concepts/terminal/)
- [Backup and restore](https://developers.cloudflare.com/sandbox/guides/backup-restore/)
- [Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/)

### Why it is not another direct provider

The Sandbox SDK runs from a **Cloudflare Worker** and addresses containers
through Durable Objects. The mobile app therefore cannot simply swap
`api.sprites.dev` for a Cloudflare URL. It needs a Worker that:

1. Authenticates the CodeRoamer client.
2. Maps each user/environment to a Durable Object sandbox ID.
3. Starts the agent as a named background process.
4. Proxies or normalizes process logs, status, kill, and terminal WebSockets.
5. Enables `keepAlive` while work is active.
6. Creates an R2 backup when work becomes idle and restores it on cold start.

Without `keepAlive`, an idle container eventually stops and its local files and
processes are lost. R2 backup/mounting can preserve project data, but this is
not identical to a Sprite preserving a complete machine filesystem
automatically. A custom container image should contain the coding CLIs and other
base dependencies so every wake does not reinstall them.

This Worker can be deployed into the user’s Cloudflare account for a
BYO-control-plane mode. A hosted CodeRoamer Worker would be a separate product
and trust decision.

### Effort

- Focused proof of concept while the container stays alive: **5–8 engineering
  days**.
- Production-quality provider with auth, R2 persistence, cold restore, and
  recovery: **3–6 weeks**.

Cloudflare is viable, but it should ship behind explicit capabilities. Its
checkpoint should be described as a workspace backup, not a full-machine Sprite
checkpoint.

## Custom VM and home server

This is not greenfield work.

The repository already contains `remote-agent/`, which speaks the Sprites-shaped
services and exec protocol. The `feat/custom-vm-providers` branch additionally
contains:

- a static Go rewrite of the daemon;
- exec attach with scrollback, stdin, resize, list, kill, and Sprites-compatible
  framing;
- file upload support;
- the per-connection client model and UI;
- guided custom-machine setup;
- AWS lifecycle work.

The daemon has integration tests. The main remaining risks documented on the
branch are real-device UI/transport testing, real tunnel testing, and real AWS
testing.

Estimated remaining work:

- Useful beta for an existing Linux machine: **3–7 engineering days**.
- Production hardening including tunnel onboarding and device coverage:
  **1–2 weeks**.

Checkpoint support should be optional. A home server, an EC2 instance, and a
random VPS do not share one safe snapshot API.

## Recommended code shape

Keep provider lifecycle separate from execution transport:

```ts
type RuntimeCapabilities = {
  checkpoint: 'in-place' | 'fork' | 'directory-backup' | 'none';
  persistentFilesystem: boolean;
  pauseResume: boolean;
  terminal: boolean;
  attachRun: boolean;
  replayOutput: boolean;
  publicPorts: boolean;
};

interface RuntimeProvider {
  listEnvironments(): Promise<Environment[]>;
  createEnvironment(input: CreateEnvironmentInput): Promise<Environment>;
  connectEnvironment(id: string): Promise<Environment>;
  deleteEnvironment(id: string): Promise<void>;
  capabilities: RuntimeCapabilities;
}

interface ExecutionTransport {
  startRun(input: StartRunInput): Promise<RunHandle>;
  getRun(id: string): Promise<RunState>;
  listRuns(): Promise<RunState[]>;
  attachRun(id: string, callbacks: RunCallbacks): Promise<RunConnection>;
  killRun(id: string): Promise<void>;
}
```

`useChat` should consume `ExecutionTransport`, not know whether the underlying
implementation is a Sprites WebSocket, E2B process connection, Cloudflare
process logs, or the custom VM compatibility daemon.

The UI should query capabilities rather than branch on provider names. Examples:

- Sprites: “Restore checkpoint.”
- E2B: “Create snapshot” and “Fork environment.”
- Cloudflare: “Back up workspace” and “Restore workspace.”
- Custom VM: hide checkpoint controls unless the connection adds a snapshot
  implementation.

This keeps the product promise honest: one interaction model across runtimes,
without pretending the runtimes have identical infrastructure semantics.
