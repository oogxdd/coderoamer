# Sprites Manager

A React Native (Expo) mobile app for managing [Fly.io Sprites](https://sprites.dev) VMs with integrated Claude Code chat. Create, monitor, and interact with cloud development environments directly from your phone.

## What It Does

Sprites Manager connects to the Sprites API to let you:

- **Manage Sprites** -- Create, delete, and monitor VM status (running, cold, stopped) with automatic wake-on-access for cold sprites.
- **Chat with Claude Code** -- Stream Claude Code sessions running inside your sprites. Send prompts, watch tool use in real-time, and resume previous sessions.
- **Manage Checkpoints** -- Create and restore filesystem checkpoints for safe experimentation.
- **Run Quick Commands** -- Execute arbitrary bash commands on sprites without leaving the chat.
- **Configure Settings** -- Choose Claude model (Sonnet/Opus/Haiku), set max turns, provide custom instructions, and configure git identity.

## How It Works

The app communicates with sprites through the Sprites REST API (`https://api.sprites.dev/v1`). Chat sessions work by:

1. Creating a service on the sprite that runs `claude -p --verbose --output-format stream-json`
2. Streaming the service's NDJSON output back to the app via HTTP
3. Parsing the two-level NDJSON (service log events wrapping Claude stream events) to render messages, tool use cards, and results in real-time

Authentication is three-step: Sprites API token, Claude Code OAuth token, and optional GitHub device flow for git identity.

## Getting Started

### Prerequisites

- Node.js 18+
- iOS device/simulator or Android emulator
- A [Sprites API token](https://sprites.dev)

### Install and Run

```bash
npm install
npx expo start
```

Then press `i` for iOS simulator, `a` for Android emulator, or `w` for web.

### First Launch

The app will walk you through entering:

1. **Sprites API Token** -- from your Sprites account
2. **Claude Code Token** -- OAuth token for Claude Code
3. **GitHub Account** (optional) -- via device flow for git commit identity

## Architecture

```
src/
  app/                          # Expo Router file-based routing
    _layout.tsx                 # Root layout with AuthProvider
    index.tsx                   # Auth redirect
    auth.tsx                    # 3-step authentication flow
    (app)/
      _layout.tsx               # Authenticated stack navigator
      index.tsx                 # Dashboard -- sprite list
      settings.tsx              # Model, turns, instructions, git identity
      sprite/[name].tsx         # Sprite detail with Overview/Chat/Checkpoints tabs

  components/
    chat/
      ChatMessageView.tsx       # Routes messages to role-specific components
      AssistantMessage.tsx      # Markdown-rendered assistant responses
      UserBubble.tsx            # User message bubble
      ToolUseCardView.tsx       # Collapsible tool use card (icon, name, elapsed time)
      ToolDetailSheet.tsx       # Full tool input/output JSON modal
      PlanCardView.tsx          # TodoWrite checklist with progress tracking
      ChatInputBar.tsx          # Multi-line input with send/interrupt toggle
      ChatListSheet.tsx         # Multi-chat switcher modal
      QuickBashSheet.tsx        # Run bash commands, insert output into chat
      ThinkingShimmer.tsx       # Animated pulsing indicator during streaming
    checkpoints/
      CheckpointsList.tsx       # List, create, restore checkpoints
      CreateCheckpointSheet.tsx # Checkpoint creation modal
    dashboard/
      SpriteRow.tsx             # Sprite list item with status indicator
      CreateSpriteSheet.tsx     # Sprite creation modal

  hooks/
    useChat.ts                  # Core chat hook -- streaming, event parsing, persistence
    use-theme.ts                # Theme colors from color scheme

  services/
    api.ts                      # REST client -- sprites, checkpoints, services, exec
    auth.ts                     # Secure token storage (expo-secure-store)
    claude-stream.ts            # Line-buffered NDJSON parser for Claude events
    github.ts                   # GitHub device flow OAuth
    storage.ts                  # AsyncStorage persistence for chats and settings

  models/
    sprite.ts                   # Sprite type, status helpers
    checkpoint.ts               # Checkpoint type, stream event type
    claude-events.ts            # Claude stream event types, JSONValue, parser
    chat.ts                     # ChatMessage, ToolUseCard, ToolResultCard types
    service.ts                  # ServiceRequest, ServiceLogEvent types

  contexts/
    AuthContext.tsx              # Auth state provider with token management

  constants/
    theme.ts                    # Colors (light/dark), spacing, font sizes
```

### Key Design Decisions

- **Service-based streaming** rather than WebSocket exec -- avoids React Native WebSocket header limitations and provides cleaner NDJSON parsing.
- **Refs alongside state** in `useChat` -- `statusRef`, `messagesRef`, etc. prevent stale closure bugs in streaming callbacks while still driving React re-renders.
- **Two-level NDJSON parsing** -- Service log events contain a `data` field with Claude's NDJSON output. `ClaudeStreamParser` buffers and parses incomplete lines. Timestamps prefixing lines are stripped before parsing.
- **Multi-chat per sprite** -- Each sprite can have multiple independent chat sessions persisted to AsyncStorage, with session resume via Claude's `--resume` flag.

## Tech Stack

- **Expo 55** / React Native 0.83
- **Expo Router** -- file-based navigation
- **expo-secure-store** -- token storage
- **@react-native-async-storage/async-storage** -- chat and settings persistence
- **react-native-markdown-display** -- assistant message rendering
- **expo-clipboard** -- GitHub device code copy
