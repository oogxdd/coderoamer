# Review handoff — `feat/custom-vm-providers`

A guide for an independent reviewer to check the multi-provider VMs work
(Sprites + custom VPS / AWS / home server). **The daemon is covered first and in
the most depth** — it's the piece most worth scrutinizing. This file is a review
aid; delete it before merge if you like.

Design spec being implemented: [`custom-vm-providers.md`](custom-vm-providers.md).
Everything is on branch `feat/custom-vm-providers` (10 commits on top of `main`).

```bash
git fetch origin && git worktree add ../review feat/custom-vm-providers
# or: git checkout feat/custom-vm-providers
```

## TL;DR — what to trust, what to scrutinize

| Area | State | How verified |
|---|---|---|
| **Go daemon** (`remote-agent/`) | **Verified** | `go test ./...` + a live HTTP smoke test (below) |
| Connection model + api/exec parameterization | Typechecks | `tsc --noEmit` clean |
| AWS SigV4 / EC2 client | **Verified (shaping)** | crypto KATs + mocked-`fetch` checks (appendix) |
| **UI** (dashboard, Add Custom VPS) | **Typechecks only** | `tsc` + `expo lint` clean — **NOT runtime-tested** (no simulator here) |
| AWS against real infra, tunnels | **Not run** | deferred → `custom-vm-testing.md` §6b checklist |

The two things that most deserve a careful read: (1) the daemon's exec framing
fix (§ below), and (2) the api.ts "active connection" resolution design.

---

## 1. The daemon — `remote-agent/` (mimics the Sprites API)

**What it is.** A single static Go binary (`creack/pty` + `gorilla/websocket`)
that speaks the *exact* wire protocol the app already uses against
`api.sprites.dev`, so the RN client can point at any Linux box unchanged. The
`:name` path segment is accepted but ignored (one machine per daemon). It was
ported from an earlier Node version (see git history for `remote-agent/index.js`)
because a Go static binary cross-compiles with **zero toolchain on the target**
(a random VPS distro or an ARM Raspberry Pi), which `node-pty` (a node-gyp native
addon) can't guarantee.

**Ground truth to check it against:** `src/services/api.ts` and
`src/services/exec-poc.ts` are the *client* side of this protocol. The daemon is
correct iff those parse its output. Endpoints:

| Method | Path | Handler |
|---|---|---|
| `PUT/GET/DELETE` | `/sprites/:name/services/:svc` | `services.go` |
| `GET` | `/sprites/:name/services/:svc/logs` | `services.go` |
| `GET` | `/sprites/:name/services` | `services.go` (list) |
| `GET` | `/sprites/:name/exec` | `exec.go` (list sessions) |
| `WS` | `/sprites/:name/exec?cmd=&cols=&rows=` | `exec.go` (new PTY) |
| `WS` | `/sprites/:name/exec/:sessionId` | `exec.go` (attach + replay) |
| `POST` | `/sprites/:name/exec/:sessionId/kill` | `exec.go` |
| `PUT` | `/sprites/:name/fs/write?path=&workingDir=&mode=&mkdir=` | `fs.go` (**new**) |

Auth: `Authorization: Bearer $AGENT_TOKEN` on every HTTP + WS request (`main.go`
`authorized()`; WS also accepts `?token=` as a fallback).

### 1a. The three deltas from the Node reference — please verify these

1. **Exec output is stream-id framed** (`exec.go` `frameOut`/`readPtyLoop`: PTY
   bytes are sent as a binary frame `[0x01, ...bytes]`). **Why it matters:** the
   app's *chat* path (`api.ts` `streamExec` → `handleBinaryMessage`, ~lines
   602–695) treats byte[0] as a stream id and **silently drops** any binary frame
   whose first byte isn't 1/2/3. The Node daemon sent *raw* PTY bytes, so
   chat-over-remote was quietly broken (only the terminal client, `exec-poc.ts`,
   tolerated raw bytes). Confirm: read `handleBinaryMessage` in `api.ts`, then
   `frameOut` in `exec.go`. `session_info` and `exit` are JSON *text* frames
   (both client parsers handle those).

2. **Optional `/v1` prefix** (`main.go` `normalizePath`). The app's base URL is
   `${baseUrl}/v1`, so requests arrive as `/v1/sprites/...`; the Node daemon
   routed on bare `/sprites/...` and would have 404'd. Confirm the client appends
   `/v1` (`api.ts` `httpBaseFor`) and `normalizePath` strips it.

3. **`fs/write` added** (`fs.go`) — mirrors `writeSpriteFile` in `api.ts`; needed
   so sprite-side audio transcription (`audio-transcription.ts`) works over
   remote connections.

### 1b. Verify the daemon independently

```bash
cd remote-agent
go vet ./... && go test -count=1 -v ./...   # in-process integration tests
```
Expected: `PASS` — `TestAuthRejected`, `TestFsWrite`, `TestServicesStream`,
`TestExecPtyStdinAndExit`, `TestExecAttachReplayAndKill`, `TestExecListSessions`.
These drive a real PTY, real WS dial (via `httptest`), stdin (0x00-framed),
resize, scrollback replay, and kill.

**Live HTTP smoke test** (I ran this against the committed code; reproduce it):
```bash
go build -o /tmp/ra . && AGENT_TOKEN=t PORT=8791 /tmp/ra &
curl -s -o /dev/null -w "%{http_code}\n" localhost:8791/sprites/x/exec            # 401
curl -s -XPUT -H "Authorization: Bearer t" --data-binary hi \
  "localhost:8791/v1/sprites/a/fs/write?path=/tmp/x.txt&mkdir=true"               # {"mode":..,"path":..,"size":2}
curl -s -XPUT -H "Authorization: Bearer t" -H 'Content-Type: application/json' \
  --data '{"cmd":"sh","args":["-c","echo hi"]}' localhost:8791/sprites/a/services/s
```
Actual output observed:
```
401
{"mode":"0644","path":"/tmp/x.txt","size":2}
{"type":"started",...}{"type":"stdout","data":"hi\n"}{"type":"exit","exit_code":0}{"type":"complete"}
```
The exec WebSocket needs a WS client (curl can't upgrade cleanly); the `go test`
suite covers it. To eyeball it against the real app, point a dev build at
`http://<host>:8765` and open a chat + the stream terminal.

### 1c. Things to scrutinize in the daemon

- **WS write serialization** (`wsClient.mu`) — gorilla allows only one concurrent
  writer; check every `ws.Write*` goes through `wsClient`.
- **Service fan-out is non-blocking** (`services.go` `emit`: `select { case ch<-ev: default: }`)
  — a slow `/logs` subscriber *drops* events rather than stalling the process.
  Acceptable for a fast local client; note it.
- **Channel close-once** (`finish` vs `deleteService` both grab+clear `subs` under
  the lock so only one closes) — check there's no double-close.
- **Exit code**: signal-killed → negative → reported as `0` (`readPtyLoop`).
- **stdin heuristic**: binary frame with a leading `0x00` is stripped (api.ts
  convention); otherwise the whole frame is stdin (exec-poc convention). Edge
  case: a genuine first stdin byte of `0x00` (Ctrl+@) is lost — documented trade.
- **Not implemented (by design):** checkpoints, sprite CRUD, `GET /sprites/:name`.
  The app degrades gracefully (`sprite/[name].tsx` wraps `getSprite` in try/catch;
  Checkpoints/ttyd are hidden for non-`sprite` connections — verify that gating).

---

## 2. App-side connection model + parameterization

- `src/models/connection.ts` — `backing: 'sprite' | 'existing' | 'aws-ec2'`.
- `src/services/connections.ts` — list in SecureStore, active-id in AsyncStorage,
  **migrates the legacy `spritesToken`** into a default sprite connection.
- `src/contexts/ConnectionsContext.tsx` — owns the list + active connection.
- **Key design (worth a look):** `api.ts`/`exec-poc.ts` resolve base URL + token
  from a **module-level active connection** (`setActiveConnection`, set by the
  context) plus a trailing optional `conn?` override on each function — *not* a
  `conn` threaded through all 11 callers. This is a deliberate deviation from
  `remote-agent/MIGRATION.md`'s original plan; rationale is in `api.ts` and the
  updated MIGRATION.md. Scrutinize: is a single global "active connection" safe
  given the app's navigation model? (I argue yes — you're inside one VM at a time;
  the dashboard uses the explicit `conn?` for cross-connection aggregation.)

Verify: `bun ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → clean.
(Note: under node, `tsc`/eslint segfault in this repo — run via `bun`. `expo lint`
auto-generates an untracked `eslint.config.js`; `rm` it after.)

---

## 3. AWS (`src/services/aws/`)

No `@aws-sdk`, no native crypto (RN has neither reliably): vendored SHA-256/HMAC
(`crypto.ts`) + hand-rolled SigV4 (`sigv4.ts`) + EC2 query calls (`ec2.ts`,
endpoint-configurable for LocalStack) + lifecycle (`index.ts`). Scoped policy:
`docs/aws-iam-policy.json` (six actions; the **instance-type** condition is what
actually caps cost — the tag only exists post-creation).

Verify the crypto + request shaping (appendix has paste-and-run scripts):
- SHA-256/HMAC known-answer vectors, incl. **AWS's documented SigV4 signing-key**
  vector (`…20120215/us-east-1/iam` → `f4780e2d…db404d`).
- Mocked-`fetch` pass over RunInstances/DescribeInstances/Start/Stop: id parse,
  `ManagedBy` tag, instance type, LocalStack endpoint override, error surface.

**Scrutinize:** (a) the AWS-path `AGENT_TOKEN` uses `Math.random`, not a CSPRNG —
flagged as a v1 limitation (manual paths use `openssl`); (b) a just-launched AWS
connection has **no `baseUrl`** until its tunnel is up — the dashboard shows it as
"provisioning" and lets you paste the URL (iOS `Alert.prompt`; Android shows an
info alert only — an editing gap to close); (c) the `user_data` bootstrap
(`index.ts` `buildUserData`) is best-effort and only truly exercised in §6b.

---

## 4. Honest risk register

1. **UI is not runtime-tested** — I couldn't launch a simulator in this
   environment. It typechecks and lints clean, but drive `Add Custom VPS` (both
   sub-paths) and the VM list on a real dev build.
2. **AWS/tunnels not run against real infra** — see `custom-vm-testing.md` §6b.
   LocalStack wasn't runnable here (no Docker), so AWS is verified at the
   request/response-shaping level only.
3. **AWS token RNG** and **pending-baseUrl editing on Android** — noted above.
4. **Environment note:** the git worktree for this branch got pruned/wiped twice
   during a session gap here (unrelated to the code); all work is safe on the
   branch + remote (`bcb4790`).

---

## Appendix — paste-and-run verification scripts

Save each **at the repo root** (the imports are repo-root-relative) and run with
`bun ./crypto-check.ts` / `bun ./aws-check.ts`. Both print `ok …` lines when the
committed code is correct (verified here).

**crypto/SigV4 KATs** (`bun crypto-check.ts`):
```ts
import { sha256Hex, hmacSha256, toHex, utf8 } from './src/services/aws/crypto';
const a = (n:string,g:string,w:string)=>console.log((g===w?'ok  ':'FAIL ')+n);
a('sha256 abc', sha256Hex(utf8('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
a('hmac jefe', toHex(hmacSha256(utf8('Jefe'),utf8('what do ya want for nothing?'))), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
const kD=hmacSha256(utf8('AWS4'+'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'),utf8('20120215'));
const kR=hmacSha256(kD,utf8('us-east-1')), kS=hmacSha256(kR,utf8('iam')), kSign=hmacSha256(kS,utf8('aws4_request'));
a('sigv4 signing key', toHex(kSign), 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
```

**EC2 request/response shaping** (`bun aws-check.ts`, mocks `fetch`):
```ts
import { signQuery } from './src/services/aws/sigv4';
import * as ec2 from './src/services/aws/ec2';
const creds={accessKeyId:'AKIDEXAMPLE',secretAccessKey:'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'};
const s=signQuery({creds,region:'us-east-1',service:'ec2',host:'ec2.us-east-1.amazonaws.com',body:'Action=DescribeInstances&Version=2016-11-15',now:new Date(Date.UTC(2025,0,1))});
console.log(/SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/.test(s.headers.Authorization)?'ok   sigv4 header':'FAIL sigv4 header');
(globalThis as any).fetch=async()=>({ok:true,status:200,text:async()=>'<r><instanceId>i-1</instanceId><instanceState><name>running</name></instanceState><ipAddress>1.2.3.4</ipAddress></r>'});
console.log((await ec2.describeInstance({creds,region:'us-east-1'},'i-1')).state==='running'?'ok   describe parse':'FAIL describe parse');
```
