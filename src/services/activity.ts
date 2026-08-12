import { AgentProvider, RemoteAgentSession } from '@/models/chat';
import { Sprite } from '@/models/sprite';
import { ClaudeSessionSummary, listClaudeSessions } from './claude-sessions';
import { CodexSessionSummary, listCodexSessions } from './codex-sessions';

export const DEFAULT_ACTIVITY_SCAN_CONCURRENCY = 3;

export type ActivityScanProvider = 'claude' | 'codex';

export interface GlobalAgentSession extends RemoteAgentSession {
  spriteName: string;
  spriteStatus: Sprite['status'];
}

export interface ActivityScanError {
  provider: ActivityScanProvider;
  message: string;
}

export interface SpriteActivityResult {
  sprite: Sprite;
  sessions: GlobalAgentSession[];
  errors: ActivityScanError[];
}

export interface ActivitySessionLoaders {
  listClaudeSessions: (spriteName: string) => Promise<ClaudeSessionSummary[]>;
  listCodexSessions: (spriteName: string) => Promise<CodexSessionSummary[]>;
}

interface ScanAllOptions {
  concurrency?: number;
  loaders?: ActivitySessionLoaders;
  onResult?: (result: SpriteActivityResult, completed: number, total: number) => void;
}

const DEFAULT_LOADERS: ActivitySessionLoaders = {
  listClaudeSessions,
  listCodexSessions,
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Session scan failed';
}

function withSprite(
  sprite: Sprite,
  provider: AgentProvider,
  sessions: (ClaudeSessionSummary | CodexSessionSummary)[]
): GlobalAgentSession[] {
  return sessions.map((session) => ({
    ...session,
    provider,
    spriteName: sprite.name,
    spriteStatus: sprite.status,
  }));
}

/** Scan both native transcript stores on one Sprite in parallel. */
export async function scanSpriteActivity(
  sprite: Sprite,
  loaders: ActivitySessionLoaders = DEFAULT_LOADERS
): Promise<SpriteActivityResult> {
  const [claudeResult, codexResult] = await Promise.allSettled([
    loaders.listClaudeSessions(sprite.name),
    loaders.listCodexSessions(sprite.name),
  ]);

  const sessions: GlobalAgentSession[] = [];
  const errors: ActivityScanError[] = [];

  if (claudeResult.status === 'fulfilled') {
    sessions.push(...withSprite(sprite, 'claude', claudeResult.value));
  } else {
    errors.push({ provider: 'claude', message: errorMessage(claudeResult.reason) });
  }

  if (codexResult.status === 'fulfilled') {
    sessions.push(...withSprite(sprite, 'codex', codexResult.value));
  } else {
    errors.push({ provider: 'codex', message: errorMessage(codexResult.reason) });
  }

  return { sprite, sessions: sortActivitySessions(sessions), errors };
}

/**
 * Fan out across Sprites without waking every environment at once. Results are
 * reported as soon as each Sprite finishes, while the returned array retains
 * the input Sprite order for deterministic callers and tests.
 */
export async function scanAllSpriteActivity(
  sprites: Sprite[],
  options: ScanAllOptions = {}
): Promise<SpriteActivityResult[]> {
  if (sprites.length === 0) return [];

  const requestedConcurrency = Math.floor(
    options.concurrency ?? DEFAULT_ACTIVITY_SCAN_CONCURRENCY
  );
  const concurrency = Math.min(sprites.length, Math.max(1, requestedConcurrency));
  const results = new Array<SpriteActivityResult>(sprites.length);
  let cursor = 0;
  let completed = 0;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= sprites.length) return;

      const result = await scanSpriteActivity(sprites[index], options.loaders ?? DEFAULT_LOADERS);
      results[index] = result;
      completed += 1;
      options.onResult?.(result, completed, sprites.length);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

export function sortActivitySessions(
  sessions: GlobalAgentSession[]
): GlobalAgentSession[] {
  return [...sessions].sort(
    (left, right) =>
      Number(right.live) - Number(left.live) ||
      right.modified - left.modified ||
      left.spriteName.localeCompare(right.spriteName) ||
      left.provider.localeCompare(right.provider) ||
      left.id.localeCompare(right.id)
  );
}
