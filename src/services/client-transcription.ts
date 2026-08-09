import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { loadToken } from '@/services/auth';
import { LocalAudioFile } from '@/services/audio-transcription';
import { base64ToBytes } from '@/services/base64';

/** Providers that transcribe a finished recording by uploading it. */
export type CloudTranscriptionProvider = 'assemblyai' | 'openai';
/**
 * `assemblyai-streaming` is not in `CloudTranscriptionProvider`: it never
 * uploads a file, so it has no place in the record-then-transcribe paths. It is
 * a live-dictation provider only (`streaming-dictation.ts`).
 */
export type TranscriptionProvider =
  | 'sprite'
  | CloudTranscriptionProvider
  | 'assemblyai-streaming';

/**
 * Which upload-based provider handles a finished recording or a picked file.
 *
 * Streaming has no file mode, and feeding a file through the realtime socket
 * would be slower and less accurate than the batch API, so it maps to plain
 * AssemblyAI — the same key, the same account.
 */
export function batchProviderFor(
  provider: TranscriptionProvider
): 'sprite' | CloudTranscriptionProvider {
  return provider === 'assemblyai-streaming' ? 'assemblyai' : provider;
}

const ASSEMBLYAI_BASE_URL = 'https://api.assemblyai.com/v2';
const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_AUDIO_UPLOAD_BYTES = 50 * 1024 * 1024;

function safeFileName(value: string | null | undefined, fallbackExt = 'm4a'): string {
  const fallback = `dictation-${Date.now().toString(36)}.${fallbackExt}`;
  const name = (value || fallback).split('/').pop() || fallback;
  return name.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120) || fallback;
}

async function readLocalAudioBytes(audio: LocalAudioFile): Promise<Uint8Array> {
  if (audio.size && audio.size > MAX_AUDIO_UPLOAD_BYTES) {
    throw new Error('Audio file is too large to upload for transcription.');
  }

  if (audio.file?.arrayBuffer) {
    const buffer = await audio.file.arrayBuffer();
    return new Uint8Array(buffer);
  }

  if (Platform.OS === 'web') {
    const response = await fetch(audio.uri);
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  const base64 = await FileSystem.readAsStringAsync(audio.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return base64ToBytes(base64);
}

function makeAudioBlob(bytes: Uint8Array, mimeType?: string | null): Blob {
  return new Blob([bytes.buffer as ArrayBuffer], {
    type: mimeType ?? 'application/octet-stream',
  });
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function transcribeWithAssemblyAI(audio: LocalAudioFile): Promise<string> {
  const apiKey = (await loadToken('assemblyAiToken'))?.trim();
  if (!apiKey) {
    throw new Error('AssemblyAI API key is not saved. Add it in Settings.');
  }

  const bytes = await readLocalAudioBytes(audio);
  if (bytes.byteLength > MAX_AUDIO_UPLOAD_BYTES) {
    throw new Error('Audio file is too large to upload for transcription.');
  }

  const uploadResponse = await fetch(`${ASSEMBLYAI_BASE_URL}/upload`, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': audio.mimeType ?? 'application/octet-stream',
    },
    body: makeAudioBlob(bytes, audio.mimeType),
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text().catch(() => '');
    throw new Error(text || `AssemblyAI upload failed (${uploadResponse.status}).`);
  }

  const uploadJson = await uploadResponse.json();
  const uploadUrl = uploadJson.upload_url;
  if (typeof uploadUrl !== 'string') {
    throw new Error('AssemblyAI upload did not return an audio URL.');
  }

  const transcriptResponse = await fetch(`${ASSEMBLYAI_BASE_URL}/transcript`, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: uploadUrl,
      language_detection: true,
      language_detection_options: {
        expected_languages: ['en', 'ru'],
        fallback_language: 'en',
      },
    }),
  });

  if (!transcriptResponse.ok) {
    const text = await transcriptResponse.text().catch(() => '');
    throw new Error(text || `AssemblyAI transcript failed (${transcriptResponse.status}).`);
  }

  const transcriptJson = await transcriptResponse.json();
  const transcriptId = transcriptJson.id;
  if (typeof transcriptId !== 'string') {
    throw new Error('AssemblyAI did not return a transcript id.');
  }

  for (let attempt = 0; attempt < 150; attempt++) {
    await wait(attempt < 5 ? 1000 : 2000);
    const pollResponse = await fetch(`${ASSEMBLYAI_BASE_URL}/transcript/${encodeURIComponent(transcriptId)}`, {
      headers: { authorization: apiKey },
    });
    if (!pollResponse.ok) {
      const text = await pollResponse.text().catch(() => '');
      throw new Error(text || `AssemblyAI polling failed (${pollResponse.status}).`);
    }
    const pollJson = await pollResponse.json();
    if (pollJson.status === 'completed') {
      const text = String(pollJson.text ?? '').trim();
      if (!text) throw new Error('AssemblyAI returned an empty transcript.');
      return text;
    }
    if (pollJson.status === 'error') {
      throw new Error(String(pollJson.error ?? 'AssemblyAI transcription failed.'));
    }
  }

  throw new Error('AssemblyAI transcription timed out.');
}

async function transcribeWithOpenAI(audio: LocalAudioFile): Promise<string> {
  const apiKey = (await loadToken('openAiToken'))?.trim();
  if (!apiKey) {
    throw new Error('OpenAI API key is not saved. Add it in Settings.');
  }

  const form = new FormData();
  const name = safeFileName(audio.name, Platform.OS === 'ios' ? 'm4a' : 'webm');
  const type = audio.mimeType ?? (Platform.OS === 'ios' ? 'audio/mp4' : 'audio/webm');

  if (audio.file) {
    form.append('file', audio.file as any, name);
  } else {
    form.append('file', { uri: audio.uri, name, type } as any);
  }
  form.append('model', 'gpt-4o-mini-transcribe');

  const response = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `OpenAI transcription failed (${response.status}).`);
  }

  const json = await response.json();
  const text = String(json.text ?? '').trim();
  if (!text) throw new Error('OpenAI returned an empty transcript.');
  return text;
}

export async function transcribeAudioWithCloudProvider(
  provider: CloudTranscriptionProvider,
  audio: LocalAudioFile
): Promise<string> {
  return provider === 'assemblyai'
    ? transcribeWithAssemblyAI(audio)
    : transcribeWithOpenAI(audio);
}

