// Health metrics engine — HRV, recovery, strain, resting HR.
//
// These are computed from raw RR-intervals and heart-rate samples using
// published sports-science formulas. They are our own implementations, NOT
// WHOOP's proprietary algorithms — recovery and strain in particular are
// defensible *proxies* that reproduce the shape of WHOOP's scores, not their
// exact numbers. RMSSD / SDNN / pNN50 are standard and vendor-independent.
//
// Pure functions, no side effects. Units: RR in ms, HR in bpm.

// --- Artifact filtering ----------------------------------------------------

/**
 * Malik filter: reject an RR interval that differs from the previous *accepted*
 * interval by more than `threshold` (default 20%). Removes ectopic beats and
 * missed/extra detections before HRV is computed.
 * @param {number[]} rr
 * @param {number} [threshold] fractional tolerance (0.2 = 20%)
 * @returns {number[]} cleaned intervals
 */
export function malikFilter(rr, threshold = 0.2) {
  if (rr.length === 0) return [];
  const out = [rr[0]];
  for (let i = 1; i < rr.length; i++) {
    const prev = out[out.length - 1];
    if (Math.abs(rr[i] - prev) <= threshold * prev) out.push(rr[i]);
  }
  return out;
}

// --- Time-domain HRV -------------------------------------------------------

export function meanRR(rr) {
  if (rr.length === 0) return null;
  return rr.reduce((a, b) => a + b, 0) / rr.length;
}

/** Root mean square of successive differences (ms). The core HRV metric. */
export function rmssd(rr) {
  if (rr.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < rr.length; i++) {
    const d = rr[i] - rr[i - 1];
    sum += d * d;
  }
  return Math.sqrt(sum / (rr.length - 1));
}

/** Standard deviation of NN intervals (ms). Population SD. */
export function sdnn(rr) {
  if (rr.length < 2) return null;
  const m = meanRR(rr);
  const variance = rr.reduce((a, b) => a + (b - m) * (b - m), 0) / rr.length;
  return Math.sqrt(variance);
}

/** Percentage of successive RR differences greater than 50 ms. */
export function pnn50(rr) {
  if (rr.length < 2) return null;
  let count = 0;
  for (let i = 1; i < rr.length; i++) {
    if (Math.abs(rr[i] - rr[i - 1]) > 50) count++;
  }
  return (count / (rr.length - 1)) * 100;
}

// --- Heart rate ------------------------------------------------------------

/** Instantaneous HR (bpm) from each RR interval (ms). */
export function hrFromRR(rr) {
  return rr.map((ms) => 60000 / ms);
}

/**
 * Percentile of a sample set (linear interpolation).
 * @param {number[]} samples
 * @param {number} p percentile 0..100
 */
export function percentile(samples, p) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Resting HR = low percentile of the HR distribution (default 5th). */
export function restingHR(hrSamples, p = 5) {
  return percentile(hrSamples, p);
}

// --- Recovery --------------------------------------------------------------

/**
 * Recovery score 0-100 from today's RMSSD relative to a personal baseline.
 * RMSSD is log-normally distributed, so we z-score ln(RMSSD) against the
 * baseline and squash through a logistic. Higher HRV vs baseline → higher
 * recovery. z=0 → 50, z=+2 → ~88, z=-2 → ~12.
 * @param {number} todayRmssd
 * @param {number[]} baselineRmssd recent daily RMSSD values (e.g. last 14 days)
 * @returns {number|null} 0-100
 */
export function recoveryScore(todayRmssd, baselineRmssd) {
  if (!todayRmssd || todayRmssd <= 0) return null;
  const logs = baselineRmssd.filter((v) => v > 0).map(Math.log);
  if (logs.length < 2) return null;
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const variance = logs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / logs.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 50;
  const z = (Math.log(todayRmssd) - mean) / std;
  const score = 100 / (1 + Math.exp(-z));
  return Math.round(Math.min(100, Math.max(0, score)));
}

// --- Strain ----------------------------------------------------------------

/**
 * Strain 0-21 — cumulative cardiovascular load, WHOOP-style logarithmic scale.
 * Load accrues per HR sample as the (clamped) heart-rate-reserve fraction times
 * the sample duration; strain saturates via 21·(1 − e^(−load/scale)). This is a
 * proxy for WHOOP's proprietary strain, matched in shape not exact value.
 * @param {number[]} hrSamples heart-rate samples (bpm)
 * @param {object} opts
 * @param {number} opts.restingHR resting HR (bpm)
 * @param {number} opts.maxHR max HR (bpm)
 * @param {number} [opts.sampleSeconds] seconds each sample represents (default 1)
 * @param {number} [opts.scale] load constant controlling the curve (default 1800)
 * @returns {number} 0-21
 */
export function strain(hrSamples, { restingHR, maxHR, sampleSeconds = 1, scale = 1800 }) {
  if (!hrSamples.length || maxHR <= restingHR) return 0;
  let load = 0;
  for (const hr of hrSamples) {
    const reserve = (hr - restingHR) / (maxHR - restingHR);
    const frac = Math.min(1, Math.max(0, reserve));
    load += frac * frac * sampleSeconds; // squared → time in high zones dominates
  }
  const s = 21 * (1 - Math.exp(-load / scale));
  return Math.round(s * 10) / 10;
}

// --- Energy expenditure -----------------------------------------------------

/**
 * Active energy expenditure (kcal/min) from heart rate, via the Keytel et al.
 * (2005) regression — the standard HR-based estimator. Needs the wearer's sex,
 * age, and weight. Clamped at 0 (the regression goes negative at low HR).
 * @param {number} hr heart rate (bpm)
 * @param {{sex?:string, ageYears:number, weightKg:number}} profile
 * @returns {number} kcal per minute
 */
export function activeKcalPerMin(hr, { sex = "male", ageYears, weightKg } = {}) {
  if (!hr || !weightKg || !ageYears) return 0;
  const kcal = sex === "female"
    ? (-20.4022 + 0.4472 * hr - 0.1263 * weightKg + 0.074 * ageYears) / 4.184
    : (-55.0969 + 0.6309 * hr + 0.1988 * weightKg + 0.2017 * ageYears) / 4.184;
  return Math.max(0, kcal);
}

/**
 * Basal metabolic rate (kcal/day) via Mifflin–St Jeor — the resting burn we add
 * as a baseline so total calories aren't just the active component.
 * @param {{sex?:string, ageYears:number, weightKg:number, heightCm:number}} profile
 * @returns {number|null} kcal per day, or null if inputs are missing
 */
export function bmrPerDay({ sex = "male", ageYears, weightKg, heightCm } = {}) {
  if (!weightKg || !ageYears || !heightCm) return null;
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  return sex === "female" ? base - 161 : base + 5;
}

/**
 * Convenience: derive a full daily snapshot from one day's RR intervals.
 * @param {number[]} rrRaw raw RR intervals for the day (ms)
 * @param {object} [opts]
 * @param {number[]} [opts.baselineRmssd] prior daily RMSSD values for recovery
 * @param {number} [opts.maxHR] for strain (defaults to 220-age unknown → 190)
 */
export function dailySnapshot(rrRaw, { baselineRmssd = [], maxHR = 190 } = {}) {
  const rr = malikFilter(rrRaw);
  const hr = hrFromRR(rr);
  const rest = restingHR(hr) ?? 60;
  const todayRmssd = rmssd(rr);
  return {
    beats: rr.length,
    rmssd: todayRmssd,
    sdnn: sdnn(rr),
    pnn50: pnn50(rr),
    meanHR: hr.length ? hr.reduce((a, b) => a + b, 0) / hr.length : null,
    restingHR: rest,
    recovery: todayRmssd ? recoveryScore(todayRmssd, baselineRmssd) : null,
    strain: strain(hr, { restingHR: rest, maxHR }),
  };
}
