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

## 2. Two independent axes — don't conflate streaming with warmth

Everything below stays on the **Exec API** (the app is already exec-based — see
§1). The earlier framing of "the ideal architecture = a persistent warm process"
was wrong: it bundled two *independent* decisions. Separate them:

- **Axis A — process lifetime:** *ephemeral* (a fresh process per turn, cold) vs
  *persistent* (one process kept alive across turns, warm).
- **Axis B — how a turn is delivered & streamed:** *argv + whole-message*
  (`claude -p <prompt>`, `codex exec --json`) vs *stdin + streamed events*
  (`claude --input-format stream-json`, `codex proto`).

> **Sprite reality check.** A sprite suspends when idle — that is the point
> (don't burn resources when nobody's looking). Keeping a process *warm for
> hours* fights the platform: you'd have to actively prevent suspension (the
> heartbeat task even expires at 5m). For the real usage pattern — *write, leave
> for hours, come back* — **cold is the correct default.** So **Axis A should
> stay ephemeral.** Warm (§2.4) is a niche optimization, not the goal.

The useful insight is that **Axis B is independent of Axis A**: you can stream a
turn token-by-token while still being *cold per turn*. Streaming is a property of
one turn's output format, not of process persistence.

### 2.1 The wire protocol (already implemented for reads)
The Exec WebSocket is **bidirectional**. Binary frames are
`[streamId: 1 byte][payload]` (`src/services/api.ts`, `handleBinaryMessage`):

| streamId | direction | meaning                |
|----------|-----------|------------------------|
| `0`      | **client → process** | **stdin** (to write)   |
| `1`      | process → client | stdout                 |
| `2`      | process → client | stderr                 |
| `3`      | process → client | exit (payload = code)  |

`StreamExecOptions` already exposes `stdin?: boolean` (`api.ts` ~L347) and the
exec URL builder sets `stdin=true`. The code currently only *reads*; to write a
turn we add a **write path**: keep a handle to the open `WebSocket` and send a
frame `Uint8Array([0x00, ...utf8(payload)])`.

### 2.2 Where each provider stands on streaming (cold, per turn)

| | cold per-turn, streams? | to make it stream |
|---|---|---|
| **Claude** | ✅ already (`-p --output-format stream-json` emits deltas) | nothing — current code already gets this |
| **Codex** | ❌ `exec --json` delivers `agent_message` whole at `item.completed` | spawn `codex proto`, push one turn to stdin, stream events, let it exit |

So **Claude already streams cold**. Only **Codex** lacks it, and the fix is
*not* warmth — it's switching that turn's process from `codex exec --json` to
`codex proto` (which streams), still launched **one process per turn**.

### 2.3 Recommended target — *cold-per-turn `codex proto` streaming*

This keeps Axis A = ephemeral (sprite-friendly) and only moves Codex along
Axis B:

1. Per Codex turn, spawn `codex proto` over Exec with `stdin: true` (no warm
   keep-alive beyond the in-flight turn — the existing heartbeat already covers
   "alive while the turn runs").
2. Write **one** turn to stdin (JSON-RPC op; resume the thread via the stored
   `codexSessionId`), `0x00`-framed.
3. Stream the incremental events back on stdout through `CodexStreamParser`
   (now you get reasoning/text deltas live instead of a wall of text at the end).
4. Turn completes → process exits. Next turn (possibly hours later) = a fresh
   cold spawn that resumes the thread from disk. Exactly the cold model you want.

Cost: one stdin write-path in `streamExec` + a small `codex proto` driver. Cold
start is paid once per turn — same as today's `codex exec resume`. **No warm
process, no service.**

When is this even worth doing? Only if Codex's "tools stream in, then the whole
answer appears at once at the end" actually bothers you. If not, the current
`codex exec --json` path (plus the §6 transcript sync and the parity fixes) is
already fine and needs zero changes.

### 2.4 Niche only — persistent/warm session

Keeping one process alive across turns (fed via stdin, reattached via
`WSS .../exec/{session_id}`) removes per-turn cold start *and* gives streaming.
But it only pays off for a **tight multi-turn burst inside one active sitting**,
where the sprite is awake anyway and cold-start latency between rapid replies is
the bottleneck. For "leave for hours" it's the wrong fit (see the reality check
above) and is **not recommended as the default**. Mechanics, if ever needed:
start idle (no baked prompt) with a large `max_run_after_disconnect`; respawn on
death with `--resume <id>` (safe — nothing to replay since no prompt is baked
in); discover live sessions via `listExecSessions`.

### 2.5 Code touchpoints (for §2.3)
- `api.ts`: add a stdin writer to `streamExec` (expose the socket or pass a
  `onSink(send: (bytes) => void)` callback); keep `stdin: true`.
- A small `codexProtoTurn(spriteName, threadId?, prompt)` driver: spawn → send
  one turn → stream → exit.
- `useChat.ts`: for `provider === 'codex'`, route the turn through the proto
  driver instead of building a `codex exec` bash line. `CodexStreamParser` /
  event mapping stay as-is (proto emits the same item/event vocabulary §6 maps).

### 2.6 Risks / open items
- Exact `codex proto` JSON-RPC schema (submit turn / resume / interrupt) must be
  pinned to the installed CLI version (`codex --version`).
- Claude `--input-format stream-json` input message shape (only relevant if the
  niche warm path in §2.4 is ever pursued).
- stdin framing details (raw bytes on stream `0` vs a JSON control frame) —
  verify against a live sprite.

### 2.7 Current exec vs ideal exec — what actually changes

Both are the **same Exec WebSocket transport**; the delta is small and Codex-only.

| | Current exec (§1) | Ideal exec (§2.3) |
|---|---|---|
| Process lifetime | ephemeral, cold per turn | **same** — ephemeral, cold per turn |
| Sprite suspends when idle | yes (desired) | **same** (desired) |
| Continuity | `--resume` / `exec resume <id>` | **same** (resume by id) |
| Claude streaming | ✅ already | ✅ unchanged |
| Codex per-turn binary | `codex exec --json` | **`codex proto`** |
| Codex prompt delivery | argv (`<prompt>` in bash line) | **stdin frame** (`0x00`+payload) |
| Codex output | whole `agent_message` at end | **streamed** reasoning/text deltas |
| `streamExec` direction | read-only | **read + write (stdin)** |
| Durability after idle | §6 transcript sync | **same** (§6) |
| Services / FIFO / warm keep-alive | none | **none** |

Net: the *only* moving parts are (a) teach `streamExec` to write a stdin frame
and (b) drive Codex turns through `codex proto` instead of `codex exec`. Process
model, cold-start behavior, resume, and durability are **identical** to today.

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
worse than §2.3 because it needs a side process and an extra exec per turn — keep
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

### 4.6 Pros / cons vs §2.3
- **Pro:** supervised auto-restart (resilience) for free; durable log buffer for
  replay; doesn't need the §2.5 stdin-writer change to `streamExec`.
- **Con:** brings back service lifecycle (naming, GC) we deliberately shed; still
  needs a side input channel (FIFO/HTTP); restart can interrupt an in-flight turn
  mid-way (mitigate by resume + idempotent turn handling).

---

## 5. Comparison

| Property | §1 exec + resume (current) | **§2.3 cold-per-turn `proto`** (recommended) | §2.4 persistent/warm (niche) | §4 per-chat service (niche) |
|---|---|---|---|---|
| API | Exec | Exec | Exec | Services |
| Process lifetime | ephemeral (cold) | **ephemeral (cold)** | persistent (warm) | persistent (supervised) |
| Sprite-friendly (suspends idle) | ✅ | ✅ | ❌ fights suspend | ❌ fights suspend |
| Codex streaming | ❌ whole message | ✅ (`codex proto`) | ✅ | ✅ |
| Cold start / turn | yes | yes (accepted) | no | no |
| Follow-ups | ✅ via resume | ✅ via resume + stdin | ✅ via stdin | ✅ via input channel |
| Durability after idle | ✅ §6 transcript sync | ✅ §6 transcript sync | ✅ §6 (+ live if alive) | ✅ durable log buffer |
| Prompt-replay risk | none | none | none | none (no baked prompt) |
| Extra machinery | none | stdin writer + proto driver | + keep-alive/respawn | service GC + input channel |
| Lifecycle cost | lowest | low | medium | medium-high |

**Recommendation:** for the real "write → leave → come back" pattern, stay
**ephemeral/cold** (the sprite model wants this). The only worthwhile upgrade is
**§2.3 — route Codex turns through `codex proto` for live streaming**, still one
cold process per turn; do it *only if* Codex's end-of-turn text dump actually
bothers you. **§2.4 (warm)** and **§4 (service)** are niche — justified only by a
tight multi-turn burst in one active sitting, and both work against sprite
suspension. Durability after idle is already handled cold by §6 for every option,
so it is not a reason to go warm. §2.3 is gated on pinning the installed
`codex proto` JSON-RPC schema.

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
