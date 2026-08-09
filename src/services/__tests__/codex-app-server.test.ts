import { describe, expect, it, vi } from 'vitest';
import { ServiceLogEvent } from '@/models/service';
import * as api from '@/services/api';
import { streamCodexAppServerTurn } from '@/services/codex-app-server';

describe('streamCodexAppServerTurn', () => {
  it('performs the handshake and passes model and effort to turn/start', async () => {
    const writes: Record<string, any>[] = [];
    const observedEvents: ServiceLogEvent[] = [];

    const streamSpy = vi.spyOn(api, 'streamExec').mockImplementation(
      async (_spriteName, _command, onEvent, _signal, options = {}) => {
        expect(options.stdin).toBe(true);
        expect(options.stdinReadyAfterSessionInfo).toBe(true);
        options.onSessionId?.('exec-1');
        options.onStdinReady?.({
          write(text) {
            writes.push(JSON.parse(text));
          },
          writeBytes() {},
        });

        const initializeResponse =
          '{"id":1,"result":{"userAgent":"probe/0.143.0","codexHome":"/home/sprite/.codex","platformFamily":"unix","platformOs":"linux"}}\n';
        onEvent({ type: 'stdout', data: initializeResponse.slice(0, 47) });
        onEvent({
          type: 'stdout',
          data:
            initializeResponse.slice(47) +
            '{"method":"remoteControl/status/changed","params":{"status":"disabled"}}\n',
        });
        onEvent({
          type: 'stdout',
          data: '{"id":2,"result":{"thread":{"id":"thread-1"}}}\n',
        });
        onEvent({
          type: 'stdout',
          data: '{"id":3,"result":{"turn":{"id":"turn-1","status":"inProgress"}}}\n',
        });
        onEvent({
          type: 'stdout',
          data: '{"method":"item/agentMessage/delta","params":{"delta":"Hi"}}\n',
        });
        onEvent({ type: 'stdout', data: '{"method":"turn/completed","params":{}}\n' });
      }
    );

    try {
      await streamCodexAppServerTurn({
        spriteName: 'sprite',
        command: ['codex', 'app-server', '--stdio'],
        workingDirectory: '/work',
        prompt: 'Hello',
        model: 'gpt-test',
        effort: 'xhigh',
        onEvent: (event) => observedEvents.push(event),
      });
    } finally {
      streamSpy.mockRestore();
    }

    expect(writes).toEqual([
      {
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'sprites-rn-manager',
            title: 'Sprites Manager',
            version: '1.3.0',
          },
        },
      },
      { method: 'initialized', params: {} },
      {
        id: 2,
        method: 'thread/start',
        params: {
          cwd: '/work',
          model: 'gpt-test',
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
        },
      },
      {
        id: 3,
        method: 'turn/start',
        params: {
          threadId: 'thread-1',
          input: [{ type: 'text', text: 'Hello', text_elements: [] }],
          cwd: '/work',
          model: 'gpt-test',
          effort: 'xhigh',
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' },
        },
      },
    ]);
    expect(observedEvents).toContainEqual({
      type: 'stdout',
      data: '{"method":"item/agentMessage/delta","params":{"delta":"Hi"}}\n',
    });
  });

  it('resumes an existing thread without experimental parameters', async () => {
    const writes: Record<string, any>[] = [];

    const streamSpy = vi.spyOn(api, 'streamExec').mockImplementation(
      async (_spriteName, _command, onEvent, _signal, options = {}) => {
        options.onStdinReady?.({
          write(text) {
            writes.push(JSON.parse(text));
          },
          writeBytes() {},
        });

        onEvent({
          type: 'stdout',
          data: '{"id":1,"result":{"userAgent":"probe/0.143.0"}}\n',
        });
        onEvent({
          type: 'stdout',
          data: '{"id":2,"result":{"thread":{"id":"thread-existing"}}}\n',
        });
        onEvent({
          type: 'stdout',
          data: '{"id":3,"result":{"turn":{"id":"turn-2","status":"inProgress"}}}\n',
        });
        onEvent({ type: 'stdout', data: '{"method":"turn/completed","params":{}}\n' });
      }
    );

    try {
      await streamCodexAppServerTurn({
        spriteName: 'sprite',
        command: ['codex', 'app-server', '--stdio'],
        workingDirectory: '/work',
        prompt: 'Continue',
        threadId: 'thread-existing',
        model: 'gpt-test',
        effort: 'high',
        onEvent: () => {},
      });
    } finally {
      streamSpy.mockRestore();
    }

    expect(writes[2]).toEqual({
      id: 2,
      method: 'thread/resume',
      params: {
        threadId: 'thread-existing',
        cwd: '/work',
        model: 'gpt-test',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      },
    });
    expect(writes[2].params).not.toHaveProperty('excludeTurns');
    expect(writes[3]).toEqual({
      id: 3,
      method: 'turn/start',
      params: {
        threadId: 'thread-existing',
        input: [{ type: 'text', text: 'Continue', text_elements: [] }],
        cwd: '/work',
        model: 'gpt-test',
        effort: 'high',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    });
  });
});
