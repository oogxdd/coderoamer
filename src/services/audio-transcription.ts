import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as api from '@/services/api';
import { base64ToBytes } from '@/services/base64';

const MAX_AUDIO_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface LocalAudioFile {
  uri: string;
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
  file?: { arrayBuffer: () => Promise<ArrayBuffer> } | null;
}

export interface SpriteTranscriptionOptions {
  spriteName: string;
  workingDirectory: string;
  audio: LocalAudioFile;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function safeFileName(value: string | null | undefined): string {
  const fallback = `dictation-${Date.now().toString(36)}.m4a`;
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

function buildSpriteTranscriptionCommand(audioPath: string, workingDirectory: string): string {
  const quotedAudio = shellQuote(audioPath);
  const quotedWorkingDirectory = shellQuote(workingDirectory);
  return [
    'set -uo pipefail',
    `cd ${quotedWorkingDirectory} 2>/dev/null || cd /tmp`,
    `AUDIO=${quotedAudio}`,
    'OUT_DIR="$(mktemp -d /tmp/wisp-dictation.XXXXXX)"',
    'LOG_FILE="$OUT_DIR/transcribe.log"',
    'cleanup() { rm -rf "$OUT_DIR"; }',
    'trap cleanup EXIT',
    'if command -v whisper >/dev/null 2>&1; then',
    '  if whisper "$AUDIO" --model base --output_format txt --output_dir "$OUT_DIR" >"$LOG_FILE" 2>&1; then',
    '    TXT_FILE="$(find "$OUT_DIR" -maxdepth 1 -name \'*.txt\' -print -quit)"',
    '    if [ -n "$TXT_FILE" ]; then cat "$TXT_FILE"; exit 0; fi',
    '    echo "Whisper finished without writing a transcript."',
    '    exit 1',
    '  fi',
    '  cat "$LOG_FILE"',
    '  exit 1',
    'fi',
    'if python3 -c "import whisper" >/dev/null 2>&1; then',
    '  python3 - "$AUDIO" 2>&1 <<\'PY\'',
    'import sys',
    'import whisper',
    'model = whisper.load_model("base")',
    'result = model.transcribe(sys.argv[1], fp16=False)',
    'print((result.get("text") or "").strip())',
    'PY',
    '  exit $?',
    'fi',
    'if python3 -c "import faster_whisper" >/dev/null 2>&1; then',
    '  python3 - "$AUDIO" 2>&1 <<\'PY\'',
    'import sys',
    'from faster_whisper import WhisperModel',
    'model = WhisperModel("base", device="cpu", compute_type="int8")',
    'segments, _ = model.transcribe(sys.argv[1])',
    'print(" ".join(segment.text.strip() for segment in segments).strip())',
    'PY',
    '  exit $?',
    'fi',
    'cat <<\'EOF\'',
    'No sprite transcription backend found. Install one inside the sprite, for example `pipx install openai-whisper` or `pip install -U openai-whisper`, then try again.',
    'EOF',
    'exit 127',
  ].join('\n');
}

export async function transcribeAudioOnSprite({
  spriteName,
  workingDirectory,
  audio,
}: SpriteTranscriptionOptions): Promise<string> {
  const bytes = await readLocalAudioBytes(audio);
  if (bytes.byteLength > MAX_AUDIO_UPLOAD_BYTES) {
    throw new Error('Audio file is too large to upload for transcription.');
  }

  const remotePath = `/tmp/wisp-chat-audio/${Date.now().toString(36)}-${safeFileName(audio.name)}`;
  await api.writeSpriteFile(spriteName, remotePath, '/', bytes, {
    mode: '0600',
    mkdir: true,
    contentType: audio.mimeType ?? 'application/octet-stream',
  });

  const command = buildSpriteTranscriptionCommand(remotePath, workingDirectory);
  const result = await api.runExec(spriteName, command, 900);
  const text = result.output.trim();

  if (!result.success) {
    throw new Error(text || 'Sprite transcription failed.');
  }
  if (!text) {
    throw new Error('Sprite transcription returned no text.');
  }

  return text;
}
