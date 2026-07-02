import { Dispatch, SetStateAction, useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { transcribeAudioOnSprite } from '@/services/audio-transcription';
import {
  TranscriptionProvider,
  transcribeAudioWithCloudProvider,
} from '@/services/client-transcription';

export type DictationMode =
  | 'idle'
  | 'client-listening'
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
  if (provider === 'sprite') {
    return transcribeAudioOnSprite({ spriteName, workingDirectory, audio });
  }
  return transcribeAudioWithCloudProvider(provider, audio);
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

  modeRef.current = mode;

  const insertTranscript = useCallback(
    (transcript: string) => {
      setInputText((current) => appendTranscript(current, transcript));
    },
    [setInputText]
  );

  useSpeechRecognitionEvent('start', () => {
    setError(undefined);
    setMode('client-listening');
  });

  useSpeechRecognitionEvent('end', () => {
    if (modeRef.current === 'client-listening') {
      setMode('idle');
    }
  });

  useSpeechRecognitionEvent('result', (event: any) => {
    if (modeRef.current !== 'client-listening') return;
    const transcript = event.results?.[0]?.transcript ?? '';
    if (!transcript.trim()) return;
    setInputText(appendTranscript(clientBaseTextRef.current, transcript));
  });

  useSpeechRecognitionEvent('error', (event: any) => {
    setError(event.message ?? event.error ?? 'Speech recognition failed.');
    setMode('idle');
  });

  const toggleClientDictation = useCallback(async () => {
    if (modeRef.current === 'client-listening') {
      ExpoSpeechRecognitionModule.stop();
      setMode('idle');
      return;
    }
    if (modeRef.current !== 'idle') return;

    try {
      setError(undefined);
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        setError('Microphone or speech recognition permission was denied.');
        return;
      }

      clientBaseTextRef.current = inputText;
      ExpoSpeechRecognitionModule.start({
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
  }, [inputText]);

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
    isClientDictating: mode === 'client-listening',
    isSpriteRecording: mode === 'sprite-recording',
    isTranscribing: mode === 'sprite-transcribing' || mode === 'file-transcribing',
    toggleClientDictation,
    toggleSpriteRecording,
    pickAudioFile,
  };
}
