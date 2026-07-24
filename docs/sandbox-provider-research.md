# Sandbox provider research

Research date: 2026-07-24.

## Conclusion

CodeRoamer is the control surface at the top of a dependent stack:

```text
CodeRoamer
    │ connects, streams, and reattaches
    ▼
sandbox / remote machine
    │ launches and keeps running
    ▼
coding agent / CLI
    │ selects, authenticates, and calls
    ▼
model provider or local inference
```

These are not three parallel integrations:

- CodeRoamer connects to the runtime environment.
- The runtime holds the repository, tools, processes, CLI authentication, and
  on-disk session transcripts.
- CodeRoamer launches and speaks the session protocol of a coding CLI inside
  that runtime.
- The coding CLI, not CodeRoamer, owns model selection, provider
  authentication, and model API calls.

Adding Gemini, GLM, Kimi, Mistral, or local inference therefore usually means
supporting a coding CLI that can use that model. It does **not** mean building a
Gemini/GLM/Kimi/Mistral transport into CodeRoamer.

Runtime integration should still be capability-based. Trying to make every
provider pretend to be a perfect Fly Sprite would hide meaningful lifecycle,
reattach, persistence, and checkpoint differences.

Recommended order:

1. Finish and harden the existing custom VM / home server branch.
2. Spike Daytona and E2B side by side; Daytona currently looks closest to the
   persistent-machine product model, while E2B has strong process/PTY
   primitives.
3. Evaluate Runloop and Blaxel as the next managed-runtime candidates.
4. Treat CodeSandbox SDK and Vercel Sandbox as emerging options.
5. Treat Cloudflare Sandbox as a later, Worker-backed provider.

## What CodeRoamer actually adapts

There are two separate adapter boundaries:

1. A **runtime adapter** owns environment lifecycle, command execution,
   streaming, reconnect, PTY, persistence, and checkpoints.
2. A **coding-agent adapter** owns command construction, event parsing, session
   IDs, transcript recovery, interruption, and authentication errors for
   Claude Code, Codex, OpenCode, Crush, Pi, or another CLI.

There should not be a third CodeRoamer “model provider adapter” in this
architecture. The coding agent already has that abstraction. CodeRoamer may
surface the agent's model setting in its UI, but it should pass that setting to
the agent rather than routing model traffic itself.

Examples of complete stacks:

| Status | Complete stack | Where model auth lives |
|---|---|---|
| Works today | CodeRoamer → Sprites → Claude Code → Anthropic | Inside the Sprite, managed by Claude Code |
| Works today | CodeRoamer → Sprites → Codex → OpenAI | Inside the Sprite, managed by Codex |
| In development | CodeRoamer → custom VM → Claude Code or Codex → supported provider | On the custom machine |
| Direction | CodeRoamer → home server → OpenCode or Pi → local inference | On the home server / inside the CLI |

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

| Capability | Sprites | Custom VM / home server | Daytona | E2B | Cloudflare Sandbox |
|---|---|---|---|---|---|
| Persistent repository | Native persistent ext4 | Native machine filesystem | Persistent by default; filesystem survives stop/start | Pause/resume preserves filesystem and memory | Requires R2 mount or backup/restore across container sleep |
| Agent survives phone disconnect | Native detachable exec | `remote-agent` owns the process | Sessions and process execution APIs | Commands and PTYs can be reconnected | Background process + `keepAlive` |
| PTY, stdin, resize | Yes | Yes | Yes | Yes | Yes, through a Worker WebSocket |
| Reattach | Yes | Yes, with scrollback replay | Session/log APIs need a focused spike | Command and PTY reconnect APIs | Terminal replay; process logs can be fetched or streamed |
| Checkpoint semantics | In-place full filesystem rollback | Host-specific; absent in v1 | Filesystem and memory/process snapshots | Snapshot creates another sandbox | Directory backup/restore through R2 |
| Direct mobile integration | Existing | Existing compatibility protocol | SDK transport needs validation | SDK transport needs validation | No: SDK is called from a Cloudflare Worker |
| Product fit | Current baseline | Strong | Very strong on paper | Strong | Possible, but structurally different |

## Additional managed runtime landscape

This is a shortlist, not a claim that every provider already works with
CodeRoamer. “Fit” means similarity to the capabilities CodeRoamer needs, not
general platform quality.

| Provider | Relevant primitives | CodeRoamer fit | Main unknown or mismatch |
|---|---|---|---|
| [Daytona](https://www.daytona.io/docs/en/persistence/) | Persistent-by-default sandboxes, stop/start filesystem persistence, memory/process snapshots, sessions, log streaming, PTY | **Very strong** | Verify detach/reattach behavior and React Native transport end to end |
| [E2B](https://e2b.dev/docs/sandbox/persistence) | Pause/resume with memory, reconnectable background commands and PTYs, snapshots | **Strong** | Snapshot creates/forks a sandbox rather than restoring the same one |
| [Runloop](https://runloop.ai/) | Devboxes, snapshots/branching, suspend/resume, wake-on-HTTP | **Strong** | Validate interactive stdin/PTY and replay semantics against CodeRoamer's protocol |
| [Blaxel](https://docs.blaxel.ai/Sandboxes/Overview) | Filesystem/process/memory state in standby, scale to zero, process/file/terminal APIs | **Strong** | Younger platform; validate session durability and mobile-friendly auth/transport |
| [CodeSandbox SDK](https://codesandbox.io/sdk) | VM sandboxes, hibernate, fork, snapshot/restore, continuous context | **Promising** | SDK is in open beta; product and API stability need monitoring |
| [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox/concepts/snapshots) | Firecracker sandboxes, filesystem snapshots, resumable and named persistent sandboxes | **Promising** | Session duration limits and the persistence beta need validation for long agent runs |
| [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) | Background processes, terminal replay, `keepAlive`, R2 backup/restore | **Possible** | Requires a Worker/Durable Object control layer; local container state is not Sprite-like persistence |
| [Modal](https://modal.com/docs/guide/sandboxes) | Sandboxes, process execution, filesystem snapshots | **Lower fit** | Maximum lifetime and snapshot-into-new-sandbox model make continuous sessions less natural |

Supporting references:

- Daytona: [process execution and sessions](https://www.daytona.io/docs/en/process-code-execution/),
  [log streaming](https://www.daytona.io/docs/en/log-streaming/), and
  [web terminal](https://www.daytona.io/docs/en/web-terminal/).
- Runloop: [TypeScript API client](https://runloopai.github.io/api-client-ts/stable/)
  and [Python Devbox API](https://runloopai.github.io/api-client-python/sdk/async/devbox.html).
- CodeSandbox: [CodeSandbox SDK](https://codesandbox.io/sdk).
- Vercel: [duration and persistence](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence)
  and [persistent sandboxes beta](https://vercel.com/changelog/vercel-sandbox-persistent-sandboxes-beta).
- Modal: [Sandbox snapshots](https://modal.com/docs/guide/sandbox-snapshots).

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

interface CodingAgentAdapter {
  buildStartCommand(input: AgentTurnInput): AgentCommand;
  buildResumeCommand(input: AgentResumeInput): AgentCommand;
  parseEvent(line: string): AgentEvent | null;
  readTranscript(session: AgentSession): Promise<ChatMessage[]>;
  classifyAuthIssue(stderr: string): AgentAuthIssue | null;
  supportedModelConfiguration: 'fixed-provider' | 'provider-and-model' | 'custom';
}
```

`useChat` should consume `ExecutionTransport`, not know whether the underlying
implementation is a Sprites WebSocket, E2B process connection, Cloudflare
process logs, or the custom VM compatibility daemon. Agent-specific behavior
should live behind `CodingAgentAdapter`; the adapter may pass model flags or
environment variables to the CLI, but it should not make model API calls.

The UI should query capabilities rather than branch on provider names. Examples:

- Sprites: “Restore checkpoint.”
- Daytona: label filesystem snapshots and hot snapshots according to their
  actual restore behavior after the proof of concept.
- E2B: “Create snapshot” and “Fork environment.”
- Cloudflare: “Back up workspace” and “Restore workspace.”
- Custom VM: hide checkpoint controls unless the connection adds a snapshot
  implementation.

This keeps the product promise honest: one interaction model across runtimes,
without pretending the runtimes have identical infrastructure semantics.
