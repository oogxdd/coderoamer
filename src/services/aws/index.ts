/**
 * High-level AWS EC2 lifecycle for 'aws-ec2' connections (§3.6):
 * launch (with a remote-agent bootstrap), sleep (StopInstances — pauses billing,
 * unlike an OS shutdown), wake (StartInstances + poll), terminate, status.
 *
 * Credentials are the user's own scoped IAM key/secret, stored in SecureStore
 * like every other token (auth.ts). No broker.
 */
import { loadToken, saveToken, deleteToken } from '@/services/auth';
import { TunnelKind } from '@/models/connection';
import { toBase64, utf8 } from './crypto';
import { AwsCreds } from './sigv4';
import * as ec2 from './ec2';
import { Ec2Client, InstanceStatus } from './ec2';

export { AwsCreds } from './sigv4';
export type { InstanceStatus, InstanceLifecycle } from './ec2';

/** Default (free-tier, x86). The IAM policy restricts to these two so a leaked
 * key can't launch an expensive type — the tag alone can't (it only exists
 * post-creation). Keep this list in sync with docs/aws-iam-policy.json. */
export const ALLOWED_INSTANCE_TYPES = ['t3.micro', 't4g.nano'] as const;
export type AllowedInstanceType = (typeof ALLOWED_INSTANCE_TYPES)[number];
export const DEFAULT_INSTANCE_TYPE: AllowedInstanceType = 't3.micro';

export const DEFAULT_REPO_URL = 'https://github.com/oogxdd/sprites-rn-manager';

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export async function loadAwsCreds(): Promise<AwsCreds | null> {
  const [accessKeyId, secretAccessKey] = await Promise.all([
    loadToken('awsAccessKeyId'),
    loadToken('awsSecretAccessKey'),
  ]);
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey };
}

export async function saveAwsCreds(creds: AwsCreds): Promise<void> {
  await Promise.all([
    saveToken('awsAccessKeyId', creds.accessKeyId.trim()),
    saveToken('awsSecretAccessKey', creds.secretAccessKey.trim()),
  ]);
}

export async function clearAwsCreds(): Promise<void> {
  await Promise.all([deleteToken('awsAccessKeyId'), deleteToken('awsSecretAccessKey')]);
}

// ---------------------------------------------------------------------------
// user_data bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  agentToken: string;
  tunnel: TunnelKind;
  /** Tailscale auth key so `tailscale up` needs no browser login on a headless box. */
  tsAuthKey?: string;
  repoUrl?: string;
  /** Optional prebuilt binary URL (arch-specific). If set, avoids needing Go on
   * the instance; otherwise the script installs Go and builds from source. */
  binaryUrl?: string;
}

/**
 * Build the base64 cloud-init user_data that installs remote-agent
 * non-interactively with the pre-generated token, so the app already knows the
 * AGENT_TOKEN before the instance finishes booting. Reuses the one installer
 * (install.sh --tunnel=…) shared with the manual-VPS path (§3.6).
 */
export function buildUserData(opts: BootstrapOptions): string {
  const repo = opts.repoUrl ?? DEFAULT_REPO_URL;
  const tunnel = opts.tunnel ?? 'tailscale';
  const lines = [
    '#!/bin/bash',
    'set -eux',
    `export AGENT_TOKEN='${opts.agentToken}'`,
  ];
  if (opts.tsAuthKey) lines.push(`export TS_AUTHKEY='${opts.tsAuthKey}'`);
  lines.push(
    'if command -v apt-get >/dev/null 2>&1; then apt-get update -y && apt-get install -y git curl; fi',
    'if command -v yum >/dev/null 2>&1; then yum install -y git curl; fi',
    // Run the daemon under a non-root login user with lingering so the systemd
    // --user unit persists across reboots.
    'TARGET_USER="$(id -un 1000 2>/dev/null || echo root)"',
    'loginctl enable-linger "$TARGET_USER" 2>/dev/null || true',
    `git clone ${repo} /opt/sprites-rn-manager || (cd /opt/sprites-rn-manager && git pull)`,
    'AGENT_DIR=/opt/sprites-rn-manager/remote-agent',
  );
  if (opts.binaryUrl) {
    lines.push(
      // Prebuilt binary path (no Go needed on the instance).
      `curl -fsSL '${opts.binaryUrl}' -o "$AGENT_DIR/remote-agent" && chmod +x "$AGENT_DIR/remote-agent"`
    );
  } else {
    lines.push(
      // Source-build fallback: install Go if absent.
      'if ! command -v go >/dev/null 2>&1; then',
      '  ARCH=$(uname -m); case "$ARCH" in x86_64) GOARCH=amd64;; aarch64) GOARCH=arm64;; esac',
      '  curl -fsSL "https://go.dev/dl/go1.22.5.linux-${GOARCH}.tar.gz" | tar -C /usr/local -xz',
      '  export PATH=$PATH:/usr/local/go/bin',
      'fi'
    );
  }
  lines.push(
    `chown -R "$TARGET_USER" /opt/sprites-rn-manager`,
    `sudo -iu "$TARGET_USER" env AGENT_TOKEN="$AGENT_TOKEN" ${opts.tsAuthKey ? 'TS_AUTHKEY="$TS_AUTHKEY" ' : ''}PATH="$PATH" bash "$AGENT_DIR/install.sh" --tunnel=${tunnel} --token="$AGENT_TOKEN" --port=8765`
  );
  return toBase64(utf8(lines.join('\n') + '\n'));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface AwsContext {
  creds: AwsCreds;
  region: string;
  endpoint?: string; // LocalStack override
}

function client(ctx: AwsContext): Ec2Client {
  return { creds: ctx.creds, region: ctx.region, endpoint: ctx.endpoint };
}

export interface LaunchOptions {
  imageId: string;
  instanceType?: AllowedInstanceType;
  agentToken: string;
  tunnel: TunnelKind;
  tsAuthKey?: string;
  name?: string;
  securityGroupId?: string;
  subnetId?: string;
  binaryUrl?: string;
  repoUrl?: string;
}

export async function launchInstance(
  ctx: AwsContext,
  opts: LaunchOptions
): Promise<{ instanceId: string }> {
  const instanceType = opts.instanceType ?? DEFAULT_INSTANCE_TYPE;
  if (!ALLOWED_INSTANCE_TYPES.includes(instanceType)) {
    // The IAM policy also enforces this; fail fast client-side with a clear error.
    throw new Error(`instanceType must be one of: ${ALLOWED_INSTANCE_TYPES.join(', ')}`);
  }
  const userData = buildUserData({
    agentToken: opts.agentToken,
    tunnel: opts.tunnel,
    tsAuthKey: opts.tsAuthKey,
    binaryUrl: opts.binaryUrl,
    repoUrl: opts.repoUrl,
  });
  return ec2.runInstance(client(ctx), {
    imageId: opts.imageId,
    instanceType,
    userData,
    name: opts.name,
    securityGroupId: opts.securityGroupId,
    subnetId: opts.subnetId,
  });
}

export function sleepInstance(ctx: AwsContext, instanceId: string): Promise<void> {
  return ec2.stopInstance(client(ctx), instanceId);
}

export function startInstance(ctx: AwsContext, instanceId: string): Promise<void> {
  return ec2.startInstance(client(ctx), instanceId);
}

export function terminateInstance(ctx: AwsContext, instanceId: string): Promise<void> {
  return ec2.terminateInstance(client(ctx), instanceId);
}

export function getStatus(ctx: AwsContext, instanceId: string): Promise<InstanceStatus> {
  return ec2.describeInstance(client(ctx), instanceId);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll DescribeInstances until the instance reaches `target` (or a terminal
 * state / timeout). Used by the wake flow (StartInstances → wait 'running').
 */
export async function waitForState(
  ctx: AwsContext,
  instanceId: string,
  target: InstanceStatus['state'],
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<InstanceStatus> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let last: InstanceStatus | null = null;
  while (Date.now() < deadline) {
    last = await getStatus(ctx, instanceId);
    if (last.state === target) return last;
    if (last.state === 'terminated' && target !== 'terminated') {
      throw new Error(`Instance ${instanceId} is terminated`);
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${instanceId} to reach '${target}' (last: '${last?.state ?? 'unknown'}')`
  );
}

/** Wake: StartInstances, then wait until 'running'. Reachability of the daemon
 * (the tunnel URL answering) is checked separately by the caller via the normal
 * exec-session ping, mirroring the cold-Sprite wake UX. */
export async function wakeInstance(ctx: AwsContext, instanceId: string): Promise<InstanceStatus> {
  await startInstance(ctx, instanceId);
  return waitForState(ctx, instanceId, 'running');
}
