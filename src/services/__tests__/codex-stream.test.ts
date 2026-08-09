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
    expect(parseOne({ type: 'turn.completed' })).toEqual([
      { type: 'turnCompleted', status: 'completed' },
    ]);
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

  it('maps terminal turn statuses and errors', () => {
    expect(parseOne({ method: 'turn/completed', params: {} })).toEqual([
      { type: 'turnCompleted', status: 'completed', message: undefined },
    ]);
    expect(
      parseOne({
        method: 'turn/completed',
        params: { turn: { status: 'failed', error: { message: 'boom' } } },
      })
    ).toEqual([{ type: 'turnCompleted', status: 'failed', message: 'boom' }]);
  });

  it('does not turn retryable transport errors into terminal chat errors', () => {
    expect(
      parseOne({
        method: 'error',
        params: { error: { message: 'temporary disconnect' }, willRetry: true },
      })
    ).toEqual([]);
  });

  it('ignores JSON-RPC responses (handled by the app-server driver)', () => {
    expect(parseOne({ id: 1, result: { threadId: 't' } })).toEqual([]);
  });

  it('surfaces image activity and ignores known bookkeeping notifications', () => {
    expect(
      parseOne({
        method: 'item/started',
        params: {
          threadId: 'secret-thread',
          turnId: 'secret-turn',
          item: {
            id: 'secret-item',
            type: 'imageView',
            path: '/private/screenshot.png',
          },
        },
      })
    ).toEqual([{
      type: 'activity',
      activityId: 'secret-item',
      name: 'ImageView',
      input: { path: '/private/screenshot.png' },
      output: undefined,
      completed: false,
    }]);

    expect(
      parseOne({
        method: 'thread/tokenUsage/updated',
        params: { threadId: 'secret-thread', tokenUsage: { total: 123 } },
      })
    ).toEqual([]);
  });

  it('tracks command execution from start through live output and completion', () => {
    expect(parseOne({
      method: 'item/started',
      params: {
        item: { type: 'commandExecution', id: 'cmd-2', command: 'pwd', cwd: '/work' },
      },
    })).toEqual([
      { type: 'commandBegin', commandId: 'cmd-2', command: 'pwd', cwd: '/work' },
    ]);
    expect(parseOne({
      method: 'item/commandExecution/outputDelta',
      params: { itemId: 'cmd-2', delta: '/work\n' },
    })).toEqual([{ type: 'commandOutput', commandId: 'cmd-2', delta: '/work\n' }]);
    expect(parseOne({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'cmd-2',
          command: 'pwd',
          aggregatedOutput: '/work\n',
          exitCode: 0,
          status: 'completed',
          durationMs: 25,
        },
      },
    })).toEqual([{
      type: 'commandEnd',
      commandId: 'cmd-2',
      command: 'pwd',
      output: '/work\n',
      exitCode: 0,
      status: 'completed',
      durationMs: 25,
    }]);
  });

  it('tracks file changes with diffs and web-search lifecycle', () => {
    expect(parseOne({
      method: 'item/started',
      params: {
        item: {
          type: 'fileChange',
          id: 'patch-1',
          changes: [{ path: 'src/a.ts', kind: 'update', diff: '+new' }],
        },
      },
    })).toEqual([{
      type: 'fileChangeBegin',
      changeId: 'patch-1',
      files: [{ path: 'src/a.ts', kind: 'update', diff: '+new' }],
    }]);
    expect(parseOne({
      method: 'item/completed',
      params: {
        item: {
          type: 'webSearch',
          id: 'web-1',
          query: 'Codex app server',
          action: { type: 'search', query: 'Codex app server' },
        },
      },
    })).toEqual([{
      type: 'activity',
      activityId: 'web-1',
      name: 'WebSearch',
      input: {
        query: 'Codex app server',
        action: { type: 'search', query: 'Codex app server' },
      },
      output: { type: 'search', query: 'Codex app server' },
      completed: true,
    }]);
  });

  it('maps plan statuses and still describes genuinely unknown notifications safely', () => {
    expect(parseOne({
      method: 'turn/plan/updated',
      params: {
        turnId: 'turn-1',
        plan: [
          { step: 'Inspect', status: 'completed' },
          { step: 'Implement', status: 'inProgress' },
        ],
      },
    })).toEqual([{
      type: 'todoList',
      listId: 'turn-1',
      items: [
        { text: 'Inspect', status: 'completed' },
        { text: 'Implement', status: 'inProgress' },
      ],
    }]);
    expect(parseOne({
      method: 'future/event',
      params: { secret: 'value' },
    })).toEqual([{
      type: 'unknown',
      rpcMethod: 'future/event',
      itemType: undefined,
      keys: ['secret'],
    }]);
    expect(parseOne({
      method: 'item/started',
      params: { item: { id: 'private-id', type: 'futureItem', secret: 'value' } },
    })).toEqual([{
      type: 'unknown',
      rpcMethod: 'item/started',
      itemType: 'futureItem',
      keys: ['item'],
    }]);
  });
});

describe('CodexStreamParser — buffering', () => {
  it('handles lines split across chunks and shell noise', () => {
    const parser = new CodexStreamParser();
    const line = JSON.stringify({ type: 'turn.completed' });
    expect(parser.parse('garbage without json\n')).toEqual([]);
    expect(parser.parse(line.slice(0, 5))).toEqual([]);
    expect(parser.parse(`${line.slice(5)}\n`)).toEqual([
      { type: 'turnCompleted', status: 'completed' },
    ]);
  });
});
