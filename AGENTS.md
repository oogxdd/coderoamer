# AGENTS.md

Guide for AI agents working in this repository. Read this before making changes.

## What this is

**Sprites Manager** — an Expo / React Native mobile (and web) client for
[Fly.io Sprites](https://sprites.dev) (cloud dev VMs). It lets you run
**Claude Code** (and **Codex**) inside a Sprite and drive coding sessions from
your phone: a streaming chat, a native session browser that reads Claude's
on-disk transcripts, a Skia-rendered TTY terminal over WebSocket, and
filesystem checkpoints.

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
npm run lint                # expo lint (ESLint). There is NO test suite.
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
- **No tests.** There is no test runner configured. `scripts/test-ws-server.js`
  is a *manual* dummy server for terminal development, not an automated test.
  Don't claim to "run tests" — run `npm run lint` instead.
- **Bundle identifier inconsistency in the repo:** `app.json` uses
  `com.digital.spritespack` (both `ios.bundleIdentifier` and `android.package`),
  but `README.md`/`DEPLOYMENT.md` reference `com.digital.spritesmanager`. Treat
  `app.json` as the source of truth. Change the id in one place if you need to
  rekey the app.
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
_layout.tsx        Root: ThemeProvider (light/dark) + AuthProvider, Stack
index.tsx          Loading/redirect based on auth state
auth.tsx           3-step sign-in (Sprites token → Claude token → GitHub)
api/[...path]+api.ts   Web-only reverse proxy to api.sprites.dev (see below)
(app)/             Auth-gated group (redirects to /auth if not signed in)
  _layout.tsx      Authenticated Stack
  index.tsx        Dashboard — sprite list, create sprite, links to Guides/Settings
  guide.tsx        In-app setup walkthrough
  settings.tsx     Defaults: provider, claude model, max turns, instructions,
                   working directory, git name/email, auto-checkpoint
  sprite/[name].tsx  The main screen: tabs Overview / Chat / Checkpoints,
                     plus session browser + terminals entry points
  exec-poc.tsx     Stream terminal (WebSocket exec → Skia terminal)
  ttyd-terminal.tsx  Legacy web terminal (ttyd in a WebView)
```

### The chat streaming pipeline (the core of the app)

`src/hooks/useChat.ts` is the single hook that drives chat. Flow:

1. On send, it builds a shell command: `mkdir -p <wd> && cd <wd> && git config ... &&
   export CLAUDE_CODE_OAUTH_TOKEN=... && export NO_DNA=1 && claude -p --verbose
   --output-format stream-json --dangerously-skip-permissions --model <m>
   [--max-turns N] [--append-system-prompt '...'] [--resume <id>] '<prompt>'`.
   The whole thing is wrapped in a **heartbeat subshell**
   `{ (while true; do sleep 20; printf . >&2; done) & HBEAT=$!; trap "kill $HBEAT" EXIT; <cmd>; kill $HBEAT; }`
   to keep the Sprites service log stream alive.
2. It starts a Sprites **service** via `api.streamService()` (`PUT /sprites/{name}/services/{svc}`)
   with `cmd: 'bash', args: ['-c', fullCommand]`. Output streams back as NDJSON.
3. Each service log line is `ServiceLogEvent` (`{type:'stdout'|'stderr'|'exit'|..., data}`).
   The `data` of a `stdout` line is itself a line of Claude's `stream-json` NDJSON,
   prefixed by a log timestamp like `2026-02-19T09:13:24.665Z [stdout] `.
   `stripLogTimestamps()` strips that prefix; `ClaudeStreamParser` parses the inner NDJSON.
   This is a **two-level NDJSON** parse — easy to miss.
4. Parsed `ClaudeStreamEvent`s (`system`/`assistant`/`user`(tool_result)/`result`)
   are applied to the in-memory `ChatMessage[]` via `updateActiveAssistant`. Tool-use
   blocks become `ToolUseCard`s; matching tool_results attach the `result` back to the
   card and also push a `toolResult` content item.
5. `processedUUIDsRef` dedupes Claude events by `uuid`, because service-log replay can
   re-emit lines.
6. If `streamService` returns zero events, it falls back to `streamServiceLogs` (replay).
7. On reopen, if the chat has a `claudeSessionId`, `loadSession` pulls the on-disk
   transcript (`readClaudeSessionMessages`) and `mergeTranscript` overlays it,
   **preserving message ids for the shared prefix** so React reuses bubbles instead
   of remounting/re-scrolling. `conversationSignature` short-circuits the setState if
   nothing actually changed (this was a real bug: reopening looked like the last turn
   was duplicated and re-answered).

### Codex provider

`AgentProvider = 'claude' | 'codex'`. The chat layer is provider-abstracted. For
Codex, the command is `codex exec [--json] [--resume <id>] --model gpt-5-codex
--skip-git-repo-check --dangerously-bypass-approvals-and-sandbox '<prompt>'`,
parsed by `CodexStreamParser` / `parseCodexEvent`. Codex auth issues are sniffed
from stderr by `classifyCodexAuthIssue` (looks for `codex login`, 401/403, etc.)
and surfaced with a switch-to-Claude prompt. Codex is keyed on `codexSessionId`
(Codex thread id); Claude on `claudeSessionId`.

### Session browser (`src/services/claude-sessions.ts`)

Reads Claude's own on-disk transcripts from the sprite — the same data
`claude --resume` shows. Claude stores one JSONL per session under
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. `listClaudeSessions`
runs a small Node script on the sprite (via `runExec`) that scans every
transcript and emits a compact JSON summary wrapped in `@@WISP@@…@@WISP@@`
sentinel markers (extracted by `extractSentinel` to tolerate shell noise).
`transcriptToMessages` converts a raw transcript into the app's `ChatMessage[]`
so the existing chat UI renders it natively.

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
  optional — used to auto-fill git name/email). `AuthContext` exposes state.
- **Chats & settings** (`src/services/storage.ts`): AsyncStorage with prefixes
  `sprite_chats_<spriteName>` (the list of `PersistedChat`), `chat_meta_<chatId>`
  (the `ChatMessage[]`), `setting_<key>` (string settings) / `setting_<key>`=`'true'|'false'`
  for bools. `normalizePersistedChat` defensively sanitizes on load and re-saves
  if the shape changed (migration).

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

- **Working directory is locked per chat once a conversation starts.** Claude
  keys resumable history by cwd (`~/.claude/projects/<hashed-cwd>/`), so
  `--resume <id>` only works from the same path. Helpers in
  `src/constants/session.ts`: `DEFAULT_WORKING_DIRECTORY = '/home/sprite/project'`,
  `normalizeWorkingDirectory`, `shortWorkingDirectory`. `~` expands to
  `/home/sprite` on the sprite — always use absolute paths in the app.
- **`--dangerously-skip-permissions` (Claude) / `--dangerously-bypass-approvals-and-sandbox` (Codex)
  are always passed.** No approval prompts — autonomous coding is the point.
  Safety net is the Checkpoints tab (snapshot/restore the filesystem).
- **One `useChat` instance is shared across all chats in a sprite.** Switching
  sessions calls `chat.interrupt()` first to stop any in-flight stream, then
  swaps `chatId`/`workingDirectory`/session ids. Don't instantiate per-session.
- **Service names are random** (`wisp-<provider>-<id>` via `makeServiceName`),
  so each send is a fresh service. `interrupt()` aborts the stream and
  `deleteService()`s the current one.
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
  `toolUseIndexRef`, `processedUUIDsRef`, `loadRequestRef`) are the source of
  truth inside callbacks; `useState` mirrors them for render. Don't split
  without preserving the ref-mirror invariant.
- **Touching the terminal** → `TerminalBuffer` is a faithful xterm.js port;
  preserve its semantics. Test with `scripts/test-ws-server.js` against a real
  `claude` TUI.

## Further reading

- `README.md` — user-facing workflow and the three connection modes (chat,
  session browser, stream terminal, ttyd).
- `DEPLOYMENT.md` — iOS simulator/device/TestFlight/EAS deep dive.
- `remote-agent/MIGRATION.md` — plan for per-connection base URLs (remote machines).
