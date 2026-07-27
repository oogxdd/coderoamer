import { Platform } from 'react-native';
import { loadToken } from './auth';
import { runExec } from './api';

/**
 * Per-sprite account connection.
 *
 * Unlike `provision.ts` (which replays globally-saved credentials onto every new
 * sprite), this drives the provider CLIs' *interactive* login flows directly on a
 * single sprite: it runs the login command over a streaming exec TTY, parses the
 * verification URL / one-time code out of the output, opens the browser for the
 * user, forwards any pasted code back into the TTY (Claude), and watches the
 * sprite's credential files to detect completion.
 *
 * Four providers: Codex (ChatGPT), GitHub, Claude, and Vercel. GitHub also has
 * a non-interactive path — pasting a (fine-grained) personal access token —
 * implemented by `validateGithubPat` + `connectGithubWithPat`.
 */

export type ProviderId = 'codex' | 'github' | 'claude' | 'vercel';

export type AccountStatus = Record<ProviderId, boolean>;

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  /** One-line explanation shown under the provider name. */
  blurb: string;
  /** Single letter monogram shown in the status chip. */
  monogram: string;
  /** Accent color for the monogram badge. */
  accent: string;
  /** Whether the flow requires the user to paste a code back (Claude). */
  needsCodePaste: boolean;
  /** Human hint shown while waiting for the user to finish in the browser. */
  waitingHint: string;
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'codex',
    label: 'Codex (ChatGPT)',
    blurb: 'Sign in with your ChatGPT account so Codex can run in this sprite.',
    monogram: 'C',
    accent: '#10A37F',
    needsCodePaste: false,
    waitingHint: 'Enter the code on the OpenAI page, then come back — this updates automatically.',
  },
  {
    id: 'github',
    label: 'GitHub',
    blurb: 'Authorize GitHub so this sprite can clone, pull, and push your repos.',
    monogram: 'G',
    accent: '#6E7681',
    needsCodePaste: false,
    waitingHint: 'Enter the code on the GitHub page, then come back — this updates automatically.',
  },
  {
    id: 'claude',
    label: 'Claude',
    blurb: 'Log in with your Claude subscription to run Claude Code in this sprite.',
    monogram: '✳',
    accent: '#D97757',
    needsCodePaste: true,
    waitingHint: 'Authorize in the browser, copy the code it shows, and paste it below.',
  },
  {
    id: 'vercel',
    label: 'Vercel',
    blurb: 'Sign in to Vercel so this sprite can deploy and manage your projects.',
    monogram: '▲',
    accent: '#171717',
    needsCodePaste: false,
    waitingHint: 'Confirm the code on the Vercel page, then come back — this updates automatically.',
  },
];

export function providerMeta(id: ProviderId): ProviderMeta {
  const meta = PROVIDERS.find((p) => p.id === id);
  if (!meta) throw new Error(`Unknown provider: ${id}`);
  return meta;
}

// ── Detection ───────────────────────────────────────────────────────────────

export type AccountSignatures = Record<ProviderId, string>;

const EMPTY_SIGS: AccountSignatures = { codex: '', github: '', claude: '', vercel: '' };

/**
 * Return a per-provider "signature" of the on-sprite credentials — the mtime and
 * size of the underlying file (or a marker for the env-token case), and empty
 * string when absent. A provider is connected iff its signature is non-empty,
 * and a *fresh* login is detected when the signature changes. Never throws.
 *
 * Codex writes ~/.codex/auth.json; gh writes ~/.config/gh/hosts.yml; Claude
 * writes ~/.claude/.credentials.json (or we store a token in ~/.sprite_env);
 * Vercel CLI (v57+) writes auth.json under the XDG data dir.
 */
export async function getAccountSignatures(spriteName: string): Promise<AccountSignatures> {
  const command = [
    `sig() { stat -c '%Y:%s' "$1" 2>/dev/null || true; }`,
    `co="$(sig "$HOME/.codex/auth.json")"`,
    `gh="$(sig "$HOME/.config/gh/hosts.yml")"; [ -n "$gh" ] || gh="$(sig "$HOME/.git-credentials")"`,
    `cl="$(sig "$HOME/.claude/.credentials.json")"; [ -n "$cl" ] || { grep -qs CLAUDE_CODE_OAUTH_TOKEN "$HOME/.sprite_env" && cl=env; }`,
    `vc="$(sig "\${XDG_DATA_HOME:-$HOME/.local/share}/com.vercel.cli/auth.json")"`,
    `[ -n "$vc" ] || vc="$(sig "$HOME/.config/com.vercel.cli/auth.json")"`,
    `[ -n "$vc" ] || vc="$(sig "$HOME/.vercel/auth.json")"`,
    `echo "codex=$co"; echo "github=$gh"; echo "claude=$cl"; echo "vercel=$vc"`,
  ].join('; ');

  const { output, success } = await runExec(spriteName, command, 20);
  if (!success && !output.includes('codex=')) return { ...EMPTY_SIGS };

  const read = (key: ProviderId) =>
    new RegExp(`^${key}=(.*)$`, 'm').exec(output)?.[1]?.trim() ?? '';
  return {
    codex: read('codex'),
    github: read('github'),
    claude: read('claude'),
    vercel: read('vercel'),
  };
}

/** Whether each provider is authenticated on the sprite (signature non-empty). */
export async function checkAccounts(spriteName: string): Promise<AccountStatus> {
  const sigs = await getAccountSignatures(spriteName);
  return {
    codex: !!sigs.codex,
    github: !!sigs.github,
    claude: !!sigs.claude,
    vercel: !!sigs.vercel,
  };
}

// ── Output parsing ────────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][0-9;]*[^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][0-9A-Za-z]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '');
}

export interface LoginPrompt {
  /** URL the user should open to authorize. */
  url?: string;
  /** One-time code to enter on the provider's page (Codex, GitHub). */
  code?: string;
}

const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,7}\b/;
// Vercel CLI 57+ prints a device-flow URL with the one-time code embedded:
// `Visit https://vercel.com/oauth/device?user_code=XXXX-XXXX`.
const VERCEL_URL_RE = /https:\/\/vercel\.com\/oauth\/device\?user_code=([A-Z0-9-]+)/;
// Base64url + URL-safe characters, so the trailing spinner glyph Claude glues on
// (e.g. `…state=abc\✢`) is excluded from the captured URL.
const CLAUDE_URL_RE =
  /https:\/\/claude\.com\/cai\/oauth\/authorize\?[A-Za-z0-9%._~:/?#[\]@!$&'()*+,;=-]+/g;

/**
 * Parse the accumulated (raw, ANSI-included) login output for the current
 * provider and return whatever verification prompt is available so far.
 */
export function parseLoginPrompt(id: ProviderId, raw: string): LoginPrompt {
  const text = stripAnsi(raw);

  if (id === 'claude') {
    // Two authorize URLs are printed: a localhost-callback one (for auto-open on
    // a desktop) and the manual one that redirects to platform.claude.com and
    // shows a code to paste. We want the manual one.
    const matches = text.match(CLAUDE_URL_RE) ?? [];
    const manual = matches.find((u) => u.includes('platform.claude.com'));
    return { url: manual };
  }

  if (id === 'github') {
    const code =
      /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4,7})/i.exec(text)?.[1] ??
      CODE_RE.exec(text)?.[0];
    return { url: 'https://github.com/login/device', code };
  }

  if (id === 'vercel') {
    const match = VERCEL_URL_RE.exec(text);
    // The code is embedded in the URL, so the page pre-fills it — the user only
    // has to confirm. Still surface it so they can double-check what's shown.
    return match ? { url: match[0], code: match[1] } : {};
  }

  // codex — parse the device URL from the output instead of assuming it, so a
  // CLI that failed to start (missing binary, old version without
  // --device-auth) doesn't masquerade as a working sign-in. v0.144 prints:
  // `1. Open this link… https://auth.openai.com/codex/device` then
  // `2. Enter this one-time code… U79V-EZHWN`.
  const url = /https:\/\/auth\.openai\.com\/\S*device\S*/.exec(text)?.[0];
  const code = CODE_RE.exec(text)?.[0];
  return { url: url ?? (code ? 'https://auth.openai.com/codex/device' : undefined), code };
}

// ── Login command construction ────────────────────────────────────────────────

interface ProviderLoginSpec {
  /** Full command run through `bash -lc`. */
  command: string;
  /** Whether the CLI needs a PTY (interactive TUIs do; gh is cleaner without). */
  tty: boolean;
  /** Terminal width — Claude's TUI wraps the URL unless the terminal is wide. */
  cols: number;
}

function loginSpec(id: ProviderId): ProviderLoginSpec {
  switch (id) {
    case 'codex':
      // Install codex if the sprite doesn't have it, stream the login while
      // logging it, and — when the CLI is too old to know --device-auth —
      // upgrade and retry once. (tee keeps output streaming; $(…) would not.)
      return {
        command:
          'command -v codex >/dev/null 2>&1 || npm install -g @openai/codex@latest >/dev/null 2>&1; ' +
          'codex login --device-auth 2>&1 | tee /tmp/wisp-codex-login.log; rc=${PIPESTATUS[0]}; ' +
          'if [ "$rc" != "0" ] && grep -qiE "unexpected|unrecognized|invalid" /tmp/wisp-codex-login.log; then ' +
          'echo "Updating Codex CLI…"; npm install -g @openai/codex@latest >/dev/null 2>&1 && codex login --device-auth; fi',
        tty: true,
        cols: 120,
      };
    case 'github':
      // Non-tty gives clean, parseable output and auto-polls without an Enter
      // keypress. `setup-git` wires the credential helper so `git push` works.
      return {
        command:
          'gh auth login --hostname github.com --git-protocol https --web ' +
          '--scopes "repo,read:org,gist" --insecure-storage && gh auth setup-git',
        tty: false,
        cols: 120,
      };
    case 'claude':
      // Wide terminal keeps the authorize URL on a single line so we can parse it.
      return { command: 'claude setup-token', tty: true, cols: 400 };
    case 'vercel':
      // Sprites don't ship the Vercel CLI — install it on first use (slowish but
      // one-time; the sheet shows a spinner). v57+ uses the OAuth device flow.
      return {
        command:
          'command -v vercel >/dev/null 2>&1 || npm install -g vercel@latest >/dev/null 2>&1; vercel login',
        tty: true,
        cols: 120,
      };
  }
}

// ── GitHub personal access token path ────────────────────────────────────────

export type GithubTokenType = 'fine-grained' | 'classic' | 'oauth' | 'unknown';

export interface GithubPatInfo {
  /** GitHub login the token belongs to. */
  login: string;
  tokenType: GithubTokenType;
  /**
   * Repositories the token can access. For fine-grained tokens `/user/repos`
   * returns exactly the granted repositories; for classic/oauth tokens it
   * returns everything the account can see, so `allRepos` is set instead of
   * trusting the (truncated) list.
   */
  repos: string[];
  /** True when the token grants broad access (classic PAT / oauth token). */
  allRepos: boolean;
}

export function githubTokenType(token: string): GithubTokenType {
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (token.startsWith('ghp_')) return 'classic';
  if (token.startsWith('gho_') || token.startsWith('ghu_')) return 'oauth';
  return 'unknown';
}

/**
 * Validate a pasted GitHub token directly against api.github.com (CORS-enabled,
 * so this works on web too) and report who it is and which repos it can reach.
 * Throws with a user-facing message when the token is rejected.
 */
export async function validateGithubPat(token: string): Promise<GithubPatInfo> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  };

  const userRes = await fetch('https://api.github.com/user', { headers });
  if (userRes.status === 401) throw new Error('GitHub rejected this token. Check it and try again.');
  if (!userRes.ok) throw new Error(`GitHub error (${userRes.status}). Try again.`);
  const user = await userRes.json();

  const tokenType = githubTokenType(token);
  const allRepos = tokenType !== 'fine-grained';

  let repos: string[] = [];
  try {
    const repoRes = await fetch(
      'https://api.github.com/user/repos?per_page=100&sort=updated',
      { headers }
    );
    if (repoRes.ok) {
      const list: Array<{ full_name: string }> = await repoRes.json();
      repos = list.map((r) => r.full_name);
    }
  } catch {
    // Repo listing is informational — a valid token without it is still usable.
  }

  return { login: user.login ?? 'unknown', tokenType, repos, allRepos };
}

/** Escape a value for safe embedding inside a single-quoted shell string. */
const sq = (v: string) => v.replace(/'/g, "'\\''");

/**
 * Command that installs a pasted token on the sprite. Primary path is
 * `gh auth login --with-token` (writes hosts.yml, wires the git credential
 * helper, and makes `gh pr create` etc. work). If gh refuses the token (e.g.
 * an old gh insisting on classic scopes), fall back to a plain git credential
 * store so clone/push still work.
 */
export function buildGithubPatCommand(token: string): string {
  const t = sq(token);
  return (
    `printf '%s\\n' '${t}' | gh auth login --hostname github.com --git-protocol https ` +
    `--with-token --insecure-storage 2>&1 && gh auth setup-git 2>&1 && echo WISP_PAT_GH ` +
    `|| { git config --global credential.helper store && ` +
    `printf 'https://x-access-token:%s@github.com\\n' '${t}' > ~/.git-credentials && ` +
    `chmod 600 ~/.git-credentials && echo WISP_PAT_GIT_ONLY; }`
  );
}

export type PatInstallResult = 'gh' | 'git-only';

/**
 * Store a validated token on the sprite. Returns which layer took it: 'gh'
 * (full gh CLI + git) or 'git-only' (git push/pull works, gh CLI does not).
 */
export async function connectGithubWithPat(
  spriteName: string,
  token: string
): Promise<PatInstallResult> {
  const { output, success } = await runExec(spriteName, buildGithubPatCommand(token), 60);
  if (output.includes('WISP_PAT_GH')) return 'gh';
  if (output.includes('WISP_PAT_GIT_ONLY')) return 'git-only';
  throw new Error(
    success ? 'Could not store the token on the sprite.' : output.trim() || 'Sprite command failed.'
  );
}

export interface GithubAccessSummary {
  /** GitHub login gh is authenticated as, when parseable. */
  login?: string;
  /** Classic/oauth scopes line from `gh auth status`, when present. */
  scopes?: string;
  /** Accessible repositories (only meaningful for fine-grained tokens). */
  repos: string[];
  /** True when the credential grants broad access to all repos. */
  allRepos: boolean;
}

/**
 * Inspect what the GitHub credential on a sprite can actually reach — so the
 * user can tell whether the sprite has full-account access (web login / classic
 * PAT) or a fine-grained token limited to specific repos.
 */
export async function getGithubAccessSummary(spriteName: string): Promise<GithubAccessSummary> {
  const status = await runExec(spriteName, 'gh auth status -h github.com 2>&1 || true', 30);
  const text = stripAnsi(status.output);
  const login = /account\s+(\S+)/i.exec(text)?.[1];
  const scopes = /Token scopes:\s*(.+)/i.exec(text)?.[1]?.trim();
  // Classic/oauth tokens report scopes; `repo` scope means everything.
  const allRepos = !!scopes && scopes !== 'none' && scopes !== "''";

  let repos: string[] = [];
  if (!allRepos) {
    const list = await runExec(
      spriteName,
      `gh api "user/repos?per_page=100" --jq '.[].full_name' 2>/dev/null || true`,
      30
    );
    repos = list.output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[\w.-]+\/[\w.-]+$/.test(l));
  }

  return { login, scopes, repos, allRepos };
}

// ── Streaming login client ─────────────────────────────────────────────────────

const WS_BASE = Platform.OS === 'web' ? 'ws://localhost:8082/v1' : 'wss://api.sprites.dev/v1';

type RNWebSocketCtor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> } | null
) => WebSocket;

export interface LoginStream {
  /** Send text into the login TTY (e.g. a pasted code + carriage return). */
  send: (text: string) => void;
  /** Send Ctrl-C to abort the login CLI. */
  cancel: () => void;
  /** Tear down the socket. */
  close: () => void;
}

export interface LoginStreamHandlers {
  onData: (chunk: string) => void;
  onExit?: (code: number) => void;
  onClose?: () => void;
  onError?: (message: string) => void;
}

function toArrayBuffer(text: string): ArrayBuffer {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).buffer;
  return Uint8Array.from(Array.from(text, (ch) => ch.charCodeAt(0) & 0xff)).buffer;
}

async function messageToBytes(data: unknown): Promise<Uint8Array | undefined> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return undefined;
}

/**
 * Start a provider login on a sprite and stream its output back. The returned
 * handle lets the caller forward a pasted code (Claude) and abort the flow.
 */
export async function startLogin(
  spriteName: string,
  id: ProviderId,
  handlers: LoginStreamHandlers
): Promise<LoginStream> {
  const spec = loginSpec(id);
  const token = await loadToken('spritesToken');
  if (!token) throw new Error('No Sprites API token found.');

  const cols = spec.cols;
  const rows = 50;
  const params = new URLSearchParams();
  for (const part of ['bash', '-lc', spec.command]) params.append('cmd', part);
  params.set('path', '/bin/bash');
  params.set('tty', spec.tty ? 'true' : 'false');
  params.set('stdin', 'true');
  params.set('cols', String(cols));
  params.set('rows', String(rows));
  // Keep the login alive briefly if the socket blips while the user is in the browser.
  params.set('max_run_after_disconnect', '600s');
  if (Platform.OS === 'web') params.set('token', token);

  const url = `${WS_BASE}/sprites/${encodeURIComponent(spriteName)}/exec?${params.toString()}`;

  let socket: WebSocket;
  if (Platform.OS === 'web') {
    socket = new WebSocket(url);
  } else {
    const RNWebSocket = WebSocket as unknown as RNWebSocketCtor;
    socket = new RNWebSocket(url, undefined, { headers: { Authorization: `Bearer ${token}` } });
  }
  socket.binaryType = 'arraybuffer';

  // Explicitly resize once open: Claude's TUI wraps the authorize URL at the
  // terminal width, so we must guarantee a wide PTY even if the exec endpoint
  // ignores the cols/rows query params.
  socket.onopen = () => {
    if (spec.tty && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  };

  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();

  const handleBytes = (bytes: Uint8Array) => {
    if (bytes.length === 0) return;
    const streamId = bytes[0];
    const payload = bytes.subarray(1);
    if (streamId === 1) {
      const text = stdoutDecoder.decode(payload, { stream: true });
      if (text) handlers.onData(text);
    } else if (streamId === 2) {
      const text = stderrDecoder.decode(payload, { stream: true });
      if (text) handlers.onData(text);
    } else if (streamId === 3) {
      const code = payload.length ? Number(new TextDecoder().decode(payload).trim()) || 0 : 0;
      handlers.onExit?.(code);
      socket.close();
    }
  };

  socket.onmessage = async (event) => {
    try {
      if (typeof event.data === 'string') {
        // Some runtimes deliver binary frames as latin1 strings.
        const first = event.data.charCodeAt(0);
        if (first >= 0 && first <= 3) {
          handleBytes(Uint8Array.from(Array.from(event.data, (ch) => ch.charCodeAt(0) & 0xff)));
        } else {
          handlers.onData(event.data);
        }
        return;
      }
      const bytes = await messageToBytes(event.data);
      if (bytes) handleBytes(bytes);
    } catch (err) {
      handlers.onError?.((err as Error).message);
    }
  };

  socket.onerror = () => handlers.onError?.('Connection error');
  socket.onclose = () => handlers.onClose?.();

  return {
    send: (text: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(toArrayBuffer(text));
    },
    cancel: () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(toArrayBuffer('\u0003'));
    },
    close: () => {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    },
  };
}
