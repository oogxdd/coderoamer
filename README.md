# CodeRoamer

Run autonomous coding agents in isolated cloud development environments and control them from
your phone. Start a task, close your laptop, and come back later: the agent keeps running next to
the code, tools, and dependencies it needs.

CodeRoamer supports **Claude Code** and **Codex** today. Fly.io
[Sprites](https://sprites.dev) are the first supported sandbox runtime; support for additional
agent CLIs and remote environments is planned.

> CodeRoamer is under active development. The repository is being prepared for an open-source
> release.

---

## Why sandbox-first?

Most mobile companions are remote controls for an agent running on your computer. For example,
[Happy](https://happy.engineering/) runs the code and agent on your computer, while
[Omnara](https://remote.omnara.com/) starts from a local workflow and offers optional cloud
migration for selected repositories.

CodeRoamer takes the opposite approach: the remote environment is the primary machine from the
first prompt.

- Your laptop does not need to remain awake or connected.
- The agent keeps running when the phone app closes or changes networks.
- The repository, toolchain, CLI sessions, and transcripts live together in the remote environment.
- Your phone is a native control surface, not a relay to a laptop.
- The same architecture can target other sandbox providers and user-managed Linux machines.

With a Sprite, the filesystem persists while compute sleeps when idle. CodeRoamer wakes the
environment when work arrives and keeps it alive for the duration of an agent turn.

## Autonomy through isolation

CodeRoamer runs Claude Code and Codex with approvals bypassed by default. The agent can install
packages, edit files, run tests, and use the network without waiting for the user to approve every
tool call. This is intentional: a long-running task should not stop five minutes after you put
your phone away.

The boundary is the remote environment:

- The agent receives full control of the sandbox, not your laptop.
- You decide which repositories and credentials exist inside that sandbox.
- For GitHub, prefer an OAuth token or a **fine-grained PAT scoped to selected repositories**
  instead of copying your personal SSH private key.
- Sprites filesystem checkpoints provide a restore point before risky work.

Autonomy is not risk-free. An agent can still delete files inside the sandbox and perform any
remote action allowed by the credentials you give it. A checkpoint cannot undo a pushed commit,
deleted branch, or other GitHub-side operation. Use narrowly scoped tokens, protected branches,
and dedicated credentials when appropriate.

## Agents and accounts

### Supported today

- **Claude Code** — native streamed chat, resumable sessions, tool cards, partial output, and
  on-disk transcript discovery.
- **Codex Live** — the Codex App Server JSON-RPC transport
  (`codex app-server --stdio`) with thread resume, models, and reasoning effort.
- **Codex Legacy** — `codex exec --json`, retained as a fallback transport.

### Subscription login

You do not have to pay separately for model API usage if you already use a supported subscription:

- Claude Code can authenticate with a Claude subscription through `claude setup-token`.
- Codex can authenticate with a ChatGPT account through the Codex device-login flow.
- GitHub can be connected per environment through device login, or with a pasted OAuth token /
  fine-grained PAT.

Onboarding currently stores only the Sprites token. Provider accounts are connected from each
Sprite's Integrations tab and their credentials live in that environment. Code for a future
device-level “sign in once, provision every Sprite” flow is retained but intentionally hidden
until its refresh, revocation, and conflict semantics are defined. Provider availability and usage
limits still depend on the user's Claude or ChatGPT plan.

Per-Sprite account connections run their login flow inside the selected environment so the
credential is created where its CLI will use it. The transport, web/native differences, security
rules, and extension checklist are documented in
[`docs/integration-auth-architecture.md`](docs/integration-auth-architecture.md).

### Planned

- [OpenCode](https://opencode.ai/)
- [Crush](https://github.com/charmbracelet/crush)
- Additional agent CLIs through the existing provider abstraction

## What the app provides

| Surface | What it is |
|---|---|
| **Chat** | A native mobile chat for Claude Code and Codex with streaming text, tool calls, plans, turn outcomes, queued prompts, retry, interrupt, model selection, and reasoning effort. |
| **Session browser** | Discovers Claude and Codex transcripts stored in the remote environment, renders them natively, and continues existing sessions. History survives reinstalling the phone app because the canonical transcript lives beside the agent. |
| **Stream terminal** | A real TTY over the Exec WebSocket, rendered with a native Skia terminal. Use the interactive agent TUI or run ordinary shell commands. |
| **Checkpoints** | Creates and restores Sprites filesystem checkpoints before autonomous or otherwise risky work. |
| **Dictation** | Device speech recognition, local recording, and audio-file transcription. Transcribed text is placed in the composer for review and is never auto-sent. |

Turns survive phone app restarts and network changes. If a WebSocket drops, CodeRoamer probes the
remote exec session, reattaches when it is still alive, or reconciles the final result from the
agent's on-disk transcript when it finished while the phone was offline.

## Quick start

### 1. Prepare the accounts

You need:

- a Sprites API token;
- a Claude subscription token from `claude setup-token`, or a Codex-capable ChatGPT account;
- optionally, a GitHub OAuth token or fine-grained PAT for cloning and pushing repositories.

On first launch, CodeRoamer asks for the Sprites token and walks through the initial Claude and
GitHub setup. Claude Code, Codex, GitHub, and Vercel CLI can also be connected for an individual
Sprite from its **Integrations** tab.

### 2. Create or open a Sprite

Create one with the **+** button in CodeRoamer or with the Sprites CLI. Install any project-specific
tools in the Sprite once; its filesystem persists between sessions.

### 3. Clone a repository

With GitHub connected inside the Sprite:

```bash
git clone https://github.com/you/your-repo.git /home/sprite/your-repo
```

You can run this from the stream terminal. An SSH key still works if you explicitly prefer one,
but it is not required.

### 4. Start a session

Open the Sprite, create a chat, choose Claude or Codex, and set the working directory:

```text
/home/sprite/your-repo
```

Send a prompt and leave. The turn runs inside the Sprite, independently of the laptop and phone.

## Working directories and resumable sessions

The working directory is locked once a conversation starts. Agent CLIs associate resumable
history with a project path, so changing directories in the middle of a chat can break resume
semantics. Start a new chat to work in another directory.

Use absolute paths in the app. A repository cloned to `~/your-repo` inside a Sprite is:

```text
/home/sprite/your-repo
```

The session browser scans the native transcript locations for both Claude Code and Codex. A chat
reopened from local storage also reconciles with those transcripts so completed background turns
appear after reconnecting.

## Privacy and data flow

The current native app has no CodeRoamer-hosted backend. It connects directly to the Sprites API:

```text
Phone ──authenticated Exec WebSocket──▶ Sprite
                                          │
                                          ├── Claude Code ──▶ Anthropic
                                          ├── Codex ────────▶ OpenAI
                                          └── Git ──────────▶ GitHub
```

- CodeRoamer stores chat metadata and messages locally in SQLite.
- Claude and Codex store their canonical transcripts inside the remote environment.
- Provider and GitHub credentials are stored with `expo-secure-store` on native devices, then
  copied into a selected environment when it is provisioned.
- Optional AssemblyAI or OpenAI transcription sends selected audio to that provider.
- Optional `ntfy` notifications contact the server configured by the user.
- The web build uses browser storage and a same-origin API proxy, so native is the preferred
  environment for sensitive credentials.

The open-source release will include a more detailed threat model and an auditable list of network
destinations.

## How chat transport works

Each turn runs as a fresh process over the Sprites **Exec WebSocket**, not as a supervised service:

1. CodeRoamer creates a uniquely named exec task in the chat's working directory.
2. It launches Claude Code or Codex with streamed machine-readable output and approval bypass.
3. A heartbeat keeps the Sprite awake while the agent is working.
4. Once the exec session ID is known, the active run is persisted in SQLite.
5. Parsed text, tool calls, results, and turn outcomes update the native chat.
6. On disconnect, CodeRoamer repeatedly probes and reattaches to the same exec session.
7. If the process ended while disconnected, the app finalizes the turn from the on-disk transcript.

Codex Live uses the App Server protocol over the same exec transport:

```text
initialize → thread/start or thread/resume → turn/start
```

This design avoids supervised-service restarts replaying a prompt and lets a turn continue for
hours after the phone disconnects.

## Remote environments

### Available now

- **Fly.io Sprites** — creation, lifecycle, exec, persistent filesystem, and checkpoints.

### In development

- **Custom Linux machines** through the included `remote-agent`, which implements the Sprites
  service and exec wire protocol.
- Direct connection profiles with a per-machine URL and token.
- Additional managed sandbox providers beyond Sprites.

The goal is for agent choice and runtime choice to be independent:

```text
Claude Code / Codex / OpenCode / Crush
                    ×
Sprites / custom VM / future sandbox providers
```

See [`remote-agent/MIGRATION.md`](./remote-agent/MIGRATION.md) for the current custom-machine
integration plan.

## Development

```bash
npm install
npx expo start
npx expo run:ios
npm run android
npm run web
npm run lint
npm run test
```

The iOS and Android apps require a development build rather than Expo Go because the project uses
custom native modules. After changing a native dependency or native configuration, rebuild with:

```bash
npx expo prebuild --clean
npx expo run:ios
```

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for simulator, device, EAS, and TestFlight instructions.

## Tech stack

- Expo 55 / React Native 0.83 / Expo Router
- TypeScript
- SQLite for chats, messages, and persisted active runs
- `expo-secure-store` for credentials on native platforms
- Skia and a custom ANSI terminal implementation
- Exec WebSockets for streamed process I/O and reattachment
- Vitest for parsers, transcript merging, command builders, and transport helpers

## Roadmap

- Open-source release with a documented threat model
- OpenCode support
- Crush support
- Custom Linux machine connections
- Additional sandbox providers
- Better repository bootstrap and narrowly scoped GitHub credential setup
