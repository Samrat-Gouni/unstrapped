// CRC primitives for the WHOOP 4.0 (Gen4 / "Harvard") frame envelope.
//
// Verified against OpenStrap (openstrap-protocol/lib/src/crc.dart and
// openstrap-research/research_playground.py) on real hardware across 811 records:
//   - CRC-8 (poly 0x07) covers ONLY the 2-byte frame-size field.
//   - CRC-32 is STANDARD zlib/IEEE (poly 0xEDB88320 reflected, xor-out
//     0xFFFFFFFF) over the zero-padded inner — i.e. exactly Node's zlib.crc32.
//
// NOTE: the earlier `whoop-reader` model (a custom xor-out 0xF43F44AC over
// [header+payload]) was a mis-identification; the real envelope is below.

// --- CRC-8, poly 0x07, MSB-first, init 0, no reflection, no final xor -------
const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
    t[i] = crc;
  }
  return t;
})();

/** CRC-8 (poly 0x07) over the frame's 2-byte size field only. */
export function crc8(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) crc = CRC8_TABLE[(crc ^ data[i]) & 0xff];
  return crc;
}

// --- Standard zlib CRC-32 (reflected poly 0xEDB88320) -----------------------
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard zlib CRC-32 over the (padded) inner content. Equals zlib.crc32(). */
export function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = (CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}
