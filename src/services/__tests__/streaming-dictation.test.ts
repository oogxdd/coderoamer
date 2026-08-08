import { describe, expect, it, vi } from 'vitest';

import { batchProviderFor } from '@/services/client-transcription';
import {
  startStreamingDictation,
  type DictationCapture,
} from '@/services/streaming-dictation';

/** A microphone the test speaks into by hand. */
function fakeCapture(sampleRate = 16000) {
  const state = {
    started: false,
    stopped: false,
    frames: [] as Uint8Array[],
    emit: (_frame: Uint8Array) => {},
    startError: null as Error | null,
    stopError: null as Error | null,
  };
  const capture: DictationCapture = {
    sampleRate,
    async start(onFrame) {
      if (state.startError) throw state.startError;
      state.started = true;
      state.emit = onFrame;
    },
    async stop() {
      state.stopped = true;
      if (state.stopError) throw state.stopError;
    },
  };
  return { capture, state };
}

/** A stand-in for the streaming session, recording what it was told to do. */
function fakeSession(text = '') {
  const state = {
    audio: [] as Uint8Array[],
    finished: false,
    aborted: false,
    sampleRate: 0,
    languageCodes: [] as string[] | undefined,
    onTranscript: undefined as ((text: string, info: { endOfTurn: boolean }) => void) | undefined,
    onError: undefined as ((error: Error) => void) | undefined,
    startError: null as Error | null,
  };
  const start = vi.fn(async (options: any) => {
    if (state.startError) throw state.startError;
    state.sampleRate = options.sampleRate;
    state.languageCodes = options.languageCodes;
    state.onTranscript = options.onTranscript;
    state.onError = options.onError;
    return {
      sendAudio: (frame: Uint8Array) => state.audio.push(frame),
      finish: async () => {
        state.finished = true;
        return text;
      },
      abort: () => {
        state.aborted = true;
      },
    } as any;
  });
  return { start, state };
}

describe('batchProviderFor', () => {
  it('routes a recorded file through the batch API even in streaming mode', () => {
    expect(batchProviderFor('assemblyai-streaming')).toBe('assemblyai');
  });

  it('leaves the upload-based providers alone', () => {
    expect(batchProviderFor('assemblyai')).toBe('assemblyai');
    expect(batchProviderFor('openai')).toBe('openai');
    expect(batchProviderFor('sprite')).toBe('sprite');
  });
});

describe('startStreamingDictation', () => {
  it('pushes microphone frames into the session', async () => {
    const { capture, state: mic } = fakeCapture();
    const { start, state: session } = fakeSession();

    await startStreamingDictation({
      apiKey: 'key',
      createCapture: () => capture,
      startSession: start,
    });

    mic.emit(new Uint8Array([1, 2]));
    mic.emit(new Uint8Array([3, 4]));
    expect(session.audio).toEqual([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
  });

  it('tells the session the rate the microphone actually runs at', async () => {
    const { capture } = fakeCapture(48000);
    const { start, state: session } = fakeSession();

    await startStreamingDictation({
      apiKey: 'key',
      createCapture: () => capture,
      startSession: start,
    });

    // Sending 48 kHz audio while claiming 16 kHz is heard as chipmunk speech.
    expect(session.sampleRate).toBe(48000);
  });

  it('defaults to the languages the batch path already assumes', async () => {
    const { capture } = fakeCapture();
    const { start, state: session } = fakeSession();

    await startStreamingDictation({
      apiKey: 'key',
      createCapture: () => capture,
      startSession: start,
    });

    expect(session.languageCodes).toEqual(['en', 'ru']);
  });

  it('forwards live transcripts to the caller', async () => {
    const { capture } = fakeCapture();
    const { start, state: session } = fakeSession();
    const seen: string[] = [];

    await startStreamingDictation({
      apiKey: 'key',
      createCapture: () => capture,
      startSession: start,
      onTranscript: (text) => seen.push(text),
    });

    session.onTranscript?.('add a', { endOfTurn: false });
    session.onTranscript?.('add a retry', { endOfTurn: true });
    expect(seen).toEqual(['add a', 'add a retry']);
  });

  it('opens the socket before touching the microphone', async () => {
    const order: string[] = [];
    const { capture } = fakeCapture();
    const trackedCapture: DictationCapture = {
      sampleRate: capture.sampleRate,
      start: async (onFrame) => {
        order.push('mic');
        await capture.start(onFrame);
      },
      stop: capture.stop,
    };
    const { start } = fakeSession();
    const trackedStart = vi.fn(async (options: any) => {
      order.push('socket');
      return start(options);
    });

    await startStreamingDictation({
      apiKey: 'key',
      createCapture: () => trackedCapture,
      startSession: trackedStart,
    });

    // A session that can never work should not have recorded anything first.
    expect(order).toEqual(['socket', 'mic']);
  });

  it('never starts the microphone when the session is refused', async () => {
    const { capture, state: mic } = fakeCapture();
    const { start, state: session } = fakeSession();
    session.startError = new Error('AssemblyAI rejected this API key.');

    await expect(
      startStreamingDictation({
        apiKey: 'bad',
        createCapture: () => capture,
        startSession: start,
      })
    ).rejects.toThrow(/rejected this API key/);
    expect(mic.started).toBe(false);
  });

  it('closes the session when the microphone will not start', async () => {
    const { capture, state: mic } = fakeCapture();
    mic.startError = new Error('Microphone permission was denied.');
    const { start, state: session } = fakeSession();

    await expect(
      startStreamingDictation({
        apiKey: 'key',
        createCapture: () => capture,
        startSession: start,
      })
    ).rejects.toThrow(/permission was denied/);
    // Otherwise the socket would sit open being billed for silence.
    expect(session.aborted).toBe(true);
  });

  it('stops the microphone before finishing the session', async () => {
    const order: string[] = [];
    const { capture } = fakeCapture();
    const trackedCapture: DictationCapture = {
      sampleRate: 16000,
      start: capture.start,
      stop: async () => {
        order.push('mic');
      },
    };
    const start = vi.fn(async () => ({
      sendAudio: () => {},
      finish: async () => {
        order.push('session');
        return 'ship it';
      },
      abort: () => {},
    })) as any;

    const handle = await startStreamingDictation({
      apiKey: 'key',
      createCapture: () => trackedCapture,
      startSession: start,
    });

    await expect(handle.stop()).resolves.toBe('ship it');
    // The other order would cut off whatever was said last.
    expect(order).toEqual(['mic', 'session']);
  });

  it('finishes once however many times stop is called', async () => {
    const { capture } = fakeCapture();
    let finishes = 0;
    const start = vi.fn(async () => ({
      sendAudio: () => {},
      finish: async () => {
        finishes += 1;
        return 'once';
      },
      abort: () => {},
    })) as any;

    const handle = await startStreamingDictation({
      apiKey: 'key',
      createCapture: () => capture,
      startSession: start,
    });

    const [first, second] = await Promise.all([handle.stop(), handle.stop()]);
    expect([first, second]).toEqual(['once', 'once']);
    expect(finishes).toBe(1);
  });

  it('still returns the transcript when releasing the microphone fails', async () => {
    const { capture, state: mic } = fakeCapture();
    mic.stopError = new Error('audio session already gone');
    const { start } = fakeSession('keep these words');
    const errors: Error[] = [];

    const handle = await startStreamingDictation({
      apiKey: 'key',
      createCapture: () => capture,
      startSession: start,
      onError: (error) => errors.push(error),
    });

    await expect(handle.stop()).resolves.toBe('keep these words');
    expect(errors.map((error) => error.message)).toEqual(['audio session already gone']);
  });

  it('releases both sides on abort', async () => {
    const { capture, state: mic } = fakeCapture();
    const { start, state: session } = fakeSession();

    const handle = await startStreamingDictation({
      apiKey: 'key',
      createCapture: () => capture,
      startSession: start,
    });
    handle.abort();

    expect(session.aborted).toBe(true);
    expect(mic.stopped).toBe(true);
  });
});
