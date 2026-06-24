import { runExec } from './api';
import { loadToken } from './auth';
import { getSetting } from './storage';

/**
 * One-time per-sprite provisioning of credentials.
 *
 * Everything here is written to the sprite filesystem so it persists across
 * chat turns AND the interactive terminal — the secrets are sent to the sprite
 * once (at creation, or lazily on first use) instead of on every chat command.
 *
 * Auth precedence for Claude: a captured browser login (`claudeCreds`, which
 * carries a refresh token) is preferred over the pasted long-lived token
 * (`claudeToken`). Each write is guarded on file existence, so re-running is a
 * cheap no-op and never clobbers an existing credential.
 */

export interface ProvisionInputs {
  gitName?: string | null;
  gitEmail?: string | null;
  githubToken?: string | null;
  claudeToken?: string | null;
  claudeCreds?: string | null;
}

/** Escape a value for safe embedding inside a single-quoted shell string. */
const sq = (v: string) => v.replace(/'/g, "'\\''");

const MARKER = '~/.config/.sprite_provisioned';

export function buildProvisionCommand(i: ProvisionInputs): string {
  const parts: string[] = [];

  if (i.gitName) parts.push(`git config --global user.name '${sq(i.gitName)}'`);
  if (i.gitEmail) parts.push(`git config --global user.email '${sq(i.gitEmail)}'`);

  if (i.githubToken) {
    parts.push(
      `[ -f ~/.git-credentials ] || { git config --global credential.helper store; ` +
        `printf 'https://x-access-token:%s@github.com\\n' '${sq(i.githubToken)}' > ~/.git-credentials && ` +
        `chmod 600 ~/.git-credentials; }`
    );
  }

  if (i.claudeCreds) {
    // Captured `claude login` file — Claude Code reads it directly and refreshes
    // the access token itself via the embedded refresh token.
    parts.push(
      `mkdir -p ~/.claude && { [ -f ~/.claude/.credentials.json ] || ` +
        `{ printf '%s' '${sq(i.claudeCreds)}' > ~/.claude/.credentials.json && ` +
        `chmod 600 ~/.claude/.credentials.json; }; }`
    );
  } else if (i.claudeToken) {
    // Long-lived OAuth token via the documented env var, sourced by chat turns
    // and (through ~/.bashrc) the interactive terminal.
    parts.push(
      `[ -f ~/.sprite_env ] || { printf "export CLAUDE_CODE_OAUTH_TOKEN='%s'\\n" '${sq(i.claudeToken)}' > ~/.sprite_env; ` +
        `chmod 600 ~/.sprite_env; grep -qs sprite_env ~/.bashrc || echo '. ~/.sprite_env' >> ~/.bashrc; }`
    );
  }

  // Completion marker so ensureProvisioned() can detect it cheaply.
  parts.push(`mkdir -p ~/.config && touch ${MARKER}`);

  return parts.join(' && ');
}

export async function loadProvisionInputs(): Promise<ProvisionInputs> {
  const [gitName, gitEmail, githubToken, claudeToken, claudeCreds] = await Promise.all([
    getSetting('gitName'),
    getSetting('gitEmail'),
    loadToken('githubToken'),
    loadToken('claudeToken'),
    loadToken('claudeCreds'),
  ]);
  return { gitName, gitEmail, githubToken, claudeToken, claudeCreds };
}

/** Write all credentials onto a sprite. Idempotent; safe to call repeatedly. */
export async function provisionSprite(spriteName: string): Promise<boolean> {
  const command = buildProvisionCommand(await loadProvisionInputs());
  const { success } = await runExec(spriteName, command, 20);
  return success;
}

/** Provision only if the sprite hasn't been provisioned yet (cheap marker check). */
export async function ensureProvisioned(spriteName: string): Promise<void> {
  const check = await runExec(spriteName, `[ -f ${MARKER} ] && echo PROVISIONED || true`, 10);
  if (check.output.includes('PROVISIONED')) return;
  await provisionSprite(spriteName);
}

const provisionedThisSession = new Set<string>();

/**
 * ensureProvisioned, deduplicated per app session: the first call for a sprite
 * does the marker-check/provision round-trip, later calls return instantly.
 * Never throws — a failure (e.g. sprite still waking) just clears the dedupe so
 * the next call retries.
 */
export async function ensureProvisionedOnce(spriteName: string): Promise<void> {
  if (provisionedThisSession.has(spriteName)) return;
  provisionedThisSession.add(spriteName);
  try {
    await ensureProvisioned(spriteName);
  } catch {
    provisionedThisSession.delete(spriteName);
  }
}

/**
 * Read a completed `claude login` credentials file back off a sprite and return
 * the validated JSON, so the caller can store it and replay it onto every
 * future sprite. Throws with a user-facing message if login isn't done yet.
 */
export async function captureClaudeCreds(spriteName: string): Promise<string> {
  const { output } = await runExec(
    spriteName,
    'cat ~/.claude/.credentials.json 2>/dev/null || true',
    10
  );
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error('No credentials found. Run `claude` in the terminal and finish the browser login first.');
  }
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('Could not parse the credentials file from the sprite.');
  }
  const hasToken =
    parsed?.claudeAiOauth?.accessToken ?? parsed?.accessToken ?? parsed?.access_token;
  if (!hasToken) {
    throw new Error('Credentials file has no access token yet — finish the login and retry.');
  }
  return trimmed;
}
