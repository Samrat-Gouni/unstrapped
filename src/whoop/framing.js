// WHOOP 4.0 (Gen4) frame envelope — build / parse / reassemble.
//
// Frame:  [0xAA SOF][u16 LE size][crc8(size)][inner, padded to /4][u32 LE CRC32]
//   size = paddedInner.length + 4   (the size field counts the trailing CRC32)
//
// The reassembler is LENGTH-BASED, not "reset on 0xAA": sensor payloads contain
// 0xAA bytes and BLE notification boundaries land on them. Ported from
// openstrap-research/research_playground.py (FrameReassembler) — verified live.

import { crc8, crc32 } from "./crc.js";

export const SOF = 0xaa;
const HEADER_LEN = 4; // Gen4: SOF + u16 size + crc8
const MAX_FRAME = 4096; // implausible-length guard against spurious SOFs

/** Zero-pad to a 4-byte boundary (CRC32 is computed over the padded form). */
export function pad4(data) {
  const padded = new Uint8Array(data.length + ((-data.length % 4) + 4) % 4);
  padded.set(data, 0);
  return padded;
}

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Wrap an inner packet in the Gen4 frame envelope. */
export function buildFrame(inner) {
  const innerP = pad4(inner);
  const declared = innerP.length + 4;
  const sizeBytes = Uint8Array.of(declared & 0xff, (declared >>> 8) & 0xff);
  const c32 = crc32(innerP);
  const frame = new Uint8Array(HEADER_LEN + innerP.length + 4);
  frame[0] = SOF;
  frame.set(sizeBytes, 1);
  frame[3] = crc8(sizeBytes);
  frame.set(innerP, HEADER_LEN);
  const off = HEADER_LEN + innerP.length;
  frame[off] = c32 & 0xff;
  frame[off + 1] = (c32 >>> 8) & 0xff;
  frame[off + 2] = (c32 >>> 16) & 0xff;
  frame[off + 3] = (c32 >>> 24) & 0xff;
  return frame;
}

/**
 * Parse one complete frame at the head of `raw`.
 * @returns {{inner:Uint8Array, headerCrcOk:boolean, crc32Ok:boolean, valid:boolean, total:number}|null}
 */
export function parseFrame(raw) {
  if (raw.length < HEADER_LEN + 4 || raw[0] !== SOF) return null;
  const declared = u16le(raw, 1);
  if (declared < 4) return null;
  const total = HEADER_LEN + declared;
  if (raw.length < total) return null;

  const headerCrcOk = crc8(raw.subarray(1, 3)) === raw[3];
  const inner = raw.slice(HEADER_LEN, HEADER_LEN + declared - 4);
  const stored = u32le(raw, HEADER_LEN + declared - 4);
  const crc32Ok = crc32(inner) === stored;
  return { inner, headerCrcOk, crc32Ok, valid: headerCrcOk && crc32Ok, total };
}

/**
 * Length-based reassembler for the BLE notification stream. Construct ONE per
 * connection; feed each notification's bytes; get back every complete, valid
 * frame it can carve out. CRC-failed frames are dropped; if the buffer head is
 * not a SOF (subscribed mid-record) it resyncs forward to the next SOF.
 */
export class FrameReassembler {
  constructor() {
    this.buf = new Uint8Array(0);
  }

  #append(chunk) {
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf, 0);
    next.set(chunk, this.buf.length);
    this.buf = next;
  }

  /** @param {Uint8Array} chunk @returns {Uint8Array[]} complete inner packets */
  feed(chunk) {
    this.#append(chunk);
    const frames = [];
    while (this.buf.length >= HEADER_LEN + 4) {
      if (this.buf[0] !== SOF) {
        const nxt = this.buf.indexOf(SOF, 1);
        if (nxt === -1) { this.buf = new Uint8Array(0); break; }
        this.buf = this.buf.slice(nxt);
        continue;
      }
      const declared = u16le(this.buf, 1);
      const total = HEADER_LEN + declared;
      if (declared < 4 || total > MAX_FRAME) {
        // implausible length → spurious SOF, skip this byte and resync
        this.buf = this.buf.slice(1);
        continue;
      }
      if (this.buf.length < total) break; // wait for more chunks
      const frame = parseFrame(this.buf);
      if (frame && frame.valid) frames.push(frame.inner);
      this.buf = this.buf.slice(total);
    }
    return frames;
  }
}
