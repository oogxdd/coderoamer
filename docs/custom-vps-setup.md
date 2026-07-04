# Adding a custom VM (VPS / AWS / home server)

The VM list can point at any Linux machine running the [`remote-agent`](../remote-agent/)
daemon, which speaks the exact Sprites wire protocol — so chat, the session
browser, and the stream terminal work against it unmodified. This guide covers
the three add paths. For the design/rationale see
[`custom-vm-providers.md`](custom-vm-providers.md).

**Custom connections are native-only** (iOS/Android dev build; not the web
build). **Checkpoints** and the **ttyd** bootstrap are Sprites-only and are
hidden for custom connections.

Everything below assumes the daemon on port **8765**. It runs commands as
whoever starts it — *treat access to the agent as equivalent to SSH access*, so
always put it behind a tunnel/TLS off-LAN.

---

## Path A — a custom VPS you already have

For any Linux box you can SSH into (a DigitalOcean/Hetzner/Linode droplet, etc.).

1. On the machine, clone the repo and run the installer with the exposure you
   want. Tailscale Funnel is the easiest (no domain/cert):

   ```bash
   git clone https://github.com/oogxdd/sprites-rn-manager
   cd sprites-rn-manager/remote-agent
   bash install.sh --tunnel=tailscale     # or --tunnel=cloudflare, or --tunnel=none
   ```

   No Go on the box? Build the binary on your dev machine first
   (`bash remote-agent/build.sh`) and copy `dist/remote-agent-linux-<arch>` next
   to `install.sh` — the installer prefers a prebuilt binary and skips the build.

2. The script prints two things at the end:

   ```
   AGENT_TOKEN:  <64-hex-chars>
   Base URL:     https://<machine>.ts.net        (or http://<lan-ip>:8765 for --tunnel=none)
   ```

3. In the app: **Add → Add Custom VPS → Existing machine**, pick the same
   exposure, and paste the **Base URL** and **AGENT_TOKEN**. Done.

**Fields to paste back:** Base URL, AGENT_TOKEN.

---

## Path B — your home machine

Identical to Path A, with two differences:

- **Recommended exposure: Tailscale** (`--tunnel=tailscale`). It avoids exposing
  your home IP/router at all — the machine is reachable only over your tailnet's
  Funnel URL. Cloudflare Tunnel is the documented alternative if you'd rather
  have a public URL than toggle a VPN on your phone.
- **No programmatic sleep/wake.** A home machine is fully on or fully off; the
  app can't power it. Wake-on-LAN over the WAN is fragile without another
  always-on relay on the LAN and is intentionally **out of scope** — leave the
  machine on, or power it yourself.

Then add it in the app exactly as in Path A (**Existing machine**).

---

## Path C — an AWS-backed VM the app creates

The app can *create* an EC2 instance, *sleep* it (StopInstances — which pauses
compute billing, unlike an OS shutdown), and *wake* it (StartInstances).

### 1. Create a scoped IAM user

Create an IAM user with **programmatic access** and attach the policy in
[`aws-iam-policy.json`](aws-iam-policy.json). **Replace `us-east-1` in that file
with the region you'll use** (it appears in every statement). The policy allows
only six actions on instances tagged `ManagedBy=sprites-rn-manager`, restricted
to `t3.micro`/`t4g.nano` — the instance-type cap is what actually bounds cost, so
don't loosen it.

Also set an **AWS Budget / billing alarm** independently, as a second net that
doesn't depend on the policy being airtight.

### 2. Find an AMI for your region

AMIs are region- **and arch**-specific. The instance type's arch must match the
AMI:

- `t3.micro` → **x86_64** AMI
- `t4g.nano` → **arm64** AMI

Grab the latest Amazon Linux 2023 AMI id from the console (EC2 → Launch → AMI),
or via the AWS CLI if you have it locally:

```bash
# x86_64 (for t3.micro):
aws ssm get-parameter --region us-east-1 \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query Parameter.Value --output text
# arm64 (for t4g.nano): …-al2023-ami-kernel-default-arm64
```

(The app itself only calls EC2 — it does not resolve AMIs, so the SSM permission
above is *not* in the policy; you look the id up once.)

### 3. Launch from the app

**Add → Add Custom VPS → AWS (create new)**, then provide:

- **AWS Access Key ID / Secret Access Key** — stored in SecureStore like every
  other token; no broker.
- **Region** — must match the region in your IAM policy.
- **Instance type** — `t3.micro` or `t4g.nano`.
- **AMI id** — from step 2 (arch must match the type).
- **Exposure** — **Tailscale recommended**. For a headless box, generate a
  Tailscale **auth key** (`tskey-…`) and paste it so the instance can join your
  tailnet without a browser login. Lock the security group to deny inbound 8765
  and rely on the outbound tunnel.

Tap **Launch instance**. The app pre-generates the `AGENT_TOKEN`, passes it and
`install.sh --tunnel=…` as the instance's user-data, and stores the connection
with its EC2 ref.

### 4. Go live, sleep, wake

- The instance boots and installs the daemon automatically (tens of seconds to a
  couple minutes). Once its tunnel is up, add the **tunnel URL** to the
  connection (tap the "provisioning" row).
- **Sleep** = long-press the machine → the AWS path uses StopInstances (billing
  paused). **Wake** = the app calls StartInstances and polls until running,
  reusing the same cold-Sprite spinner UX.
- **Terminate** = long-press → *Terminate instance* when you're done.

**Fields you provide:** AWS keys, region, instance type, AMI id, (optional)
Tailscale auth key. **Fields the app derives:** AGENT_TOKEN, instance id, tunnel
URL.

> v1 note: the AWS-path `AGENT_TOKEN` is generated with `Math.random` (not a
> CSPRNG). The manual paths use `openssl rand` on the machine instead. Harden the
> AWS path by wiring in a crypto RNG (e.g. `expo-crypto`).

---

## Reference

- Exposure options in depth (Caddy / nginx / LAN): [`MIGRATION.md`](../remote-agent/MIGRATION.md) §2.
- Daemon endpoints, build, and run: [`remote-agent/README.md`](../remote-agent/README.md).
- Why AWS EC2 stop/start (and not Lightsail / microVMs): [`custom-vm-providers.md`](custom-vm-providers.md) §3.6 / §5 / §7.
