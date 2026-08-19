import { describe, expect, it } from 'vitest';
import { parsePiModelTable } from '@/services/pi-models';

const TABLE = [
  'provider  model              context  max-out  thinking  images',
  'zai       glm-5.3            1M       131.1K   yes       no    ',
  'anthropic claude-sonnet-4-5  200K     64K      yes       yes   ',
  'openai    gpt-5.2-codex      400K     128K     no        no    ',
  '',
].join('\n');

describe('parsePiModelTable', () => {
  it('parses the --list-models table into provider/model ids', () => {
    const models = parsePiModelTable(TABLE);
    expect(models).toEqual([
      {
        id: 'zai/glm-5.3',
        provider: 'zai',
        model: 'glm-5.3',
        supportsThinking: true,
        supportsImages: false,
      },
      {
        id: 'anthropic/claude-sonnet-4-5',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        supportsThinking: true,
        supportsImages: true,
      },
      {
        id: 'openai/gpt-5.2-codex',
        provider: 'openai',
        model: 'gpt-5.2-codex',
        supportsThinking: false,
        supportsImages: false,
      },
    ]);
  });

  it('skips the header and non-table noise', () => {
    const models = parsePiModelTable('No models configured.\none-col');
    expect(models).toEqual([]);
  });

  it('keeps parsing when a provider name fills the whole column (1-space gap)', () => {
    const table = [
      'provider   model         context  max-out  thinking  images',
      'anthropic  sonnet-4-5    200K     64K      yes       no',
    ].join('\n');
    const models = parsePiModelTable(table);
    expect(models).toEqual([
      {
        id: 'anthropic/sonnet-4-5',
        provider: 'anthropic',
        model: 'sonnet-4-5',
        supportsThinking: true,
        supportsImages: false,
      },
    ]);
  });
});
