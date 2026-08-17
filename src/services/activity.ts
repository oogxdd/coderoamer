import { RemoteAgentSession } from '@/models/chat';
import { Sprite, SpriteStatus } from '@/models/sprite';
import { scanClaudeSessions } from './claude-sessions';
import { scanCodexSessions } from './codex-sessions';
import { SessionScanResult } from './session-scan';

export const DEFAULT_ACTIVITY_SCAN_CONCURRENCY = 3;

export type ActivityScanProvider = 'claude' | 'codex';

export const ACTIVITY_SCAN_PROVIDERS: ActivityScanProvider[] = ['claude', 'codex'];

/**
 * Where a row came from. `scan` rows were read off a sprite's transcript store;
 * `local` rows were recorded by this app when it started the turn itself, so
 * they appear the instant an agent is launched — before any scan has run.
 */
export type ActivityOrigin = 'scan' | 'local';

export interface GlobalAgentSession extends RemoteAgentSession {
  spriteName: string;
  spriteStatus: SpriteStatus;
  origin?: ActivityOrigin;
}

export interface ActivityScanError {
  provider: ActivityScanProvider;
  message: string;
}

/** Per-provider scan cursor for one Sprite (see `session-scan.ts`). */
export type ActivityCursors = Partial<Record<ActivityScanProvider, number>>;

export interface SpriteActivityResult {
  sprite: Sprite;
  /** The merged, authoritative row set for this Sprite after the scan. */
  sessions: GlobalAgentSession[];
  errors: ActivityScanError[];
  /** New cursors — only for providers whose scan actually succeeded. */
  cursors: ActivityCursors;
}

export interface ActivitySessionLoaders {
  scanClaudeSessions: (spriteName: string, since: number) => Promise<SessionScanResult>;
  scanCodexSessions: (spriteName: string, since: number) => Promise<SessionScanResult>;
}

export interface SpriteScanInput {
  sprite: Sprite;
  /** Cursor per provider; `0`/absent forces a full scan of that store. */
  cursors?: ActivityCursors;
  /** Cached rows for this Sprite — the detail for unchanged transcripts. */
  cached?: GlobalAgentSession[];
}

interface ScanAllOptions {
  concurrency?: number;
  loaders?: ActivitySessionLoaders;
  onResult?: (result: SpriteActivityResult, completed: number, total: number) => void;
}

const DEFAULT_LOADERS: ActivitySessionLoaders = {
  scanClaudeSessions,
  scanCodexSessions,
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Session scan failed';
}

/**
 * Fold one provider's scan into that provider's cached rows.
 *
 * The scan is authoritative about *which* transcripts exist and about their
 * mtime and live flag; it only re-reads the ones that changed since the cursor.
 * Everything else keeps the preview / cwd / line count already on the device.
 *
 * A cached row the scan didn't mention is gone from the sprite and is dropped —
 * except a locally recorded run that started after the scan snapshot, which the
 * scan simply couldn't have seen yet.
 */
export function mergeProviderScan(
  cached: GlobalAgentSession[],
  scan: SessionScanResult,
  meta: { spriteName: string; spriteStatus: SpriteStatus; provider: ActivityScanProvider }
): GlobalAgentSession[] {
  const byId = new Map(cached.map((session) => [session.id, session]));
  const merged: GlobalAgentSession[] = [];
  const seen = new Set<string>();

  for (const entry of scan.entries) {
    seen.add(entry.id);
    const previous = byId.get(entry.id);

    if (entry.detail) {
      merged.push({
        id: entry.id,
        provider: meta.provider,
        spriteName: meta.spriteName,
        spriteStatus: meta.spriteStatus,
        cwd: entry.detail.cwd,
        preview: entry.detail.preview,
        messageCount: entry.detail.messageCount,
        modified: entry.modified,
        live: entry.live,
        origin: 'scan',
      });
      continue;
    }

    // Unchanged transcript: reuse the cached detail, refresh what the scan knows.
    // No cached row means the cache was cleared behind the cursor — skip it; the
    // next full refresh (pull-to-refresh) re-reads the whole store.
    if (!previous) continue;
    merged.push({
      ...previous,
      spriteStatus: meta.spriteStatus,
      modified: entry.modified,
      live: entry.live,
    });
  }

  for (const session of cached) {
    if (seen.has(session.id)) continue;
    if (session.origin === 'local' && session.modified > scan.cursor) {
      // A turn this app started after the scan began — not yet on disk when the
      // store was walked, so its absence proves nothing.
      merged.push({ ...session, spriteStatus: meta.spriteStatus });
    }
  }

  return merged;
}

/** Scan both native transcript stores on one Sprite in parallel. */
export async function scanSpriteActivity(
  input: SpriteScanInput,
  loaders: ActivitySessionLoaders = DEFAULT_LOADERS
): Promise<SpriteActivityResult> {
  const { sprite, cursors = {}, cached = [] } = input;
  const [claudeResult, codexResult] = await Promise.allSettled([
    loaders.scanClaudeSessions(sprite.name, cursors.claude ?? 0),
    loaders.scanCodexSessions(sprite.name, cursors.codex ?? 0),
  ]);

  const sessions: GlobalAgentSession[] = [];
  const errors: ActivityScanError[] = [];
  const nextCursors: ActivityCursors = {};

  const settled: [ActivityScanProvider, PromiseSettledResult<SessionScanResult>][] = [
    ['claude', claudeResult],
    ['codex', codexResult],
  ];

  for (const [provider, result] of settled) {
    const cachedForProvider = cached.filter((session) => session.provider === provider);
    if (result.status === 'fulfilled') {
      sessions.push(
        ...mergeProviderScan(cachedForProvider, result.value, {
          spriteName: sprite.name,
          spriteStatus: sprite.status,
          provider,
        })
      );
      nextCursors[provider] = result.value.cursor;
    } else {
      // A store that can't be read this time keeps whatever the device already
      // knows — a transient failure must not erase history from the list.
      sessions.push(
        ...cachedForProvider.map((session) => ({ ...session, spriteStatus: sprite.status }))
      );
      errors.push({ provider, message: errorMessage(result.reason) });
    }
  }

  return { sprite, sessions: sortActivitySessions(sessions), errors, cursors: nextCursors };
}

/**
 * Fan out across Sprites without waking every environment at once. Results are
 * reported as soon as each Sprite finishes, while the returned array retains
 * the input Sprite order for deterministic callers and tests.
 */
export async function scanAllSpriteActivity(
  inputs: SpriteScanInput[],
  options: ScanAllOptions = {}
): Promise<SpriteActivityResult[]> {
  if (inputs.length === 0) return [];

  const requestedConcurrency = Math.floor(
    options.concurrency ?? DEFAULT_ACTIVITY_SCAN_CONCURRENCY
  );
  const concurrency = Math.min(inputs.length, Math.max(1, requestedConcurrency));
  const results = new Array<SpriteActivityResult>(inputs.length);
  let cursor = 0;
  let completed = 0;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= inputs.length) return;

      const result = await scanSpriteActivity(inputs[index], options.loaders ?? DEFAULT_LOADERS);
      results[index] = result;
      completed += 1;
      options.onResult?.(result, completed, inputs.length);
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
