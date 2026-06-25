# Chat transport architecture (Claude & Codex)

Status: design notes + decisions. Captures the analysis of how chat turns are
transported to/from the agent CLIs inside a sprite, the current model, and the
two persistent-session designs we considered. Companion to
[`codex-app-server-estimate.md`](./codex-app-server-estimate.md).

---

## 1. Current model — one-shot exec + `resume`

Each chat turn spawns a **fresh process** over the Exec WebSocket and streams its
stdout NDJSON back:

- Transport: `api.streamExec(sprite, ['bash','-c', cmd], onEvent, signal, opts)`
  → `WSS /v1/sprites/{name}/exec` (`src/services/api.ts`).
- Claude: `claude -p --verbose --output-format stream-json --dangerously-skip-permissions [--resume <id>] <prompt>`
- Codex: `codex exec [resume <id>] --json --model gpt-5-codex --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox <prompt>`
- Continuity across turns is via **session id resume**, not a live process:
  `claude --resume <session_id>` / `codex exec resume <thread_id>`. The id comes
  from the first `system` / `thread.started` event and is persisted
  (`claudeSessionIdRef` / `codexSessionIdRef` in `src/hooks/useChat.ts`).
- The process is kept alive *during* a turn by `withSpriteTaskHeartbeat`
  (sprite task API `expire 5m`, re-put every 60s; plus a dot every 20s to keep
  the stream warm) and `max_run_after_disconnect`, so the app can detach/attach
  to an **in-flight** turn (`attachSessionId`).

**Why exec and not the Services API** (see the comment at
`src/services/api.ts` ~L427): services are *supervised* — the sprite service
manager may **restart** a crashed/finished service, which, with the prompt baked
into the service `cmd`, **replays the same prompt into `claude --resume`**. Exec
sessions never auto-restart and `max_run_after_disconnect` makes disconnect
behavior explicit. The legacy service-per-turn chat path is what
`cleanupLegacyChatServices` (`wisp-claude-*` / `wisp-codex-*` / `wisp-exec-*`)
tears down.

### Limits of the current model
- **No token-by-token streaming for Codex.** `codex exec --json` only emits a
  whole `agent_message` at `item.completed`. (Claude's `stream-json` *does*
  stream deltas.)
- **Cold start every turn.** `resume` re-launches the process and reloads the
  thread from disk each turn.
- **Durability gap after a turn ends.** The heartbeat keeps the process alive
  *while a turn runs*, but a one-shot turn's process **exits when the turn
  completes**. If the app was closed and the turn finished meanwhile, there's no
  live stream to reattach to — only locally-persisted messages remain. Claude
  recovers via on-disk session files (`syncClaudeTranscript`); Codex had no
  equivalent until `syncCodexTranscript` (§6).

---

## 2. Ideal architecture — persistent exec session + stdin over WebSocket

The Exec WebSocket is **bidirectional**: the same socket that streams stdout/stderr
can also carry **stdin**. This is the elegant primitive that removes the
"duplex blocker" — no FIFO and no Services API needed.

### 2.1 The wire protocol (already implemented for reads)
Binary WS frames are `[streamId: 1 byte][payload]` (`src/services/api.ts`,
`handleBinaryMessage`):

| streamId | direction | meaning                |
|----------|-----------|------------------------|
| `0`      | **client → process** | **stdin** (to write)   |
| `1`      | process → client | stdout                 |
| `2`      | process → client | stderr                 |
| `3`      | process → client | exit (payload = code)  |

`StreamExecOptions` already exposes `stdin?: boolean` (`api.ts` ~L347) and the
exec URL builder sets `stdin=true`. The code currently only *reads*; to drive a
session we add a **write path**: keep a handle to the open `WebSocket` and send a
frame `Uint8Array([0x00, ...utf8(payload)])`.

### 2.2 Session lifecycle
1. **Start idle** (no prompt baked in) with `stdin: true` and a large
   `max_run_after_disconnect`, kept warm by the heartbeat:
   - Claude: `claude -p --input-format stream-json --output-format stream-json --dangerously-skip-permissions [--resume <id>] --model <m>`
     (reads a stream of user-message JSON objects from stdin; this is the mode
     the Agent SDK uses).
   - Codex: `codex proto` (the persistent JSON-RPC-over-stdio app-server mode).
2. Capture `session_id` from `session_info` (`onSessionId`).
3. **Send a turn** = write one stdin frame (newline-delimited JSON for Claude;
   a JSON-RPC `sendUserTurn`-style request for `codex proto`). The reply streams
   back on stdout (stream 1) as the same NDJSON our parsers already consume.
4. **Reattach** across app restarts / device changes via
   `WSS .../exec/{session_id}` (`attachSessionId`, also bidirectional). Discover
   live sessions with `listExecSessions`.
5. **Respawn on death.** Exec sessions do **not** auto-restart, so if the process
   dies (crash / OOM / sprite suspend) we relaunch it ourselves — trivially safe
   because **no prompt is baked in**, so there is nothing to replay. Re-establish
   thread context by starting with `--resume <id>` (Claude) / resuming the thread
   (`codex proto`).

### 2.3 What this buys us
- True **streaming** (Claude deltas; Codex `proto` emits incremental events).
- **No cold start** between turns (warm process).
- **Follow-ups via stdin** on one channel; **reattach** for durability.
- Reuses a transport the app already speaks; **no Services API, no FIFO**.

### 2.4 Code touchpoints
- `api.ts`: add a stdin writer to `streamExec` (expose socket or pass a
  `getSink(send: (bytes) => void)` callback); keep `stdin: true`.
- A thin `persistentAgentSession` layer: `start()` → `sendTurn(text)` →
  `reattach(id)` → `interrupt()` / `close()`.
- `useChat.ts`: send turns by writing stdin instead of spawning a new exec;
  parsers (`ClaudeStreamParser` / `CodexStreamParser`) are unchanged.

### 2.5 Risks / open items
- Exact `codex proto` JSON-RPC schema (start/turn/interrupt) must be pinned to
  the installed CLI version (`codex --version`).
- Claude `--input-format stream-json` input message shape must be confirmed
  against the installed `claude` version.
- stdin framing details (whether the gateway expects raw bytes on stream 0 vs a
  JSON control frame) — verify against a live sprite.

---

## 3. Alternative A — FIFO injection

If, for some reason, we run the agent as a process whose stdin we cannot address
directly over WS, inject prompts through a named pipe inside the sprite:

```sh
mkfifo /tmp/chat.in
# keep the FIFO open so per-message writers don't EOF the reader:
sleep infinity > /tmp/chat.in &
claude -p --input-format stream-json --output-format stream-json < /tmp/chat.in
```

Each prompt is a tiny **separate exec**: `printf '%s\n' "$JSON" > /tmp/chat.in`.
Output still streams on the agent process's stdout (capture via exec attach or,
if run as a service, the service log buffer).

**Gotchas:** FIFO EOF handling (must hold a writer fd open, hence the
`sleep infinity > fifo`); one FIFO per session; cleanup of the pipe. Strictly
worse than §2 because it needs a side process and an extra exec per turn — keep
it only as a fallback.

---

## 4. Alternative B — per-conversation service **without a startup prompt**

> Documented in depth because this is a likely implementation target. The core
> idea fixes the exact reason we left the Services API: **don't bake the prompt
> into the service `cmd`.** A restart then just yields a fresh idle process that
> does nothing until a prompt is delivered — no replay.

### 4.1 Shape
- **One service per chat conversation** (not per turn). Name it deterministically
  from the chat id, e.g. `wisp-agent-<chatId>`, so reopening the chat finds it
  via `listServices` / `getServiceStatus`.
- Service `cmd` starts the agent in **persistent, prompt-less stdin mode**:
  - Claude: `claude -p --input-format stream-json --output-format stream-json --dangerously-skip-permissions --resume <id?> --model <m>`
  - Codex: `codex proto`
  - **No prompt argument anywhere.** The process boots, opens stdin, and idles.
- Register via `PUT /v1/sprites/{name}/services/{service}` with
  `ServiceRequest { cmd, args?, needs?, http_port? }` (see `streamService`).

### 4.2 Delivering prompts (input channel)
The service is supervised; we still need a way *in*. Options, best first:
1. **FIFO** the service reads from (as §3): service `cmd` reads `< /tmp/<svc>.in`;
   a prompt is a small exec `printf … > /tmp/<svc>.in`. Survives restarts if the
   FIFO is recreated on boot (wrap the service cmd in a small shell that
   `mkfifo -p` + holds it open).
2. **Local HTTP wrapper**: service runs a tiny daemon owning the agent child and
   exposing `POST /turn` on `http_port`; reach it via the sprite TCP proxy
   (`WSS /v1/sprites/{name}/proxy`). More moving parts, but clean request/response
   and back-pressure.
3. **Watched file/queue**: prompt written via `PUT /filesystem/files`; a wrapper
   tails it. Simplest to write, least elegant (polling).

### 4.3 Reading output (durability win)
Read the service's stdout from the **durable log buffer**:
`GET /v1/sprites/{name}/services/{service}/logs?lines=<n>&duration=<follow>`
(`streamServiceLogs`). This is the big advantage over exec: the buffer
**survives the app being killed and survives turns completing**, so reopening a
chat = `streamServiceLogs(lines=all)` replayed through the existing parser →
full state rebuilt. (Buffer may be ring-capped for very long sessions; treat the
agent's own on-disk transcript — §6 — as the ultimate source of truth.)

### 4.4 Restart semantics — why "no startup prompt" matters
- A supervised restart of a **prompt-less** service = a fresh idle reader. **No
  prompt is replayed** (the historical failure mode).
- The cost: a restart drops the warm in-memory thread. On (re)start, pass
  `--resume <id>` (Claude) / resume the thread (`codex proto`) so context is
  reloaded from disk. Persist the id locally and in the service args.
- Concurrency: one service per chat ⇒ stable name avoids collisions; multiple
  open chats ⇒ multiple services. Garbage-collect idle/stale services
  (extend `cleanupLegacyChatServices` with the new prefix + an age/last-activity
  check).

### 4.5 Lifecycle checklist (for implementation)
- [ ] Create-or-attach: `getServiceStatus` → if missing, `streamService`/PUT to
      create with prompt-less cmd + resume id.
- [ ] Input channel chosen (FIFO recommended for a first cut).
- [ ] Output via `streamServiceLogs` (`lines` backfill on open, `duration` follow).
- [ ] Map events through existing `ClaudeStreamParser` / `CodexStreamParser`.
- [ ] Resume id threaded into service args; re-create on restart without replay.
- [ ] Stop/cleanup: `deleteService` on explicit chat close; periodic GC of stale
      `wisp-agent-*` services.
- [ ] Concurrency cap / eviction policy for many open chats.

### 4.6 Pros / cons vs §2
- **Pro:** supervised auto-restart (resilience) for free; durable log buffer for
  replay; doesn't need the §2 stdin-writer change to `streamExec`.
- **Con:** brings back service lifecycle (naming, GC) we deliberately shed; still
  needs a side input channel (FIFO/HTTP); restart can interrupt an in-flight turn
  mid-way (mitigate by resume + idempotent turn handling).

---

## 5. Comparison

| Property | §1 exec + resume (current) | §2 persistent exec + stdin | §4 per-chat service (no prompt) |
|---|---|---|---|
| Streaming (Codex) | ❌ whole message | ✅ (`codex proto`) | ✅ (`codex proto`) |
| Cold start / turn | yes | no | no |
| Follow-ups | ✅ via resume | ✅ via stdin | ✅ via input channel |
| Reattach in-flight | ✅ attach | ✅ attach | ✅ logs follow |
| Survives turn-completed-while-away | ❌ (transcript sync only) | ⚠️ if session alive | ✅ durable log buffer |
| Auto-restart | n/a | ❌ self-respawn | ✅ supervised |
| Prompt-replay risk | none | none | none (no baked prompt) |
| Extra machinery | none | stdin writer | service GC + input channel |
| Lifecycle cost | lowest | low | medium |

**Recommendation:** §2 (persistent exec + stdin) is the cleanest path to
streaming + persistence and reuses existing transport. §4 is the fallback when
supervised resilience / durable buffering matters more than avoiding service
lifecycle. Both are gated on confirming the installed `codex proto` /
`claude --input-format stream-json` schemas.

---

## 6. Durability today — `syncCodexTranscript` (implemented)

Independent of §2/§4, Codex now has the same on-disk transcript recovery Claude
has. Codex CLI writes a **rollout** per thread:
`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<thread_id>.jsonl`. The
`<thread_id>` is the same UUID we store as `codexSessionId` (from
`thread.started`). See `src/services/codex-sessions.ts`.

Rollout line envelope: `{type, payload, timestamp}` where `type` ∈
`session_meta | response_item | event_msg | turn_context | compacted`. Mapping to
the app's `ChatMessage[]`:

| Source line | → rendered as |
|---|---|
| `event_msg/user_message` (`.message`) | user bubble (clean human prompt) |
| `event_msg/agent_message` (`.message`) | assistant text (visible narration) |
| `response_item/function_call` (`exec_command`, args `.cmd`) | `Bash` tool card, linked by `call_id` |
| `response_item/function_call_output` (`.output`) | tool result |
| `response_item/custom_tool_call` (`apply_patch`, `.input`) | `Edit` tool card |
| `response_item/custom_tool_call_output` | tool result |
| `response_item/web_search_call` (`.action.query`) | `WebSearch` tool card |
| `response_item/reasoning` | **skipped** — `summary: []`, only `encrypted_content` (no plaintext) |
| `response_item/message` (developer/user/assistant) | skipped — covered by `event_msg` equivalents; developer/AGENTS.md preamble is noise |
| `event_msg/{token_count,task_started,task_complete,patch_apply_end,web_search_end}` | skipped (redundant/usage) |

Like Claude, this is read sprite-side via a `node` script behind sentinel
markers so we transfer a few KB, not full transcripts, and it survives app
close / reinstall.
