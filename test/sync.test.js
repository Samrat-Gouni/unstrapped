import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFrame, FrameReassembler } from "../src/whoop/framing.js";
import { PacketType, SyncMeta } from "../src/whoop/protocol.js";
import { classifyPacket } from "../dashboard/sync.js";

// --- synthetic packet builders ---------------------------------------------
function makeR24(ts, hr, rr = []) {
  const inner = new Uint8Array(96);
  const dv = new DataView(inner.buffer);
  inner[0] = PacketType.HISTORICAL_DATA;
  inner[1] = 24;
  dv.setUint32(7, ts, true);
  inner[17] = hr;
  inner[18] = rr.length;
  rr.forEach((v, i) => dv.setInt16(19 + i * 2, v, true));
  return inner;
}
function makeEnd(token) {
  const inner = new Uint8Array(21);
  inner[0] = PacketType.METADATA;
  inner[2] = SyncMeta.HISTORY_END;
  inner.set(token, 13);
  return inner;
}
function makeComplete() {
  const inner = new Uint8Array(4);
  inner[0] = PacketType.METADATA;
  inner[2] = SyncMeta.HISTORY_COMPLETE;
  return inner;
}

test("classifyPacket decodes a historical record", () => {
  const r = classifyPacket(makeR24(1_700_000_000, 58, [1010, 1005]));
  assert.equal(r.kind, "record");
  assert.equal(r.record.hr, 58);
  assert.equal(r.record.tsEpoch, 1_700_000_000);
  assert.deepEqual(r.record.rrIntervalsMs, [1010, 1005]);
});

test("classifyPacket surfaces the ACK token on HISTORY_END", () => {
  const token = Uint8Array.of(9, 8, 7, 6, 5, 4, 3, 2);
  const r = classifyPacket(makeEnd(token));
  assert.equal(r.kind, "end");
  assert.deepEqual(r.token, token);
});

test("classifyPacket recognises HISTORY_COMPLETE", () => {
  assert.equal(classifyPacket(makeComplete()).kind, "complete");
});

test("full pipeline: framed records + markers reassemble and classify in order", () => {
  const token = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
  const inners = [
    makeR24(1000, 60, [1000]),
    makeR24(1001, 61, [980, 1002]),
    makeR24(1002, 59),
    makeEnd(token),
    makeComplete(),
  ];
  // Wrap each in a real frame and concatenate into one byte stream.
  const frames = inners.map(buildFrame);
  const total = frames.reduce((n, f) => n + f.length, 0);
  const stream = new Uint8Array(total);
  let o = 0;
  for (const f of frames) { stream.set(f, o); o += f.length; }

  // Feed the stream through the reassembler in small, boundary-crossing chunks.
  const ra = new FrameReassembler();
  const results = [];
  for (let i = 0; i < stream.length; i += 7) {
    for (const inner of ra.feed(stream.subarray(i, i + 7))) results.push(classifyPacket(inner));
  }

  const records = results.filter((r) => r.kind === "record");
  const ends = results.filter((r) => r.kind === "end");
  const completes = results.filter((r) => r.kind === "complete");
  assert.equal(records.length, 3);
  assert.equal(records[1].record.rrIntervalsMs.length, 2);
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].token, token);
  assert.equal(completes.length, 1);
});
