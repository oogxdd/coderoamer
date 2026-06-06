# Sprites Manager

Run **Claude Code inside a [Fly.io Sprite](https://sprites.dev)** (a cloud dev VM) and
drive it from your phone. Set up a sprite once on your computer, then start, watch, and guide
coding sessions from anywhere — close the app and pick the same session back up later.

> Personal project against the new Sprites API. Focused on Claude Code today; other agents later.

---

## Quick start (the workflow this app is built around)

The smoothest setup is to prepare a sprite on your computer, then connect from the phone:

1. **Create a sprite** — tap **+** on the dashboard, or use the Sprites CLI on your computer.
2. **Add an SSH key** so the sprite can reach GitHub. In a sprite shell:
   ```bash
   ssh-keygen -t ed25519 -C "you@example.com"
   cat ~/.ssh/id_ed25519.pub        # add this to GitHub → Settings → SSH and GPG keys
   ```
3. **Clone your repo** into the sprite:
   ```bash
   git clone git@github.com:you/your-repo.git ~/your-repo
   ```
4. **Connect from the phone.** Open the sprite, set the session **working directory** to your
   repo (e.g. `/home/sprite/your-repo`), type a prompt, and send. Claude starts working with no
   approval prompts.
5. **Come back anytime.** Reopen the app and you land in the same session — send another message
   to continue the conversation.

The same flow is available in-app under **Guides** (dashboard → Guides).

---

## Connecting: three approaches

The app deliberately ships three ways to reach Claude so you can find what feels best on a phone.
The first is the default; the other two are launched from a sprite's **Overview → "More ways to
connect"**.

| | What it is | Best for |
|---|---|---|
| **Chat** (default) | Runs Claude non-interactively (`claude -p --output-format stream-json`) as a one-shot Sprites *service* and streams the result into a native chat with tool/plan/result cards. | Day-to-day prompting and reading results comfortably on a phone. |
| **Interactive Terminal** | A real TTY over a WebSocket (`/v1/sprites/{name}/exec`) rendered in a Skia terminal. Auto-runs `cd <repo> && claude`. | Answering Claude's interactive prompts, watching the live TUI, full shell control. |
| **Web Terminal (ttyd)** | Embeds a [`ttyd`](https://github.com/tsl0922/ttyd) web terminal running *inside* the sprite, via a WebView. Experimental. | Experimenting; a full xterm in a WebView. Requires starting ttyd in the sprite. |

### Session working directory

Claude is always launched after `cd`-ing into the session's **working directory**. This matters
twice over:

- It's where your cloned repo lives, so set it per session (or set a default in Settings).
- Claude keys its **resumable history by directory**, so resuming only works from the same path.
  The working directory is therefore locked once a conversation starts — begin a new session to
  switch folders.

For the third approach, **"Start ttyd in this sprite"** does it for you: it sets the sprite URL to
`public`, installs `ttyd` if it's missing (apt/apk/dnf, falling back to a static binary), starts it
on port 8080 (the public URL proxies to port 8080 / the first HTTP port), and connects. To run it by
hand instead:
```bash
ttyd -W -c user:pass -p 8080 claude      # reachable at the sprite's public URL
```

---

## Authentication

First launch walks you through three steps:

1. **Sprites API token** — from your sprites.dev account or the Sprites CLI. Lets the app manage
   your sprites.
2. **Claude Code token** — run `claude setup-token` on your computer (requires a Claude
   subscription) and paste the `sk-ant-oat01-…` value. The app injects it as
   `CLAUDE_CODE_OAUTH_TOKEN` when it launches Claude in the sprite, so you never log in there.
3. **GitHub** (optional) — device-flow login used to auto-fill your git commit name/email.

Tokens are stored with `expo-secure-store`.

---

## No approvals — and safety

Chat launches Claude with `--dangerously-skip-permissions`, so it never pauses to ask before
running commands. That's the point — autonomous coding from your phone — but it means Claude can
run anything in the sprite. The sprite is an isolated VM; still, use the **Checkpoints** tab to
snapshot the filesystem before risky work and restore if needed.

---

## Running the app

```bash
npm install        # .npmrc sets legacy-peer-deps so the web devDependency conflict is handled
npx expo run:ios   # builds & runs a dev build on the iOS simulator (needed: app uses native modules)
```

`npx expo start` then `w` works for web. The app uses custom native modules (Skia, WebView), so on
iOS use a **dev build** (`expo run:ios`) rather than Expo Go.

**Prerequisites:** Node.js 18+, a Sprites API token, and (for Claude) a Claude Code OAuth token.

**Developing on a device and shipping to TestFlight:** see **[DEPLOYMENT.md](./DEPLOYMENT.md)**.

---

## Architecture

```
src/
  app/                          # Expo Router (file-based)
    _layout.tsx                 # Root layout + AuthProvider
    index.tsx                   # Auth redirect
    auth.tsx                    # 3-step auth flow
    (app)/
      _layout.tsx               # Authenticated stack
      index.tsx                 # Dashboard (sprite list) + Guides/Settings
      guide.tsx                 # In-app guides & setup walkthrough
      settings.tsx              # Defaults (working dir, model, turns, instructions, git id)
      sprite/[name].tsx         # Overview / Chat / Checkpoints, + "more ways to connect"
      exec-poc.tsx              # Interactive Terminal (WebSocket exec → Skia terminal)
      ttyd-terminal.tsx         # Web Terminal (ttyd in a WebView)

  components/
    chat/                       # Chat UI: messages, tool cards, plan, input bar,
                                #   session list, new-session sheet, quick bash
    checkpoints/                # Create / list / restore checkpoints
    dashboard/                  # Sprite row + create sheet
    terminal/                   # Skia-based terminal (ANSI parser, buffer, renderer)

  hooks/        useChat.ts      # Streaming, two-level NDJSON parsing, persistence, resume
  services/     api.ts          # REST client: sprites, checkpoints, services, exec
                auth.ts          # Secure token storage
                claude-stream.ts # NDJSON parser for Claude events
                exec-poc.ts      # WebSocket exec client
                storage.ts       # AsyncStorage: chats + settings
  models/                        # sprite, chat, claude-events, service, checkpoint
  constants/    session.ts      # Working-directory defaults/helpers; theme.ts
```

### How Chat streaming works

1. The app starts a Sprites **service** that runs Claude in your working directory:
   `claude -p --verbose --output-format stream-json --dangerously-skip-permissions --model <model>
   [--resume <session-id>] '<prompt>'`.
2. The service's output streams back as NDJSON over HTTP.
3. `ClaudeStreamParser` parses the two-level NDJSON (service log events whose `data` field carries
   Claude's own NDJSON), and `useChat` renders text, tool-use cards, plans, and results live.
4. Each chat persists Claude's session id and working directory, so the next message resumes the
   same conversation — across app restarts.

---

## Tech stack

- **Expo 55** / React Native 0.83, **Expo Router** (file-based navigation)
- **@shopify/react-native-skia** — high-performance terminal rendering
- **react-native-webview** — ttyd web terminal
- **expo-secure-store** — token storage · **AsyncStorage** — chats & settings

---

## Roadmap

- Full support for additional agents (the chat layer already abstracts a `provider`).
- Pushing/observing long-running sessions in the background.
- Background push notifications when a session finishes or needs input.
