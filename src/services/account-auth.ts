import { Platform } from 'react-native';
import { GITHUB_CLIENT_ID, GITHUB_DEVICE_SCOPE } from '@/constants/github';
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
 * Five providers: Codex (ChatGPT), GitHub, Claude, Vercel, and pi (API key).
 */

export type ProviderId = 'codex' | 'github' | 'claude' | 'vercel' | 'pi';

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
  {
    id: 'pi',
    label: 'Pi',
    blurb: 'Connect a model provider API key so the pi coding agent can run in this sprite.',
    monogram: 'π',
    accent: '#7C3AED',
    needsCodePaste: false,
    waitingHint: '',
  },
];

export function providerMeta(id: ProviderId): ProviderMeta {
  const meta = PROVIDERS.find((p) => p.id === id);
  if (!meta) throw new Error(`Unknown provider: ${id}`);
  return meta;
}

// ── Detection ───────────────────────────────────────────────────────────────

export type AccountSignatures = Record<ProviderId, string>;

const EMPTY_SIGS: AccountSignatures = { codex: '', github: '', claude: '', vercel: '', pi: '' };

/** pi provider env vars whose presence in ~/.sprite_env authenticates pi. */
export const PI_API_KEY_PROVIDERS: { label: string; envVar: string }[] = [
  { label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { label: 'OpenAI', envVar: 'OPENAI_API_KEY' },
  { label: 'Google Gemini', envVar: 'GEMINI_API_KEY' },
  { label: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY' },
  { label: 'xAI', envVar: 'XAI_API_KEY' },
  { label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY' },
  { label: 'Groq', envVar: 'GROQ_API_KEY' },
  { label: 'Mistral', envVar: 'MISTRAL_API_KEY' },
  { label: 'Z.AI', envVar: 'ZAI_API_KEY' },
];

const PI_ENV_VARS_PATTERN = PI_API_KEY_PROVIDERS.map((p) => p.envVar).join('|');

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
    `pi_auth="$(sig "$HOME/.pi/agent/auth.json")"`,
    `pi_env=""; grep -qsE '^export (${PI_ENV_VARS_PATTERN})=' "$HOME/.sprite_env" 2>/dev/null && pi_env="$(sig "$HOME/.sprite_env")"`,
    `pi=""; [ -n "$pi_auth" ] && pi="auth:$pi_auth"; [ -n "$pi_env" ] && pi="\${pi:+$pi|}env:$pi_env"`,
    `echo "codex=$co"; echo "github=$gh"; echo "claude=$cl"; echo "vercel=$vc"; echo "pi=$pi"`,
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
    pi: read('pi'),
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
    pi: !!sigs.pi,
  };
}

// ── Output parsing ────────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][0-9;]*[^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][0-9A-Za-z]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '');
}

const CLAUDE_OAUTH_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]+/;

export function containsClaudeOAuthToken(input: string): boolean {
  return CLAUDE_OAUTH_TOKEN_RE.test(stripAnsi(input));
}

export function sanitizedLoginOutput(input: string, secrets: string[] = []): string {
  let text = stripAnsi(input);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[submitted code]');
  }
  const lines = text
    .replace(/sk-ant-[A-Za-z0-9_-]+/gi, '[redacted token]')
    .replace(/https?:\/\/[^\s\x00-\x1f"'<>]+/gi, '[authorization URL]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted value]')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index, all) => index === 0 || line !== all[index - 1]);
  return lines.slice(-16).join('\n');
}

export interface LoginPrompt {
  /** URL the user should open to authorize. */
  url?: string;
  /** One-time code to enter on the provider's page (Codex, GitHub). */
  code?: string;
}

const CODE_RE =
  /\b([A-Z0-9](?:\s*[A-Z0-9]){3})\s*-\s*([A-Z0-9](?:\s*[A-Z0-9]){3,6})\b/i;
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
    /(?:one-time|device)\s+code(?:\s+\([^)]*\))?\s*:?\s*([A-Z0-9](?:\s*[A-Z0-9]){3}\s*-\s*[A-Z0-9](?:\s*[A-Z0-9]){3,6})/i.exec(
      text
    )?.[1];
  const match = CODE_RE.exec(text);
  const raw = labelled ?? (match ? `${match[1]}-${match[2]}` : undefined);
  return raw?.replace(/\s/g, '').toUpperCase();
}

/**
 * Parse the accumulated (raw, ANSI-included) login output for the current
 * provider and return whatever verification prompt is available so far.
 */
export function parseLoginPrompt(id: ProviderId, raw: string): LoginPrompt {
  const text = stripAnsi(raw);

  if (id === 'pi') {
    // pi connects via an API key flow, not an interactive TTY login.
    return {};
  }

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
      /one-time code:\s*([A-Z0-9](?:\s*[A-Z0-9]){3}\s*-\s*[A-Z0-9](?:\s*[A-Z0-9]){3,6})/i
        .exec(text)?.[1]
        ?.replace(/\s/g, '')
        .toUpperCase() ?? deviceCode(text);
    // Do not advance to the browser step until the code is actually visible.
    return { url: code ? 'https://github.com/login/device' : undefined, code };
  }

  if (id === 'vercel') {
    const urls = text.match(VERCEL_URL_RE) ?? [];
    return {
      url: trimUrl(urls.at(-1)),
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildGithubDeviceScript(): string {
  return [
    `const fs = require("fs")`,
    `const os = require("os")`,
    `const path = require("path")`,
    `const { spawnSync } = require("child_process")`,
    `const clientId = ${JSON.stringify(GITHUB_CLIENT_ID)}`,
    `const scope = ${JSON.stringify(GITHUB_DEVICE_SCOPE)}`,
    `const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))`,
    `async function post(url, body) {`,
    `  const response = await fetch(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) })`,
    `  const data = await response.json()`,
    `  if (!response.ok) throw new Error(data.error_description || data.error || "GitHub request failed")`,
    `  return data`,
    `}`,
    `function read(file) { try { return fs.readFileSync(file, "utf8") } catch { return "" } }`,
    `function writePrivate(file, contents) {`,
    `  fs.mkdirSync(path.dirname(file), { recursive: true })`,
    `  const temp = file + ".coderoamer-" + process.pid`,
    `  fs.writeFileSync(temp, contents, { mode: 0o600 })`,
    `  fs.renameSync(temp, file)`,
    `}`,
    `async function main() {`,
    `  const device = await post("https://github.com/login/device/code", { client_id: clientId, scope })`,
    `  console.log("First copy your one-time code: " + device.user_code)`,
    `  console.log("Open " + device.verification_uri + " in your browser")`,
    `  let interval = Number(device.interval || 5)`,
    `  const deadline = Date.now() + Number(device.expires_in || 900) * 1000`,
    `  while (Date.now() < deadline) {`,
    `    await sleep(interval * 1000)`,
    `    const result = await post("https://github.com/login/oauth/access_token", { client_id: clientId, device_code: device.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" })`,
    `    if (result.access_token) {`,
    `      const token = String(result.access_token)`,
    `      if (!/^(?:gho_|ghu_|ghp_|github_pat_)[A-Za-z0-9_]+$/.test(token)) throw new Error("GitHub returned an unsupported token")`,
    `      const home = os.homedir()`,
    `      const envFile = path.join(home, ".sprite_env")`,
    `      const envLines = read(envFile).split("\\n").filter((line) => line && !line.startsWith("export GH_TOKEN="))`,
    `      envLines.push("export GH_TOKEN='" + token + "'")`,
    `      writePrivate(envFile, envLines.join("\\n") + "\\n")`,
    `      const credsFile = path.join(home, ".git-credentials")`,
    `      const credLines = read(credsFile).split("\\n").filter((line) => line && !/^https:\\/\\/[^@]*@github\\.com\\/?$/.test(line))`,
    `      credLines.push("https://x-access-token:" + token + "@github.com")`,
    `      writePrivate(credsFile, credLines.join("\\n") + "\\n")`,
    `      const git = spawnSync("git", ["config", "--global", "credential.helper", "store"], { stdio: "ignore" })`,
    `      if (git.status !== 0) throw new Error("Could not configure Git credentials")`,
    `      const modeFile = path.join(home, ".config", "coderoamer", "github-auth-mode")`,
    `      writePrivate(modeFile, "oauth\\n")`,
    `      console.log("@@WISP_GITHUB_CONNECTED@@")`,
    `      return`,
    `    }`,
    `    if (result.error === "authorization_pending") continue`,
    `    if (result.error === "slow_down") { interval = Number(result.interval || interval) + 1; continue }`,
    `    if (result.error === "expired_token") throw new Error("GitHub device code expired")`,
    `    if (result.error === "access_denied") throw new Error("GitHub access was denied")`,
    `    if (result.error) throw new Error(result.error_description || result.error)`,
    `  }`,
    `  throw new Error("GitHub device code expired")`,
    `}`,
    `main().catch((error) => { console.error("@@WISP_GITHUB_ERROR@@" + String(error && error.message || error)); process.exit(1) })`,
  ].join('\n');
}

export function buildGithubDeviceCommand(): string {
  return `node -e ${shellQuote(buildGithubDeviceScript())}`;
}

export function buildVercelLoginCommand(): string {
  return [
    `if command -v vercel >/dev/null; then BROWSER=true vercel login --no-color`,
    `else runner=''`,
    `if command -v pnpm >/dev/null && { echo 'Starting Vercel CLI with pnpm…'; BROWSER=true pnpm dlx vercel@latest login --no-color; }; then runner='pnpm dlx vercel@latest'`,
    `elif command -v bunx >/dev/null && { echo 'Starting Vercel CLI with bunx…'; BROWSER=true bunx vercel@latest login --no-color; }; then runner='bunx vercel@latest'`,
    `elif command -v npx >/dev/null && { echo 'Starting Vercel CLI with npx…'; BROWSER=true npx --yes vercel@latest login --no-color; }; then runner='npx --yes vercel@latest'`,
    `else echo 'All available Vercel CLI launch methods failed.' >&2; exit 1`,
    `fi`,
    `[ -n "$runner" ] || exit 1`,
    `mkdir -p "$HOME/.local/bin"`,
    `printf '#!/bin/sh\nexec %s "$@"\n' "$runner" > "$HOME/.local/bin/vercel"`,
    `chmod 700 "$HOME/.local/bin/vercel"`,
    `env_file="$HOME/.sprite_env"`,
    `touch "$env_file"`,
    `grep -qs 'HOME/.local/bin' "$env_file" || printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$env_file"`,
    `fi`,
  ].join('; ');
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
        command: buildGithubDeviceCommand(),
        tty: false,
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
        command: buildVercelLoginCommand(),
        tty: false,
        cols: 120,
      };
    case 'pi':
      // pi has no headless login CLI; the Connect sheet uses the API-key flow
      // (connectPiWithApiKey) instead of this interactive spec.
      throw new Error('pi connects with a provider API key, not an interactive login');
  }
}

// ── GitHub personal access token path ────────────────────────────────────────

export type GithubTokenType = 'fine-grained' | 'classic' | 'oauth' | 'unknown';

export interface GithubAccessSummary {
  login?: string;
  tokenType: GithubTokenType | 'cli';
  repos: string[];
  repoCount: number;
  allRepos: boolean;
}

export function githubTokenType(token: string): GithubTokenType {
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (token.startsWith('ghp_')) return 'classic';
  if (token.startsWith('gho_') || token.startsWith('ghu_')) return 'oauth';
  return 'unknown';
}

export function isGithubToken(token: string): boolean {
  return /^(?:github_pat_|ghp_|gho_|ghu_)[A-Za-z0-9_]+$/.test(token);
}

function githubPatCommand(install: boolean): string {
  return [
    `command -v gh >/dev/null || { echo '@@WISP_GITHUB_ERROR@@GitHub CLI is not installed on this sprite.'; exit 127; }`,
    `IFS= read -r token`,
    `[ -n "$token" ] || { echo '@@WISP_GITHUB_ERROR@@No token received.'; exit 2; }`,
    `case "$token" in *[!A-Za-z0-9_]* ) echo '@@WISP_GITHUB_ERROR@@Invalid token format.'; exit 2 ;; esac`,
    `case "$token" in github_pat_* ) mode=fine-grained ;; ghp_* ) mode=classic ;; gho_*|ghu_* ) mode=oauth ;; * ) echo '@@WISP_GITHUB_ERROR@@Unsupported GitHub token.'; exit 2 ;; esac`,
    `login="$(GH_TOKEN="$token" gh api user --jq .login 2>/dev/null)" || { echo '@@WISP_GITHUB_ERROR@@GitHub rejected this token. Check its expiry and permissions.'; exit 3; }`,
    `repo_file="$(mktemp)"`,
    `next_env="$(mktemp)"`,
    `next_creds="$(mktemp)"`,
    `trap 'rm -f "$repo_file" "$next_env" "$next_creds"' EXIT`,
    `GH_TOKEN="$token" gh api --paginate 'user/repos?per_page=100&affiliation=owner,collaborator,organization_member' --jq '.[].full_name' 2>/dev/null | sort -u > "$repo_file" || true`,
    ...(install
      ? [
          `env_file="$HOME/.sprite_env"`,
          `{ grep -v '^export GH_TOKEN=' "$env_file" 2>/dev/null || true; printf "export GH_TOKEN='%s'\\n" "$token"; } > "$next_env"`,
          `chmod 600 "$next_env"`,
          `mv "$next_env" "$env_file"`,
          `grep -qs '^[.] ~/.sprite_env$' "$HOME/.bashrc" 2>/dev/null || printf '\\n. ~/.sprite_env\\n' >> "$HOME/.bashrc"`,
          `creds_file="$HOME/.git-credentials"`,
          `{ grep -vE '^https://[^@]*@github\\.com/?$' "$creds_file" 2>/dev/null || true; printf 'https://x-access-token:%s@github.com\\n' "$token"; } > "$next_creds"`,
          `chmod 600 "$next_creds"`,
          `mv "$next_creds" "$creds_file"`,
          `git config --global credential.helper store`,
          `mkdir -p "$HOME/.config/coderoamer"`,
          `printf '%s\\n' "$mode" > "$HOME/.config/coderoamer/github-auth-mode"`,
        ]
      : []),
    `printf '@@WISP_GITHUB@@\\nlogin=%s\\nmode=%s\\n' "$login" "$mode"`,
    `printf 'repo_count=%s\\n' "$(wc -l < "$repo_file" | tr -d ' ')"`,
    `sed 's/^/repo=/' "$repo_file"`,
    `printf '@@WISP_GITHUB_END@@\\n'`,
  ].join('; ');
}

export function parseGithubAccessSummary(output: string): GithubAccessSummary | undefined {
  const block = /@@WISP_GITHUB@@\s*([\s\S]*?)@@WISP_GITHUB_END@@/.exec(output)?.[1];
  if (!block) return undefined;
  const value = (key: string) =>
    new RegExp(`^${key}=(.*)$`, 'm').exec(block)?.[1]?.trim();
  const mode = value('mode');
  const tokenType: GithubAccessSummary['tokenType'] =
    mode === 'fine-grained' || mode === 'classic' || mode === 'oauth' || mode === 'cli'
      ? mode
      : 'unknown';
  const repos = Array.from(block.matchAll(/^repo=(.+)$/gm), (match) => match[1].trim()).filter(
    (repo) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
  );
  const parsedCount = Number(value('repo_count'));
  const repoCount = Number.isFinite(parsedCount) ? parsedCount : repos.length;
  return {
    login: value('login'),
    tokenType,
    repos,
    repoCount,
    allRepos: tokenType === 'cli' || tokenType === 'classic' || tokenType === 'oauth',
  };
}

function githubCommandError(output: string): string {
  const explicit = /@@WISP_GITHUB_ERROR@@([^\r\n]+)/.exec(output)?.[1]?.trim();
  if (explicit) return explicit;
  const tail = stripAnsi(output)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join('\n');
  return tail || 'Could not connect GitHub on this sprite.';
}

/**
 * Validate and install a pasted token entirely on the sprite. The secret is
 * written to exec stdin after the WebSocket opens; it never appears in an exec
 * URL, shell command, app log, or Sprites task metadata.
 */
async function runGithubTokenCommand(
  spriteName: string,
  token: string,
  install: boolean
): Promise<GithubAccessSummary> {
  const trimmed = token.trim();
  if (!isGithubToken(trimmed)) {
    throw new Error('Paste a GitHub fine-grained or classic personal access token.');
  }

  return new Promise<GithubAccessSummary>(async (resolve, reject) => {
    let output = '';
    let settled = false;
    let stream: LoginStream | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream?.close();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('GitHub token validation timed out.')));
    }, 90_000);

    try {
      stream = await startCommandStream(
        spriteName,
        install ? 'github-pat-install' : 'github-pat-inspect',
        { command: githubPatCommand(install), tty: false, cols: 120 },
        {
          onData: (chunk) => {
            output += chunk;
          },
          onExit: (code) => {
            const summary = parseGithubAccessSummary(output);
            if (code === 0 && summary) finish(() => resolve(summary));
            else finish(() => reject(new Error(githubCommandError(output))));
          },
          onError: (message) => {
            if (!output) output = message;
          },
          onClose: () => {
            setTimeout(() => {
              if (!settled) finish(() => reject(new Error(githubCommandError(output))));
            }, 250);
          },
        }
      );
      stream.send(`${trimmed}\n`);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

export async function inspectGithubPat(
  spriteName: string,
  token: string
): Promise<GithubAccessSummary> {
  return runGithubTokenCommand(spriteName, token, false);
}

export async function connectGithubWithPat(
  spriteName: string,
  token: string
): Promise<GithubAccessSummary> {
  return runGithubTokenCommand(spriteName, token, true);
}

/** Inspect the GitHub credential already installed on a sprite. */
export async function getGithubAccessSummary(
  spriteName: string
): Promise<GithubAccessSummary | undefined> {
  const command = [
    `. "$HOME/.sprite_env" 2>/dev/null || true`,
    `command -v gh >/dev/null || exit 0`,
    `login="$(gh api user --jq .login 2>/dev/null)" || exit 0`,
    `mode="$(cat "$HOME/.config/coderoamer/github-auth-mode" 2>/dev/null || true)"`,
    `if [ -z "$mode" ]; then token="$(gh auth token 2>/dev/null || true)"; case "$token" in github_pat_* ) mode=fine-grained ;; ghp_* ) mode=classic ;; gho_*|ghu_* ) mode=oauth ;; * ) mode=cli ;; esac; unset token; fi`,
    `repo_file="$(mktemp)"`,
    `trap 'rm -f "$repo_file"' EXIT`,
    `if [ "$mode" = fine-grained ]; then gh api --paginate 'user/repos?per_page=100&affiliation=owner,collaborator,organization_member' --jq '.[].full_name' 2>/dev/null | sort -u > "$repo_file" || true; fi`,
    `printf '@@WISP_GITHUB@@\\nlogin=%s\\nmode=%s\\n' "$login" "$mode"`,
    `printf 'repo_count=%s\\n' "$(wc -l < "$repo_file" | tr -d ' ')"`,
    `sed 's/^/repo=/' "$repo_file"`,
    `printf '@@WISP_GITHUB_END@@\\n'`,
  ].join('; ');
  const { output } = await runExec(spriteName, command, 45);
  return parseGithubAccessSummary(output);
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

export function makeLoginStdinFrame(text: string): Uint8Array {
  const payload = new Uint8Array(toArrayBuffer(text));
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = 0;
  frame.set(payload, 1);
  return frame;
}

export function makeLoginStdinPayload(text: string, tty: boolean): Uint8Array {
  return tty ? new Uint8Array(toArrayBuffer(text)) : makeLoginStdinFrame(text);
}

export interface ExecControlEvent {
  type: 'session_info' | 'exit';
  exitCode?: number;
  sessionId?: string;
  cols?: number;
  rows?: number;
}

export interface LoginOutputFrame {
  streamId: 1 | 2 | 3;
  payload: Uint8Array;
  rawTty: boolean;
}

export function decodeLoginOutputFrame(
  bytes: Uint8Array,
  tty: boolean
): LoginOutputFrame | undefined {
  if (bytes.length === 0) return undefined;
  const streamId = bytes[0];
  if (streamId === 1 || streamId === 2 || streamId === 3) {
    return { streamId, payload: bytes.subarray(1), rawTty: false };
  }
  // Sprites sends PTY output as raw terminal bytes rather than multiplexing it
  // behind a stream-id byte. A leading 13 here is simply a carriage return.
  if (tty) return { streamId: 1, payload: bytes, rawTty: true };
  return undefined;
}

export function parseExecControlEvent(text: string): ExecControlEvent | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.type === 'session_info') {
      return {
        type: 'session_info',
        sessionId: typeof value.session_id === 'string' ? value.session_id : undefined,
        cols: typeof value.cols === 'number' ? value.cols : undefined,
        rows: typeof value.rows === 'number' ? value.rows : undefined,
      };
    }
    if (value.type === 'exit') {
      const rawCode = value.exit_code ?? value.exitCode;
      return { type: 'exit', exitCode: typeof rawCode === 'number' ? rawCode : 0 };
    }
  } catch {
    // Provider output is normally not JSON.
  }
  return undefined;
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
async function startCommandStream(
  spriteName: string,
  flow: string,
  spec: ProviderLoginSpec,
  handlers: LoginStreamHandlers
): Promise<LoginStream> {
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
  params.set('max_run_after_disconnect', '900s');
  if (Platform.OS === 'web') params.set('token', token);

  const url = `${WS_BASE}/sprites/${encodeURIComponent(spriteName)}/exec?${params.toString()}`;
  const pendingWrites: Uint8Array[] = [];
  let sawExit = false;
  let failureReported = false;

  const debug = (event: string, details?: Record<string, unknown>) => {
    if (!__DEV__) return;
    // Never include the command, URL query, provider output, or credential values.
    console.info(`[integration:${flow}] ${event}`, details ?? '');
  };

  debug('socket.create', {
    spriteName,
    platform: Platform.OS,
    tty: spec.tty,
    cols,
    rows,
  });

  let socket: WebSocket;
  if (Platform.OS === 'web') {
    socket = new WebSocket(url);
  } else {
    const RNWebSocket = WebSocket as unknown as RNWebSocketCtor;
    socket = new RNWebSocket(url, undefined, { headers: { Authorization: `Bearer ${token}` } });
  }
  socket.binaryType = 'arraybuffer';

  const sendResize = () => {
    if (spec.tty && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols, rows }));
      debug('resize.send', { cols, rows });
    }
  };

  const reportError = (message: string) => {
    if (failureReported) return;
    failureReported = true;
    debug('socket.failure', { message });
    handlers.onError?.(message);
  };

  const openTimer = setTimeout(() => {
    debug('socket.open-timeout');
    reportError('Timed out connecting to the sprite login session.');
    socket.close();
  }, 15_000);

  // Explicitly resize once open: Claude's TUI wraps the authorize URL at the
  // terminal width, so we must guarantee a wide PTY even if the exec endpoint
  // ignores the cols/rows query params.
  socket.onopen = () => {
    clearTimeout(openTimer);
    debug('socket.open', { queuedWrites: pendingWrites.length });
    sendResize();
    for (const payload of pendingWrites.splice(0)) socket.send(payload);
  };

  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();

  const handleBytes = (bytes: Uint8Array) => {
    const frame = decodeLoginOutputFrame(bytes, spec.tty);
    if (!frame) {
      debug('frame.binary-unknown', { firstByte: bytes[0], bytes: bytes.byteLength });
      return;
    }
    const { streamId, payload, rawTty } = frame;
    debug(rawTty ? 'frame.raw-tty' : 'frame.binary', {
      streamId,
      payloadBytes: payload.byteLength,
    });
    if (streamId === 1) {
      const text = stdoutDecoder.decode(payload, { stream: true });
      if (text) handlers.onData(text);
    } else if (streamId === 2) {
      const text = stderrDecoder.decode(payload, { stream: true });
      if (text) handlers.onData(text);
    } else if (streamId === 3) {
      const code = payload.length ? Number(new TextDecoder().decode(payload).trim()) || 0 : 0;
      sawExit = true;
      handlers.onExit?.(code);
      socket.close();
    }
  };

  socket.onmessage = async (event) => {
    try {
      if (typeof event.data === 'string') {
        const control = parseExecControlEvent(event.data);
        if (control?.type === 'session_info') {
          debug('control.session_info', {
            sessionId: control.sessionId,
            reportedCols: control.cols,
            reportedRows: control.rows,
          });
          // On web, the browser-facing proxy socket can open before its upstream
          // connection. Resize again only after Sprites confirms the exec session.
          sendResize();
          return;
        }
        if (control?.type === 'exit') {
          debug('control.exit', { exitCode: control.exitCode ?? 0 });
          sawExit = true;
          handlers.onExit?.(control.exitCode ?? 0);
          socket.close();
          return;
        }
        // Some runtimes deliver binary frames as latin1 strings.
        const first = event.data.charCodeAt(0);
        if (first >= 0 && first <= 3) {
          handleBytes(Uint8Array.from(Array.from(event.data, (ch) => ch.charCodeAt(0) & 0xff)));
        } else {
          debug('frame.text-output', { bytes: event.data.length });
          handlers.onData(event.data);
        }
        return;
      }
      const bytes = await messageToBytes(event.data);
      if (bytes) handleBytes(bytes);
    } catch (err) {
      reportError((err as Error).message);
    }
  };

  socket.onerror = () => reportError('Could not connect to the sprite login session.');
  socket.onclose = () => {
    clearTimeout(openTimer);
    debug('socket.close', { sawExit, failureReported });
    if (!sawExit) reportError('The sprite login connection closed unexpectedly.');
    handlers.onClose?.();
  };

  return {
    send: (text: string) => {
      const payload = makeLoginStdinPayload(text, spec.tty);
      debug('stdin.write', {
        payloadBytes: payload.byteLength - (spec.tty ? 0 : 1),
        framed: !spec.tty,
        readyState: socket.readyState,
      });
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
      else if (socket.readyState === WebSocket.CONNECTING) pendingWrites.push(payload);
    },
    cancel: () => {
      debug('stdin.cancel', { readyState: socket.readyState });
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(makeLoginStdinPayload('\u0003', spec.tty));
      }
    },
    close: () => {
      debug('socket.close-request', { readyState: socket.readyState });
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    },
  };
}

export async function startLogin(
  spriteName: string,
  id: ProviderId,
  handlers: LoginStreamHandlers
): Promise<LoginStream> {
  return startCommandStream(spriteName, id, loginSpec(id), handlers);
}

// ── pi API-key connection ─────────────────────────────────────────────────────

const PI_ENV_VAR_RE = /^[A-Z][A-Z0-9_]*_API_KEY$/;

function piApiKeyCommand(envVar: string): string {
  return [
    `IFS= read -r key`,
    `[ -n "$key" ] || { echo '@@WISP_PI_ERROR@@No key received.'; exit 2; }`,
    `case "$key" in *[!A-Za-z0-9_.:+/=~-]* ) echo '@@WISP_PI_ERROR@@Invalid key format.'; exit 2 ;; esac`,
    `env_file="$HOME/.sprite_env"`,
    `next_env="$(mktemp)"`,
    `{ grep -v "^export ${envVar}=" "$env_file" 2>/dev/null || true; printf "export ${envVar}='%s'\\n" "$key"; } > "$next_env"`,
    `chmod 600 "$next_env"`,
    `mv "$next_env" "$env_file"`,
    `grep -qs '^[.] ~/.sprite_env$' "$HOME/.bashrc" 2>/dev/null || printf '\\n. ~/.sprite_env\\n' >> "$HOME/.bashrc"`,
    `printf '@@WISP_PI_CONNECTED@@\\n'`,
  ].join('; ');
}

function piConnectError(output: string): string {
  const explicit = /@@WISP_PI_ERROR@@([^\r\n]+)/.exec(output)?.[1]?.trim();
  if (explicit) return explicit;
  return 'Could not save the API key on this sprite.';
}

/**
 * Install a model-provider API key for pi on a sprite. The key is written to
 * exec stdin after the WebSocket opens — it never appears in an exec URL,
 * shell command, app log, or Sprites task metadata. Chat turns already source
 * ~/.sprite_env, so the next `pi` run picks the key up automatically.
 */
export async function connectPiWithApiKey(
  spriteName: string,
  envVar: string,
  apiKey: string
): Promise<void> {
  const trimmed = apiKey.trim();
  if (!PI_ENV_VAR_RE.test(envVar)) {
    throw new Error('Unsupported provider environment variable.');
  }
  if (!trimmed || /[\s'"]/.test(trimmed)) {
    throw new Error('Paste the API key exactly as your provider shows it.');
  }

  return new Promise<void>(async (resolve, reject) => {
    let output = '';
    let settled = false;
    let stream: LoginStream | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream?.close();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('Saving the API key timed out.')));
    }, 30_000);

    try {
      stream = await startCommandStream(
        spriteName,
        'pi-api-key',
        { command: piApiKeyCommand(envVar), tty: false, cols: 120 },
        {
          onData: (chunk) => {
            output += chunk;
          },
          onExit: (code) => {
            if (code === 0 && output.includes('@@WISP_PI_CONNECTED@@')) {
              finish(() => resolve());
            } else {
              finish(() => reject(new Error(piConnectError(output))));
            }
          },
          onError: (message) => {
            if (!output) output = message;
          },
          onClose: () => {
            setTimeout(() => {
              if (!settled) finish(() => reject(new Error(piConnectError(output))));
            }, 250);
          },
        }
      );
      stream.send(`${trimmed}\n`);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
