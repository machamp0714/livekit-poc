// Baseline（自分1ストリーム）vs Load（複数ストリーム同時受信）の2段計測を
// 支えるピュア関数群。0.5秒ポーリングで集めた数値列を、移動平均・一定区間の
// average / worst に集計し、2フェーズ間の Delta を出す。

export interface Aggregate {
  count: number;
  average: number;
  min: number;
  max: number;
}

export function aggregate(values: number[]): Aggregate {
  if (values.length === 0) {
    return { count: 0, average: 0, min: 0, max: 0 };
  }
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { count: values.length, average: sum / values.length, min, max };
}

/**
 * 末尾 window 件の単純移動平均列を返す（先頭は利用可能な分だけで平均）。
 * window <= 0 は元の値をそのまま返す。
 */
export function movingAverage(values: number[], window: number): number[] {
  if (window <= 1) return [...values];
  const out: number[] = [];
  let sum = 0;
  const q: number[] = [];
  for (const v of values) {
    q.push(v);
    sum += v;
    if (q.length > window) sum -= q.shift() as number;
    out.push(sum / q.length);
  }
  return out;
}

// メトリクスの「悪い方向」。loss/jitter/rtt は高いほど悪い、bitrate/fps は低いほど悪い。
export type WorstDir = 'high' | 'low';

export function worst(agg: Aggregate, dir: WorstDir): number {
  if (agg.count === 0) return 0;
  return dir === 'high' ? agg.max : agg.min;
}

export interface PhaseDelta {
  averageDelta: number; // load.average - baseline.average
  worstDelta: number; // load.worst - baseline.worst
}

export function phaseDelta(
  baseline: Aggregate,
  load: Aggregate,
  dir: WorstDir,
): PhaseDelta {
  return {
    averageDelta: load.average - baseline.average,
    worstDelta: worst(load, dir) - worst(baseline, dir),
  };
}

// ----------------------------------------------------------------------------
// 1ティック分の集約サンプル。受信中の全リモート映像トラックを横断して、
// 「同時受信したときの体感」を1点に畳む（合計ビットレート、最悪 loss/jitter 等）。
export interface TickSample {
  timestamp: number;
  trackCount: number;
  totalBitrateKbps: number;
  avgLossRate: number; // 0..1
  maxJitterMs: number;
  minFps: number;
  totalFramesDropped: number;
}

export interface MetricSummary {
  bitrate: Aggregate; // worst = low
  loss: Aggregate; // worst = high
  jitter: Aggregate; // worst = high
  fps: Aggregate; // worst = low
  framesDropped: Aggregate; // worst = high
  trackCount: Aggregate;
  tickCount: number;
}

export function summarize(samples: TickSample[]): MetricSummary {
  return {
    bitrate: aggregate(samples.map((s) => s.totalBitrateKbps)),
    loss: aggregate(samples.map((s) => s.avgLossRate)),
    jitter: aggregate(samples.map((s) => s.maxJitterMs)),
    fps: aggregate(samples.map((s) => s.minFps)),
    framesDropped: aggregate(samples.map((s) => s.totalFramesDropped)),
    trackCount: aggregate(samples.map((s) => s.trackCount)),
    tickCount: samples.length,
  };
}

export interface PhaseComparison {
  bitrate: PhaseDelta;
  loss: PhaseDelta;
  jitter: PhaseDelta;
  fps: PhaseDelta;
  framesDropped: PhaseDelta;
}

export function comparePhases(
  baseline: MetricSummary,
  load: MetricSummary,
): PhaseComparison {
  return {
    bitrate: phaseDelta(baseline.bitrate, load.bitrate, 'low'),
    loss: phaseDelta(baseline.loss, load.loss, 'high'),
    jitter: phaseDelta(baseline.jitter, load.jitter, 'high'),
    fps: phaseDelta(baseline.fps, load.fps, 'low'),
    framesDropped: phaseDelta(
      baseline.framesDropped,
      load.framesDropped,
      'high',
    ),
  };
}
