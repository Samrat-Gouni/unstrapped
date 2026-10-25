import { test } from "node:test";
import assert from "node:assert/strict";
import {
  malikFilter, meanRR, rmssd, sdnn, pnn50, hrFromRR, percentile, restingHR,
  recoveryScore, strain, dailySnapshot, activeKcalPerMin, bmrPerDay,
} from "../src/whoop/metrics.js";

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test("rmssd matches a hand-computed value", () => {
  // RR = [800, 810, 790]; diffs = [10, -20]; sq = [100, 400]; mean/(n-1)=500/2=250
  // sqrt(250) = 15.811388...
  assert.ok(approx(rmssd([800, 810, 790]), Math.sqrt(250)));
});

test("rmssd needs at least two intervals", () => {
  assert.equal(rmssd([800]), null);
  assert.equal(rmssd([]), null);
});

test("meanRR and sdnn on a constant series", () => {
  assert.equal(meanRR([1000, 1000, 1000]), 1000);
  assert.equal(sdnn([1000, 1000, 1000]), 0);
});

test("pnn50 counts successive diffs above 50 ms", () => {
  // diffs: 60 (>50), 10, 90 (>50) → 2 of 3 = 66.66%
  const v = pnn50([800, 860, 870, 960]);
  assert.ok(approx(v, (2 / 3) * 100, 1e-9));
});

test("hrFromRR converts ms to bpm", () => {
  assert.deepEqual(hrFromRR([1000, 500]), [60, 120]);
});

test("percentile interpolates and handles the edges", () => {
  assert.equal(percentile([10, 20, 30, 40, 50], 0), 10);
  assert.equal(percentile([10, 20, 30, 40, 50], 100), 50);
  assert.equal(percentile([10, 20, 30, 40, 50], 50), 30);
});

test("restingHR picks the low tail of the HR distribution", () => {
  const hr = [55, 56, 60, 62, 70, 72, 80, 90, 100, 110];
  const r = restingHR(hr, 5);
  assert.ok(r >= 55 && r < 60, `resting HR ${r} should sit near the low end`);
});

test("malikFilter drops intervals beyond the tolerance", () => {
  // 300 is >20% below 800 (prev accepted) → dropped; 810 within 20% of 800 → kept
  assert.deepEqual(malikFilter([800, 810, 300, 805], 0.2), [800, 810, 805]);
});

test("malikFilter is a no-op on a stable series", () => {
  const rr = [800, 805, 810, 802];
  assert.deepEqual(malikFilter(rr, 0.2), rr);
});

test("recoveryScore returns 50 when today equals the baseline mean", () => {
  const baseline = [40, 40, 40, 40];
  assert.equal(recoveryScore(40, baseline), 50);
});

test("recoveryScore rises above 50 when HRV beats baseline", () => {
  const baseline = [30, 35, 40, 45, 50];
  const high = recoveryScore(80, baseline);
  const low = recoveryScore(20, baseline);
  assert.ok(high > 50, `expected >50, got ${high}`);
  assert.ok(low < 50, `expected <50, got ${low}`);
  assert.ok(high >= 0 && high <= 100 && low >= 0 && low <= 100);
});

test("recoveryScore is null without enough baseline", () => {
  assert.equal(recoveryScore(40, [40]), null);
  assert.equal(recoveryScore(0, [40, 40]), null);
});

test("strain is 0 at rest and grows with load, capped at 21", () => {
  const rest = 55, max = 190;
  assert.equal(strain([rest, rest, rest], { restingHR: rest, maxHR: max }), 0);
  const easy = strain(Array(600).fill(110), { restingHR: rest, maxHR: max });
  const hard = strain(Array(3600).fill(175), { restingHR: rest, maxHR: max });
  assert.ok(hard > easy, `hard ${hard} should exceed easy ${easy}`);
  assert.ok(hard <= 21 && easy >= 0);
});

test("activeKcalPerMin matches the Keytel regression (male)", () => {
  // HR 150, 75kg, 30y → (-55.0969 + 94.635 + 14.91 + 6.051)/4.184 ≈ 14.46 kcal/min
  assert.ok(approx(activeKcalPerMin(150, { sex: "male", ageYears: 30, weightKg: 75 }), 14.46, 0.02));
});

test("activeKcalPerMin matches the Keytel regression (female)", () => {
  // HR 150, 65kg, 30y → (-20.4022 + 67.08 - 8.2095 + 2.22)/4.184 ≈ 9.72 kcal/min
  assert.ok(approx(activeKcalPerMin(150, { sex: "female", ageYears: 30, weightKg: 65 }), 9.72, 0.02));
});

test("activeKcalPerMin clamps to 0 at rest and returns 0 without a profile", () => {
  assert.equal(activeKcalPerMin(50, { sex: "male", ageYears: 30, weightKg: 75 }), 0);
  assert.equal(activeKcalPerMin(150, {}), 0);
});

test("bmrPerDay matches Mifflin–St Jeor", () => {
  // male 75kg 178cm 30y → 750 + 1112.5 - 150 + 5 = 1717.5
  assert.ok(approx(bmrPerDay({ sex: "male", ageYears: 30, weightKg: 75, heightCm: 178 }), 1717.5, 0.01));
  // female 65kg 165cm 30y → 650 + 1031.25 - 150 - 161 = 1370.25
  assert.ok(approx(bmrPerDay({ sex: "female", ageYears: 30, weightKg: 65, heightCm: 165 }), 1370.25, 0.01));
  assert.equal(bmrPerDay({ ageYears: 30, weightKg: 75 }), null);
});

test("dailySnapshot assembles a full metric set", () => {
  const rr = Array.from({ length: 200 }, (_, i) => 850 + Math.round(30 * Math.sin(i / 5)));
  const snap = dailySnapshot(rr, { baselineRmssd: [25, 30, 28, 32, 27], maxHR: 190 });
  assert.ok(snap.beats > 0);
  assert.ok(snap.rmssd > 0);
  assert.ok(snap.restingHR > 0);
  assert.ok(snap.recovery >= 0 && snap.recovery <= 100);
  assert.ok(snap.strain >= 0 && snap.strain <= 21);
});
