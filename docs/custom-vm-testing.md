# Multi-provider VMs — testing

Two stages (see `custom-vm-providers.md` §6). **§6a is done** (no credentials
needed). **§6b** is the credentialed, real-infrastructure follow-up — run it when
AWS keys + a DigitalOcean droplet are available. Don't block shipping on §6b.

## §6a — self-verifiable, done during implementation

- [x] **Go daemon, localhost.** `cd remote-agent && go test ./...` — in-process
      integration tests: bearer auth (401), `fs/write` (bytes + mode + mkdir),
      services NDJSON lifecycle (`started`/`stdout`/`exit`/`complete`), exec PTY
      (session_info, stream-id-framed stdout, 0x00-prefixed stdin, resize, exit),
      attach + scrollback replay, kill, session list, and the `/v1` prefix. All green.
- [x] **AWS control-plane, no account.** SigV4 signer + EC2 request/response
      shaping verified with SHA-256/HMAC known-answer tests, AWS's documented
      signing-key vector, and a mocked-`fetch` pass over
      RunInstances/DescribeInstances/Start/Stop (state parse, tag, instance type,
      endpoint override, error surface). Endpoint is configurable for LocalStack:
      point `endpoint` at `http://localhost:4566` and re-run against a running
      LocalStack (`localstack start`, needs Docker) to exercise the calls for real.
- [x] **App-side (connection model + api/exec parameterization + UI).** `tsc
      --noEmit` clean; `expo lint` clean for all new files. Runtime pass is the
      normal RN dev loop: `npx expo run:ios`, point a dev build at
      `http://localhost:8765` (a locally-run daemon), exercise chat/terminal.
- [x] **Install-script logic.** `bash -n` + flag validation. A full tunnel pass
      (a reachable public URL) needs a real machine — that's §6b.

## §6b — credentialed, real infrastructure (follow-up)

### AWS (real or dedicated test account)

- [ ] Create an IAM user scoped to `docs/aws-iam-policy.json` (region replaced).
      This validates the policy is actually **sufficient**, not just written.
- [ ] Set an AWS Budget / billing alarm first.
- [ ] Look up a current AMI id for the region (arch must match the instance type:
      `t3.micro`→x86_64, `t4g.nano`→arm64).
- [ ] **Add → Add Custom VPS → AWS**: paste keys + region + type + AMI + a
      Tailscale auth key; **Launch**. Confirm RunInstances succeeds with the
      `ManagedBy=sprites-rn-manager` tag and the chosen type only.
- [ ] Confirm the **user-data bootstrap** installs the daemon + tunnel and the
      daemon answers on the tunnel URL. (Watch the non-root-user + `enable-linger`
      + systemd-`--user` path in `buildUserData`; adjust to a system unit if a
      given AMI makes the user path awkward.)
- [ ] Add the tunnel URL to the connection; confirm it goes **live** — exercise
      chat + exec for real against the instance.
- [ ] **Sleep** (long-press → the StopInstances path): confirm DescribeInstances
      shows `stopped` (compute billing paused), *not* just OS-shutdown-still-metered,
      and the daemon is unreachable.
- [ ] **Wake** (StartInstances + poll): confirm it returns to `running` and the
      connection reconnects.
- [ ] **Terminate** when done; confirm `terminated` and no lingering charges.

### "Existing machine" via a DigitalOcean droplet (stands in for a home box)

- [ ] Spin up a cheap hourly droplet (Ubuntu). *Do not* test power-cycling via
      DO's API — the existing-machine path has no programmatic sleep/wake by
      design (§3.7); that's not what's being validated.
- [ ] `git clone … && cd remote-agent && bash install.sh --tunnel=tailscale` →
      confirm it prints a reachable `https://<machine>.ts.net` URL + AGENT_TOKEN.
- [ ] Repeat with `--tunnel=cloudflare` → confirm a reachable `trycloudflare.com`
      URL (so both §3.5 options get exercised).
- [ ] **Add → Add Custom VPS → Existing machine**: paste URL + token for each;
      confirm chat / exec / services / stream terminal work like a Sprite.
- [ ] Confirm **Checkpoints** and the **ttyd** bootstrap are hidden for the
      connection (not 404-ing) (§3.2).
- [ ] Destroy the droplet(s) afterward.
