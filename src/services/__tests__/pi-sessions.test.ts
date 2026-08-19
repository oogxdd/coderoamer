import { describe, expect, it } from 'vitest';
import { piTranscriptToMessages } from '@/services/pi-sessions';

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

const T = '2026-08-18T21:20:06.601Z';

function entry(message: unknown, timestamp = T) {
  return { type: 'message', id: 'e1', parentId: null, timestamp, message };
}

describe('piTranscriptToMessages', () => {
  it('renders a user prompt and a grouped assistant turn with tools', () => {
    const raw = jsonl([
      { type: 'session', version: 3, id: 's-1', timestamp: T, cwd: '/home/sprite' },
      entry({ role: 'user', content: 'list the files' }),
      entry({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Use bash.' },
          { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
        ],
      }),
      entry({
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'file.txt\n' }],
        isError: false,
      }),
      entry({ role: 'assistant', content: [{ type: 'text', text: 'There is file.txt.' }] }),
    ]);

    const messages = piTranscriptToMessages(raw);
    expect(messages).toHaveLength(2);

    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toEqual([{ type: 'text', text: 'list the files' }]);

    expect(messages[1].role).toBe('assistant');
    const kinds = messages[1].content.map((c) => c.type);
    expect(kinds).toEqual(['reasoning', 'toolUse', 'toolResult', 'text']);

    const toolUse = messages[1].content[1];
    expect(toolUse.type).toBe('toolUse');
    if (toolUse.type === 'toolUse') {
      expect(toolUse.card.toolName).toBe('bash');
      expect(toolUse.card.input).toEqual({ command: 'ls' });
      expect(toolUse.card.result?.content).toEqual([{ type: 'text', text: 'file.txt\n' }]);
    }

    const toolResult = messages[1].content[2];
    expect(toolResult.type).toBe('toolResult');
    if (toolResult.type === 'toolResult') {
      expect(toolResult.card.toolUseId).toBe('call_1');
    }
  });

  it('accepts string user content and skips non-message entries', () => {
    const raw = jsonl([
      { type: 'session', version: 3, id: 's-2', timestamp: T, cwd: '/x' },
      { type: 'model_change', id: 'm1', parentId: null, timestamp: T, provider: 'zai', modelId: 'glm-5.3' },
      entry({ role: 'user', content: 'plain string prompt' }),
      { type: 'compaction', id: 'c1', parentId: null, timestamp: T, summary: 'old stuff', tokensBefore: 1000 },
    ]);
    const messages = piTranscriptToMessages(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([{ type: 'text', text: 'plain string prompt' }]);
  });

  it('ignores tool results without a matching tool call', () => {
    const raw = jsonl([
      entry({ role: 'toolResult', toolCallId: 'ghost', toolName: 'bash', content: [], isError: false }),
    ]);
    expect(piTranscriptToMessages(raw)).toEqual([]);
  });

  it('returns nothing for empty or corrupted input', () => {
    expect(piTranscriptToMessages('')).toEqual([]);
    expect(piTranscriptToMessages('not json\n{broken')).toEqual([]);
  });
});
