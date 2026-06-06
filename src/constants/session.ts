/**
 * Shared session defaults.
 *
 * Sprites run as the `sprite` user, so `/home/sprite` is the home directory.
 * The working directory is where Claude Code is launched (`cd <dir>`) and is
 * also what Claude uses to key its resumable session history
 * (`~/.claude/projects/<hashed-cwd>/`). Resuming a session therefore requires
 * launching from the *same* directory it was started in — which is why the
 * working directory is stored per chat and locked once a conversation begins.
 */
export const DEFAULT_WORKING_DIRECTORY = '/home/sprite/project';

/** Normalize a user-entered path: trim, drop trailing slashes (but keep root "/"). */
export function normalizeWorkingDirectory(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_WORKING_DIRECTORY;
  if (trimmed === '/') return '/';
  return trimmed.replace(/\/+$/, '');
}

/** A short, display-friendly version of a path (keeps the last two segments). */
export function shortWorkingDirectory(dir: string): string {
  const normalized = normalizeWorkingDirectory(dir);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length <= 2) return normalized;
  return `.../${segments.slice(-2).join('/')}`;
}
