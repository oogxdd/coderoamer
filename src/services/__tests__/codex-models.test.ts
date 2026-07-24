import { beforeEach, describe, expect, it, vi } from 'vitest';

const { settings, streamExec, killExecSession } = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  streamExec: vi.fn(),
  killExecSession: vi.fn(async () => {}),
}));

vi.mock('@/services/api', () => ({
  streamExec,
  killExecSession,
}));

vi.mock('@/services/storage', () => ({
  getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
  setSetting: vi.fn(async (key: string, value: string) => {
    settings.set(key, value);
  }),
}));

// Vitest module mocks must be registered before this service is evaluated.
// eslint-disable-next-line import/first
import {
  cacheCodexModels,
  getCachedCodexModels,
  listCodexModels,
} from '@/services/codex-models';

describe('Codex model catalog', () => {
  beforeEach(() => {
    settings.clear();
    streamExec.mockReset();
    killExecSession.mockClear();
  });

  it('handshakes with app-server and preserves model/effort ordering', async () => {
    streamExec.mockImplementation(async (_sprite, _command, onEvent, _signal, options) => {
      options.onSessionId('exec-1');
      options.onStdinReady({
        write(text: string) {
          const message = JSON.parse(text);
          if (message.id === 1) {
            onEvent({ type: 'stdout', data: '{"id":1,"result":{}}\n' });
          } else if (message.id === 2) {
            onEvent({
              type: 'stdout',
              data: `${JSON.stringify({
                id: 2,
                result: {
                  data: [
                    {
                      id: 'gpt-new',
                      model: 'gpt-new',
                      displayName: 'GPT New',
                      description: 'Fast coding model',
                      supportedReasoningEfforts: [
                        { reasoningEffort: 'low' },
                        { reasoningEffort: 'xhigh' },
                      ],
                      defaultReasoningEffort: 'low',
                      isDefault: true,
                    },
                    {
                      id: 'gpt-old',
                      model: 'gpt-old',
                      displayName: 'GPT Old',
                      supportedReasoningEfforts: ['none', 'medium'],
                      isDefault: false,
                    },
                  ],
                },
              })}\n`,
            });
          }
        },
        writeBytes() {},
      });
    });

    await expect(listCodexModels('sprite-a')).resolves.toEqual([
      {
        id: 'gpt-new',
        model: 'gpt-new',
        displayName: 'GPT New',
        description: 'Fast coding model',
        supportedReasoningEfforts: ['low', 'xhigh'],
        defaultReasoningEffort: 'low',
        isDefault: true,
      },
      {
        id: 'gpt-old',
        model: 'gpt-old',
        displayName: 'GPT Old',
        description: undefined,
        supportedReasoningEfforts: ['none', 'medium'],
        defaultReasoningEffort: undefined,
        isDefault: false,
      },
    ]);

    expect(streamExec.mock.calls[0][1]).toEqual([
      'bash',
      '-lc',
      expect.stringContaining('codex app-server --stdio'),
    ]);
    expect(killExecSession).toHaveBeenCalledWith('sprite-a', 'exec-1');
  });

  it('round-trips a cached catalog', async () => {
    const models = [{
      id: 'gpt-new',
      model: 'gpt-new',
      displayName: 'GPT New',
      supportedReasoningEfforts: ['high' as const],
      defaultReasoningEffort: 'high' as const,
      isDefault: true,
    }];
    await cacheCodexModels(models);
    await expect(getCachedCodexModels()).resolves.toEqual([
      { ...models[0], description: undefined },
    ]);
  });
});
