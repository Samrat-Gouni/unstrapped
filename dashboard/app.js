// Unstrapped Console — orchestration. Reuses the tested metrics engine from
// ../src/whoop/metrics.js (same code the unit tests cover) and drives the UI,
// charts, and local session store.

import { rmssd, malikFilter, restingHR, strain, recoveryScore, percentile, activeKcalPerMin, bmrPerDay } from "../src/whoop/metrics.js";
import { detectSleepWindow, sleepMetrics } from "../src/whoop/sleep.js";
import { HRTrace } from "./charts.js";
import { createBleSource, createDemoSource } from "./ble.js";
import { saveSession, listSessions, deleteSession, downloadCsv, recentRmssd } from "./store.js";

const RR_WINDOW = 60; // rolling RR count for live RMSSD
const RING_C = 2 * Math.PI * 86; // recovery ring circumference
const MAX_HR = 190; // strain reference; refine later from profile/age

const $ = (id) => document.getElementById(id);
const setText = (id, v) => { $(id).textContent = v; };
const el = {
  connect: $("connect"), disconnect: $("disconnect"), demo: $("demo"),
  dot: $("dot"), status: $("status"),
  battery: $("battery"), battPct: $("batt-pct"), battFill: $("batt-fill"),
  hr: $("hr"), pulse: $("pulse"), trace: $("trace"),
  hrMin: $("hr-min"), hrAvg: $("hr-avg"), hrMax: $("hr-max"),
  hrv: $("hrv"), rhr: $("rhr"), rr: $("rr"), beats: $("beats"),
  strain: $("strain"), strainBar: $("strain-bar"),
  recValue: $("rec-value"), recArc: $("rec-arc"), recTag: $("rec-tag"), recNote: $("rec-note"),
  recCard: document.querySelector(".recovery"),
  elapsed: $("elapsed"), rrn: $("rrn"), win: $("win"), src: $("src"), recLive: $("rec-live"),
  hist: $("hist"), histCount: $("hist-count"),
  gatt: $("gatt"), gattModal: $("gatt-modal"), gattBody: $("gatt-body"), gattSub: $("gatt-sub"),
  sync: $("sync"), syncModal: $("sync-modal"), syncLog: $("sync-log"),
};
let lastGatt = null;

const trace = new HRTrace(el.trace);
let source = null;
let session = null; // active recording
let baseline = []; // recent daily RMSSD for recovery
let isDemo = false;
let clock = null;

// ---- profile (for calories) ------------------------------------------------
const PROFILE_KEY = "whoop-profile";
function loadProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || null; } catch { return null; }
}
function saveProfile(p) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}
let profile = loadProfile();

el.recArc.style.strokeDasharray = RING_C;
el.recArc.style.strokeDashoffset = RING_C;

// ---- source lifecycle ------------------------------------------------------
function startSource(factory, demo) {
  stopSource();
  isDemo = demo;
  source = factory();
  source.on("status", onStatus);
  source.on("device", (d) => setText("src", d.name));
  source.on("battery", onBattery);
  source.on("hr", onHeartRate);
  source.connect();
  el.connect.hidden = demo;
  el.disconnect.hidden = false;
  el.demo.setAttribute("aria-pressed", String(demo));
}

function stopSource() {
  if (source) { source.disconnect(); source = null; }
}

function onStatus({ state, text }) {
  el.dot.className = "dot" + (state === "live" ? " live" : state === "connecting" ? " wait" : state === "err" ? " err" : "");
  setText("status", text);
  el.gatt.hidden = !(state === "live" && source && source.captureGatt);
  el.sync.hidden = !(state === "live" && source && source.syncHistory);
  if (state === "live") startSession();
  else endSession();
}

function onBattery(pct) {
  el.battery.hidden = false;
  setText("batt-pct", `${Math.round(pct)}%`);
  el.battFill.style.width = `${Math.max(4, Math.min(100, pct))}%`;
  el.battFill.style.background = pct < 20 ? "var(--rec-low)" : pct < 45 ? "var(--rec-mid)" : "var(--rec-high)";
}

// ---- session recording -----------------------------------------------------
function startSession() {
  if (session) return;
  session = { id: Date.now(), startedAt: Date.now(), endedAt: null, source: isDemo ? "demo" : "strap",
    samples: [], hrAll: [], rrAll: [], kcal: 0, lastCalT: null };
  rrBuffer = [];
  trace.start();
  el.recLive.hidden = false;
  setText("cal", profile ? "0" : "--");
  clock = setInterval(tickClock, 1000);
}

async function endSession() {
  trace.stop();
  el.recLive.hidden = true;
  el.connect.hidden = false;
  el.disconnect.hidden = true;
  el.demo.setAttribute("aria-pressed", "false");
  if (clock) { clearInterval(clock); clock = null; }
  if (!session || session.samples.length === 0) { session = null; return; }

  const rr = malikFilter(session.rrAll);
  const hr = session.hrAll;
  session.endedAt = Date.now();
  session.summary = {
    beats: hr.length,
    rmssd: rmssd(rr),
    meanHR: hr.length ? Math.round(hr.reduce((a, b) => a + b, 0) / hr.length) : null,
    restingHR: hr.length ? Math.round(restingHR(hr) ?? 0) : null,
    strain: strain(hr, { restingHR: restingHR(hr) ?? 60, maxHR: MAX_HR }),
    rrCount: rr.length,
    kcal: Math.round(session.kcal),
  };
  const persisted = { ...session };
  session = null;
  try { await saveSession(persisted); await refreshHistory(); } catch { /* storage may be blocked */ }
}

function tickClock() {
  if (!session) return;
  const s = Math.floor((Date.now() - session.startedAt) / 1000);
  setText("elapsed", `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`);
}

// ---- live readings ---------------------------------------------------------
const HR_MIN = 25, HR_MAX = 230, RR_MIN = 300, RR_MAX = 2000;
let rrBuffer = [];
function onHeartRate({ bpm, rr }) {
  if (!session) return;
  // A real WHOOP reports HR = 0 (and junk RR) whenever it briefly loses optical
  // contact. Drop those — otherwise a stray 0 tanks min/resting HR and a missed-
  // beat gap explodes RMSSD.
  if (!(bpm >= HR_MIN && bpm <= HR_MAX)) return;

  setText("hr", bpm);
  el.pulse.classList.remove("beat"); void el.pulse.offsetWidth; el.pulse.classList.add("beat");
  trace.push(bpm);

  const clean = (rr || []).filter((v) => v >= RR_MIN && v <= RR_MAX);
  session.hrAll.push(bpm);
  session.samples.push({ t: Date.now(), hr: bpm, rr: clean });
  setText("beats", session.hrAll.length);

  const hr = session.hrAll;
  setText("hr-min", Math.min(...hr));
  setText("hr-max", Math.max(...hr));
  setText("hr-avg", Math.round(hr.reduce((a, b) => a + b, 0) / hr.length));
  const rest = restingHR(hr) ?? Math.min(...hr);
  setText("rhr", Math.round(rest));
  const s = strain(hr, { restingHR: rest, maxHR: MAX_HR });
  setText("strain", s.toFixed(1));
  el.strainBar.style.width = `${(s / 21) * 100}%`;

  // Calories: Keytel active burn + Mifflin–St Jeor resting baseline, integrated
  // over the real time between valid samples (gaps clamped so a dropout doesn't
  // over-count). Needs a saved profile.
  const now = Date.now();
  if (profile && session.lastCalT) {
    const dt = Math.min(5, (now - session.lastCalT) / 1000);
    const activeKcal = (activeKcalPerMin(bpm, profile) / 60) * dt;
    const bmr = bmrPerDay(profile);
    const baseKcal = bmr ? (bmr / 86400) * dt : 0;
    session.kcal += activeKcal + baseKcal;
    setText("cal", Math.round(session.kcal));
  }
  session.lastCalT = now;

  if (clean.length) {
    setText("rr", Math.round(clean[clean.length - 1]));
    for (const iv of clean) { rrBuffer.push(iv); session.rrAll.push(iv); }
    if (rrBuffer.length > RR_WINDOW) rrBuffer = rrBuffer.slice(-RR_WINDOW);
    setText("rrn", session.rrAll.length);
    setText("win", `${rrBuffer.length} RR`);
    // Malik-filter the live window so one optical artifact can't blow up RMSSD.
    const v = rmssd(malikFilter(rrBuffer));
    setText("hrv", v == null ? "--" : Math.round(v));
    // NOTE: recovery is intentionally NOT updated from the live stream. It's an
    // overnight metric (sleep HRV vs baseline) set by the history sync — daytime
    // HRV must not overwrite it.
  }
}

// ---- recovery --------------------------------------------------------------
function updateRecovery(currentRmssd) {
  // A realistic baseline has natural spread; a too-tight one makes recovery
  // hypersensitive. These demo values span a believable 2-week RMSSD range.
  const base = baseline.length >= 2 ? baseline : (isDemo ? [33, 49, 38, 52, 36, 45, 42, 50, 37, 44] : null);
  if (!base) return;
  const score = recoveryScore(currentRmssd, base);
  if (score == null) return;
  setText("rec-value", score);
  el.recArc.style.strokeDashoffset = RING_C * (1 - score / 100);
  const color = score < 34 ? "var(--rec-low)" : score < 67 ? "var(--rec-mid)" : "var(--rec-high)";
  el.recCard.style.setProperty("--rec", color);
  setText("rec-tag", isDemo && baseline.length < 2 ? "demo baseline" : "live");
  setText("rec-note", score < 34 ? "Low — your HRV is below baseline; prioritise rest."
    : score < 67 ? "Moderate — train, but keep an eye on load."
    : "High — your body is primed; a harder day is well tolerated.");
}

// ---- history ---------------------------------------------------------------
function fmtWhen(ts) {
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtDur(a, b) {
  const s = Math.max(0, Math.floor((b - a) / 1000));
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function refreshHistory() {
  const sessions = await listSessions();
  baseline = sessions.map((s) => s.summary?.rmssd).filter((v) => v > 0).slice(0, 14);
  setText("hist-count", `${sessions.length} session${sessions.length === 1 ? "" : "s"}`);
  el.hist.replaceChildren();
  if (sessions.length === 0) {
    el.hist.append(mk("li", { class: "hist-empty", text: "No sessions yet — connect the strap or run demo mode." }));
    return;
  }
  for (const s of sessions) el.hist.append(historyRow(s));
}

function historyRow(s) {
  const li = mk("li", { class: "hist-row" });
  const left = mk("div");
  left.append(mk("div", { class: "when", text: fmtWhen(s.startedAt) }));
  const rmssdTxt = s.summary?.rmssd ? `${Math.round(s.summary.rmssd)}ms HRV` : "—";
  const kcalTxt = s.summary?.kcal ? `${s.summary.kcal} kcal · ` : "";
  const sleepTxt = s.summary?.sleepMin ? `${Math.floor(s.summary.sleepMin / 60)}h${s.summary.sleepMin % 60}m sleep · ` : "";
  left.append(mk("div", { class: "meta", text: `${fmtDur(s.startedAt, s.endedAt || s.startedAt)} · ${s.summary?.meanHR ?? "--"} avg · ${rmssdTxt} · ${sleepTxt}${kcalTxt}${s.source}` }));
  const actions = mk("div", { class: "row-actions" });
  const exp = mk("button", { class: "mini", text: "CSV" });
  exp.addEventListener("click", () => downloadCsv(s));
  const del = mk("button", { class: "mini del", text: "Delete" });
  del.addEventListener("click", async () => { await deleteSession(s.id); await refreshHistory(); });
  actions.append(exp, del);
  li.append(left, mk("span"), actions);
  return li;
}

function mk(tag, opts = {}) {
  const n = document.createElement(tag);
  if (opts.class) n.className = opts.class;
  if (opts.text != null) n.textContent = opts.text;
  return n;
}

// ---- wire up ---------------------------------------------------------------
// ---- GATT map --------------------------------------------------------------
function shortUuid(u) {
  const m = String(u).match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i);
  return m ? "0x" + m[1].toUpperCase() : u;
}
const KNOWN = {
  "0x180d": "Heart Rate", "0x180f": "Battery", "0x180a": "Device Info",
  "61080000-8d6d-82b8-614a-1c8cb0f8dcc6": "WHOOP (proprietary)",
  "61080001-8d6d-82b8-614a-1c8cb0f8dcc6": "WHOOP (proprietary)",
};

function renderGatt(map) {
  el.gattBody.replaceChildren();
  setText("gatt-sub", `${map.device || "strap"} · captured ${new Date(map.capturedAt).toLocaleString()}`);
  if (!map.services.length) { el.gattBody.append(mk("p", { class: "modal-empty", text: "No services enumerated." })); return; }
  for (const svc of map.services) {
    const block = mk("div", { class: "gatt-svc" });
    const head = mk("div", { class: "gatt-svc-head" });
    const known = KNOWN[shortUuid(svc.service).toLowerCase()] || KNOWN[svc.service];
    if (known) head.append(mk("span", { class: "label", text: known }));
    head.append(mk("span", { class: "uuid", text: shortUuid(svc.service) }));
    block.append(head);
    for (const c of svc.characteristics) {
      const row = mk("div", { class: "gatt-char" });
      row.append(mk("span", { class: "cu", text: shortUuid(c.uuid) }));
      const props = mk("span", { class: "cp" });
      for (const p of c.properties) props.append(mk("span", { text: p }));
      row.append(props);
      if (c.text || c.value) {
        const val = mk("span", { class: "cval" });
        val.append(mk("em", { text: c.text ? `"${c.text}"  ` : "" }));
        val.append(document.createTextNode(c.value || ""));
        row.append(val);
      }
      block.append(row);
    }
    el.gattBody.append(block);
  }
}

async function openGatt() {
  if (!source || !source.captureGatt) return;
  try {
    setText("gatt-sub", "Reading services…");
    el.gattModal.hidden = false;
    lastGatt = await source.captureGatt();
    renderGatt(lastGatt);
  } catch (e) {
    el.gattBody.replaceChildren(mk("p", { class: "modal-empty", text: `Capture failed: ${e.message}` }));
  }
}

el.gatt.addEventListener("click", openGatt);
$("gatt-close").addEventListener("click", () => { el.gattModal.hidden = true; });
el.gattModal.addEventListener("click", (e) => { if (e.target === el.gattModal) el.gattModal.hidden = true; });
$("gatt-copy").addEventListener("click", () => {
  if (lastGatt) navigator.clipboard.writeText(JSON.stringify(lastGatt, null, 2));
});
$("gatt-download").addEventListener("click", () => {
  if (!lastGatt) return;
  const blob = new Blob([JSON.stringify(lastGatt, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `whoop-gatt-${Date.now()}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---- history sync (flash drain) --------------------------------------------
function syncLog(msg, cls) {
  const line = mk("div", { class: "l" });
  line.append(mk("span", { class: "t", text: new Date().toTimeString().slice(0, 8) }));
  line.append(mk("span", { class: "m" + (cls ? " " + cls : ""), text: msg }));
  el.syncLog.append(line);
  el.syncLog.scrollTop = el.syncLog.scrollHeight;
}

async function runSync() {
  if (!source || !source.syncHistory) return;
  el.syncModal.hidden = false;
  el.syncLog.replaceChildren();
  setText("sync-count", "starting…");
  syncLog("Starting flash drain…");

  const records = [];
  let first = null, last = null;
  const onRecord = (r) => {
    records.push({ tsEpoch: r.tsEpoch, hr: r.hr, rrIntervalsMs: r.rrIntervalsMs || [] });
    if (r.tsEpoch) { first = first == null ? r.tsEpoch : Math.min(first, r.tsEpoch); last = Math.max(last || 0, r.tsEpoch); }
  };
  const onProgress = (n) => setText("sync-count", `${n} records`);

  try {
    const res = await source.syncHistory({ onRecord, onProgress, onLog: (m) => syncLog(m) });

    // Prefer the detected sleep window for recovery; fall back to the whole dump.
    const sleepWin = detectSleepWindow(records);
    const sleep = sleepWin ? sleepMetrics(sleepWin) : null;
    const allHr = [], allRr = [];
    for (const r of records) {
      if (r.hr >= 25 && r.hr <= 230) allHr.push(r.hr);
      for (const v of r.rrIntervalsMs) if (v >= 300 && v <= 2000) allRr.push(v);
    }
    const overnightRmssd = sleep?.sleepRmssd ?? rmssd(malikFilter(allRr));
    const sleepingHR = sleep?.sleepingHR ?? (allHr.length ? Math.round(restingHR(allHr) ?? Math.min(...allHr)) : null);
    if (sleep) syncLog(`sleep window: ${Math.floor(sleep.durationMin / 60)}h ${sleep.durationMin % 60}m · sleeping HR ${sleep.sleepingHR} bpm`);
    else syncLog("no awake/sleep contrast — using whole dump for HRV");

    // Guard against an unset strap RTC (timestamps near epoch 0 → use now).
    const SANE = 1577836800; // 2020-01-01
    const startTs = (first && first > SANE ? first : Math.floor(Date.now() / 1000)) * 1000;
    const endTs = (last && last > SANE ? last : Math.floor(Date.now() / 1000)) * 1000;
    const drain = {
      id: Date.now(),
      startedAt: startTs, endedAt: endTs, source: "sync", samples: [],
      summary: {
        beats: allHr.length,
        rmssd: overnightRmssd,
        meanHR: allHr.length ? Math.round(allHr.reduce((a, b) => a + b, 0) / allHr.length) : null,
        restingHR: sleepingHR,
        rrCount: allRr.length,
        sleepMin: sleep ? sleep.durationMin : null,
      },
    };
    await saveSession(drain);
    await refreshHistory();
    if (overnightRmssd) updateRecovery(overnightRmssd);
    setText("sync-count", `${res.records} records · done`);
    syncLog(`✓ stored ${res.records} records · overnight HRV ${overnightRmssd ? Math.round(overnightRmssd) : "--"} ms · resting ${sleepingHR ?? "--"} bpm`, "ok");
  } catch (e) {
    setText("sync-count", "failed");
    syncLog(`✗ ${e.message}`, "err");
  }
}

el.sync.addEventListener("click", runSync);
$("sync-close").addEventListener("click", () => { el.syncModal.hidden = true; });
el.syncModal.addEventListener("click", (e) => { if (e.target === el.syncModal) el.syncModal.hidden = true; });

// ---- profile modal ---------------------------------------------------------
function openProfile() {
  const p = profile || {};
  $("p-sex").value = p.sex || "male";
  $("p-age").value = p.ageYears ?? "";
  $("p-weight").value = p.weightKg ?? "";
  $("p-height").value = p.heightCm ?? "";
  $("profile-modal").hidden = false;
}
$("profile").addEventListener("click", openProfile);
$("profile-close").addEventListener("click", () => { $("profile-modal").hidden = true; });
$("profile-modal").addEventListener("click", (e) => { if (e.target.id === "profile-modal") e.currentTarget.hidden = true; });
$("profile-form").addEventListener("submit", (e) => {
  e.preventDefault();
  profile = {
    sex: $("p-sex").value,
    ageYears: Number($("p-age").value) || null,
    weightKg: Number($("p-weight").value) || null,
    heightCm: Number($("p-height").value) || null,
  };
  saveProfile(profile);
  $("profile-modal").hidden = true;
  if (session) setText("cal", Math.round(session.kcal));
});

el.connect.addEventListener("click", () => startSource(createBleSource, false));
el.demo.addEventListener("click", () => {
  if (isDemo && source) stopSource();
  else startSource(createDemoSource, true);
});
el.disconnect.addEventListener("click", stopSource);

refreshHistory();
