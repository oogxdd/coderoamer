import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { requireOptionalNativeModule } from 'expo';
import { loadToken } from '@/services/auth';
import { transcribeAudioOnSprite } from '@/services/audio-transcription';
import {
  batchProviderFor,
  TranscriptionProvider,
  transcribeAudioWithCloudProvider,
} from '@/services/client-transcription';
import {
  startStreamingDictation,
  type StreamingDictationHandle,
} from '@/services/streaming-dictation';

export type DictationMode =
  | 'idle'
  /** On-device recognition streaming into the input box. */
  | 'client-listening'
  /** AssemblyAI's streaming socket doing the same job over the network. */
  | 'streaming-listening'
  | 'streaming-connecting'
  | 'sprite-recording'
  | 'sprite-transcribing'
  | 'file-transcribing';

interface UseChatDictationOptions {
  spriteName: string;
  workingDirectory: string;
  inputText: string;
  setInputText: Dispatch<SetStateAction<string>>;
  transcriptionProvider: TranscriptionProvider;
}

type SpeechRecognitionModule = {
  addListener: (eventName: string, listener: (event: any) => void) => { remove: () => void };
  requestPermissionsAsync: () => Promise<{ granted: boolean }>;
  start: (options: Record<string, unknown>) => void;
  stop: () => void;
};

let speechRecognitionModule: SpeechRecognitionModule | null | undefined;

function getSpeechRecognitionModule(): SpeechRecognitionModule | null {
  if (speechRecognitionModule !== undefined) return speechRecognitionModule ?? null;
  if (Platform.OS === 'web') {
    // The package registers a web shim; native builds must avoid importing it
    // unless the actual native module is present in the dev app.
    speechRecognitionModule = require('expo-speech-recognition').ExpoSpeechRecognitionModule;
  } else {
    speechRecognitionModule =
      requireOptionalNativeModule<SpeechRecognitionModule>('ExpoSpeechRecognition');
  }
  return speechRecognitionModule ?? null;
}

function appendTranscript(current: string, transcript: string): string {
  const cleaned = transcript.replace(/\s+/g, ' ').trim();
  if (!cleaned) return current;
  const base = current.replace(/\s+$/g, '');
  return base ? `${base} ${cleaned}` : cleaned;
}

function statusForMode(mode: DictationMode): string | undefined {
  switch (mode) {
    case 'client-listening':
      return 'Listening...';
    case 'streaming-connecting':
      return 'Connecting to AssemblyAI...';
    case 'streaming-listening':
      return 'Listening (AssemblyAI)...';
    case 'sprite-recording':
      return 'Recording...';
    case 'sprite-transcribing':
      return 'Transcribing recording on sprite...';
    case 'file-transcribing':
      return 'Transcribing file on sprite...';
    case 'idle':
      return undefined;
  }
}

async function transcribeAudio({
  provider,
  spriteName,
  workingDirectory,
  audio,
}: {
  provider: TranscriptionProvider;
  spriteName: string;
  workingDirectory: string;
  audio: Parameters<typeof transcribeAudioOnSprite>[0]['audio'];
}): Promise<string> {
  // A finished recording always goes through an upload-based provider, even
  // when the live provider is selected.
  const batch = batchProviderFor(provider);
  if (batch === 'sprite') {
    return transcribeAudioOnSprite({ spriteName, workingDirectory, audio });
  }
  return transcribeAudioWithCloudProvider(batch, audio);
}

export function useChatDictation({
  spriteName,
  workingDirectory,
  inputText,
  setInputText,
  transcriptionProvider,
}: UseChatDictationOptions) {
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [mode, setMode] = useState<DictationMode>('idle');
  const [error, setError] = useState<string | undefined>();
  const modeRef = useRef<DictationMode>('idle');
  const clientBaseTextRef = useRef('');
  const streamingRef = useRef<StreamingDictationHandle | null>(null);

  modeRef.current = mode;

  // Leaving the chat while dictating must not leave the socket open and the
  // microphone hot.
  useEffect(
    () => () => {
      streamingRef.current?.abort();
      streamingRef.current = null;
    },
    []
  );

  const insertTranscript = useCallback(
    (transcript: string) => {
      setInputText((current) => appendTranscript(current, transcript));
    },
    [setInputText]
  );

  useEffect(() => {
    const module = getSpeechRecognitionModule();
    if (!module) return;

    const subscriptions = [
      module.addListener('start', () => {
        setError(undefined);
        setMode('client-listening');
      }),
      module.addListener('end', () => {
        if (modeRef.current === 'client-listening') {
          setMode('idle');
        }
      }),
      module.addListener('result', (event: any) => {
        if (modeRef.current !== 'client-listening') return;
        const transcript = event.results?.[0]?.transcript ?? '';
        if (!transcript.trim()) return;
        setInputText(appendTranscript(clientBaseTextRef.current, transcript));
      }),
      module.addListener('error', (event: any) => {
        setError(event.message ?? event.error ?? 'Speech recognition failed.');
        setMode('idle');
      }),
    ];

    return () => {
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, [setInputText]);

  /**
   * The AssemblyAI streaming counterpart of on-device dictation: same button,
   * same live-text-into-the-input behaviour, different engine. Useful where the
   * OS recognizer is weak (Android, mixed languages) or where its quality
   * simply isn't good enough for a prompt you're about to hand to an agent.
   */
  const toggleStreamingDictation = useCallback(async () => {
    if (modeRef.current === 'streaming-listening') {
      const handle = streamingRef.current;
      streamingRef.current = null;
      setMode('idle');
      // The final text already arrived through onTranscript; awaiting the
      // shutdown only matters for releasing the socket.
      await handle?.stop().catch(() => {});
      return;
    }
    if (modeRef.current !== 'idle') return;

    setError(undefined);
    setMode('streaming-connecting');
    clientBaseTextRef.current = inputText;
    // A failure reported while connecting already moves us back to idle;
    // this flag stops us from painting over it with "listening".
    let cancelled = false;
    try {
      const apiKey = (await loadToken('assemblyAiToken'))?.trim();
      if (!apiKey) {
        throw new Error('AssemblyAI API key is not saved. Add it in Settings.');
      }
      const handle = await startStreamingDictation({
        apiKey,
        onTranscript: (text) => {
          setInputText(appendTranscript(clientBaseTextRef.current, text));
        },
        onError: (streamError) => {
          setError(streamError.message);
          streamingRef.current = null;
          cancelled = true;
          setMode('idle');
        },
      });
      streamingRef.current = handle;
      if (cancelled) {
        handle.abort();
      } else {
        setMode('streaming-listening');
      }
    } catch (err) {
      setError((err as Error).message);
      setMode('idle');
    }
  }, [inputText, setInputText]);

  const toggleClientDictation = useCallback(async () => {
    if (transcriptionProvider === 'assemblyai-streaming') {
      await toggleStreamingDictation();
      return;
    }
    const module = getSpeechRecognitionModule();
    if (!module) {
      setError('Live speech recognition requires rebuilding the iOS dev app.');
      setMode('idle');
      return;
    }

    if (modeRef.current === 'client-listening') {
      module.stop();
      setMode('idle');
      return;
    }
    if (modeRef.current !== 'idle') return;

    try {
      setError(undefined);
      const permission = await module.requestPermissionsAsync();
      if (!permission.granted) {
        setError('Microphone or speech recognition permission was denied.');
        return;
      }

      clientBaseTextRef.current = inputText;
      module.start({
        lang: 'en-US',
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        requiresOnDeviceRecognition: false,
      });
    } catch (err) {
      setError((err as Error).message);
      setMode('idle');
    }
  }, [inputText, transcriptionProvider, toggleStreamingDictation]);

  const startSpriteRecording = useCallback(async () => {
    if (modeRef.current !== 'idle') return;

    try {
      setError(undefined);
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError('Microphone permission was denied.');
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      await audioRecorder.prepareToRecordAsync();
      await audioRecorder.record();
      setMode('sprite-recording');
    } catch (err) {
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      setError((err as Error).message);
      setMode('idle');
    }
  }, [audioRecorder]);

  const stopSpriteRecording = useCallback(async () => {
    if (modeRef.current !== 'sprite-recording') return;

    setMode('sprite-transcribing');
    try {
      const stopResult = await audioRecorder.stop();
      const uri = typeof stopResult === 'string' ? stopResult : audioRecorder.uri;
      await setAudioModeAsync({ allowsRecording: false });

      if (!uri) {
        throw new Error('Recording did not produce an audio file.');
      }

      const transcript = await transcribeAudio({
        provider: transcriptionProvider,
        spriteName,
        workingDirectory,
        audio: {
          uri,
          name: `dictation-${Date.now().toString(36)}.${Platform.OS === 'ios' ? 'm4a' : 'webm'}`,
          mimeType: Platform.OS === 'ios' ? 'audio/mp4' : 'audio/webm',
        },
      });
      insertTranscript(transcript);
      setMode('idle');
    } catch (err) {
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      setError((err as Error).message);
      setMode('idle');
    }
  }, [audioRecorder, insertTranscript, spriteName, transcriptionProvider, workingDirectory]);

  const toggleSpriteRecording = useCallback(async () => {
    if (modeRef.current === 'sprite-recording') {
      await stopSpriteRecording();
      return;
    }
    await startSpriteRecording();
  }, [startSpriteRecording, stopSpriteRecording]);

  const pickAudioFile = useCallback(async () => {
    if (modeRef.current !== 'idle') return;

    try {
      setError(undefined);
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;

      const asset = result.assets?.[0];
      if (!asset?.uri) return;

      setMode('file-transcribing');
      const transcript = await transcribeAudio({
        provider: transcriptionProvider,
        spriteName,
        workingDirectory,
        audio: {
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType,
          size: asset.size,
          file: asset.file,
        },
      });
      insertTranscript(transcript);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMode('idle');
    }
  }, [insertTranscript, spriteName, transcriptionProvider, workingDirectory]);

  const clearDictationError = useCallback(() => {
    setError(undefined);
  }, []);

  return {
    mode,
    status: statusForMode(mode),
    error,
    clearDictationError,
    // Both live engines drive the same mic button, so the UI treats them alike.
    isClientDictating: mode === 'client-listening' || mode === 'streaming-listening',
    isSpriteRecording: mode === 'sprite-recording',
    isTranscribing:
      mode === 'sprite-transcribing' ||
      mode === 'file-transcribing' ||
      mode === 'streaming-connecting',
    toggleClientDictation,
    toggleSpriteRecording,
    pickAudioFile,
  };
}
