import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveToken } from '@/services/auth';
import { streamExec } from '@/services/api';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static latest: FakeWebSocket | undefined;

  readyState = FakeWebSocket.CONNECTING;
  binaryType = '';
  sent: unknown[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void | Promise<void>) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor() {
    FakeWebSocket.latest = this;
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  async message(data: unknown) {
    await this.onmessage?.({ data });
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({});
  }
}

const originalWebSocket = globalThis.WebSocket;

async function createdSocket(): Promise<FakeWebSocket> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (FakeWebSocket.latest) return FakeWebSocket.latest;
    await Promise.resolve();
  }
  throw new Error('WebSocket was not created');
}

describe('streamExec stdin readiness', () => {
  beforeEach(async () => {
    FakeWebSocket.latest = undefined;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    await saveToken('spritesToken', 'test-token');
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  it('waits for session_info before allowing the first stdin write', async () => {
    const events: { type: string; data?: string }[] = [];
    const stream = streamExec(
      'sprite',
      ['codex', 'app-server', '--stdio'],
      (event) => events.push(event),
      undefined,
      {
        stdin: true,
        stdinReadyAfterSessionInfo: true,
        stdinReadyFallbackMs: 60_000,
        onStdinReady: (writer) => writer.write('{"method":"initialize"}\n'),
      }
    );

    const socket = await createdSocket();
    socket.open();
    expect(socket.sent).toEqual([]);

    // Sprites emits these lifecycle objects as newline-less text frames before
    // session_info. They are control-plane messages, not process stdout.
    await socket.message(JSON.stringify({ msg: 'session_created cmd=/bin/bash', pid: 123 }));
    await socket.message(JSON.stringify({ msg: 'session_started', pid: 123 }));
    await socket.message(
      JSON.stringify({ type: 'port_opened', port: 3000, address: '0.0.0.0', pid: 123 })
    );
    expect(events.filter((event) => event.type === 'stdout')).toEqual([]);

    await socket.message(JSON.stringify({ type: 'session_info', session_id: 'exec-1' }));
    expect(socket.sent).toHaveLength(1);
    const frame = new Uint8Array(socket.sent[0] as ArrayBuffer);
    expect(frame[0]).toBe(0);
    expect(new TextDecoder().decode(frame.slice(1))).toBe('{"method":"initialize"}\n');

    const stdoutText = '{"id":1,"result":{"userAgent":"test"}}\n';
    const stdoutPayload = new TextEncoder().encode(stdoutText);
    const stdoutFrame = new Uint8Array(stdoutPayload.length + 1);
    stdoutFrame[0] = 1;
    stdoutFrame.set(stdoutPayload, 1);
    await socket.message(stdoutFrame.buffer);
    expect(events).toContainEqual({ type: 'stdout', data: stdoutText });

    // Replayed session metadata must not initialize the protocol twice.
    await socket.message(JSON.stringify({ type: 'session_info', session_id: 'exec-1' }));
    expect(socket.sent).toHaveLength(1);

    await socket.message(JSON.stringify({ type: 'exit', exit_code: 0 }));
    await stream;
  });
});
