import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  batchProviderFor,
  transcribeAudioWithCloudProvider,
} from '@/services/client-transcription';

vi.mock('@/services/auth', () => ({
  loadToken: vi.fn(async () => 'test-key'),
}));

type UploadOptions = Record<string, unknown>;

const uploadAsync =
  vi.fn<(url: string, fileUri: string, options: UploadOptions) => Promise<unknown>>();
const getInfoAsync = vi.fn<(uri: string, options?: UploadOptions) => Promise<unknown>>();
const readAsStringAsync = vi.fn<(uri: string, options?: UploadOptions) => Promise<string>>();

vi.mock('expo-file-system/legacy', () => ({
  EncodingType: { UTF8: 'utf8', Base64: 'base64' },
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
  getInfoAsync: (uri: string, options?: UploadOptions) => getInfoAsync(uri, options),
  uploadAsync: (url: string, fileUri: string, options: UploadOptions) =>
    uploadAsync(url, fileUri, options),
  readAsStringAsync: (uri: string, options?: UploadOptions) => readAsStringAsync(uri, options),
}));

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('batchProviderFor', () => {
  it('routes finished streaming recordings through the batch uploader', () => {
    // Why one Blob bug broke "both streaming and usual": the same upload path.
    expect(batchProviderFor('assemblyai-streaming')).toBe('assemblyai');
    expect(batchProviderFor('assemblyai')).toBe('assemblyai');
    expect(batchProviderFor('sprite')).toBe('sprite');
  });
});

/**
 * The react-native stub reports `Platform.OS === 'ios'`, so these cover the
 * device path — the one that used to die in React Native's Blob store, which
 * rejects any blob built out of bytes.
 */
describe('transcribeAudioWithCloudProvider — assemblyai on device', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getInfoAsync.mockResolvedValue({ exists: true, size: 1024 });
    uploadAsync.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ upload_url: 'https://cdn.assemblyai.com/upload/abc' }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('streams the file from disk instead of buffering it into a request body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'transcript-1' }))
      .mockResolvedValue(jsonResponse({ status: 'completed', text: '  hello there  ' }));
    vi.stubGlobal('fetch', fetchMock);

    const transcribed = transcribeAudioWithCloudProvider('assemblyai', {
      uri: 'file:///tmp/dictation.m4a',
      name: 'dictation.m4a',
      mimeType: 'audio/mp4',
    });
    await vi.runAllTimersAsync();
    expect(await transcribed).toBe('hello there');

    const [url, fileUri, options] = uploadAsync.mock.calls[0];
    expect(url).toBe('https://api.assemblyai.com/v2/upload');
    expect(fileUri).toBe('file:///tmp/dictation.m4a');
    expect(options).toMatchObject({
      httpMethod: 'POST',
      uploadType: 0,
      headers: { authorization: 'test-key', 'content-type': 'audio/mp4' },
    });

    // The two ways the old code broke: the audio never becomes bytes in JS, and
    // the upload never goes out over `fetch` (where it would need a Blob body).
    expect(readAsStringAsync).not.toHaveBeenCalled();
    for (const [called] of fetchMock.mock.calls) {
      expect(String(called)).not.toContain('/upload');
    }
  });

  it('surfaces the server body when the upload is rejected', async () => {
    uploadAsync.mockResolvedValue({ status: 401, headers: {}, body: 'Invalid API key' });
    vi.stubGlobal('fetch', vi.fn());

    await expect(
      transcribeAudioWithCloudProvider('assemblyai', {
        uri: 'file:///tmp/dictation.m4a',
        mimeType: 'audio/mp4',
      })
    ).rejects.toThrow('Invalid API key');
  });

  it('fails before uploading when the recording is gone', async () => {
    getInfoAsync.mockResolvedValue({ exists: false });
    vi.stubGlobal('fetch', vi.fn());

    await expect(
      transcribeAudioWithCloudProvider('assemblyai', { uri: 'file:///tmp/gone.m4a' })
    ).rejects.toThrow('no longer available on disk');
    expect(uploadAsync).not.toHaveBeenCalled();
  });
});
