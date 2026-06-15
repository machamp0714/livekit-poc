import { describe, it, expect } from "vitest";
import {
  computeStatsDelta,
  computeOutboundDelta,
  extractInboundRtp,
  extractOutboundRtp,
  type StatsSnapshot,
  type OutboundSnapshot,
} from './stats';

// RTCStatsReport は Map 互換（values() を持つ）。テストでは Map をそのまま使う。
function makeReport(
  stats: Array<RTCStats & Record<string, unknown>>,
): RTCStatsReport {
  return new Map(stats.map((s) => [s.id, s])) as unknown as RTCStatsReport;
}

const base: StatsSnapshot = {
  timestamp: 1000,
  bytesReceived: 0,
  packetsReceived: 0,
  packetsLost: 0,
  jitter: 0,
};

describe('computeStatsDelta', () => {
  it('1秒で 1MB 受信 = 8000 kbps', () => {
    const curr: StatsSnapshot = {
      ...base,
      timestamp: 2000,
      bytesReceived: 1_000_000,
    };
    const d = computeStatsDelta(base, curr);
    expect(d.bitrateKbps).toBeCloseTo(8000, 0);
  });

  it('loss = lost / (lost + received)', () => {
    const curr: StatsSnapshot = {
      ...base,
      timestamp: 2000,
      packetsReceived: 95,
      packetsLost: 5,
    };
    const d = computeStatsDelta(base, curr);
    expect(d.packetLossRate).toBeCloseTo(0.05, 3);
  });

  it('jitter は秒→ms 換算', () => {
    const curr: StatsSnapshot = { ...base, timestamp: 2000, jitter: 0.012 };
    const d = computeStatsDelta(base, curr);
    expect(d.jitterMs).toBeCloseTo(12, 1);
  });

  it('dt<=0 ならゼロ', () => {
    const d = computeStatsDelta(base, { ...base });
    expect(d.bitrateKbps).toBe(0);
    expect(d.packetLossRate).toBe(0);
  });

  it('カウンタ後退（reset）は 0 として扱う', () => {
    const curr: StatsSnapshot = {
      ...base,
      timestamp: 2000,
      bytesReceived: -50,
    };
    const d = computeStatsDelta(base, curr);
    expect(d.bitrateKbps).toBe(0);
  });

  it('framesPerSecond があればそれを FPS に採用', () => {
    const curr: StatsSnapshot = { ...base, timestamp: 2000, framesPerSecond: 29.97 };
    expect(computeStatsDelta(base, curr).fps).toBeCloseTo(29.97, 2);
  });

  it('framesPerSecond が無ければ framesDecoded 差分/秒で算出', () => {
    const prev: StatsSnapshot = { ...base, framesDecoded: 100 };
    const curr: StatsSnapshot = { ...base, timestamp: 2000, framesDecoded: 130 };
    expect(computeStatsDelta(prev, curr).fps).toBeCloseTo(30, 1);
  });

  it('framesDropped は累積差分', () => {
    const prev: StatsSnapshot = { ...base, framesDropped: 5 };
    const curr: StatsSnapshot = { ...base, timestamp: 2000, framesDropped: 8 };
    expect(computeStatsDelta(prev, curr).framesDropped).toBe(3);
  });
});

describe('extractInboundRtp', () => {
  it('kind 一致の inbound-rtp を拾い、frame 系も取り込む', () => {
    const report = makeReport([
      { id: 'a', type: 'inbound-rtp', kind: 'audio', timestamp: 1, bytesReceived: 10 } as never,
      {
        id: 'v',
        type: 'inbound-rtp',
        kind: 'video',
        timestamp: 2,
        bytesReceived: 999,
        packetsReceived: 50,
        packetsLost: 1,
        jitter: 0.01,
        framesDropped: 2,
        framesDecoded: 60,
        framesPerSecond: 30,
      } as never,
    ]);
    const snap = extractInboundRtp(report, 'video');
    expect(snap?.bytesReceived).toBe(999);
    expect(snap?.framesPerSecond).toBe(30);
    expect(snap?.framesDropped).toBe(2);
  });

  it('該当 kind が無ければ null', () => {
    const report = makeReport([
      { id: 'a', type: 'inbound-rtp', kind: 'audio', timestamp: 1 } as never,
    ]);
    expect(extractInboundRtp(report, 'video')).toBeNull();
  });
});

describe('extractOutboundRtp / computeOutboundDelta', () => {
  it('outbound-rtp と remote-inbound-rtp を結合（loss/RTT は対向由来）', () => {
    const report = makeReport([
      {
        id: 'o',
        type: 'outbound-rtp',
        kind: 'video',
        timestamp: 1000,
        bytesSent: 0,
        packetsSent: 0,
        framesEncoded: 0,
        qualityLimitationReason: 'bandwidth',
      } as never,
      {
        id: 'ri',
        type: 'remote-inbound-rtp',
        kind: 'video',
        timestamp: 1000,
        packetsLost: 3,
        fractionLost: 0.02,
        roundTripTime: 0.05,
      } as never,
    ]);
    const snap = extractOutboundRtp(report, 'video');
    expect(snap?.qualityLimitationReason).toBe('bandwidth');
    expect(snap?.fractionLost).toBe(0.02);
    expect(snap?.roundTripTime).toBe(0.05);
  });

  it('送信ビットレート/FPS/RTT を算出、loss は fractionLost を優先', () => {
    const prev: OutboundSnapshot = {
      timestamp: 1000,
      kind: 'video',
      bytesSent: 0,
      packetsSent: 0,
      framesEncoded: 0,
    };
    const curr: OutboundSnapshot = {
      timestamp: 2000,
      kind: 'video',
      bytesSent: 1_000_000,
      packetsSent: 100,
      framesEncoded: 30,
      fractionLost: 0.03,
      roundTripTime: 0.04,
    };
    const d = computeOutboundDelta(prev, curr);
    expect(d.bitrateKbps).toBeCloseTo(8000, 0);
    expect(d.fps).toBeCloseTo(30, 1);
    expect(d.packetLossRate).toBeCloseTo(0.03, 3);
    expect(d.roundTripTimeMs).toBeCloseTo(40, 1);
  });

  it('outbound-rtp が無ければ null', () => {
    const report = makeReport([
      { id: 'x', type: 'inbound-rtp', kind: 'video', timestamp: 1 } as never,
    ]);
    expect(extractOutboundRtp(report, 'video')).toBeNull();
  });
});

