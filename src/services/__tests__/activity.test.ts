import { describe, expect, it } from 'vitest';
import {
  ActivitySessionLoaders,
  GlobalAgentSession,
  mergeProviderScan,
  scanAllSpriteActivity,
  scanSpriteActivity,
  sortActivitySessions,
} from '@/services/activity';
import { SessionScanResult } from '@/services/session-scan';
import { Sprite } from '@/models/sprite';

const sprites: Sprite[] = [
  { id: 'one', name: 'sprite-one', status: 'running' },
  { id: 'two', name: 'sprite-two', status: 'cold' },
  { id: 'three', name: 'sprite-three', status: 'warm' },
];

/** A full scan result — every entry carries its detail. */
function fullScan(
  cursor: number,
  entries: { id: string; modified: number; live?: boolean; preview?: string; messageCount?: number }[]
): SessionScanResult {
  return {
    cursor,
    entries: entries.map((entry) => ({
      id: entry.id,
      modified: entry.modified,
      live: !!entry.live,
      detail: {
        preview: entry.preview ?? '',
        messageCount: entry.messageCount ?? 0,
      },
    })),
  };
}

function loaders(overrides: Partial<ActivitySessionLoaders> = {}): ActivitySessionLoaders {
  return {
    scanClaudeSessions: async () => ({ cursor: 0, entries: [] }),
    scanCodexSessions: async () => ({ cursor: 0, entries: [] }),
    ...overrides,
  };
}

function cachedSession(overrides: Partial<GlobalAgentSession> = {}): GlobalAgentSession {
  return {
    id: 'session-1',
    provider: 'claude',
    spriteName: 'sprite-one',
    spriteStatus: 'running',
    preview: 'Cached prompt',
    messageCount: 12,
    modified: 100,
    live: false,
    origin: 'scan',
    ...overrides,
  };
}

describe('activity scanner', () => {
  it('combines Claude and Codex metadata with its Sprite identity', async () => {
    const result = await scanSpriteActivity(
      { sprite: sprites[0] },
      loaders({
        scanClaudeSessions: async () =>
          fullScan(50, [{ id: 'claude-1', modified: 10, preview: 'Claude task', messageCount: 4 }]),
        scanCodexSessions: async () =>
          fullScan(60, [
            { id: 'codex-1', modified: 20, live: true, preview: 'Codex task', messageCount: 8 },
          ]),
      })
    );

    expect(result.errors).toEqual([]);
    expect(result.sessions.map((session) => session.id)).toEqual(['codex-1', 'claude-1']);
    expect(result.sessions[0]).toMatchObject({
      provider: 'codex',
      spriteName: 'sprite-one',
      spriteStatus: 'running',
    });
    expect(result.cursors).toEqual({ claude: 50, codex: 60 });
  });

  it('keeps the cached rows of a provider whose store cannot be read', async () => {
    const cached = [
      cachedSession({ id: 'claude-1', provider: 'claude' }),
      cachedSession({ id: 'codex-1', provider: 'codex', modified: 20 }),
    ];

    const result = await scanSpriteActivity(
      {
        sprite: sprites[0],
        cached,
      },
      loaders({
        scanClaudeSessions: async () => {
          throw new Error('Claude unavailable');
        },
        scanCodexSessions: async () =>
          fullScan(60, [{ id: 'codex-1', modified: 30, preview: 'Codex task', messageCount: 9 }]),
      })
    );

    expect(result.errors).toEqual([{ provider: 'claude', message: 'Claude unavailable' }]);
    // The failed store keeps what the device already knew; only Codex advanced.
    expect(result.sessions.map((session) => session.id).sort()).toEqual(['claude-1', 'codex-1']);
    expect(result.cursors).toEqual({ codex: 60 });
  });

  it('limits Sprite fan-out and reports progressive completion', async () => {
    let activeSprites = 0;
    let maxActiveSprites = 0;
    const started = new Map<string, number>();
    const completions: number[] = [];

    const markStarted = async (spriteName: string): Promise<SessionScanResult> => {
      const calls = (started.get(spriteName) ?? 0) + 1;
      started.set(spriteName, calls);
      if (calls === 1) {
        activeSprites += 1;
        maxActiveSprites = Math.max(maxActiveSprites, activeSprites);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (calls === 2) activeSprites -= 1;
      return { cursor: 0, entries: [] };
    };

    const results = await scanAllSpriteActivity(
      sprites.map((sprite) => ({ sprite })),
      {
        concurrency: 2,
        loaders: loaders({
          scanClaudeSessions: markStarted,
          scanCodexSessions: markStarted,
        }),
        onResult: (_result, completed) => completions.push(completed),
      }
    );

    expect(maxActiveSprites).toBe(2);
    expect(completions).toEqual([1, 2, 3]);
    expect(results.map((result) => result.sprite.name)).toEqual(
      sprites.map((sprite) => sprite.name)
    );
  });
});

describe('mergeProviderScan', () => {
  const meta = {
    spriteName: 'sprite-one',
    spriteStatus: 'running' as const,
    provider: 'claude' as const,
  };

  it('reuses cached detail for transcripts the scan skipped', () => {
    const merged = mergeProviderScan(
      [cachedSession({ id: 'session-1', preview: 'Cached prompt', messageCount: 12 })],
      { cursor: 500, entries: [{ id: 'session-1', modified: 400, live: true }] },
      meta
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      preview: 'Cached prompt',
      messageCount: 12,
      // Liveness and mtime always come from the scan, never from the cache.
      modified: 400,
      live: true,
    });
  });

  it('lets a re-read transcript replace the cached row', () => {
    const merged = mergeProviderScan(
      [cachedSession({ id: 'session-1', preview: 'Old', messageCount: 2 })],
      {
        cursor: 500,
        entries: [
          {
            id: 'session-1',
            modified: 600,
            live: false,
            detail: { preview: 'New', messageCount: 40, cwd: '/home/sprite/repo' },
          },
        ],
      },
      meta
    );

    expect(merged[0]).toMatchObject({
      preview: 'New',
      messageCount: 40,
      cwd: '/home/sprite/repo',
      origin: 'scan',
    });
  });

  it('drops sessions the Sprite no longer has', () => {
    const merged = mergeProviderScan(
      [cachedSession({ id: 'deleted-session' })],
      { cursor: 500, entries: [] },
      meta
    );

    expect(merged).toEqual([]);
  });

  it('keeps a locally recorded run the scan started too early to see', () => {
    const merged = mergeProviderScan(
      [cachedSession({ id: 'just-started', origin: 'local', modified: 900, live: true })],
      { cursor: 500, entries: [] },
      meta
    );

    expect(merged.map((session) => session.id)).toEqual(['just-started']);
  });

  it('skips a stale entry with nothing cached to fill it in', () => {
    const merged = mergeProviderScan([], {
      cursor: 500,
      entries: [{ id: 'unknown', modified: 100, live: false }],
    }, meta);

    expect(merged).toEqual([]);
  });
});

describe('sortActivitySessions', () => {
  it('places live sessions first, then sorts by most recent activity', () => {
    const makeSession = (
      id: string,
      modified: number,
      live: boolean
    ): GlobalAgentSession => ({
      id,
      provider: 'claude',
      spriteName: 'sprite-one',
      spriteStatus: 'running',
      preview: '',
      messageCount: 1,
      modified,
      live,
    });

    const sorted = sortActivitySessions([
      makeSession('finished-new', 300, false),
      makeSession('live-old', 100, true),
      makeSession('live-new', 200, true),
    ]);

    expect(sorted.map((session) => session.id)).toEqual([
      'live-new',
      'live-old',
      'finished-new',
    ]);
  });
});
