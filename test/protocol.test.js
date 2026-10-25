import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrame } from "../src/whoop/framing.js";
import {
  buildCommand, buildBatchAck, buildSetClock, buildGetHello,
  parseR24, parseMetadataMarker, parseRealtimeHr, parseBatteryResponse,
  PacketType, Cmd, SyncMeta,
} from "../src/whoop/protocol.js";

const innerOf = (frame) => parseFrame(frame).inner;

test("buildCommand frames [0x23][seq][opcode][payload] and is valid", () => {
  const frame = buildCommand(0x05, Cmd.GET_DATA_RANGE, Uint8Array.of(0xab));
  const p = parseFrame(frame);
  assert.ok(p.valid);
  assert.equal(p.inner[0], PacketType.COMMAND);
  assert.equal(p.inner[1], 0x05);
  assert.equal(p.inner[2], Cmd.GET_DATA_RANGE);
  assert.equal(p.inner[3], 0xab);
});

test("buildGetHello uses the GET_HELLO_HARVARD opcode", () => {
  assert.equal(innerOf(buildGetHello())[2], Cmd.GET_HELLO_HARVARD);
});

test("buildCommand refuses dangerous opcodes without override", () => {
  assert.throws(() => buildCommand(0, Cmd.FORCE_TRIM), /dangerous/i);
  assert.throws(() => buildCommand(0, Cmd.TOGGLE_PERSISTENT_R21), /dangerous/i);
  // explicit override is allowed (frame still builds)
  assert.ok(buildCommand(0, Cmd.FORCE_TRIM, Uint8Array.of(0), { allowDangerous: true }).length > 0);
});

test("buildBatchAck echoes the 8-byte token in a 12-byte inner", () => {
  const token = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
  const inner = innerOf(buildBatchAck(0x11, token));
  assert.equal(inner[0], PacketType.COMMAND);
  assert.equal(inner[1], 0x11);
  assert.equal(inner[2], Cmd.HISTORICAL_DATA_RESULT);
  assert.equal(inner[3], 0x01); // REVISION_1 / SUCCESS
  assert.deepEqual(inner.slice(4, 12), token);
});

test("buildBatchAck rejects a wrong-length token", () => {
  assert.throws(() => buildBatchAck(0, Uint8Array.of(1, 2, 3)), /8 bytes/);
});

test("buildSetClock encodes epoch as u32 LE followed by a zero word", () => {
  const inner = innerOf(buildSetClock(0x01020304));
  assert.equal(inner[2], Cmd.SET_CLOCK);
  assert.deepEqual(inner.slice(3, 11), Uint8Array.of(4, 3, 2, 1, 0, 0, 0, 0));
});

test("parseMetadataMarker extracts the token on HISTORY_END", () => {
  const inner = new Uint8Array(21);
  inner[0] = PacketType.METADATA;
  inner[2] = SyncMeta.HISTORY_END;
  for (let i = 13; i < 21; i++) inner[i] = i; // token bytes 13..20
  const m = parseMetadataMarker(inner);
  assert.equal(m.sub, SyncMeta.HISTORY_END);
  assert.deepEqual(m.token, Uint8Array.of(13, 14, 15, 16, 17, 18, 19, 20));
});

test("parseMetadataMarker returns no token on START/COMPLETE", () => {
  const start = Uint8Array.of(PacketType.METADATA, 0, SyncMeta.HISTORY_START);
  assert.equal(parseMetadataMarker(start).token, null);
});

test("parseR24 decodes header, HR, RR and accel at verified offsets", () => {
  const inner = new Uint8Array(96);
  const dv = new DataView(inner.buffer);
  inner[0] = PacketType.HISTORICAL_DATA;
  inner[1] = 24;
  dv.setUint32(3, 42, true); // counter
  dv.setUint32(7, 1_700_000_000, true); // ts epoch
  dv.setUint16(11, 512, true); // subsec
  inner[17] = 62; // HR
  inner[18] = 2; // rr_count
  dv.setInt16(19, 800, true);
  dv.setInt16(21, 810, true);
  dv.setFloat32(36, 0, true);
  dv.setFloat32(40, 0, true);
  dv.setFloat32(44, 1.0, true); // ~1g on Z at rest
  dv.setUint16(68, 1234, true); // skin-temp raw ADC

  const r = parseR24(inner);
  assert.equal(r.counter, 42);
  assert.equal(r.tsEpoch, 1_700_000_000);
  assert.equal(r.hr, 62);
  assert.deepEqual(r.rrIntervalsMs, [800, 810]);
  assert.deepEqual(r.accelG, [0, 0, 1]);
  assert.equal(r.skinTempRaw, 1234);
});

test("parseR24 rejects a too-short record", () => {
  assert.equal(parseR24(new Uint8Array(80)), null);
});

test("parseRealtimeHr reads HR and on-wrist from a 0x28 packet", () => {
  const inner = new Uint8Array(20);
  inner[0] = PacketType.REALTIME_DATA;
  inner[8] = 77;
  inner[18] = 0; // on wrist
  const rt = parseRealtimeHr(inner);
  assert.equal(rt.hr, 77);
  assert.equal(rt.onWrist, true);
});

test("parseBatteryResponse divides the u16 at [5:7] by 10", () => {
  const inner = new Uint8Array(7);
  new DataView(inner.buffer).setUint16(5, 875, true); // 87.5%
  assert.equal(parseBatteryResponse(inner), 87.5);
});
