import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { crc8, crc32 } from "../src/whoop/crc.js";

const enc = (s) => new TextEncoder().encode(s);

test("crc8 (poly 0x07) matches the standard 0xF4 check value", () => {
  // CRC-8/SMBUS check value over ASCII "123456789" is 0xF4.
  assert.equal(crc8(enc("123456789")), 0xf4);
});

test("crc8 of empty input is 0", () => {
  assert.equal(crc8(new Uint8Array(0)), 0);
});

test("crc32 equals Node's zlib.crc32 (empty + known)", () => {
  assert.equal(crc32(new Uint8Array(0)), zlib.crc32(Buffer.alloc(0)) >>> 0);
  assert.equal(crc32(enc("123456789")), zlib.crc32(Buffer.from("123456789")) >>> 0);
});

test("crc32 equals zlib.crc32 across 500 random buffers", () => {
  for (let n = 0; n < 500; n++) {
    const len = Math.floor(Math.random() * 200);
    const buf = Uint8Array.from({ length: len }, () => Math.floor(Math.random() * 256));
    assert.equal(crc32(buf), zlib.crc32(Buffer.from(buf)) >>> 0, `mismatch at len ${len}`);
  }
});

test("crc32 returns an unsigned 32-bit value", () => {
  const c = crc32(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
  assert.equal(c, c >>> 0);
  assert.ok(c >= 0 && c <= 0xffffffff);
});
