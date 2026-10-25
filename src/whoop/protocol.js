// WHOOP 4.0 (Gen4 / "Harvard") proprietary protocol: commands + record decoders.
//
// Verified against OpenStrap (openstrap-research/research_playground.py,
// openstrap-protocol) — hardware-confirmed across 811 real records. Pure module:
// no BLE/DOM deps, so it runs identically in Node (tests) and the browser.
//
// Live HR for the dashboard comes from the STANDARD Heart Rate service
// (0x180D/0x2A37, see phase1/index.html); this proprietary channel is for the
// historical flash drain, device commands, and the raw sensor record (R24).

import { buildFrame } from "./framing.js";

// --- GATT UUIDs (Gen4). OpenStrap's hardware-verified mapping; confirm against
// the on-device GATT explorer, since community refs disagree by one slot. ------
export const SERVICE_UUID = "61080001-8d6d-82b8-614a-1c8cb0f8dcc6";
export const CHAR = Object.freeze({
  cmdWrite: "61080002-8d6d-82b8-614a-1c8cb0f8dcc6", // phone → strap
  cmdNotify: "61080003-8d6d-82b8-614a-1c8cb0f8dcc6", // strap → phone (responses)
  events: "61080004-8d6d-82b8-614a-1c8cb0f8dcc6", // async events
  data: "61080005-8d6d-82b8-614a-1c8cb0f8dcc6", // realtime + historical records
  memfault: "61080007-8d6d-82b8-614a-1c8cb0f8dcc6",
});

// --- Inner-packet type byte (inner[0]) -------------------------------------
export const PacketType = Object.freeze({
  COMMAND: 0x23,
  COMMAND_RESPONSE: 0x24,
  REALTIME_DATA: 0x28,
  REALTIME_RAW_DATA: 0x2b,
  HISTORICAL_DATA: 0x2f,
  EVENT: 0x30,
  METADATA: 0x31,
  CONSOLE_LOGS: 0x32,
});

// --- Command opcodes (inner[2] inside a 0x23 COMMAND) -----------------------
export const Cmd = Object.freeze({
  LINK_VALID: 0x01, // heartbeat, send ~every 10s
  TOGGLE_REALTIME_HR: 0x03,
  SET_CLOCK: 0x0a, // [u32 epoch LE][u32 0] — set RTC or timestamps are zero-epoch
  GET_CLOCK: 0x0b,
  ABORT_HISTORICAL_TRANSMITS: 0x14,
  SEND_HISTORICAL_DATA: 0x16, // start the flash drain
  HISTORICAL_DATA_RESULT: 0x17, // the batch ACK
  FORCE_TRIM: 0x19, // ⚠ flash erase — destructive
  GET_BATTERY_LEVEL: 0x1a, // resp [5:7] u16 LE / 10 = %
  REBOOT_STRAP: 0x1d,
  SET_READ_POINTER: 0x21, // u32 offset
  GET_DATA_RANGE: 0x22,
  GET_HELLO_HARVARD: 0x23,
  SEND_R10_R11_REALTIME: 0x3f,
  TOGGLE_IMU_MODE: 0x6a,
  ENABLE_OPTICAL_DATA: 0x6b, // 2-byte [01,01] — the wrist-gated HR source
  GET_ADVERTISING_NAME_HARVARD: 0x4c,
  TOGGLE_PERSISTENT_R21: 0x9a, // ⚠ forces optical persistently → stuck LED
});

// Sync metadata sub-types (inner[2] inside a 0x31 METADATA packet)
export const SyncMeta = Object.freeze({ HISTORY_START: 1, HISTORY_END: 2, HISTORY_COMPLETE: 3 });

export const REVISION_1 = 0x01;

// Opcodes we refuse to build without an explicit override: FORCE_TRIM wipes
// flash; TOGGLE_PERSISTENT_R21 can leave the LED stuck on until a reboot.
const DANGEROUS = new Set([Cmd.FORCE_TRIM, Cmd.TOGGLE_PERSISTENT_R21]);

// --- little-endian readers --------------------------------------------------
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i16 = (b, o) => { const v = u16(b, o); return v >= 0x8000 ? v - 0x10000 : v; };
const f32 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true);
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// --- command builders -------------------------------------------------------

/**
 * Build a framed command. Inner = [0x23][seq][opcode][payload].
 * @param {number} seq sequence byte
 * @param {number} opcode see Cmd
 * @param {Uint8Array|number[]} [payload] defaults to a single 0x00
 * @param {{allowDangerous?:boolean}} [opts]
 */
export function buildCommand(seq, opcode, payload = Uint8Array.of(0), opts = {}) {
  if (DANGEROUS.has(opcode) && !opts.allowDangerous) {
    throw new Error(`Refusing to build dangerous opcode 0x${opcode.toString(16)} without allowDangerous`);
  }
  const p = Uint8Array.from(payload);
  const inner = new Uint8Array(3 + p.length);
  inner[0] = PacketType.COMMAND;
  inner[1] = seq & 0xff;
  inner[2] = opcode & 0xff;
  inner.set(p, 3);
  return buildFrame(inner);
}

/**
 * The historical-sync batch ACK (cmd 0x17). Inner = [0x23][seq][0x17][0x01]+token(8).
 * `token` is inner[13:21] from a HISTORY_END metadata marker. Miss it and the
 * band re-sends the same batch forever (the "Groundhog Day" bug).
 */
export function buildBatchAck(seq, token) {
  if (token.length !== 8) throw new Error("batch token must be 8 bytes");
  const inner = new Uint8Array(12);
  inner[0] = PacketType.COMMAND;
  inner[1] = seq & 0xff;
  inner[2] = Cmd.HISTORICAL_DATA_RESULT;
  inner[3] = REVISION_1; // also reads as 0x01 SUCCESS
  inner.set(token, 4);
  return buildFrame(inner);
}

/** Set the strap RTC. Without this, drained records carry zero-epoch timestamps. */
export function buildSetClock(epochSeconds, seq = 0) {
  const p = new Uint8Array(8);
  const dv = new DataView(p.buffer);
  dv.setUint32(0, epochSeconds >>> 0, true);
  dv.setUint32(4, 0, true);
  return buildCommand(seq, Cmd.SET_CLOCK, p);
}

// One-shot convenience builders for the session-init sequence.
export const buildGetHello = (seq = 0) => buildCommand(seq, Cmd.GET_HELLO_HARVARD);
export const buildGetBattery = (seq = 0) => buildCommand(seq, Cmd.GET_BATTERY_LEVEL, new Uint8Array(0));
export const buildGetDataRange = (seq = 0) => buildCommand(seq, Cmd.GET_DATA_RANGE);
export const buildSendHistorical = (seq = 0) => buildCommand(seq, Cmd.SEND_HISTORICAL_DATA);
export const buildAbortHistorical = (seq = 0) => buildCommand(seq, Cmd.ABORT_HISTORICAL_TRANSMITS);
export const buildSetReadPointer = (offset, seq = 0) => {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setUint32(0, offset >>> 0, true);
  return buildCommand(seq, Cmd.SET_READ_POINTER, p);
};

// --- inbound parsers --------------------------------------------------------

/**
 * Parse a 0x31 METADATA sync marker. Returns the sub-type and, for HISTORY_END,
 * the 8-byte continuation token to echo back via buildBatchAck.
 * @returns {{sub:number, token:Uint8Array|null, batchId:number|null}|null}
 */
export function parseMetadataMarker(inner) {
  if (inner.length < 3 || inner[0] !== PacketType.METADATA) return null;
  const sub = inner[2];
  if (sub === SyncMeta.HISTORY_END && inner.length >= 21) {
    return { sub, token: inner.slice(13, 21), batchId: u32(inner, 17) };
  }
  return { sub, token: null, batchId: null };
}

/**
 * Decode a type-24 (R24) 1 Hz historical record. Offsets re-validated by
 * OpenStrap across 811 real records. HR + header are verified; the optical /
 * temp / ambient channels are RAW RELATIVE ADCs (WHOOP derives %SpO₂ and °C in
 * the cloud) — surface them as trends, never as absolute SpO₂% or °C.
 * @param {Uint8Array} inner inner packet (inner[0]=0x2F, inner[1]=24)
 */
export function parseR24(inner) {
  if (inner.length < 89) return null;
  const rrCount = inner[18];
  const rr = [];
  for (let i = 0, o = 19; i < rrCount && o + 2 <= inner.length; i++, o += 2) {
    const v = i16(inner, o);
    if (v > 0) rr.push(v);
  }
  return {
    counter: u32(inner, 3),
    tsEpoch: u32(inner, 7),
    tsSubsec: u16(inner, 11),
    hr: inner[17], // bpm; 0 = no reading
    rrCount,
    rrIntervalsMs: rr,
    ppgGreen: u16(inner, 29),
    ppgRedIr: u16(inner, 31),
    accelG: [round4(f32(inner, 36)), round4(f32(inner, 40)), round4(f32(inner, 44))],
    skinContact: inner[51], // 0-198 quality, NOT a wear flag
    spo2RedRaw: u16(inner, 64), // relative ADC
    spo2IrRaw: u16(inner, 66), // relative ADC (pairs with red → SpO₂ ratio)
    skinTempRaw: u16(inner, 68), // relative ADC (°C is cloud-derived)
    ambientRaw: u16(inner, 70), // relative ADC
    rawTailHex: toHex(inner.slice(13)),
  };
}

/** Decode a 0x28 compact REALTIME_DATA packet (proprietary live HR channel). */
export function parseRealtimeHr(inner) {
  if (inner.length < 20 || inner[0] !== PacketType.REALTIME_DATA) return null;
  return { hr: inner[8], tsEpoch: u32(inner, 2), subsec: u16(inner, 6), onWrist: inner[18] === 0 };
}

/** Battery % from a 0x1A response inner packet: u16 LE at [5:7] ÷ 10. */
export function parseBatteryResponse(inner) {
  if (inner.length < 7) return null;
  return u16(inner, 5) / 10;
}

function round4(x) { return Math.round(x * 1e4) / 1e4; }
