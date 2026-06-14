import { describe, it, expect } from 'vitest';
import {
  aggregate,
  movingAverage,
  worst,
  phaseDelta,
  summarize,
  comparePhases,
  type TickSample,
} from './measure';

describe('aggregate', () => {
  it('average / min / max / count', () => {
    const a = aggregate([10, 20, 30]);
    expect(a.average).toBe(20);
    expect(a.min).toBe(10);
    expect(a.max).toBe(30);
    expect(a.count).toBe(3);
  });
  it('空配列はゼロ', () => {
    expect(aggregate([])).toEqual({ count: 0, average: 0, min: 0, max: 0 });
  });
});

describe('movingAverage', () => {
  it('window=2 の単純移動平均', () => {
    expect(movingAverage([1, 2, 3, 4], 2)).toEqual([1, 1.5, 2.5, 3.5]);
  });
  it('window<=1 はそのまま', () => {
    expect(movingAverage([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });
});

describe('worst', () => {
  it("high 方向は max（loss/jitter）", () => {
    expect(worst(aggregate([1, 5, 2]), 'high')).toBe(5);
  });
  it("low 方向は min（bitrate/fps）", () => {
    expect(worst(aggregate([10, 3, 7]), 'low')).toBe(3);
  });
});

describe('phaseDelta', () => {
  it('average と worst の差分（low 方向）', () => {
    const base = aggregate([30, 30, 30]); // fps baseline
    const load = aggregate([20, 10, 25]); // fps load
    const d = phaseDelta(base, load, 'low');
    expect(d.averageDelta).toBeCloseTo(18.33 - 30, 1);
    expect(d.worstDelta).toBe(10 - 30); // worst(load)=min=10, worst(base)=30
  });
});

describe('summarize / comparePhases', () => {
  const tick = (over: Partial<TickSample>): TickSample => ({
    timestamp: 0,
    trackCount: 1,
    totalBitrateKbps: 1000,
    avgLossRate: 0,
    maxJitterMs: 5,
    minFps: 30,
    totalFramesDropped: 0,
    ...over,
  });

  it('Load では bitrate 合算が増え fps worst が落ちる傾向を Delta で表現', () => {
    const baseline = summarize([
      tick({ totalBitrateKbps: 1000, minFps: 30, avgLossRate: 0 }),
      tick({ totalBitrateKbps: 1100, minFps: 30, avgLossRate: 0 }),
    ]);
    const load = summarize([
      tick({ trackCount: 3, totalBitrateKbps: 2800, minFps: 22, avgLossRate: 0.02 }),
      tick({ trackCount: 3, totalBitrateKbps: 3000, minFps: 18, avgLossRate: 0.03 }),
    ]);
    const cmp = comparePhases(baseline, load);
    expect(cmp.bitrate.averageDelta).toBeGreaterThan(0); // 合算ビットレート増
    expect(cmp.fps.worstDelta).toBeLessThan(0); // 最悪 FPS は悪化（低下）
    expect(cmp.loss.worstDelta).toBeGreaterThan(0); // 最悪 loss は悪化（増加）
  });
});
