import { AgentProvider } from '@/models/chat';
import { SpriteStatus } from '@/models/sprite';
import {
  ActivityCursors,
  ActivityOrigin,
  ActivityScanProvider,
  GlobalAgentSession,
  sortActivitySessions,
} from './activity';
import { getDatabase } from './database';

/**
 * Durable cache behind the Activity tab.
 *
 * Activity used to be rebuilt from scratch on every visit: list the Sprites,
 * wake each one, read every transcript. That is seconds of waiting for data
 * that barely changes. Now the screen paints from this table immediately and
 * revalidates in the background, and each revalidation only re-reads the
 * transcripts modified after the stored cursor (see `session-scan.ts`).
 *
 * Two kinds of rows live here:
 * - `scan` — read off a Sprite's Claude/Codex transcript store.
 * - `local` — recorded by this app when *it* launched the turn, so an agent
 *   started from the phone is in the list before any scan runs.
 *
 * A later scan of the same store supersedes both: it is authoritative about
 * which sessions exist on that Sprite.
 */

interface ActivityRow {
  sprite_name: string;
  provider: string;
  session_id: string;
  sprite_status: string;
  cwd: string | null;
  preview: string;
  message_count: number;
  modified: number;
  live: number;
  origin: string;
}

interface CursorRow {
  sprite_name: string;
  provider: string;
  cursor: number;
  scanned_at: number;
}

/** A locally observed run, recorded as the app starts/finishes an agent turn. */
export interface LocalActivityRecord {
  spriteName: string;
  provider: AgentProvider;
  sessionId: string;
  spriteStatus?: SpriteStatus;
  cwd?: string;
  preview: string;
  messageCount: number;
  live: boolean;
  modified?: number;
}

/**
 * Sprites are scanned in parallel, but SQLite transactions on the one shared
 * connection must not interleave, so every write goes through this chain.
 */
let writeChain: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = writeChain.then(work, work);
  // Keep the chain usable after a failed write.
  writeChain = next.catch(() => {});
  return next;
}

function normalizeScanProvider(value: string): ActivityScanProvider {
  return value === 'codex' ? 'codex' : 'claude';
}

function normalizeStatus(value: string): SpriteStatus {
  return value === 'running' || value === 'warm' || value === 'cold' ? value : 'unknown';
}

function normalizeOrigin(value: string): ActivityOrigin {
  return value === 'local' ? 'local' : 'scan';
}

function toSession(row: ActivityRow): GlobalAgentSession {
  return {
    id: row.session_id,
    provider: normalizeScanProvider(row.provider),
    spriteName: row.sprite_name,
    spriteStatus: normalizeStatus(row.sprite_status),
    cwd: row.cwd ?? undefined,
    preview: row.preview ?? '',
    messageCount: row.message_count ?? 0,
    modified: row.modified ?? 0,
    live: row.live === 1,
    origin: normalizeOrigin(row.origin),
  };
}

/**
 * Codex has two provider ids in the chat layer (`codex`, `codexAppServer`) but
 * one transcript store, so activity rows are keyed by the store.
 */
export function activityProviderKey(provider: AgentProvider): ActivityScanProvider {
  return provider === 'claude' ? 'claude' : 'codex';
}

const SESSION_UPSERT_SQL = `
INSERT OR REPLACE INTO activity_sessions
  (sprite_name, provider, session_id, sprite_status, cwd, preview,
   message_count, modified, live, origin)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

async function replaceSpriteImpl(
  spriteName: string,
  scanned: GlobalAgentSession[],
  cursors: ActivityCursors,
  scannedAt: number
): Promise<GlobalAgentSession[]> {
  const providers = Object.keys(cursors) as ActivityScanProvider[];
  if (providers.length === 0) return scanned;

  const db = await getDatabase();
  let sessions = scanned;
  const keptIds = new Set(sessions.map((session) => session.id));

  await db.withTransactionAsync(async () => {
    for (const provider of providers) {
      // A turn recorded while this scan was in flight is newer than anything
      // the scan could have seen — carry it across the swap.
      const raced = await db.getAllAsync<ActivityRow>(
        `SELECT * FROM activity_sessions
          WHERE sprite_name = ? AND provider = ? AND origin = 'local' AND modified > ?`,
        spriteName,
        provider,
        cursors[provider] ?? 0
      );
      await db.runAsync(
        'DELETE FROM activity_sessions WHERE sprite_name = ? AND provider = ?',
        spriteName,
        provider
      );
      for (const row of raced) {
        if (keptIds.has(row.session_id)) continue;
        sessions = [...sessions, toSession(row)];
        keptIds.add(row.session_id);
      }
      await db.runAsync(
        `INSERT OR REPLACE INTO activity_cursors
           (sprite_name, provider, cursor, scanned_at)
         VALUES (?, ?, ?, ?)`,
        spriteName,
        provider,
        cursors[provider] ?? 0,
        scannedAt
      );
    }

    for (const session of sessions) {
      const provider = activityProviderKey(session.provider);
      if (!providers.includes(provider)) continue;
      await db.runAsync(
        SESSION_UPSERT_SQL,
        spriteName,
        provider,
        session.id,
        session.spriteStatus,
        session.cwd ?? null,
        session.preview ?? '',
        session.messageCount ?? 0,
        session.modified ?? 0,
        session.live ? 1 : 0,
        session.origin ?? 'scan'
      );
    }
  });

  return sessions;
}

async function recordLocalImpl(record: LocalActivityRecord): Promise<void> {
  const db = await getDatabase();
  const provider = activityProviderKey(record.provider);
  const existing = await db.getFirstAsync<ActivityRow>(
    `SELECT * FROM activity_sessions
      WHERE sprite_name = ? AND provider = ? AND session_id = ?`,
    record.spriteName,
    provider,
    record.sessionId
  );

  await db.runAsync(
    SESSION_UPSERT_SQL,
    record.spriteName,
    provider,
    record.sessionId,
    record.spriteStatus ?? normalizeStatus(existing?.sprite_status ?? 'running'),
    record.cwd ?? existing?.cwd ?? null,
    // A scan's preview is the session's *first* prompt; keep whatever is already
    // stored rather than overwriting it with a later turn's message.
    existing?.preview || record.preview,
    Math.max(record.messageCount, existing?.message_count ?? 0),
    record.modified ?? Date.now(),
    record.live ? 1 : 0,
    'local'
  );
}

async function pruneMissingSpritesImpl(spriteNames: string[]): Promise<void> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ sprite_name: string }>(
    'SELECT DISTINCT sprite_name FROM activity_sessions'
  );
  const keep = new Set(spriteNames);
  const gone = rows.map((row) => row.sprite_name).filter((name) => !keep.has(name));
  if (gone.length === 0) return;
  await db.withTransactionAsync(async () => {
    for (const name of gone) {
      await db.runAsync('DELETE FROM activity_sessions WHERE sprite_name = ?', name);
      await db.runAsync('DELETE FROM activity_cursors WHERE sprite_name = ?', name);
    }
  });
}

export const activityRepository = {
  /** Everything the device knows, live and newest first. */
  async list(): Promise<GlobalAgentSession[]> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<ActivityRow>(
      'SELECT * FROM activity_sessions ORDER BY modified DESC'
    );
    return sortActivitySessions(rows.map(toSession));
  },

  /** Scan cursors keyed `"<sprite>:<provider>"`. */
  async cursors(): Promise<Record<string, number>> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<CursorRow>('SELECT * FROM activity_cursors');
    const out: Record<string, number> = {};
    for (const row of rows) {
      out[`${row.sprite_name}:${normalizeScanProvider(row.provider)}`] = row.cursor;
    }
    return out;
  },

  /** When the newest successful scan finished, for the "Updated …" label. */
  async lastScanAt(): Promise<number | undefined> {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{ scanned_at: number }>(
      'SELECT MAX(scanned_at) AS scanned_at FROM activity_cursors'
    );
    return row?.scanned_at || undefined;
  },

  /**
   * Replace one Sprite's rows with the merged result of a scan. The caller has
   * already folded the scan into the cached rows (`mergeProviderScan`), so this
   * is a straight swap — which is what prunes sessions deleted on the Sprite.
   *
   * Only providers present in `cursors` are replaced: a provider whose store
   * could not be read keeps its existing rows. Returns the Sprite's resulting
   * row set, which can differ from `scanned` when a turn was recorded locally
   * while the scan was in flight.
   */
  replaceSprite(
    spriteName: string,
    scanned: GlobalAgentSession[],
    cursors: ActivityCursors,
    scannedAt = Date.now()
  ): Promise<GlobalAgentSession[]> {
    return serialize(() => replaceSpriteImpl(spriteName, scanned, cursors, scannedAt));
  },

  /**
   * Record a turn this app is running. Called when the agent's session id
   * becomes known and again when the turn ends, so the Activity list reflects a
   * phone-started agent without a single extra network call.
   */
  recordLocal(record: LocalActivityRecord): Promise<void> {
    if (!record.spriteName || !record.sessionId) return Promise.resolve();
    return serialize(() => recordLocalImpl(record));
  },

  /** Drop rows for Sprites that no longer exist on the account. */
  pruneMissingSprites(spriteNames: string[]): Promise<void> {
    return serialize(() => pruneMissingSpritesImpl(spriteNames));
  },

  /** Forget everything — a full rescan starts from here. */
  clear(): Promise<void> {
    return serialize(async () => {
      const db = await getDatabase();
      await db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM activity_sessions');
        await db.runAsync('DELETE FROM activity_cursors');
      });
    });
  },
};
