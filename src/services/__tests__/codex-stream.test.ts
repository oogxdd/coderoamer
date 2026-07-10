import { describe, expect, it } from 'vitest';
import { CodexStreamParser } from '@/services/codex-stream';

function parseOne(line: unknown) {
  const parser = new CodexStreamParser();
  return parser.parse(`${JSON.stringify(line)}\n`);
}

describe('CodexStreamParser — legacy `codex exec --json` events', () => {
  it('maps thread.started to threadStarted', () => {
    const events = parseOne({ type: 'thread.started', thread_id: 't-1' });
    expect(events).toEqual([{ type: 'threadStarted', threadId: 't-1' }]);
  });

  it('maps a completed agent message to assistantDelta', () => {
    const events = parseOne({
      type: 'item.completed',
      item: { type: 'agent_message', id: 'i1', text: 'All done.' },
    });
    expect(events).toEqual([{ type: 'assistantDelta', text: 'All done.' }]);
  });

  it('maps command execution completion with output and exit code', () => {
    const events = parseOne({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        id: 'cmd-1',
        command: 'ls',
        aggregated_output: 'file.txt',
        exit_code: 0,
      },
    });
    expect(events).toEqual([
      { type: 'commandEnd', commandId: 'cmd-1', command: 'ls', output: 'file.txt', exitCode: 0 },
    ]);
  });

  it('maps turn.completed and turn.failed', () => {
    expect(parseOne({ type: 'turn.completed' })).toEqual([{ type: 'turnCompleted' }]);
    expect(parseOne({ type: 'turn.failed', error: { message: 'boom' } })).toEqual([
      { type: 'error', message: 'boom' },
    ]);
  });

  it('labels unrecognized events as unknown with debugging hints', () => {
    const events = parseOne({ type: 'something.new', item: { type: 'mystery' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'unknown', rawType: 'something.new', itemType: 'mystery' });
  });
});

describe('CodexStreamParser — app-server notifications', () => {
  it('maps thread/started from the thread object or threadId', () => {
    expect(parseOne({ method: 'thread/started', params: { thread: { id: 't-2' } } })).toEqual([
      { type: 'threadStarted', threadId: 't-2' },
    ]);
    expect(parseOne({ method: 'thread/started', params: { threadId: 't-3' } })).toEqual([
      { type: 'threadStarted', threadId: 't-3' },
    ]);
  });

  it('maps agent message deltas', () => {
    expect(parseOne({ method: 'item/agentMessage/delta', params: { delta: 'Hi' } })).toEqual([
      { type: 'assistantDelta', text: 'Hi' },
    ]);
  });

  it('maps turn/completed', () => {
    expect(parseOne({ method: 'turn/completed', params: {} })).toEqual([{ type: 'turnCompleted' }]);
  });

  it('ignores JSON-RPC responses (handled by the app-server driver)', () => {
    expect(parseOne({ id: 1, result: { threadId: 't' } })).toEqual([]);
  });
});

describe('CodexStreamParser — buffering', () => {
  it('handles lines split across chunks and shell noise', () => {
    const parser = new CodexStreamParser();
    const line = JSON.stringify({ type: 'turn.completed' });
    expect(parser.parse('garbage without json\n')).toEqual([]);
    expect(parser.parse(line.slice(0, 5))).toEqual([]);
    expect(parser.parse(`${line.slice(5)}\n`)).toEqual([{ type: 'turnCompleted' }]);
  });
});
