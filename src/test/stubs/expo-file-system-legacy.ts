// Minimal expo-file-system/legacy stub for node-based unit tests
// (vitest.config.ts alias). Importing the real module pulls in
// expo-modules-core, which expects React Native globals like __DEV__.
//
// Nothing here needs to work: the tests that touch files inject their own
// reader. This exists so service modules that import the module at the top
// level can be loaded at all.

export const EncodingType = {
  UTF8: 'utf8',
  Base64: 'base64',
} as const;

export async function getInfoAsync(): Promise<{ exists: boolean; size?: number }> {
  return { exists: false };
}

export async function readAsStringAsync(): Promise<string> {
  return '';
}

export const FileSystemUploadType = {
  BINARY_CONTENT: 0,
  MULTIPART: 1,
} as const;

export const FileSystemSessionType = {
  BACKGROUND: 0,
  FOREGROUND: 1,
} as const;

export async function uploadAsync(): Promise<{
  status: number;
  body: string;
  headers: Record<string, string>;
}> {
  return { status: 0, body: '', headers: {} };
}

export async function writeAsStringAsync(): Promise<void> {}

export const documentDirectory: string | null = null;
export const cacheDirectory: string | null = null;
