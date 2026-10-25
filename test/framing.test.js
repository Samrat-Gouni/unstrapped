import { test } from "node:test";
import assert from "node:assert/strict";
import { crc8, crc32 } from "../src/whoop/crc.js";
import { pad4, buildFrame, parseFrame, FrameReassembler, SOF } from "../src/whoop/framing.js";

test("pad4 rounds up to a 4-byte boundary with zeros", () => {
  assert.equal(pad4(new Uint8Array(5)).length, 8);
  assert.equal(pad4(new Uint8Array(8)).length, 8);
  assert.deepEqual(pad4(Uint8Array.of(1, 2, 3)), Uint8Array.of(1, 2, 3, 0));
});

test("buildFrame lays out SOF, size, crc8, padded inner and trailing crc32", () => {
  const inner = Uint8Array.of(0x23, 0x00, 0x23); // 3 bytes → padded to 4
  const frame = buildFrame(inner);
  assert.equal(frame[0], SOF);
  const declared = frame[1] | (frame[2] << 8);
  assert.equal(declared, 4 + 4); // paddedInner(4) + crc32(4)
  assert.equal(frame[3], crc8(frame.subarray(1, 3)));
  const innerP = frame.slice(4, 4 + 4);
  const stored = (frame[8] | (frame[9] << 8) | (frame[10] << 16) | (frame[11] << 24)) >>> 0;
  assert.equal(stored, crc32(innerP));
});

test("parseFrame round-trips buildFrame and validates both CRCs", () => {
  const inner = Uint8Array.from({ length: 40 }, (_, i) => i);
  const parsed = parseFrame(buildFrame(inner));
  assert.ok(parsed && parsed.valid);
  assert.equal(parsed.headerCrcOk, true);
  assert.equal(parsed.crc32Ok, true);
  assert.deepEqual(parsed.inner.slice(0, 40), inner); // padding may extend it
});

test("parseFrame flags a corrupted payload", () => {
  const frame = buildFrame(Uint8Array.of(0x23, 1, 2, 3, 4, 5));
  frame[5] ^= 0xff; // corrupt an inner byte → crc32 fails
  const parsed = parseFrame(frame);
  assert.equal(parsed.crc32Ok, false);
  assert.equal(parsed.valid, false);
});

test("parseFrame rejects bad SOF and short buffers", () => {
  assert.equal(parseFrame(Uint8Array.of(0x00, 4, 0, 0, 0, 0, 0, 0)), null);
  assert.equal(parseFrame(Uint8Array.of(SOF, 4)), null);
});

test("reassembler carves frames across arbitrary chunk splits", () => {
  const a = buildFrame(Uint8Array.of(0x23, 1, 0x23));
  const b = buildFrame(Uint8Array.of(0x2f, 2, 24, 9, 9));
  const stream = new Uint8Array(a.length + b.length);
  stream.set(a, 0); stream.set(b, a.length);

  const r = new FrameReassembler();
  const got = [];
  for (let i = 0; i < stream.length; i += 3) got.push(...r.feed(stream.subarray(i, i + 3)));
  assert.equal(got.length, 2);
  assert.equal(got[0][0], 0x23);
  assert.equal(got[1][0], 0x2f);
});

test("reassembler is not fooled by 0xAA bytes inside the payload", () => {
  // Inner deliberately contains 0xAA (== SOF) in its body.
  const inner = Uint8Array.of(0x2f, 0x01, 24, 0xaa, 0xaa, 0xaa, 0xaa);
  const frame = buildFrame(inner);
  const r = new FrameReassembler();
  const got = r.feed(frame);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].slice(0, inner.length), inner);
});

test("reassembler resyncs forward when it starts mid-record", () => {
  const frame = buildFrame(Uint8Array.of(0x23, 5, 0x23));
  const garbagePrefixed = new Uint8Array(3 + frame.length);
  garbagePrefixed.set([0x11, 0x22, 0x33], 0); // junk, no SOF
  garbagePrefixed.set(frame, 3);
  const r = new FrameReassembler();
  const got = r.feed(garbagePrefixed);
  assert.equal(got.length, 1);
  assert.equal(got[0][0], 0x23);
});
