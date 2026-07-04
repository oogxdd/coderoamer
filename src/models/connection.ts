/**
 * Connection model — the app is conceptually a list of VMs, and a Connection is
 * how the app reaches one provider of VMs.
 *
 * Backings (§3.1 of docs/custom-vm-providers.md):
 *  - 'sprite'   — a Fly.io Sprites account. One connection → many sprites (VMs),
 *                 reached via https://api.sprites.dev. Token is the Sprites API token.
 *  - 'existing' — any Linux box already running the remote-agent daemon: a home
 *                 server OR any VPS you already have. One connection → one VM.
 *                 Token is the daemon's AGENT_TOKEN. Home-vs-VPS is only a UI-copy /
 *                 default-tunnel-suggestion distinction at add-time, NOT a separate
 *                 backing (see §3.1 / §3.7) — do not add a fourth enum value for it.
 *  - 'aws-ec2'  — an EC2 instance the app can programmatically create / stop / start.
 *                 Same daemon + AGENT_TOKEN as 'existing', plus an `aws` descriptor
 *                 so the lifecycle layer can drive Stop/StartInstances.
 *
 * Kept an extensible union (not a two-way branch) so a future provider
 * (GCP/Azure/Hetzner/…) doesn't force a model rewrite — see §5 non-goals.
 */
export type ConnectionBacking = 'sprite' | 'existing' | 'aws-ec2';

export type TunnelKind = 'tailscale' | 'cloudflare' | 'none';

export interface AwsInstanceRef {
  region: string;
  instanceId: string;
  /** Instance type actually launched (t4g.nano / t3.micro). Informational. */
  instanceType?: string;
}

export interface Connection {
  /** Local UUID, stable for the life of the connection. Not a secret. */
  id: string;
  backing: ConnectionBacking;
  /** Display name (a sprite-account label, "my MacBook", "aws us-east-1", …). */
  name: string;
  /**
   * Base origin WITHOUT the /v1 suffix, e.g. `https://box.ts.net` or
   * `http://192.168.1.9:8765`. Unset for 'sprite' (which uses api.sprites.dev).
   */
  baseUrl?: string;
  /** Sprites API token for 'sprite'; AGENT_TOKEN for 'existing'/'aws-ec2'. */
  token: string;
  /**
   * Which exposure the machine uses. Informational for 'existing' (drives which
   * setup instructions we show); for 'aws-ec2' we default to 'tailscale' (§3.6).
   */
  tunnel?: TunnelKind;
  /** Present only for 'aws-ec2'. */
  aws?: AwsInstanceRef;
}

/** True for connections served by a remote-agent daemon (not Sprites). */
export function isRemoteBacked(conn: Connection): boolean {
  return conn.backing === 'existing' || conn.backing === 'aws-ec2';
}

/**
 * Whether Sprites-only REST features (checkpoints, sprite CRUD, ttyd url-auth
 * bootstrap) are available for this connection. remote-agent does not implement
 * them, so the UI must hide/disable them rather than let a 404 surface (§3.2).
 */
export function supportsSpriteOnlyFeatures(conn: Connection | null | undefined): boolean {
  return !!conn && conn.backing === 'sprite';
}

/** Whether this connection can be programmatically slept/woken (§3.6 / §3.7). */
export function supportsPowerControl(conn: Connection): boolean {
  return conn.backing === 'aws-ec2';
}

/**
 * Normalize a user-entered base URL: trim, drop a trailing slash, and strip a
 * trailing `/v1` if the user pasted the full app base URL by mistake (the app
 * appends `/v1` itself).
 */
export function normalizeBaseUrl(raw: string): string {
  let s = raw.trim();
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/v1$/, '');
  return s;
}
