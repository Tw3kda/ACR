/**
 * Base64 → bytes.
 *
 * `expo-print` hands the PDF over the bridge as base64, and the audit log has
 * to fingerprint the *file*, not that transport encoding. Decoding here means
 * `pdf_sha256` is the digest of the same bytes that land on disk — the one
 * `sha256sum consent.pdf` produces.
 *
 * Written out rather than using `atob`, which is not guaranteed on every
 * Hermes build, and whose behaviour on padded/whitespace input varies.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup, built once. -1 marks a character that is not base64. */
const LOOKUP = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

export function base64ToBytes(base64: string): Uint8Array {
  // Line breaks and padding are stripped: some encoders wrap at 76 columns,
  // and the padding carries no data.
  let clean = '';
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    if (code < 128 && LOOKUP[code] >= 0) clean += base64[i];
  }

  const byteLength = Math.floor((clean.length * 3) / 4);
  const bytes = new Uint8Array(byteLength);

  let byteIndex = 0;
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < clean.length; i += 1) {
    buffer = (buffer << 6) | LOOKUP[clean.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[byteIndex] = (buffer >> bits) & 0xff;
      byteIndex += 1;
    }
  }

  return bytes;
}
