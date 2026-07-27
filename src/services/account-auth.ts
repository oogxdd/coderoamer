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
 * Four providers: Codex (ChatGPT), GitHub, Claude, and Vercel.
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
    label: 'Claude Code',
    blurb: 'Log in with your Claude subscription to run Claude Code in this sprite.',
    monogram: '✳',
    accent: '#D97757',
    needsCodePaste: true,
    waitingHint: 'Authorize in the browser, copy the code it shows, and paste it below.',
  },
  {
    id: 'vercel',
    label: 'Vercel CLI',
    blurb: 'Sign in to deploy and manage Vercel projects from this sprite.',
    monogram: '▲',
    accent: '#171717',
    needsCodePaste: false,
    waitingHint: 'Approve the device on Vercel, then come back — this updates automatically.',
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
 * Vercel writes auth.json under its XDG data directory.
 */
export async function getAccountSignatures(spriteName: string): Promise<AccountSignatures> {
  const command = [
    `sig() { stat -c '%Y:%s:%i' "$1" 2>/dev/null || true; }`,
    `co="$(sig "$HOME/.codex/auth.json")"`,
    `gh_cfg="$(sig "$HOME/.config/gh/hosts.yml")"`,
    `gh_store="$(sig "$HOME/.git-credentials")"`,
    `gh_env=""; grep -qs '^export GH_TOKEN=' "$HOME/.sprite_env" 2>/dev/null && gh_env="$(sig "$HOME/.sprite_env")"`,
    `gh=""; [ -n "$gh_cfg" ] && gh="config:$gh_cfg"; [ -n "$gh_store" ] && gh="\${gh:+$gh|}git:$gh_store"; [ -n "$gh_env" ] && gh="\${gh:+$gh|}env:$gh_env"`,
    `cl_creds="$(sig "$HOME/.claude/.credentials.json")"`,
    `cl_env=""; grep -qs '^export CLAUDE_CODE_OAUTH_TOKEN=' "$HOME/.sprite_env" 2>/dev/null && cl_env="$(sig "$HOME/.sprite_env")"`,
    `cl=""; [ -n "$cl_creds" ] && cl="creds:$cl_creds"; [ -n "$cl_env" ] && cl="\${cl:+$cl|}env:$cl_env"`,
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

const CODE_RE = /\b[A-Z0-9]{4}\s*-\s*[A-Z0-9]{4,7}\b/i;
// Base64url + URL-safe characters, so the trailing spinner glyph Claude glues on
// (e.g. `…state=abc\✢`) is excluded from the captured URL.
const CLAUDE_URL_RE =
  /https:\/\/claude\.com\/cai\/oauth\/authorize\?[A-Za-z0-9%._~:/?#[\]@!$&'()*+,;=-]+/g;
const VERCEL_URL_RE = /https:\/\/(?:www\.)?vercel\.com\/[^\s\x00-\x1f"'<>]+/g;

function trimUrl(url: string | undefined): string | undefined {
  return url?.replace(/[),.;]+$/, '');
}

function deviceCode(text: string): string | undefined {
  const labelled =
    /(?:one-time|device)\s+code(?:\s+\([^)]*\))?\s*:?\s*([A-Z0-9]{4}\s*-\s*[A-Z0-9]{4,7})/i.exec(
      text
    )?.[1];
  const raw = labelled ?? CODE_RE.exec(text)?.[0];
  return raw?.replace(/\s/g, '').toUpperCase();
}

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
      /one-time code:\s*([A-Z0-9]{4}\s*-\s*[A-Z0-9]{4,7})/i.exec(text)?.[1]
        ?.replace(/\s/g, '')
        .toUpperCase() ?? deviceCode(text);
    return { url: 'https://github.com/login/device', code };
  }

  if (id === 'vercel') {
    const urls = text.match(VERCEL_URL_RE) ?? [];
    return {
      url: trimUrl(urls.at(-1)) ?? 'https://vercel.com/login/device',
      code: deviceCode(text),
    };
  }

  // Wait for the code before enabling the browser button. Codex prints the URL
  // first, and opening it early strands the user on a page asking for a code
  // that the app has not surfaced yet.
  const code = deviceCode(text);
  const printedUrl = /https:\/\/auth\.openai\.com\/\S*codex\/device\S*/i.exec(text)?.[0];
  return {
    url: code ? trimUrl(printedUrl) ?? 'https://auth.openai.com/codex/device' : undefined,
    code,
  };
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
      return {
        command:
          `command -v codex >/dev/null || { echo 'Codex CLI is not installed on this sprite.' >&2; exit 127; }; ` +
          'codex login --device-auth',
        tty: true,
        cols: 120,
      };
    case 'github':
      return {
        command:
          `command -v gh >/dev/null || { echo 'GitHub CLI is not installed on this sprite.' >&2; exit 127; }; ` +
          'BROWSER=true gh auth login --hostname github.com --git-protocol https --web ' +
          '--scopes "repo,read:org,gist" --insecure-storage && gh auth setup-git',
        tty: true,
        cols: 120,
      };
    case 'claude':
      // `setup-token` prints (but does not save) the long-lived token. Tee its
      // output so the UI can parse the authorize URL, then persist only the
      // resulting token in the sprite's private environment file.
      return {
        command: [
          `command -v claude >/dev/null || { echo 'Claude Code CLI is not installed on this sprite.' >&2; exit 127; }`,
          `tmp="$(mktemp)"`,
          `trap 'rm -f "$tmp"' EXIT`,
          'set -o pipefail',
          'claude setup-token 2>&1 | tee "$tmp"',
          'status="${PIPESTATUS[0]}"',
          '[ "$status" -eq 0 ] || exit "$status"',
          `token="$(grep -Eo 'sk-ant-oat01-[A-Za-z0-9_-]+' "$tmp" | tail -n 1)"`,
          `[ -n "$token" ] || { echo 'Claude finished without returning an OAuth token.' >&2; exit 1; }`,
          'env_file="$HOME/.sprite_env"',
          'next_env="$(mktemp)"',
          `{ grep -v '^export CLAUDE_CODE_OAUTH_TOKEN=' "$env_file" 2>/dev/null || true; printf "export CLAUDE_CODE_OAUTH_TOKEN='%s'\\n" "$token"; } > "$next_env"`,
          'chmod 600 "$next_env"',
          'mv "$next_env" "$env_file"',
          `grep -qs '^[.] ~/.sprite_env$' "$HOME/.bashrc" 2>/dev/null || printf '\\n. ~/.sprite_env\\n' >> "$HOME/.bashrc"`,
        ].join('; '),
        tty: true,
        cols: 400,
      };
    case 'vercel':
      return {
        command:
          `command -v vercel >/dev/null || { echo 'Vercel CLI is not installed on this sprite. Install it with: npm install -g vercel' >&2; exit 127; }; ` +
          'BROWSER=true vercel login --no-color',
        tty: false,
        cols: 120,
      };
  }
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
  const pendingWrites: ArrayBuffer[] = [];

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
    for (const payload of pendingWrites.splice(0)) socket.send(payload);
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
      const payload = toArrayBuffer(text);
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
      else if (socket.readyState === WebSocket.CONNECTING) pendingWrites.push(payload);
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
