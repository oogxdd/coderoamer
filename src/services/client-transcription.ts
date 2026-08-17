import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { loadToken } from '@/services/auth';
import { LocalAudioFile } from '@/services/audio-transcription';

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
const ASSEMBLYAI_UPLOAD_URL = `${ASSEMBLYAI_BASE_URL}/upload`;
const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_AUDIO_UPLOAD_BYTES = 50 * 1024 * 1024;

function safeFileName(value: string | null | undefined, fallbackExt = 'm4a'): string {
  const fallback = `dictation-${Date.now().toString(36)}.${fallbackExt}`;
  const name = (value || fallback).split('/').pop() || fallback;
  return name.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120) || fallback;
}

/**
 * Web only — native never reads the clip into JS (see `uploadAudioToAssemblyAI`).
 * A picked file carries its own bytes; a recording is a `blob:` URL.
 */
async function readWebAudioBlob(audio: LocalAudioFile, type: string): Promise<Blob> {
  if (audio.file?.arrayBuffer) {
    return new Blob([await audio.file.arrayBuffer()], { type });
  }
  const response = await fetch(audio.uri);
  return response.blob();
}

function parseUploadUrl(body: string): string {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('AssemblyAI upload returned a response that was not JSON.');
  }
  const uploadUrl = (json as { upload_url?: unknown } | null)?.upload_url;
  if (typeof uploadUrl !== 'string') {
    throw new Error('AssemblyAI upload did not return an audio URL.');
  }
  return uploadUrl;
}

/**
 * POSTs the raw audio to `/v2/upload` and returns the URL AssemblyAI hands back.
 *
 * Nothing here may build a `Blob` out of bytes: React Native's Blob is backed by
 * a native blob store and its constructor rejects binary parts outright
 * ("Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported"),
 * which is what used to kill every AssemblyAI recording on device — including
 * the streaming provider, whose finished recordings come back through this same
 * batch path via `batchProviderFor`.
 *
 * So native uploads straight from disk with `FileSystem.uploadAsync`. That is
 * not just Blob-avoidance: reading the file into JS first would materialise a
 * 50 MB clip four times over (base64 string → bytes → RN's copy → base64 again
 * for the bridge) before a single byte left the phone. The foreground session
 * type keeps the upload tied to this dictation rather than to iOS's discretionary
 * background queue.
 *
 * Web has no `uploadAsync`, so it reads the clip and posts it — and there a
 * `Blob` really is the right body, because a browser Blob is just bytes.
 */
async function uploadAudioToAssemblyAI(
  apiKey: string,
  audio: LocalAudioFile
): Promise<string> {
  const headers = {
    authorization: apiKey,
    'content-type': audio.mimeType ?? 'application/octet-stream',
  };

  if (Platform.OS !== 'web') {
    const info = await FileSystem.getInfoAsync(audio.uri, { size: true });
    if (!info?.exists) {
      throw new Error('The recording is no longer available on disk.');
    }
    if ((info.size ?? 0) > MAX_AUDIO_UPLOAD_BYTES) {
      throw new Error('Audio file is too large to upload for transcription.');
    }

    const result = await FileSystem.uploadAsync(ASSEMBLYAI_UPLOAD_URL, audio.uri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
      headers,
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(result.body || `AssemblyAI upload failed (${result.status}).`);
    }
    return parseUploadUrl(result.body ?? '');
  }

  const blob = await readWebAudioBlob(audio, headers['content-type']);
  if (blob.size > MAX_AUDIO_UPLOAD_BYTES) {
    throw new Error('Audio file is too large to upload for transcription.');
  }

  const response = await fetch(ASSEMBLYAI_UPLOAD_URL, {
    method: 'POST',
    headers,
    body: blob,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `AssemblyAI upload failed (${response.status}).`);
  }
  return parseUploadUrl(await response.text());
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function transcribeWithAssemblyAI(audio: LocalAudioFile): Promise<string> {
  const apiKey = (await loadToken('assemblyAiToken'))?.trim();
  if (!apiKey) {
    throw new Error('AssemblyAI API key is not saved. Add it in Settings.');
  }

  if (audio.size && audio.size > MAX_AUDIO_UPLOAD_BYTES) {
    throw new Error('Audio file is too large to upload for transcription.');
  }

  const uploadUrl = await uploadAudioToAssemblyAI(apiKey, audio);

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

