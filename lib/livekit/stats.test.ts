import { describe, it, expect } from "vitest";
import { computeStatsDelta, type StatsSnapshot } from './stats';

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
});

