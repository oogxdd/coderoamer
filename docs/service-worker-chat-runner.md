# Service-backed chat runner design

This document sketches a future architecture for running mobile chat turns through
a durable worker service. It is not part of the current hotfix. The current app
should run chat turns through Exec sessions, with a Tasks heartbeat while the
agent is working.

## Problem

A Sprite Service is a persistent process definition. It can start on boot and
restart after crashes or cold wakes. That is useful for daemons, but dangerous if
the service command contains a user prompt:

```bash
claude -p --resume "$SESSION_ID" "$PROMPT"
```

If that service restarts, it can submit the same prompt into the same Claude Code
session again. That corrupts the transcript and can drain usage limits.

## Worker model

A safe service-backed design would make the service a stable worker, not a
prompt runner:

```bash
node mobile-chat-worker.js --sprite-local
```

The prompt would be stored as a job with a unique turn id:

```json
{
  "turnId": "turn_123",
  "chatId": "mobile-test-chat-1",
  "provider": "claude",
  "cwd": "/home/sprite/your-repo",
  "claudeSessionId": "2e9e7a92-8192-472e-92bc-0e9095258bd1",
  "prompt": "Implement the requested fix",
  "state": "pending"
}
```

The worker would read jobs, mark a job as `running`, launch Claude or Codex once,
stream output to a durable log, then mark the job `completed` or `failed`.

## Required invariants

- The service command must never contain the user prompt.
- Every user turn must have a unique stable `turnId`.
- The worker must persist state before invoking Claude or Codex.
- On restart, the worker must inspect state before doing anything:
  - `pending`: safe to start.
  - `running`: inspect whether the child process is still alive or mark failed.
  - `completed`: never submit again.
  - `failed`: surface the failure; retry only by creating a new turn id.
- The app should render from durable job output and provider transcripts, not from
  transient service logs alone.

## Why not build this now

This requires a queue, durable job state, worker lifecycle code, output storage,
and retry semantics. That is more moving parts than the current bug fix needs.

For the current app behavior, Exec plus a Tasks heartbeat is enough:

1. The app starts one Exec session for the turn.
2. The Exec wrapper creates and refreshes a task so the Sprite stays awake.
3. Claude/Codex writes its normal transcript.
4. The app streams output while connected.
5. On reopen, the app attaches to the Exec session if it is still running or
   reloads the provider transcript from disk.

Services should remain reserved for actual long-running daemons until a worker
like the one above exists.
