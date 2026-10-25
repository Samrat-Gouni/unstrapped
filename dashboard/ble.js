// Data sources behind one interface. Both emit the same events so the app is
// agnostic to whether readings come from a real strap or the demo generator:
//   'status'  {state:'idle'|'connecting'|'live'|'err', text}
//   'device'  {name}
//   'battery' pct (number)
//   'hr'      {bpm, rr:[ms,...]}

// --- Bluetooth SIG standard services (bonding-free; confirmed on WHOOP 4.0) ---
const HEART_RATE_SERVICE = 0x180d;
const HEART_RATE_MEASUREMENT = 0x2a37;
const BATTERY_SERVICE = 0x180f;
const BATTERY_LEVEL = 0x2a19;
const WHOOP_SERVICES = [
  "61080000-8d6d-82b8-614a-1c8cb0f8dcc6",
  "61080001-8d6d-82b8-614a-1c8cb0f8dcc6",
];

import { drainHistory } from "./sync.js";

class Emitter extends EventTarget {
  on(type, cb) { this.addEventListener(type, (e) => cb(e.detail)); return this; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

// Standard Heart Rate Measurement (0x2A37): flags bit0 HR u8/u16, bit3 energy,
// bit4 RR intervals (u16 LE, 1/1024 s). Matches the WHOOP 4.0 stream.
function parseHeartRate(value) {
  const flags = value.getUint8(0);
  let o = 1, bpm;
  if ((flags & 0x01) === 0) { bpm = value.getUint8(o); o += 1; }
  else { bpm = value.getUint16(o, true); o += 2; }
  if (flags & 0x08) o += 2;
  const rr = [];
  if (flags & 0x10) {
    while (o + 1 < value.byteLength) { rr.push((value.getUint16(o, true) * 1000) / 1024); o += 2; }
  }
  return { bpm, rr };
}

export function createBleSource() {
  const em = new Emitter();
  let device = null, server = null;

  em.connect = async () => {
    if (!navigator.bluetooth) {
      em.emit("status", { state: "err", text: "Web Bluetooth unavailable — use Chrome/Edge" });
      return;
    }
    try {
      em.emit("status", { state: "connecting", text: "Requesting device…" });
      device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [HEART_RATE_SERVICE, BATTERY_SERVICE, ...WHOOP_SERVICES],
      });
      em.emit("device", { name: device.name || "(unnamed strap)" });
      device.addEventListener("gattserverdisconnected", () =>
        em.emit("status", { state: "err", text: "Strap disconnected" }));

      em.emit("status", { state: "connecting", text: "Connecting…" });
      server = await device.gatt.connect();

      const hrSvc = await server.getPrimaryService(HEART_RATE_SERVICE);
      const hrChar = await hrSvc.getCharacteristic(HEART_RATE_MEASUREMENT);
      await hrChar.startNotifications();
      hrChar.addEventListener("characteristicvaluechanged", (e) =>
        em.emit("hr", parseHeartRate(e.target.value)));

      try {
        const batSvc = await server.getPrimaryService(BATTERY_SERVICE);
        const batChar = await batSvc.getCharacteristic(BATTERY_LEVEL);
        em.emit("battery", (await batChar.readValue()).getUint8(0));
      } catch { /* battery is optional */ }

      em.emit("status", { state: "live", text: "Live · strap" });
    } catch (e) {
      if (e.name === "NotFoundError") { em.emit("status", { state: "idle", text: "Idle" }); return; }
      em.emit("status", { state: "err", text: `${e.name}: ${e.message}` });
    }
  };

  em.disconnect = () => {
    if (device && device.gatt.connected) device.gatt.disconnect();
    em.emit("status", { state: "idle", text: "Idle" });
  };

  // Enumerate every GATT service/characteristic. Read-only: we read `read`-able
  // characteristics for their values but never subscribe to or write the
  // proprietary notify channels, so this has no side effects on the strap.
  em.captureGatt = async () => {
    if (!server || !server.connected) throw new Error("Not connected to a strap");
    const hexOf = (dv) => Array.from(new Uint8Array(dv.buffer), (b) => b.toString(16).padStart(2, "0")).join(" ");
    const services = await server.getPrimaryServices();
    const out = [];
    for (const svc of services) {
      let chars = [];
      try { chars = await svc.getCharacteristics(); } catch { /* some services block enumeration */ }
      const entry = { service: svc.uuid, characteristics: [] };
      for (const c of chars) {
        const props = Object.entries(c.properties).filter(([, v]) => v).map(([k]) => k);
        let value = null, text = null;
        if (c.properties.read) {
          try {
            const dv = await c.readValue();
            value = hexOf(dv);
            const s = new TextDecoder().decode(dv).replace(/[^\x20-\x7e]+/g, "").trim();
            if (s) text = s;
          } catch { /* readable but denied */ }
        }
        entry.characteristics.push({ uuid: c.uuid, properties: props, value, text });
      }
      out.push(entry);
    }
    return { device: (device && device.name) || null, capturedAt: new Date().toISOString(), services: out };
  };

  // Drain the strap's historical flash over the existing connection.
  em.syncHistory = (cbs) => {
    if (!server || !server.connected) return Promise.reject(new Error("Not connected to a strap"));
    return drainHistory(server, cbs);
  };

  return em;
}

// Realistic-ish generator: HR drifts on a slow sine + noise; RR derived from HR
// with beat-to-beat variability so RMSSD/strain look alive.
export function createDemoSource() {
  const em = new Emitter();
  let timer = null, phase = 0, battery = 82;

  em.connect = async () => {
    em.emit("device", { name: "Demo strap (simulated)" });
    em.emit("battery", battery);
    em.emit("status", { state: "live", text: "Live · demo" });
    timer = setInterval(() => {
      phase += 0.05;
      const base = 64 + 14 * Math.sin(phase) + 6 * Math.sin(phase * 2.7);
      const bpm = Math.max(45, Math.round(base + (Math.random() - 0.5) * 4));
      const meanRr = 60000 / bpm;
      const n = 1 + (Math.random() < 0.25 ? 1 : 0);
      // ±50ms beat-to-beat jitter → RMSSD ~40ms, a realistic resting HRV.
      const rr = Array.from({ length: n }, () => meanRr + (Math.random() - 0.5) * 100);
      em.emit("hr", { bpm, rr });
      if (Math.random() < 0.01 && battery > 1) em.emit("battery", --battery);
    }, 1000);
  };

  em.disconnect = () => {
    if (timer) clearInterval(timer);
    timer = null;
    em.emit("status", { state: "idle", text: "Idle" });
  };

  // A representative WHOOP 4.0 GATT layout so the map view can be previewed
  // without a strap. The real band reports its own UUIDs when connected.
  em.captureGatt = async () => ({
    device: "Demo strap (simulated)",
    capturedAt: new Date().toISOString(),
    services: [
      { service: "00001800-0000-1000-8000-00805f9b34fb", characteristics: [
        { uuid: "00002a00-0000-1000-8000-00805f9b34fb", properties: ["read"], value: null, text: "WHOOP DEMO" },
      ] },
      { service: "0000180a-0000-1000-8000-00805f9b34fb", characteristics: [
        { uuid: "00002a24-0000-1000-8000-00805f9b34fb", properties: ["read"], value: null, text: "WHOOP 4.0" },
        { uuid: "00002a26-0000-1000-8000-00805f9b34fb", properties: ["read"], value: null, text: "4.2.1" },
        { uuid: "00002a27-0000-1000-8000-00805f9b34fb", properties: ["read"], value: null, text: "revB" },
      ] },
      { service: "0000180f-0000-1000-8000-00805f9b34fb", characteristics: [
        { uuid: "00002a19-0000-1000-8000-00805f9b34fb", properties: ["read", "notify"], value: "52", text: null },
      ] },
      { service: "0000180d-0000-1000-8000-00805f9b34fb", characteristics: [
        { uuid: "00002a37-0000-1000-8000-00805f9b34fb", properties: ["notify"], value: null, text: null },
        { uuid: "00002a38-0000-1000-8000-00805f9b34fb", properties: ["read"], value: "02", text: null },
      ] },
      { service: "61080001-8d6d-82b8-614a-1c8cb0f8dcc6", characteristics: [
        { uuid: "61080002-8d6d-82b8-614a-1c8cb0f8dcc6", properties: ["write", "writeWithoutResponse"], value: null, text: null },
        { uuid: "61080003-8d6d-82b8-614a-1c8cb0f8dcc6", properties: ["notify"], value: null, text: null },
        { uuid: "61080004-8d6d-82b8-614a-1c8cb0f8dcc6", properties: ["notify"], value: null, text: null },
        { uuid: "61080005-8d6d-82b8-614a-1c8cb0f8dcc6", properties: ["notify"], value: null, text: null },
        { uuid: "61080007-8d6d-82b8-614a-1c8cb0f8dcc6", properties: ["notify"], value: null, text: null },
      ] },
    ],
  });

  // Synthetic drain so the sync flow can be exercised without a strap: a full
  // day at 60s cadence — 1h awake, 8h sleep, 1h awake — so sleep detection fires.
  em.syncHistory = async ({ onRecord, onProgress, onLog } = {}) => {
    onLog && onLog("service 61080001 (demo) · 4 notify channels");
    onLog && onLog("clock set");
    onLog && onLog("drain requested — receiving…");
    let ts = Math.floor(Date.now() / 1000) - 10 * 3600;
    let count = 0;
    const emit = (hr, jitter) => {
      onRecord && onRecord({ tsEpoch: ts, hr, rrIntervalsMs: [Math.round(60000 / hr + (Math.random() - 0.5) * jitter)] });
      ts += 60; count++;
      if (count % 120 === 0) { onProgress && onProgress(count); onLog && onLog(`… ${count} records`); }
    };
    for (let i = 0; i < 60; i++) emit(74 + Math.round(4 * Math.sin(i / 8) + (Math.random() - 0.5) * 3), 50); // pre-sleep
    for (let i = 0; i < 480; i++) { emit(52 + Math.round(5 * Math.sin(i / 40) + (Math.random() - 0.5) * 2), 90); if (i % 80 === 0) await new Promise((r) => setTimeout(r, 1)); } // sleep
    for (let i = 0; i < 60; i++) emit(77 + Math.round(4 * Math.sin(i / 8) + (Math.random() - 0.5) * 3), 50); // post-wake
    onLog && onLog("HISTORY_COMPLETE");
    return { records: count, complete: true };
  };

  return em;
}
