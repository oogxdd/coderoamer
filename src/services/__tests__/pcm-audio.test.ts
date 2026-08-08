import { describe, expect, it } from 'vitest';

import {
  float32ToPcm16,
  frameBytes,
  PcmFrameBuffer,
  WavTail,
  wavPcmBodyOffset,
  type TailingFileReader,
} from '@/services/pcm-audio';

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/**
 * Builds a WAV file. `extraChunks` stands in for the chunks iOS writes before
 * `data`, which is why the body offset can't be assumed to be 44.
 */
function wavFile(pcm: number[], extraChunks: { id: string; body: number[] }[] = []) {
  const fmt = { id: 'fmt ', body: new Array(16).fill(0) };
  const chunks = [fmt, ...extraChunks];
  const bytes: number[] = [
    ...ascii('RIFF'),
    0,
    0,
    0,
    0, // size, patched only when recording stops
    ...ascii('WAVE'),
  ];
  for (const chunk of chunks) {
    bytes.push(...ascii(chunk.id));
    const size = chunk.body.length;
    bytes.push(size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff);
    bytes.push(...chunk.body);
    if (size % 2 === 1) bytes.push(0);
  }
  bytes.push(...ascii('data'), 0, 0, 0, 0);
  const bodyOffset = bytes.length;
  bytes.push(...pcm);
  return { bytes: new Uint8Array(bytes), bodyOffset };
}

/** A file that the test grows by hand, like a recorder flushing as it goes. */
function growingFile(initial: Uint8Array) {
  let content = initial;
  const reader: TailingFileReader = {
    size: async () => content.byteLength,
    read: async (offset, length) => content.slice(offset, offset + length),
  };
  return {
    reader,
    append(extra: number[]) {
      const next = new Uint8Array(content.byteLength + extra.length);
      next.set(content, 0);
      next.set(new Uint8Array(extra), content.byteLength);
      content = next;
    },
  };
}

describe('wavPcmBodyOffset', () => {
  it('finds the samples after a plain fmt + data header', () => {
    const { bytes, bodyOffset } = wavFile([1, 2, 3, 4]);
    expect(wavPcmBodyOffset(bytes)).toBe(bodyOffset);
    expect(bodyOffset).toBe(44);
  });

  it('skips chunks between fmt and data instead of assuming 44 bytes', () => {
    const { bytes, bodyOffset } = wavFile([1, 2], [{ id: 'LIST', body: new Array(10).fill(7) }]);
    expect(bodyOffset).toBeGreaterThan(44);
    expect(wavPcmBodyOffset(bytes)).toBe(bodyOffset);
  });

  it('handles the pad byte after an odd-sized chunk', () => {
    const { bytes, bodyOffset } = wavFile([5], [{ id: 'LIST', body: new Array(9).fill(7) }]);
    expect(wavPcmBodyOffset(bytes)).toBe(bodyOffset);
  });

  it('waits rather than guessing when the header is still incomplete', () => {
    const { bytes } = wavFile([1, 2]);
    expect(wavPcmBodyOffset(bytes.slice(0, 20))).toBeNull();
    expect(wavPcmBodyOffset(new Uint8Array(4))).toBeNull();
  });

  it('rejects something that is not a WAV file', () => {
    const notWav = new Uint8Array([...ascii('FORM'), 0, 0, 0, 0, ...ascii('AIFF')]);
    expect(wavPcmBodyOffset(notWav)).toBeNull();
  });
});

describe('frameBytes', () => {
  it('sizes a frame in whole 16-bit samples', () => {
    expect(frameBytes(16000, 100)).toBe(3200);
    expect(frameBytes(16000, 50)).toBe(1600);
  });
});

describe('float32ToPcm16', () => {
  it('maps full scale without wrapping polarity', () => {
    const bytes = float32ToPcm16(new Float32Array([0, 1, -1]));
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(32767);
    expect(view.getInt16(4, true)).toBe(-32768);
  });

  it('clamps out-of-range input instead of overflowing', () => {
    const bytes = float32ToPcm16(new Float32Array([2, -2]));
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32768);
  });

  it('writes little-endian samples', () => {
    const bytes = float32ToPcm16(new Float32Array([0.5]));
    // 0.5 * 32767 = 16383.5 -> 16384 = 0x4000, low byte first.
    expect([bytes[0], bytes[1]]).toEqual([0x00, 0x40]);
  });
});

describe('PcmFrameBuffer', () => {
  it('emits fixed-size frames and carries the remainder', () => {
    const buffer = new PcmFrameBuffer(4);
    expect(buffer.push(new Uint8Array([1, 2, 3]))).toEqual([]);
    expect(buffer.push(new Uint8Array([4, 5, 6, 7, 8]))).toEqual([
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
    ]);
    expect(buffer.pendingBytes).toBe(0);
  });

  it('never splits a sample across frames', () => {
    const buffer = new PcmFrameBuffer(4);
    // An odd byte count would misalign every following sample if passed through.
    buffer.push(new Uint8Array([1, 2, 3, 4, 5]));
    expect(buffer.pendingBytes).toBe(1);
    expect(buffer.push(new Uint8Array([6, 7, 8]))).toEqual([new Uint8Array([5, 6, 7, 8])]);
  });

  it('flushes a whole number of samples and drops a half one', () => {
    const buffer = new PcmFrameBuffer(4);
    buffer.push(new Uint8Array([1, 2, 3]));
    expect(buffer.flush()).toEqual(new Uint8Array([1, 2]));
    expect(buffer.flush()).toBeNull();
  });

  it('rejects a frame size that is not whole samples', () => {
    expect(() => new PcmFrameBuffer(3)).toThrow(/whole number of samples/);
    expect(() => new PcmFrameBuffer(0)).toThrow();
  });
});

describe('WavTail', () => {
  // 2 samples/sec at 1000ms per frame = 4 bytes a frame: small enough to read.
  const tailOf = (file: { reader: TailingFileReader }, frames: Uint8Array[]) =>
    new WavTail({
      reader: file.reader,
      sampleRate: 2,
      frameMs: 1000,
      onFrame: (frame) => frames.push(frame),
    });

  it('emits the samples and never a byte of the header', async () => {
    const file = growingFile(wavFile([]).bytes);
    const frames: Uint8Array[] = [];
    const tail = tailOf(file, frames);

    file.append([1, 2, 3, 4, 5, 6]);
    await tail.finish();

    // One full frame, then the 2-byte remainder flushed at the end.
    expect(frames).toEqual([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])]);
  });

  it('picks up bytes flushed between polls without re-sending old ones', async () => {
    const file = growingFile(wavFile([1, 2, 3, 4]).bytes);
    const frames: Uint8Array[] = [];
    const tail = tailOf(file, frames);

    await tail.poll();
    expect(frames).toEqual([new Uint8Array([1, 2, 3, 4])]);

    file.append([5, 6, 7, 8]);
    await tail.poll();
    expect(frames).toEqual([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])]);
  });

  it('emits nothing when nothing new was written', async () => {
    const file = growingFile(wavFile([1, 2, 3, 4]).bytes);
    const frames: Uint8Array[] = [];
    const tail = tailOf(file, frames);

    await tail.poll();
    await tail.poll();
    expect(frames).toHaveLength(1);
  });

  it('holds a partial frame back until the rest of it arrives', async () => {
    const file = growingFile(wavFile([1, 2]).bytes);
    const frames: Uint8Array[] = [];
    const tail = tailOf(file, frames);

    await tail.poll();
    expect(frames).toEqual([]);

    file.append([3, 4]);
    await tail.poll();
    expect(frames).toEqual([new Uint8Array([1, 2, 3, 4])]);
  });

  it('stays quiet until the header names where the samples start', async () => {
    // Only a truncated header exists so far — the data chunk is not there yet.
    const file = growingFile(wavFile([1, 2, 3, 4]).bytes.slice(0, 16));
    const frames: Uint8Array[] = [];
    const tail = tailOf(file, frames);

    await tail.poll();
    expect(frames).toEqual([]);
  });

  it('does nothing while the recorder has not created the file', async () => {
    const frames: Uint8Array[] = [];
    const tail = new WavTail({
      reader: { size: async () => null, read: async () => new Uint8Array(0) },
      sampleRate: 2,
      frameMs: 1000,
      onFrame: (frame) => frames.push(frame),
    });

    await tail.poll();
    expect(frames).toEqual([]);
  });

  it('lets a read failure reach the caller instead of swallowing it', async () => {
    const tail = new WavTail({
      reader: {
        size: async () => {
          throw new Error('file vanished');
        },
        read: async () => new Uint8Array(0),
      },
      sampleRate: 2,
      frameMs: 1000,
      onFrame: () => {},
    });

    await expect(tail.poll()).rejects.toThrow('file vanished');
  });
});
