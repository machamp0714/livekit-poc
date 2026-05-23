export interface StatsSnapshot {
  timestamp: number; // ms (DOMHighResTimeStamp 互換)
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  jitter?: number; // 秒
}

export interface StatsDelta {
  bitrateKbps: number;
  packetLossRate: number; // 0..1
  jitterMs: number;
}

export function computeStatsDelta(
  prev: StatsSnapshot,
  curr: StatsSnapshot,
): StatsDelta {
  const dtSec = (curr.timestamp - prev.timestamp) / 1000;
  if (dtSec <= 0) {
    return { bitrateKbps: 0, packetLossRate: 0, jitterMs: 0 };
  }
  const deltaBytes = Math.max(0, curr.bytesReceived - prev.bytesReceived);
  const deltaLost = Math.max(0, curr.packetsLost - prev.packetsLost);
  const deltaRecv = Math.max(0, curr.packetsReceived - prev.packetsReceived);
  const denom = deltaLost + deltaRecv;
  return {
    bitrateKbps: (deltaBytes * 8) / dtSec / 1000,
    packetLossRate: denom === 0 ? 0 : deltaLost / denom,
    jitterMs: (curr.jitter ?? 0) * 1000,
  };
}

export function extractInboundRtp(
  report: RTCStatsReport,
  kind: 'video' | 'audio',
): StatsSnapshot | null {
  for (const stat of report.values()) {
    const s = stat as RTCStats & {
      kind?: string;
      bytesReceived?: number;
      packetsReceived?: number;
      packetsLost?: number;
      jitter?: number;
    };
    if (s.type === 'inbound-rtp' && s.kind === kind) {
      return {
        timestamp: s.timestamp,
        bytesReceived: s.bytesReceived ?? 0,
        packetsReceived: s.packetsReceived ?? 0,
        packetsLost: s.packetsLost ?? 0,
        jitter: s.jitter,
      };
    }
  }
  return null;
}

