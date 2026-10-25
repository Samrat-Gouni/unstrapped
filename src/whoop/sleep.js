// Sleep-window detection from drained 1 Hz records.
//
// Recovery should reflect your HRV during SLEEP, not the whole flash dump. This
// finds the main sleep stretch — the longest sustained low-heart-rate window —
// and derives sleeping HR + overnight RMSSD from just that slice. Pure module;
// reuses the tested time-domain helpers from metrics.js.

import { percentile, malikFilter, rmssd } from "./metrics.js";

/** Simple trailing moving average (window in samples). */
export function movingAverage(values, win) {
  const out = new Array(values.length);
  let sum = 0;
  const q = [];
  for (let i = 0; i < values.length; i++) {
    q.push(values[i]);
    sum += values[i];
    if (q.length > win) sum -= q.shift();
    out[i] = sum / q.length;
  }
  return out;
}

/**
 * Detect the primary sleep window: the longest contiguous run where smoothed HR
 * sits below a personalised threshold (30th percentile + 5 bpm). Records with
 * HR = 0 (no contact) are treated as non-sleep boundaries.
 * @param {Array<{tsEpoch:number, hr:number, rrIntervalsMs?:number[]}>} records
 * @param {{minMinutes?:number, smoothWin?:number}} [opts]
 * @returns {{startTs:number,endTs:number,durationMin:number,startIdx:number,endIdx:number,records:Array}|null}
 */
export function detectSleepWindow(records, { minMinutes = 90, smoothWin = 30, maxGapMin = 20 } = {}) {
  if (!records || records.length < 10) return null;
  const sorted = [...records].sort((a, b) => a.tsEpoch - b.tsEpoch);
  const validHr = sorted.map((r) => r.hr).filter((h) => h > 0);
  if (validHr.length < 10) return null;

  // Threshold generously separates the sleep HR band from the awake band: a low
  // percentile (near resting) plus a wide margin, so natural overnight HR drift
  // stays inside the window instead of fragmenting it.
  const threshold = percentile(validHr, 10) + 15;
  // HR=0 → large value so it can't be inside a sleep run.
  const smoothed = movingAverage(sorted.map((r) => (r.hr > 0 ? r.hr : 999)), smoothWin);

  // Longest run of smoothed HR ≤ threshold, bridging brief excursions above it
  // (short wake-ups / optical dropouts) up to maxGapMin.
  const maxGapS = maxGapMin * 60;
  let best = null, runStart = null, lastBelow = null;
  const close = () => {
    if (runStart === null) return;
    const durS = sorted[lastBelow].tsEpoch - sorted[runStart].tsEpoch;
    if (!best || durS > best.durS) best = { start: runStart, end: lastBelow, durS };
    runStart = null; lastBelow = null;
  };
  for (let i = 0; i < smoothed.length; i++) {
    if (smoothed[i] <= threshold) {
      if (runStart === null) runStart = i;
      lastBelow = i;
    } else if (runStart !== null && sorted[i].tsEpoch - sorted[lastBelow].tsEpoch > maxGapS) {
      close();
    }
  }
  close();
  if (!best) return null;
  const durationMin = best.durS / 60;
  if (durationMin < minMinutes) return null;

  // Contrast gate: a genuine sleep window is clearly lower than the surrounding
  // awake periods. Require a real awake period (≥20 valid samples) that is ≥8 bpm
  // higher — HR alone can't distinguish a flat all-awake day from sleep without
  // one. For a night-only dump (no awake contrast) we return null and the caller
  // falls back to whole-dump HRV, which is already the night.
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const insideHr = sorted.slice(best.start, best.end + 1).map((r) => r.hr).filter((h) => h > 0);
  const outsideHr = [...sorted.slice(0, best.start), ...sorted.slice(best.end + 1)]
    .map((r) => r.hr).filter((h) => h > 0);
  if (outsideHr.length < 20 || mean(outsideHr) - mean(insideHr) < 8) return null;

  return {
    startTs: sorted[best.start].tsEpoch,
    endTs: sorted[best.end].tsEpoch,
    durationMin: Math.round(durationMin),
    startIdx: best.start,
    endIdx: best.end,
    records: sorted.slice(best.start, best.end + 1),
  };
}

/**
 * HRV + HR metrics over a detected sleep window.
 * @param {ReturnType<typeof detectSleepWindow>} window
 */
export function sleepMetrics(window) {
  if (!window) return null;
  const rr = [];
  const hr = [];
  for (const r of window.records) {
    if (r.hr > 0) hr.push(r.hr);
    for (const v of r.rrIntervalsMs || []) if (v >= 300 && v <= 2000) rr.push(v);
  }
  const filtered = malikFilter(rr);
  return {
    durationMin: window.durationMin,
    sleepRmssd: rmssd(filtered),
    sleepingHR: hr.length ? Math.min(...hr) : null,    // lowest ≈ true sleeping HR
    meanSleepHR: hr.length ? Math.round(hr.reduce((a, b) => a + b, 0) / hr.length) : null,
    rrCount: filtered.length,
  };
}
