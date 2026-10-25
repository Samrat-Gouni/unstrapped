import { test } from "node:test";
import assert from "node:assert/strict";
import { movingAverage, detectSleepWindow, sleepMetrics } from "../src/whoop/sleep.js";

// Build a synthetic day at 30s cadence: 2h awake (~80 bpm), 8h night (~52 bpm),
// 1h awake (~76 bpm). Night RR alternates ±20 ms so RMSSD is non-zero.
function syntheticDay() {
  const recs = [];
  let ts = 1_700_000_000;
  const step = 30;
  for (let i = 0; i < 240; i++) { recs.push({ tsEpoch: ts, hr: 78 + (i % 7), rrIntervalsMs: [750] }); ts += step; }
  const nightStart = ts;
  for (let i = 0; i < 960; i++) { recs.push({ tsEpoch: ts, hr: 50 + (i % 5), rrIntervalsMs: [1153 + (i % 2 ? 20 : -20)] }); ts += step; }
  const nightEnd = ts - step;
  for (let i = 0; i < 120; i++) { recs.push({ tsEpoch: ts, hr: 74 + (i % 6), rrIntervalsMs: [789] }); ts += step; }
  return { recs, nightStart, nightEnd };
}

test("movingAverage smooths and preserves length", () => {
  const out = movingAverage([10, 10, 10, 40], 3);
  assert.equal(out.length, 4);
  assert.equal(out[0], 10);
  assert.ok(out[3] > 10 && out[3] < 40);
});

test("detectSleepWindow finds the overnight low-HR stretch", () => {
  const { recs, nightStart, nightEnd } = syntheticDay();
  const w = detectSleepWindow(recs);
  assert.ok(w, "expected a sleep window");
  // ~8 hours, within smoothing tolerance
  assert.ok(w.durationMin >= 420 && w.durationMin <= 485, `duration ${w.durationMin}`);
  // starts around lights-out, not in the morning-awake block
  assert.ok(w.startTs >= nightStart - 1200 && w.startTs <= nightStart + 1800, `startTs ${w.startTs - nightStart}`);
  assert.ok(w.endTs <= nightEnd + 1200, `endTs ${w.endTs - nightEnd}`); // smoothing lag tolerance
});

test("sleepMetrics reports sleeping HR and overnight RMSSD from the window", () => {
  const w = detectSleepWindow(syntheticDay().recs);
  const m = sleepMetrics(w);
  assert.ok(m.sleepingHR >= 50 && m.sleepingHR <= 54, `sleepingHR ${m.sleepingHR}`);
  assert.ok(m.meanSleepHR >= 50 && m.meanSleepHR <= 54);
  assert.ok(m.sleepRmssd > 0);
  assert.ok(m.durationMin >= 420);
});

test("detectSleepWindow keeps one window despite overnight HR drift", () => {
  // Night HR oscillates 47-57 (crosses a naive mid-band threshold); must stay one window.
  const recs = [];
  let ts = 1_700_000_000;
  for (let i = 0; i < 60; i++) { recs.push({ tsEpoch: ts, hr: 75 + (i % 5), rrIntervalsMs: [800] }); ts += 60; }
  for (let i = 0; i < 480; i++) { recs.push({ tsEpoch: ts, hr: 52 + Math.round(5 * Math.sin(i / 40)), rrIntervalsMs: [1150] }); ts += 60; }
  for (let i = 0; i < 60; i++) { recs.push({ tsEpoch: ts, hr: 77 + (i % 5), rrIntervalsMs: [780] }); ts += 60; }
  const w = detectSleepWindow(recs);
  assert.ok(w, "expected a window");
  assert.ok(w.durationMin >= 440, `expected ~8h unfragmented, got ${w.durationMin}m`);
});

test("detectSleepWindow returns null when there is no sustained low-HR window", () => {
  const recs = [];
  let ts = 1_700_000_000;
  for (let i = 0; i < 300; i++) { recs.push({ tsEpoch: ts, hr: 78 + (i % 10), rrIntervalsMs: [750] }); ts += 30; }
  assert.equal(detectSleepWindow(recs), null);
});

test("detectSleepWindow returns null for too few records", () => {
  assert.equal(detectSleepWindow([{ tsEpoch: 1, hr: 50 }]), null);
});
