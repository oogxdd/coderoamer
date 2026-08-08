// Live AssemblyAI dictation: microphone → PCM frames → streaming socket → text
// in the chat input while the user is still talking.
//
// Capture is the platform-specific half and is kept behind `DictationCapture`
// so the orchestration below — frame pumping, stop ordering, error handling — is
// testable with a fake microphone.
//
// Native capture is roundabout for a reason: nothing in this app's dependency
// set hands out live PCM buffers. `expo-speech-recognition` can persist its
// capture as a 16 kHz PCM16 WAV while it records, so that file is tailed as it
// grows (see `pcm-audio.ts`). That reuses the module the `Mic` button already
// needs, instead of adding a second native audio dependency.

import { Platform } from 'react-native';

import {
  AssemblyAiStreamingSession,
  STREAMING_SAMPLE_RATE,
} from '@/services/assemblyai-streaming';
import { base64ToBytes } from '@/services/base64';
import {
  DEFAULT_TAIL_POLL_MS,
  float32ToPcm16,
  WavTail,
  type TailingFileReader,
} from '@/services/pcm-audio';

/** Languages the batch AssemblyAI path already assumes; kept in step. */
export const STREAMING_LANGUAGE_CODES = ['en', 'ru'];

export interface DictationCapture {
  /** Must match the frames handed to `onFrame`. */
  readonly sampleRate: number;
  start(onFrame: (frame: Uint8Array) => void): Promise<void>;
  /** Flush any buffered audio, then release the microphone. */
  stop(): Promise<void>;
}

export interface StreamingDictationHandle {
  /** Stop the microphone, close the session, resolve with the full transcript. */
  stop(): Promise<string>;
  /** Give up without waiting for the server. */
  abort(): void;
}

export interface StreamingDictationOptions {
  apiKey: string;
  languageCodes?: string[];
  /** Live text for the input box, replacing whatever was shown before. */
  onTranscript?: (text: string) => void;
  onError?: (error: Error) => void;
  createCapture?: () => DictationCapture;
  startSession?: typeof AssemblyAiStreamingSession.start;
}

/**
 * Opens the socket *before* the microphone: a session that is never going to
 * work (no key, refused token) should fail without having recorded anything or
 * shown a recording indicator.
 */
export async function startStreamingDictation(
  options: StreamingDictationOptions
): Promise<StreamingDictationHandle> {
  const capture = (options.createCapture ?? createPlatformCapture)();
  const start = options.startSession ?? AssemblyAiStreamingSession.start;

  const session = await start({
    apiKey: options.apiKey,
    sampleRate: capture.sampleRate,
    languageCodes: options.languageCodes ?? STREAMING_LANGUAGE_CODES,
    onTranscript: (text) => options.onTranscript?.(text),
    onError: options.onError,
  });

  try {
    await capture.start((frame) => session.sendAudio(frame));
  } catch (error) {
    session.abort();
    throw error;
  }

  let settled: Promise<string> | null = null;
  return {
    stop: () => {
      // Idempotent: the stop button and an unmount can both land here.
      settled ??= (async () => {
        // Microphone first, so the last words make it into the socket before
        // the server is told the stream is over.
        await capture.stop().catch((error) => options.onError?.(error as Error));
        return session.finish();
      })();
      return settled;
    },
    abort: () => {
      void capture.stop().catch(() => {});
      session.abort();
    },
  };
}

function createPlatformCapture(): DictationCapture {
  return Platform.OS === 'web' ? createWebAudioCapture() : createNativeWavCapture();
}

// ── Web ───────────────────────────────────────────────────────────────────────

/**
 * Web Audio gives real live PCM, so the web path is a direct feed. The context
 * is asked for 16 kHz, but whatever rate it actually reports is what gets sent —
 * AssemblyAI accepts 8–96 kHz, which is cheaper than resampling here.
 */
export function createWebAudioCapture(): DictationCapture {
  let context: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let rate = STREAMING_SAMPLE_RATE;

  return {
    get sampleRate() {
      return rate;
    },
    async start(onFrame) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      context = new AudioContext({ sampleRate: STREAMING_SAMPLE_RATE });
      rate = context.sampleRate;
      source = context.createMediaStreamSource(stream);
      // 4096 frames is ~256ms at 16 kHz — inside AssemblyAI's 50–1000ms window.
      processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        onFrame(float32ToPcm16(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(context.destination);
    },
    async stop() {
      processor?.disconnect();
      source?.disconnect();
      if (processor) processor.onaudioprocess = null;
      stream?.getTracks().forEach((track) => track.stop());
      await context?.close().catch(() => {});
      processor = null;
      source = null;
      stream = null;
      context = null;
    },
  };
}

// ── Native ────────────────────────────────────────────────────────────────────

type SpeechRecognitionModule = {
  addListener: (
    eventName: string,
    listener: (event: any) => void
  ) => { remove: () => void };
  requestPermissionsAsync: () => Promise<{ granted: boolean }>;
  start: (options: Record<string, unknown>) => void;
  stop: () => void;
};

function loadSpeechRecognitionModule(): SpeechRecognitionModule | null {
  // Same optional-native-module dance as useChatDictation: absent in a dev app
  // built before the package was added.
  const { requireOptionalNativeModule } = require('expo');
  return (
    requireOptionalNativeModule<SpeechRecognitionModule>('ExpoSpeechRecognition') ?? null
  );
}

/** A byte-range reader over a local file, for `WavTail`. */
export function createFileTailReader(uri: string): TailingFileReader {
  const FileSystem = require('expo-file-system/legacy');
  return {
    async size() {
      const info = await FileSystem.getInfoAsync(uri, { size: true });
      return info?.exists ? (info.size ?? 0) : null;
    },
    async read(offset, length) {
      if (length <= 0) return new Uint8Array(0);
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: 'base64',
        position: offset,
        length,
      });
      return base64ToBytes(base64);
    },
  };
}

const AUDIO_START_TIMEOUT_MS = 8000;

/**
 * Records with `expo-speech-recognition`'s persisted WAV and tails it.
 *
 * The module's own recognition results are ignored — AssemblyAI is doing the
 * transcribing. On-device recognition is requested so the OS recognizer does not
 * also ship audio somewhere, and the recording is kept to 16 kHz PCM16, which is
 * exactly what the streaming socket wants.
 */
export function createNativeWavCapture(): DictationCapture {
  let module: SpeechRecognitionModule | null = null;
  let tail: WavTail | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let subscriptions: { remove: () => void }[] = [];
  let polling = false;

  const stopPolling = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    sampleRate: STREAMING_SAMPLE_RATE,
    async start(onFrame) {
      module = loadSpeechRecognitionModule();
      if (!module) {
        throw new Error(
          'Live AssemblyAI dictation needs the speech-recognition module — rebuild the dev app.'
        );
      }
      const permission = await module.requestPermissionsAsync();
      if (!permission.granted) {
        throw new Error('Microphone permission was denied.');
      }

      const audioUri = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('The recorder did not start.')),
          AUDIO_START_TIMEOUT_MS
        );
        subscriptions.push(
          module!.addListener('audiostart', (event: { uri: string | null }) => {
            clearTimeout(timeout);
            if (event.uri) resolve(event.uri);
            else reject(new Error('The recorder did not produce an audio file.'));
          }),
          module!.addListener('error', (event: any) => {
            clearTimeout(timeout);
            reject(new Error(event?.message ?? event?.error ?? 'Recording failed.'));
          })
        );

        module!.start({
          lang: 'en-US',
          interimResults: false,
          continuous: true,
          requiresOnDeviceRecognition: true,
          recordingOptions: {
            persist: true,
            outputSampleRate: STREAMING_SAMPLE_RATE,
            outputEncoding: 'pcmFormatInt16',
          },
        });
      });

      tail = new WavTail({
        reader: createFileTailReader(audioUri),
        sampleRate: STREAMING_SAMPLE_RATE,
        onFrame,
      });
      timer = setInterval(() => {
        // Skip a tick rather than stacking reads if the filesystem is slow.
        if (polling || !tail) return;
        polling = true;
        void tail
          .poll()
          .catch(() => {})
          .finally(() => {
            polling = false;
          });
      }, DEFAULT_TAIL_POLL_MS);
    },
    async stop() {
      stopPolling();
      module?.stop();
      subscriptions.forEach((subscription) => subscription.remove());
      subscriptions = [];
      // The recorder flushes its last buffers as it stops, so read once more
      // after asking it to stop — otherwise the final word is lost.
      await tail?.finish().catch(() => {});
      tail = null;
      module = null;
    },
  };
}
