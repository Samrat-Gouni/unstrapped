// Historical flash-drain for the WHOOP 4.0 proprietary channel.
//
// Pulls the 1 Hz records the strap recorded to flash (even with no phone
// connected) and reassembles + decodes them with the tested codec. The read
// cursor is persistent and non-destructive — we never erase.
//
// Design: we DON'T hardcode the contested service/characteristic UUIDs. We find
// the proprietary service by its `610800…` prefix, pick the writable command
// characteristic and the notify characteristics by their GATT *properties*, and
// route every reassembled packet by its type byte. So it works whether the band
// maps the service at 61080000 or 61080001.

import { FrameReassembler } from "../src/whoop/framing.js";
import {
  parseR24, parseMetadataMarker, buildBatchAck, buildSetClock,
  buildGetHello, buildGetDataRange, buildSendHistorical, buildAbortHistorical,
  PacketType, SyncMeta,
} from "../src/whoop/protocol.js";

const IDLE_MS = 8000;   // no new records for this long ⇒ backlog drained
const SAFETY_MS = 180000; // hard cap
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Classify a reassembled inner packet for the drain state machine. Pure — the
 * unit tests drive it directly with synthetic frames.
 * @param {Uint8Array} inner
 */
export function classifyPacket(inner) {
  const type = inner[0];
  if (type === PacketType.HISTORICAL_DATA) return { kind: "record", record: parseR24(inner) };
  if (type === PacketType.METADATA) {
    const m = parseMetadataMarker(inner);
    if (!m) return { kind: "other" };
    if (m.sub === SyncMeta.HISTORY_END) return { kind: "end", token: m.token };
    if (m.sub === SyncMeta.HISTORY_COMPLETE) return { kind: "complete" };
    return { kind: "meta" };
  }
  if (type === PacketType.COMMAND_RESPONSE) return { kind: "response" };
  if (type === PacketType.EVENT) return { kind: "event" };
  return { kind: "other" };
}

async function findProprietaryService(server) {
  const services = await server.getPrimaryServices();
  const svc = services.find((s) => s.uuid.toLowerCase().startsWith("610800"));
  if (!svc) throw new Error("No WHOOP proprietary service (61080…) found on this band");
  return svc;
}

/**
 * Run the flash drain over an already-connected GATT `server`.
 * @param {BluetoothRemoteGATTServer} server
 * @param {{onRecord?:Function, onProgress?:Function, onLog?:Function}} cbs
 * @returns {Promise<{records:number, complete:boolean, firstTs:number|null, lastTs:number|null}>}
 */
export async function drainHistory(server, { onRecord, onProgress, onLog } = {}) {
  const log = (m) => onLog && onLog(m);
  const svc = await findProprietaryService(server);
  log(`service ${svc.uuid}`);

  const chars = await svc.getCharacteristics();
  const writeChar = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
  const notifyChars = chars.filter((c) => c.properties.notify);
  if (!writeChar) throw new Error("No writable command characteristic in the service");
  if (!notifyChars.length) throw new Error("No notify characteristics to receive records");
  log(`write ${writeChar.uuid.slice(0, 8)} · ${notifyChars.length} notify channel(s)`);

  let seq = 1;
  const nextSeq = () => seq++ & 0xff;
  const write = async (frame) => {
    try { await writeChar.writeValueWithoutResponse(frame); }
    catch { await writeChar.writeValue(frame); }
  };

  const stats = { records: 0, complete: false, firstTs: null, lastTs: null };
  let resolveDone;
  const done = new Promise((res) => (resolveDone = res));
  let idleTimer = null;
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { log("idle — backlog drained"); resolveDone(); }, IDLE_MS);
  };

  const onInner = async (inner) => {
    const res = classifyPacket(inner);
    if (res.kind === "record" && res.record) {
      stats.records++;
      const ts = res.record.tsEpoch;
      if (ts) { stats.firstTs = stats.firstTs == null ? ts : Math.min(stats.firstTs, ts); stats.lastTs = Math.max(stats.lastTs || 0, ts); }
      onRecord && onRecord(res.record);
      if (stats.records % 200 === 0) { onProgress && onProgress(stats.records); log(`… ${stats.records} records`); }
      bumpIdle();
    } else if (res.kind === "end") {
      await write(buildBatchAck(nextSeq(), res.token)); // echo token or the band re-sends forever
      bumpIdle();
    } else if (res.kind === "complete") {
      stats.complete = true; log("HISTORY_COMPLETE"); resolveDone();
    }
  };

  // one reassembler per notify characteristic (each is its own byte stream)
  for (const c of notifyChars) {
    const ra = new FrameReassembler();
    c.addEventListener("characteristicvaluechanged", (e) => {
      const bytes = new Uint8Array(e.target.value.buffer);
      for (const inner of ra.feed(bytes)) onInner(inner);
    });
    await c.startNotifications();
  }

  // session-init sequence → triggers the drain
  await write(buildSetClock(Math.floor(Date.now() / 1000), nextSeq())); log("clock set");
  await sleep(150);
  await write(buildGetHello(nextSeq()));
  await sleep(150);
  await write(buildGetDataRange(nextSeq()));
  await sleep(150);
  await write(buildSendHistorical(nextSeq())); log("drain requested — receiving…");
  bumpIdle();

  await Promise.race([done, sleep(SAFETY_MS)]);
  clearTimeout(idleTimer);
  if (!stats.complete) { try { await write(buildAbortHistorical(nextSeq())); log("abort sent"); } catch { /* ignore */ } }
  log(`done · ${stats.records} records`);
  return stats;
}
