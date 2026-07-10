import { describe, expect, it } from 'vitest';
import { transcriptToMessages } from '@/services/claude-sessions';

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

const T = '2026-07-01T10:00:00.000Z';

describe('transcriptToMessages', () => {
  it('renders a user prompt and a grouped assistant turn', () => {
    const raw = jsonl([
      { type: 'user', timestamp: T, message: { role: 'user', content: 'fix the bug' } },
      {
        type: 'assistant',
        timestamp: T,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking… ' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: T,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file.txt' }],
        },
      },
      {
        type: 'assistant',
        timestamp: T,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      },
    ]);

    const messages = transcriptToMessages(raw);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');

    const assistant = messages[1];
    const toolUse = assistant.content.find((c) => c.type === 'toolUse');
    expect(toolUse && toolUse.type === 'toolUse' && toolUse.card.toolName).toBe('Bash');
    expect(toolUse && toolUse.type === 'toolUse' && toolUse.card.result?.content).toBe('file.txt');
    const texts = assistant.content.filter((c) => c.type === 'text');
    expect(texts.map((t) => t.type === 'text' && t.text)).toEqual(['Looking… ', 'done']);
  });

  it('starts a new assistant group after each user prompt', () => {
    const raw = jsonl([
      { type: 'user', timestamp: T, message: { role: 'user', content: 'one' } },
      { type: 'assistant', timestamp: T, message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }] } },
      { type: 'user', timestamp: T, message: { role: 'user', content: 'two' } },
      { type: 'assistant', timestamp: T, message: { role: 'assistant', content: [{ type: 'text', text: 'a2' }] } },
    ]);
    const roles = transcriptToMessages(raw).map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('skips local command noise and unparseable lines', () => {
    const raw = [
      JSON.stringify({ type: 'user', timestamp: T, message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
      'not json',
      JSON.stringify({ type: 'user', timestamp: T, message: { role: 'user', content: 'real prompt' } }),
    ].join('\n');
    const messages = transcriptToMessages(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([{ type: 'text', text: 'real prompt' }]);
  });

  it('renders thinking blocks as reasoning', () => {
    const raw = jsonl([
      { type: 'user', timestamp: T, message: { role: 'user', content: 'go' } },
      {
        type: 'assistant',
        timestamp: T,
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
      },
    ]);
    const assistant = transcriptToMessages(raw)[1];
    expect(assistant.content).toEqual([{ type: 'reasoning', text: 'hmm' }]);
  });
});
