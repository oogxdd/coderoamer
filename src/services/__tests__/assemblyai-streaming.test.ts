import { describe, expect, it, vi } from 'vitest';

import {
  AssemblyAiStreamingSession,
  buildStreamingUrl,
  TranscriptAssembler,
  type StreamingWebSocket,
} from '@/services/assemblyai-streaming';

/**
 * A WebSocket the test drives by hand. `sent` keeps text frames and binary
 * frames apart, because mixing them up is exactly the bug that would make the
 * API see control messages as audio.
 */
class FakeSocket implements StreamingWebSocket {
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  readonly text: string[] = [];
  readonly audio: ArrayBuffer[] = [];
  closedWith: number | undefined;

  send(data: string | ArrayBuffer): void {
    if (typeof data === 'string') this.text.push(data);
    else this.audio.push(data);
  }

  close(code?: number): void {
    this.closedWith = code;
  }

  // ── test-side driving ──
  open(): void {
    this.onopen?.();
  }

  emit(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  begin(): void {
    this.emit({ type: 'Begin', id: 'session-1', expires_at: 0 });
  }

  fail(): void {
    this.onerror?.({ message: 'boom' });
  }

  serverClose(code = 1000, reason = ''): void {
    this.onclose?.({ code, reason });
  }
}

/** Starts a session, opening + confirming the socket the way the server would. */
async function startSession(
  overrides: Partial<Parameters<typeof AssemblyAiStreamingSession.start>[0]> = {}
) {
  const socket = new FakeSocket();
  const urls: string[] = [];
  const transcripts: { text: string; endOfTurn: boolean }[] = [];
  const errors: Error[] = [];

  const starting = AssemblyAiStreamingSession.start({
    apiKey: 'test-key',
    fetchToken: async () => 'temp-token',
    openSocket: (url) => {
      urls.push(url);
      return socket;
    },
    onTranscript: (text, info) => transcripts.push({ text, endOfTurn: info.endOfTurn }),
    onError: (error) => errors.push(error),
    ...overrides,
  });

  // Let `start` install its handlers before the "server" responds.
  await Promise.resolve();
  socket.open();
  socket.begin();
  const session = await starting;
  return { session, socket, urls, transcripts, errors };
}

describe('buildStreamingUrl', () => {
  it('sends the encoding and sample rate the microphone actually produces', () => {
    const url = new URL(buildStreamingUrl('tok', { sampleRate: 16000 }));
    expect(url.origin + url.pathname).toBe('wss://streaming.assemblyai.com/v3/ws');
    expect(url.searchParams.get('token')).toBe('tok');
    expect(url.searchParams.get('encoding')).toBe('pcm_s16le');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    // No languages requested: let the server pick its default model.
    expect(url.searchParams.get('speech_model')).toBeNull();
    expect(url.searchParams.get('language_codes')).toBeNull();
  });

  it('switches to the multilingual model when several languages are wanted', () => {
    const url = new URL(
      buildStreamingUrl('tok', { sampleRate: 16000, languageCodes: ['en', 'ru'] })
    );
    expect(url.searchParams.get('language_codes')).toBe('["en","ru"]');
    expect(url.searchParams.get('language_detection')).toBe('true');
    expect(url.searchParams.get('speech_model')).toBe('universal-streaming-multilingual');
  });

  it('keeps the default model for a single language', () => {
    const url = new URL(
      buildStreamingUrl('tok', { sampleRate: 16000, languageCodes: ['en'] })
    );
    expect(url.searchParams.get('speech_model')).toBeNull();
  });

  it('honours an explicitly pinned model', () => {
    const url = new URL(
      buildStreamingUrl('tok', {
        sampleRate: 8000,
        languageCodes: ['en', 'ru'],
        speechModel: 'universal-streaming-english',
      })
    );
    expect(url.searchParams.get('speech_model')).toBe('universal-streaming-english');
  });
});

describe('TranscriptAssembler', () => {
  it('replaces partials instead of appending them', () => {
    const assembler = new TranscriptAssembler();
    assembler.accept({ transcript: 'add a' });
    assembler.accept({ transcript: 'add a retry' });
    expect(assembler.text).toBe('add a retry');
  });

  it('keeps finished turns and starts the next one clean', () => {
    const assembler = new TranscriptAssembler();
    assembler.accept({ transcript: 'add a retry' });
    expect(assembler.accept({ utterance: 'Add a retry.', end_of_turn: true })).toBe(true);
    assembler.accept({ transcript: 'then run the tests' });
    expect(assembler.text).toBe('Add a retry. then run the tests');
  });

  it('falls back to the running transcript when a turn has no utterance', () => {
    const assembler = new TranscriptAssembler();
    assembler.accept({ transcript: 'no utterance here', end_of_turn: true });
    expect(assembler.text).toBe('no utterance here');
  });

  it('ignores an empty final turn rather than adding blank spacing', () => {
    const assembler = new TranscriptAssembler();
    assembler.accept({ transcript: 'first.', end_of_turn: true });
    assembler.accept({ transcript: '   ', end_of_turn: true });
    assembler.accept({ transcript: 'second' });
    expect(assembler.text).toBe('first. second');
  });
});

describe('AssemblyAiStreamingSession', () => {
  it('waits for Begin before reporting itself open', async () => {
    const socket = new FakeSocket();
    const starting = AssemblyAiStreamingSession.start({
      apiKey: 'test-key',
      fetchToken: async () => 'temp-token',
      openSocket: () => socket,
    });
    await Promise.resolve();
    socket.open();

    let settled = false;
    void starting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.begin();
    await expect(starting).resolves.toBeInstanceOf(AssemblyAiStreamingSession);
  });

  it('reports the growing transcript on every turn', async () => {
    const { socket, transcripts } = await startSession();

    socket.emit({ type: 'Turn', turn_order: 0, transcript: 'add a', end_of_turn: false });
    socket.emit({ type: 'Turn', turn_order: 0, transcript: 'add a retry', end_of_turn: false });
    socket.emit({
      type: 'Turn',
      turn_order: 0,
      transcript: 'add a retry',
      utterance: 'Add a retry.',
      end_of_turn: true,
    });

    expect(transcripts).toEqual([
      { text: 'add a', endOfTurn: false },
      { text: 'add a retry', endOfTurn: false },
      { text: 'Add a retry.', endOfTurn: true },
    ]);
  });

  it('sends audio as binary frames and control messages as text', async () => {
    const { session, socket } = await startSession();

    session.sendAudio(new Uint8Array([1, 2, 3, 4]));
    session.forceEndpoint();

    expect(socket.audio).toHaveLength(1);
    expect(new Uint8Array(socket.audio[0])).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(socket.text).toEqual([JSON.stringify({ type: 'ForceEndpoint' })]);
  });

  it('sends only the bytes of a frame that views a larger buffer', async () => {
    const { session, socket } = await startSession();
    // A view into a larger buffer, which is what a frame slice looks like.
    const pool = new Uint8Array([9, 9, 1, 2, 9, 9]);
    session.sendAudio(pool.subarray(2, 4));

    expect(new Uint8Array(socket.audio[0])).toEqual(new Uint8Array([1, 2]));
  });

  it('queues audio produced before the session is confirmed', async () => {
    const socket = new FakeSocket();
    const starting = AssemblyAiStreamingSession.start({
      apiKey: 'test-key',
      fetchToken: async () => 'temp-token',
      openSocket: () => socket,
    });
    await Promise.resolve();
    socket.open();
    socket.begin();
    const session = await starting;

    // Nothing is lost even though the microphone was already running.
    session.sendAudio(new Uint8Array([7, 7]));
    expect(socket.audio).toHaveLength(1);
  });

  it('finishes by terminating and resolving with the whole transcript', async () => {
    const { session, socket } = await startSession();
    socket.emit({ type: 'Turn', transcript: 'ship it', end_of_turn: true });

    const finishing = session.finish();
    expect(socket.text).toContain(JSON.stringify({ type: 'Terminate' }));

    socket.emit({ type: 'Termination', audio_duration_seconds: 2 });
    await expect(finishing).resolves.toBe('ship it');
    expect(socket.closedWith).toBe(1000);
  });

  it('still returns the dictated words if the server never confirms shutdown', async () => {
    vi.useFakeTimers();
    try {
      const { session, socket } = await startSession();
      socket.emit({ type: 'Turn', transcript: 'half a sentence', end_of_turn: true });

      const finishing = session.finish();
      await vi.advanceTimersByTimeAsync(5000);

      await expect(finishing).resolves.toBe('half a sentence');
      expect(socket.closedWith).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a key the token endpoint refuses', async () => {
    await expect(
      AssemblyAiStreamingSession.start({
        apiKey: 'bad-key',
        fetchToken: async () => {
          throw new Error('AssemblyAI rejected this API key.');
        },
        openSocket: () => new FakeSocket(),
      })
    ).rejects.toThrow(/rejected this API key/);
  });

  it('refuses to open without a key instead of asking the server', async () => {
    const openSocket = vi.fn(() => new FakeSocket());
    await expect(
      AssemblyAiStreamingSession.start({ apiKey: '   ', openSocket })
    ).rejects.toThrow(/API key is not saved/);
    expect(openSocket).not.toHaveBeenCalled();
  });

  it('fails the start when the server refuses the session after connecting', async () => {
    const socket = new FakeSocket();
    const starting = AssemblyAiStreamingSession.start({
      apiKey: 'test-key',
      fetchToken: async () => 'expired-token',
      openSocket: () => socket,
    });
    await Promise.resolve();
    socket.open();
    socket.emit({ error: 'Invalid or expired token' });

    await expect(starting).rejects.toThrow('Invalid or expired token');
  });

  it('reports an unexpected close as an error mid-session', async () => {
    const { socket, errors } = await startSession();
    socket.serverClose(1013, 'Try again later');

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Try again later');
  });

  it('treats a clean close as a clean close', async () => {
    const { socket, errors } = await startSession();
    socket.serverClose(1000);
    expect(errors).toEqual([]);
  });

  it('drops audio after the session is aborted', async () => {
    const { session, socket } = await startSession();
    session.abort();
    session.sendAudio(new Uint8Array([1, 2]));

    expect(socket.audio).toHaveLength(0);
    expect(socket.closedWith).toBe(1000);
  });
});
