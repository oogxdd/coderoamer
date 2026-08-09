// Getting PCM16 frames out of what React Native can actually record.
//
// AssemblyAI's streaming socket wants raw 16-bit little-endian mono PCM in
// 50–1000 ms chunks. Nothing in this app's dependency set hands out live PCM
// buffers: `expo-audio` records to a file, and `expo-speech-recognition` only
// exposes recognition events — but it *can* persist its capture as a WAV while
// it records (`recordingOptions.persist`). So the native path tails that growing
// file, and the web path takes Float32 buffers from Web Audio. Both funnel into
// the same frames.
//
// Everything here is pure or has its IO injected: the byte-level work is where
// the bugs live, and it should be provable without a microphone.

/** Bytes per sample for the encoding AssemblyAI is configured with. */
const BYTES_PER_SAMPLE = 2;
const RIFF_HEADER_MIN_BYTES = 12;

/**
 * Where the samples start in a WAV file.
 *
 * The 44-byte header everyone assumes is only the *common* case — iOS writes
 * extra chunks, so a hardcoded 44 would feed chunk headers to the API as if
 * they were audio (heard as a click, or a rejected stream). Walks the chunk list
 * instead and returns null while too little has been written to tell.
 */
export function wavPcmBodyOffset(header: Uint8Array): number | null {
  if (header.byteLength < RIFF_HEADER_MIN_BYTES) return null;
  const ascii = (offset: number) =>
    String.fromCharCode(
      header[offset],
      header[offset + 1],
      header[offset + 2],
      header[offset + 3]
    );
  if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') return null;

  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  let cursor = RIFF_HEADER_MIN_BYTES;
  while (cursor + 8 <= header.byteLength) {
    const id = ascii(cursor);
    const size = view.getUint32(cursor + 4, true);
    const body = cursor + 8;
    if (id === 'data') return body;
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    cursor = body + size + (size % 2);
  }
  return null;
}

/** Frame size in bytes for a given duration of mono PCM16. */
export function frameBytes(sampleRate: number, frameMs: number): number {
  const samples = Math.round((sampleRate * frameMs) / 1000);
  return samples * BYTES_PER_SAMPLE;
}

/** Web Audio hands out Float32 in [-1, 1]; the API wants clamped Int16 LE. */
export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * BYTES_PER_SAMPLE);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    // Asymmetric on purpose: -1 maps to -32768 and +1 to 32767, so full-scale
    // input can't wrap around to the opposite polarity.
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(i * BYTES_PER_SAMPLE, Math.round(value), true);
  }
  return out;
}

/**
 * Buffers arbitrary byte runs and emits them as fixed-size frames.
 *
 * A tailing read returns however much happened to be flushed, which is not a
 * whole number of frames and can even split a sample in half. Sending those
 * straight through would misalign every following sample (audible as noise), so
 * the remainder is always carried over.
 */
export class PcmFrameBuffer {
  private pending = new Uint8Array(0);

  constructor(private readonly frameSize: number) {
    if (frameSize <= 0 || frameSize % BYTES_PER_SAMPLE !== 0) {
      throw new Error('Frame size must be a positive whole number of samples.');
    }
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength === 0) return [];
    const merged = new Uint8Array(this.pending.byteLength + chunk.byteLength);
    merged.set(this.pending, 0);
    merged.set(chunk, this.pending.byteLength);

    const frames: Uint8Array[] = [];
    let offset = 0;
    while (merged.byteLength - offset >= this.frameSize) {
      frames.push(merged.slice(offset, offset + this.frameSize));
      offset += this.frameSize;
    }
    this.pending = merged.slice(offset);
    return frames;
  }

  /** Whatever is left, padded up to a whole sample. Call once at the end. */
  flush(): Uint8Array | null {
    const remainder = this.pending.byteLength - (this.pending.byteLength % BYTES_PER_SAMPLE);
    const frame = remainder > 0 ? this.pending.slice(0, remainder) : null;
    this.pending = new Uint8Array(0);
    return frame;
  }

  get pendingBytes(): number {
    return this.pending.byteLength;
  }
}

export interface TailingFileReader {
  /** Total bytes currently on disk, or null if the file isn't there yet. */
  size(): Promise<number | null>;
  /** Read `length` bytes from `offset`. May return fewer at end of file. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface WavTailOptions {
  reader: TailingFileReader;
  sampleRate: number;
  frameMs?: number;
  onFrame: (frame: Uint8Array) => void;
}

const DEFAULT_FRAME_MS = 100;
/** How often to look for newly flushed audio, when the caller doesn't say. */
export const DEFAULT_TAIL_POLL_MS = 100;
/** Cap on one read, so a long stall doesn't turn into one enormous buffer. */
const MAX_READ_BYTES = 256 * 1024;

/**
 * Follows a WAV file that is still being written and reports each complete
 * frame of PCM as it appears.
 *
 * Pull-based on purpose: the caller owns the timer. A self-driving async loop
 * would be both harder to stop precisely and untestable without real timers,
 * and the caller already has a natural place to tick from.
 *
 * The recorder patches the RIFF length fields only when it stops, so the header
 * is unreliable mid-recording — this ignores the declared data size and reads
 * whatever bytes exist past the start of the `data` chunk.
 */
export class WavTail {
  private offset: number | null = null;
  private readonly frames: PcmFrameBuffer;

  constructor(private readonly options: WavTailOptions) {
    this.frames = new PcmFrameBuffer(
      frameBytes(options.sampleRate, options.frameMs ?? DEFAULT_FRAME_MS)
    );
  }

  /** Read everything flushed since the last call. Emits whole frames only. */
  async poll(): Promise<void> {
    const size = await this.options.reader.size();
    if (size === null) return;

    if (this.offset === null) {
      // Nothing is safe to send until the header names where samples start.
      const header = await this.options.reader.read(0, Math.min(size, 1024));
      const bodyOffset = wavPcmBodyOffset(header);
      if (bodyOffset === null) return;
      this.offset = bodyOffset;
    }

    while (this.offset < size) {
      const length = Math.min(size - this.offset, MAX_READ_BYTES);
      const chunk = await this.options.reader.read(this.offset, length);
      if (chunk.byteLength === 0) return;
      this.offset += chunk.byteLength;
      for (const frame of this.frames.push(chunk)) {
        this.options.onFrame(frame);
      }
    }
  }

  /** Final catch-up read plus the sub-frame remainder, so no audio is lost. */
  async finish(): Promise<void> {
    await this.poll();
    const tail = this.frames.flush();
    if (tail) this.options.onFrame(tail);
  }
}
