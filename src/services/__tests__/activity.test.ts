import { describe, expect, it } from 'vitest';
import {
  ActivitySessionLoaders,
  GlobalAgentSession,
  scanAllSpriteActivity,
  scanSpriteActivity,
  sortActivitySessions,
} from '@/services/activity';
import { Sprite } from '@/models/sprite';

const sprites: Sprite[] = [
  { id: 'one', name: 'sprite-one', status: 'running' },
  { id: 'two', name: 'sprite-two', status: 'cold' },
  { id: 'three', name: 'sprite-three', status: 'warm' },
];

function loaders(overrides: Partial<ActivitySessionLoaders> = {}): ActivitySessionLoaders {
  return {
    listClaudeSessions: async () => [],
    listCodexSessions: async () => [],
    ...overrides,
  };
}

describe('activity scanner', () => {
  it('combines Claude and Codex metadata with its Sprite identity', async () => {
    const result = await scanSpriteActivity(
      sprites[0],
      loaders({
        listClaudeSessions: async () => [
          { id: 'claude-1', preview: 'Claude task', messageCount: 4, modified: 10, live: false },
        ],
        listCodexSessions: async () => [
          { id: 'codex-1', preview: 'Codex task', messageCount: 8, modified: 20, live: true },
        ],
      })
    );

    expect(result.errors).toEqual([]);
    expect(result.sessions.map((session) => session.id)).toEqual(['codex-1', 'claude-1']);
    expect(result.sessions[0]).toMatchObject({
      provider: 'codex',
      spriteName: 'sprite-one',
      spriteStatus: 'running',
    });
  });

  it('keeps one provider result when the other scan fails', async () => {
    const result = await scanSpriteActivity(
      sprites[0],
      loaders({
        listClaudeSessions: async () => {
          throw new Error('Claude unavailable');
        },
        listCodexSessions: async () => [
          { id: 'codex-1', preview: '', messageCount: 1, modified: 20, live: false },
        ],
      })
    );

    expect(result.sessions).toHaveLength(1);
    expect(result.errors).toEqual([{ provider: 'claude', message: 'Claude unavailable' }]);
  });

  it('limits Sprite fan-out and reports progressive completion', async () => {
    let activeSprites = 0;
    let maxActiveSprites = 0;
    const started = new Map<string, number>();
    const completions: number[] = [];

    const markStarted = async (spriteName: string) => {
      const calls = (started.get(spriteName) ?? 0) + 1;
      started.set(spriteName, calls);
      if (calls === 1) {
        activeSprites += 1;
        maxActiveSprites = Math.max(maxActiveSprites, activeSprites);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (calls === 2) activeSprites -= 1;
      return [];
    };

    const results = await scanAllSpriteActivity(sprites, {
      concurrency: 2,
      loaders: loaders({
        listClaudeSessions: markStarted,
        listCodexSessions: markStarted,
      }),
      onResult: (_result, completed) => completions.push(completed),
    });

    expect(maxActiveSprites).toBe(2);
    expect(completions).toEqual([1, 2, 3]);
    expect(results.map((result) => result.sprite.name)).toEqual(
      sprites.map((sprite) => sprite.name)
    );
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
