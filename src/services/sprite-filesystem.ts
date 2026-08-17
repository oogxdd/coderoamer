import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as api from '@/services/api';

/** A file picked from the device (via `expo-document-picker`), shaped for upload. */
export interface LocalPickedFile {
  uri: string;
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
  file?: { arrayBuffer: () => Promise<ArrayBuffer> } | null;
}

// Guard rail — the write endpoint takes a raw body, but a phone shouldn't try to
// stream a multi-GB file through fetch. Keep uploads to a sane ceiling.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Preview text files up to this size; larger files show metadata only.
export const MAX_PREVIEW_BYTES = 256 * 1024;

function base64ToBytes(base64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of base64.replace(/\s/g, '')) {
    if (char === '=') break;
    const value = chars.indexOf(char);
    if (value === -1) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

/** Read a device-local file to bytes across web (fetch/File) and native (base64). */
export async function readLocalFileBytes(file: LocalPickedFile): Promise<Uint8Array> {
  if (file.file?.arrayBuffer) {
    return new Uint8Array(await file.file.arrayBuffer());
  }

  if (Platform.OS === 'web') {
    const response = await fetch(file.uri);
    return new Uint8Array(await response.arrayBuffer());
  }

  const base64 = await FileSystem.readAsStringAsync(file.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return base64ToBytes(base64);
}

/** Basename of a picked file, stripped of path separators so it can't escape the dir. */
export function remoteFileName(value: string | null | undefined): string {
  const fallback = `upload-${Date.now().toString(36)}`;
  const base = (value || fallback).split(/[\\/]/).pop() || fallback;
  return base.trim() || fallback;
}

export function joinRemotePath(dir: string, name: string): string {
  if (!dir || dir === '/') return `/${name}`;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

/** Read a device file and write it into `destDir` on the sprite. */
export async function uploadFileToSpriteDir(
  spriteName: string,
  destDir: string,
  file: LocalPickedFile
): Promise<api.SpriteFileWriteResult> {
  if (file.size && file.size > MAX_UPLOAD_BYTES) {
    throw new Error('File is too large to upload (max 100 MB).');
  }
  const bytes = await readLocalFileBytes(file);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error('File is too large to upload (max 100 MB).');
  }
  const remotePath = joinRemotePath(destDir, remoteFileName(file.name));
  return api.writeSpriteFile(spriteName, remotePath, '/', bytes, {
    mkdir: true,
    contentType: file.mimeType ?? 'application/octet-stream',
  });
}

/** Parent directory of an absolute path (root stays root). */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed || trimmed === '') return '/';
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/** Human-readable byte size (e.g. "1.4 KB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Heuristic: treat the buffer as text unless it has a NUL byte or a high ratio of
 * non-printable control bytes in the sampled prefix.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (sample.length === 0) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    // Allow tab (9), LF (10), CR (13); flag other C0 controls.
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length < 0.1;
}

export function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}
