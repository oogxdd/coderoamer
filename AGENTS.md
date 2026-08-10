# AGENTS.md

Guide for AI agents working in this repository. Read this before making changes.

## What this is

**Sprites Manager** — an Expo / React Native mobile (and web) client for
[Fly.io Sprites](https://sprites.dev) (cloud dev VMs). It lets you run
**Claude Code** (and **Codex**) inside a Sprite and drive coding sessions from
your phone: a streaming chat, a native session browser that reads Claude's
on-disk transcripts, client/sprite audio transcription experiments, a
Skia-rendered TTY terminal over WebSocket, and filesystem checkpoints.

The app does **not** run Claude locally. It launches Claude *inside the sprite*
as a one-shot Sprites "service" and streams the NDJSON output back over HTTP.

## Essential commands

```bash
npm install                 # REQUIRED: .npmrc sets legacy-peer-deps=true (see Gotchas)
npx expo start              # start Metro bundler
npx expo run:ios            # dev build on iOS simulator (NOT Expo Go — custom native modules)
npx expo run:ios --device   # dev build on a connected physical iPhone
npm run android             # expo run:android
npm run web                 # starts scripts/ws-proxy.js (background) + expo start --web
npm run lint                # expo lint (ESLint, flat config in eslint.config.js)
npm run test                # vitest — unit tests for parsers/transcripts/helpers (src/**/__tests__)
npm run reset-project       # node ./scripts/reset-project.js (resets the Expo template bits)
```

EAS (build/ship to TestFlight — see `DEPLOYMENT.md`):

```bash
eas build  --platform ios --profile production         # store build (.ipa)
eas submit --platform ios --latest                     # upload to TestFlight
eas build  --platform ios --profile production --auto-submit
```

Manual dev helpers (not run by npm scripts):

```bash
node scripts/test-ws-server.js   # dummy WebSocket+PTY server for terminal dev (port 8082)
node scripts/ws-proxy.js         # WS auth proxy for web (browsers can't auth WS headers)
```

## Critical gotchas (read these first)

- **Not Expo Go.** The app bundles custom native modules (`@shopify/react-native-skia`,
  `react-native-webview`, `react-native-reanimated`/`worklets`). It requires a
  **dev build** (`npx expo run:ios`), not Expo Go. After *any* native
  dependency add/update or `app.json` native-config change, rebuild with
  `npx expo prebuild --clean && npx expo run:ios`. JS/TSX-only changes hot-reload.
- **`.npmrc` with `legacy-peer-deps=true` is committed and load-bearing.** A web
  devDependency pins an older Expo than the app, which makes npm's peer resolver
  error out. EAS cloud builds also read this file. Do not remove it.
- **`metro.config.js` contains two non-obvious hacks** — don't "simplify" it:
  1. Maps `punycode` to the real npm package (RN polyfill isn't enough for some deps).
  2. Strips trailing `.js` from `@babel/runtime/helpers` internal requires, because
     v7.28+'s package exports map omits `.js` but the helpers require with `.js`,
     which Metro can't match. The custom `resolveRequest` fixes this.
- **Unit tests exist; no e2e.** `npm run test` runs vitest over the pure chat
  logic (stream parsers, transcript rendering/merging, shell command builders)
  with `react-native`/`expo-secure-store` aliased to stubs (`vitest.config.ts`).
  UI and hooks are untested — verify those by running the app.
  `scripts/test-ws-server.js` is a *manual* dummy server for terminal
  development, not an automated test.
- **Bundle identifier** is `com.digital.coderoamer` in `app.json` (both
  `ios.bundleIdentifier` and `android.package`) — the source of truth. Change it
  in that one place if you need to rekey the app.
- **App config is dynamic.** `app.config.js` wraps `app.json` and stamps build
  provenance into `extra.build` (commit SHA from `EAS_BUILD_GIT_COMMIT_HASH`,
  `GITHUB_SHA`, or local git). Read it through `src/constants/build-info.ts`,
  never `Constants.expoConfig.extra` directly. Nothing in that config may vary
  per evaluation — it feeds the Expo fingerprint. See `docs/RELEASING.md`.
- **Release claims are load-bearing.** `docs/PROVENANCE.md` makes specific
  promises to users about what a released build proves; the workflow's commit
  check, the Sigstore attestation, and the "Reported commit" wording in Settings
  exist to keep those promises true. Do not weaken any of them — or the claims —
  without updating that document in the same change.
- **EAS versioning:** `eas.json` sets `cli.appVersionSource: "remote"` and
  `production.autoIncrement: true`. EAS bumps the **build number** automatically;
  bump `expo.version` in `app.json` only for a new marketing release. Don't also
  hand-bump `ios.buildNumber`.
- **React Compiler is ON** (`app.json` → `experiments.reactCompiler: true`),
  and `typedRoutes: true`. Keep components compiler-friendly (no unstable
  hook closures returning new objects on every render where avoidable).

## Architecture

### Route layout (Expo Router, file-based, `src/app/`)

```
_layout.tsx        Root: GestureHandlerRootView + ThemeProvider (light/dark)
                   + AuthProvider + ToastProvider, Stack
index.tsx          Loading/redirect based on auth state
auth.tsx           3-step sign-in (Sprites token → Claude token → GitHub)
api/[...path]+api.ts   Web-only reverse proxy to api.sprites.dev (see below)
(app)/             Auth-gated group (redirects to /auth if not signed in)
  _layout.tsx      Authenticated Stack
  index.tsx        Dashboard — sprite list, create sprite, links to Guides/Settings
  guide.tsx        In-app setup walkthrough
  settings.tsx     Defaults: provider, claude model, max turns, instructions,
                   working directory, git name/email, transcription keys,
                   auto-checkpoint
  sprite/[name].tsx  The main screen: tabs Overview / Chat / Checkpoints,
                     plus session browser + terminals entry points
  exec-poc.tsx     Stream terminal (WebSocket exec → Skia terminal)
  ttyd-terminal.tsx  Legacy web terminal (ttyd in a WebView)
```

### The chat streaming pipeline (the core of the app)

`src/hooks/useChat.ts` drives chat; its pure helpers (shell quoting, heartbeat
wrapper, transcript merge/signature, auth sniffing, notify/kill command
builders) live in `src/services/chat-helpers.ts` and are unit-tested. Flow:

1. `sendMessage` appends the user + empty assistant messages, persists them,
   then hands off to **`executeTurn`**, which builds a shell command:
   `mkdir -p <wd> && cd <wd> && . ~/.sprite_env && export NO_DNA=1 && claude -p
   --verbose --output-format stream-json --dangerously-skip-permissions
   --include-partial-messages --model <m> [--max-turns N]
   [--append-system-prompt '...'] [--resume <id>] '<prompt>'`
   (Codex: `codex exec --json ...` or `codex app-server --stdio`).
   `--include-partial-messages` gives token-level `stream_event` deltas,
   rendered as a live preview and **replaced** by each complete `assistant`
   event (`partialDeltaCountRef` tracks the preview tail); a CLI that rejects
   the flag is sniffed from stderr and the turn retried once without it.
   If a ntfy topic is configured, `buildTurnNotifySuffix` appends a curl that
   pushes a phone notification when the agent exits. The whole thing is wrapped
   by `withSpriteTaskHeartbeat` (sprite task re-put every 60s + a stderr dot
   every 20s + cleanup trap) so the sprite stays awake for the entire turn.
2. The turn runs over the **Exec WebSocket** (`api.streamExec`,
   `WSS /v1/sprites/{name}/exec`, `max_run_after_disconnect=8h`) — *not* the
   Services API (supervised services can restart and replay the prompt; see
   `docs/codex-chat-transport-architecture.md`). Binary frames are
   `[streamId][payload]`; stdout carries the agent's NDJSON with **no** log
   timestamps (`stripLogTimestamps` is defensive for legacy/service paths).
3. Once the exec session id arrives, an **`ActiveChatRun`** (exec session id,
   unique task name `wisp-chat-<provider>-<userMessageId>`, message ids) is
   persisted via `chatRepository` — that row is what makes a turn survive app
   restarts, chat switches, and network drops.
4. Parsed `ClaudeStreamEvent`s / `CodexStreamEvent`s are applied to the
   in-memory `ChatMessage[]` via `updateActiveAssistant`; tool_use blocks
   become `ToolUseCard`s, tool_results attach back to their card.
   `processedUUIDsRef` dedupes Claude events by `uuid`. Claude `result` events
   (and Codex `turn.completed`/`error`, plus local interrupts) append a
   **`turnOutcome`** content item — the footer that distinguishes
   success / max-turns (with a Continue action) / error / interrupted.
5. **Disconnects are not failures.** A dropped socket or attach error enters a
   reconnect loop (`scheduleReconnect`, 1s→30s backoff): each tick probes
   `GET /exec` — unreachable → keep backing off; session gone → the run
   finished while away, finalize from the on-disk transcript
   (`finishActiveRun`); alive → `attachToRun` reattaches. Reattach pulls the
   on-disk transcript *before* opening the socket (the attach socket has no
   replay). `reconcileActiveRuns` (`src/services/run-reconcile.ts`) does the
   same probe for *all* of a sprite's persisted runs on screen open/foreground.
6. A send that errored before any exec session/output existed becomes a
   `failedSend` with a Retry button; messages sent while a turn streams are
   queued (`queuedPrompts`) and auto-sent when a turn completes normally.
7. On reopen, if the chat has a `claudeSessionId`/`codexSessionId`,
   `loadSession` pulls the on-disk transcript (`readClaudeSessionMessages` /
   `readCodexSessionMessages`) and `mergeTranscript` overlays it, **preserving
   message ids for the shared prefix** (React reuses bubbles instead of
   remounting) and **carrying over locally recorded `turnOutcome` items**
   (transcripts have no result lines). `conversationSignature` short-circuits
   the setState if nothing changed.

### Codex provider

`AgentProvider = 'claude' | 'codex' | 'codexAppServer'`. The chat layer is
provider-abstracted. The two Codex providers intentionally expose the two
transport paths side-by-side:

- `codex`: legacy/fallback `codex exec --json` / `codex exec resume --json
  <id>`, still parsed by `CodexStreamParser` / `parseCodexEvent`.
- `codexAppServer`: `codex app-server --stdio`; `useChat` drives the
  JSON-RPC handshake through `streamCodexAppServerTurn`
  (`initialize` → `thread/start`/`thread/resume` → `turn/start`), with stdin
  carried over the Exec WebSocket.

Both modes use `--skip-git-repo-check` and/or no-approval/full-access settings
where the CLI supports them. Codex auth issues are sniffed from stderr by
`classifyCodexAuthIssue` (looks for `codex login`, 401/403, etc.) and surfaced
with a switch-to-Claude prompt. Codex is keyed on `codexSessionId` (Codex thread
id); Claude on `claudeSessionId`.

### Session browser (`src/services/claude-sessions.ts`)

Reads Claude's own on-disk transcripts from the sprite — the same data
`claude --resume` shows. Claude stores one JSONL per session under
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. `listClaudeSessions`
runs a small Node script on the sprite (via `runExec`) that scans every
transcript and emits a compact JSON summary wrapped in `@@WISP@@…@@WISP@@`
sentinel markers (extracted by `extractSentinel` to tolerate shell noise).
`transcriptToMessages` converts a raw transcript into the app's `ChatMessage[]`
so the existing chat UI renders it natively.

### Dictation and audio transcription

`src/hooks/useChatDictation.ts` owns the chat input's audio paths:

- `Mic` uses `expo-speech-recognition` directly on the device with interim
  results enabled. It streams text into the input box as the user speaks.
- `Rec` uses `expo-audio` to record locally, then transcribes the recording.
- `File` uses `expo-document-picker` to select an audio file, then transcribes
  the file.

`Rec` and `File` route through the persisted `transcriptionProvider` setting:

- `sprite` (default): `src/services/audio-transcription.ts` uploads to the
  sprite and runs a local backend (`whisper`, Python `whisper`, or
  `faster_whisper`). This needs a backend installed inside each target sprite.
- `assemblyai`: `src/services/client-transcription.ts` uploads directly from
  the client to AssemblyAI, creates a transcript, and polls it. The request sets
  language detection with expected languages `en` and `ru`.
- `openai`: `src/services/client-transcription.ts` uploads directly from the
  client to OpenAI's `/v1/audio/transcriptions` endpoint with
  `gpt-4o-mini-transcribe`.

All transcription paths append text to the chat input only; they do **not**
auto-send the chat message. AssemblyAI and OpenAI keys are stored via
`src/services/auth.ts` (`assemblyAiToken`, `openAiToken`) and configured in
Settings → Transcription.

### Terminal (`src/components/terminal/`)

A from-scratch Skia terminal (not xterm.js): `AnsiParser` → `TerminalBuffer`
(port of xterm.js's Buffer + InputHandler, with the 256-color palette) →
`SkiaTerminalRenderer` (Skia draw) → `SkiaTerminal` (gestures, keyboard,
selection, reconnect). Input goes over a WebSocket to
`/v1/sprites/{name}/exec` (`src/services/exec-poc.ts`). `TerminalErrorBoundary`
wraps it. On web, Skia loads via CanvasKit (`components/web/WithSkiaWeb.tsx`)
and `exec-poc.tsx` `require()`s the native component conditionally.

### Auth & storage

- **Tokens** (`src/services/auth.ts`): `expo-secure-store` on native, `localStorage`
  on web. Three keys: `spritesToken` (Sprites API), `claudeToken`
  (`CLAUDE_CODE_OAUTH_TOKEN`, injected at launch time), `githubToken` (device flow,
  optional — used to auto-fill git name/email), plus optional `assemblyAiToken`
  and `openAiToken` for client-side audio transcription. `AuthContext` exposes state.
- **Chats** (`src/services/chat-repository.ts` + `database.ts`): SQLite
  (`expo-sqlite`, WAL). Tables `chats`, `chat_messages` (one row per message),
  `active_runs` (the persisted `ActiveChatRun` per chat). A one-time
  AsyncStorage → SQLite import runs on first launch (`migration_meta` flag).
  `normalizePersistedChat` defensively sanitizes on load.
- **Settings** (`src/services/storage.ts`): AsyncStorage, `setting_<key>`
  strings (bools as `'true'|'false'`). Notable keys: `claudeModel`, `maxTurns`,
  `customInstructions`, `defaultProvider`, `defaultWorkingDirectory`,
  `transcriptionProvider`, `ntfyTopic`/`ntfyServer` (turn-finished push).

### API layer (`src/services/api.ts`)

REST client for `api.sprites.dev/v1` (Sprites: list/create/delete, checkpoints,
services, exec). `BASE_URL` is **platform-conditional**:
`Platform.OS === 'web' ? '/api/v1' : 'https://api.sprites.dev/v1'`. On web, the
Expo Router route `src/app/api/[...path]+api.ts` proxies all `/api/*` requests to
`https://api.sprites.dev` (browsers can't carry the bearer token cross-origin).
`runExec` is a helper that runs a one-shot `bash -c '<cmd>'` as a temporary
service, collects stdout, and cleans up — used by the session browser and
sprite wake-up. `startBackgroundService` fires a service without awaiting and
resolves once the first lifecycle event arrives.

### `remote-agent/` (separate Node daemon)

A standalone daemon (`node-pty` + `ws`) that implements the *exact same* Sprites
wire protocol (`/sprites/:name/services/:svc`, `/sprites/:name/exec`, etc.) so
the app can connect to **any Linux machine**, not just Sprites. The `:name`
segment is ignored. Install with `bash remote-agent/install.sh` (generates an
`AGENT_TOKEN`, writes a systemd user service on port 8765). See
`remote-agent/MIGRATION.md` for the planned app change: base URLs and token
source become per-connection instead of global. **When that migration lands,
update this doc.**

## Non-obvious conventions & invariants

- **Onboarding is Sprites-only for now.** Claude/GitHub device-level onboarding
  and cross-Sprite provisioning code is intentionally retained but hidden. The
  supported UI path is to connect providers separately in each Sprite's
  Integrations tab. See `docs/integration-auth-architecture.md` before
  re-enabling global provider onboarding.
- **Do not create an implicit first conversation.** A newly created or empty
  Sprite must show an empty Chats list. Persist a local chat only after the user
  explicitly starts one, or when a discovered remote transcript is resumed.
- **Working directory is locked per chat once a conversation starts.** Claude
  keys resumable history by cwd (`~/.claude/projects/<hashed-cwd>/`), so
  `--resume <id>` only works from the same path. Helpers in
  `src/constants/session.ts`: `DEFAULT_WORKING_DIRECTORY = '/home/sprite'`,
  `normalizeWorkingDirectory`, `shortWorkingDirectory`. `~` expands to
  `/home/sprite` on the sprite — always use absolute paths in the app.
- **`--dangerously-skip-permissions` (Claude) / `--dangerously-bypass-approvals-and-sandbox` (Codex)
  are always passed.** No approval prompts — autonomous coding is the point.
  Safety net is the Checkpoints tab (snapshot/restore the filesystem).
- **One `useChat` instance is shared across all chats in a sprite.** Switching
  sessions calls `chat.detachStream()` first — the exec session **keeps
  running** on the sprite and is reattached when its chat reopens (via the
  persisted `ActiveChatRun`). `interrupt()` is the *stop* action: it kills the
  exec session **and** runs a process-group kill found via the turn's unique
  task name (`buildProcessGroupKillCommand` — a plain session SIGTERM only hits
  the bash wrapper, whose trap is deferred while the agent runs). Don't
  instantiate `useChat` per-session, and don't confuse detach with interrupt.
- **Each turn is a fresh exec session** named by task
  `wisp-chat-<provider>-<userMessageId>` (`safeTaskName`). Old builds ran turns
  as supervised services — `cleanupLegacyChatServices` still deletes stale
  `wisp-claude-*`/`wisp-codex-*`/`wisp-exec-*` services on sprite open.
- **Sending during a turn queues, it does not interrupt.** `sendMessage` appends
  to `queuedPrompts` whenever a run is in flight and fires it when the turn ends
  (`maybeSendNextQueued`). The composer's send button therefore stays enabled
  while streaming; **Stop is a separate button**, never the same control. Don't
  re-disable send on `isStreaming` — that made queuing unreachable and left
  killing the agent as the only way to add a follow-up.
- **The sprite screen has back levels the navigator can't see** — an open
  conversation (`chatOpen`), a settings sub-view (`settingsView`). They're
  collapsed into `inScreenLevel`, which drives the header button, the
  `SwipeBackView` edge gesture, and the Android back button together, and turns
  the native stack gesture off (`navigation.setOptions({ gestureEnabled })`)
  while a level is open so the two can't both fire. **Add any new in-screen
  level to `inScreenLevel`**, or back will skip past it and pop the screen.
  Keep it a plain value, not a closure — those effects must not re-run per render.
- **`parseMessageSegments` (`src/services/message-text.ts`) is shared** by
  `AssistantMessage` and the copy/quote picker on purpose: the picker may only
  offer pieces the bubble actually drew. Don't fork the fence parser.
- **Auto-scroll follows the bottom only when already at the bottom**
  (`isNearBottomRef`); otherwise the "↓ Latest" pill appears. Unconditional
  `scrollToEnd` on new output makes a streaming answer unreadable.
- **Path aliases** (`tsconfig.json`): `@/*` → `./src/*`, `@/assets/*` → `./assets/*`.
- **Theming:** `useTheme()` (`src/hooks/use-theme.ts`) returns the active
  `Colors` palette from `src/constants/theme.ts` (light/dark aware via
  `useColorScheme`). Use `Spacing`/`FontSize` constants, not magic numbers.
  `BottomTabInset` and `MaxContentWidth` are defined there too.
- **Ids:** `makeId()` in `src/models/chat.ts` (`Math.random().toString(36) + Date.now().toString(36)`).
- **Section comments:** `api.ts` uses `// MARK: - <Section>` (Objective-C style).
- **Debug logging** is `__DEV__`-gated (e.g. `debugChat`). Don't leave console
  logs that run in production.
- **`NO_DNA=1`** is exported before launching Claude (internal flag). Keep it.
- **`expo-splash-screen`, `expo-router`, `expo-secure-store`** are the configured
  plugins in `app.json`. iOS export compliance is pre-declared
  (`ITSAppUsesNonExemptEncryption: false`).
- **Generated native folders (`/ios`, `/android`) are gitignored.** They're
  produced by `expo prebuild` (run automatically by `expo run:ios`/`run:android`).

## When you change things

- **Adding a native dependency or native config** → rebuild
  (`npx expo prebuild --clean && npx expo run:ios`). JS-only edits hot-reload.
- **Adding a new screen** → put it under `src/app/(app)/` and register a
  `Stack.Screen` in `src/app/(app)/_layout.tsx`. Auth-gated routes go inside
  the `(app)` group.
- **Adding a new service API call** → add to `src/services/api.ts`, follow the
  `apiRequest`/`AppError` pattern. For streaming endpoints, mirror
  `streamService` (NDJSON line buffer + `parseServiceEventLine`).
- **Adding a new Claude event shape** → extend `src/models/claude-events.ts`
  (`ClaudeContentBlock`, `parseClaudeEvent`) and handle it in
  `useChat.handleClaudeEvent`.
- **Touching `useChat`** → it's large and ref-heavy. Read the whole file first.
  The refs (`messagesRef`, `activeUser/AssistantMessageIdRef`,
  `toolUseIndexRef`, `processedUUIDsRef`, `loadRequestRef`, `activeRunRef`,
  `reconnectTimerRef`, `queuedPromptsRef`, `failedSendRef`) are the source of
  truth inside callbacks; `useState` mirrors them for render. Don't split
  without preserving the ref-mirror invariant. Pure logic belongs in
  `src/services/chat-helpers.ts` (unit-tested, no RN imports) — put new
  side-effect-free helpers there, not in the hook.
- **Touching the terminal** → `TerminalBuffer` is a faithful xterm.js port;
  preserve its semantics. Test with `scripts/test-ws-server.js` against a real
  `claude` TUI.

## Further reading

- `README.md` — user-facing workflow and the three connection modes (chat,
  session browser, stream terminal, ttyd).
- `DEPLOYMENT.md` — iOS simulator/device/TestFlight/EAS deep dive.
- `remote-agent/MIGRATION.md` — plan for per-connection base URLs (remote machines).
