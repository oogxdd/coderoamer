// Base64 → bytes, shared by every audio path.
//
// React Native has no `Buffer` and `atob` is not dependable across the
// platforms this app runs on (iOS, Android, web, Hermes), so the decode is done
// by hand. It lived as a copy in each transcription service until the streaming
// path needed a third one.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  // URL-safe variants, so a caller never has to care which flavour it got.
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

export function base64ToBytes(base64: string): Uint8Array {
  // Upper bound: 4 input characters become 3 bytes. Padding/whitespace only
  // ever makes the real count smaller, so one allocation is enough.
  const out = new Uint8Array(Math.ceil((base64.length * 3) / 4));
  let length = 0;
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < base64.length; i++) {
    const code = base64.charCodeAt(i);
    if (code === 61 /* = */) break;
    const value = code < 128 ? LOOKUP[code] : -1;
    if (value === -1) continue; // whitespace, newlines, stray characters
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length++] = (buffer >> bits) & 0xff;
    }
  }

  return out.subarray(0, length);
}
