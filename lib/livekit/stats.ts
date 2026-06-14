// 標準 RTCStatsReport（getRTCStatsReport が返すもの）から、minedia-www
// （OpenTok）の接続テスト相当の品質メトリクスを算出するためのピュア関数群。
// すべて副作用なし・ブラウザ非依存にして単体テスト可能に保つ。

export interface StatsSnapshot {
  timestamp: number; // ms (DOMHighResTimeStamp 互換)
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  jitter?: number; // 秒
  // 映像向け（inbound-rtp, kind=video）。音声には存在しない。
  framesReceived?: number;
  framesDropped?: number;
  framesDecoded?: number;
  framesPerSecond?: number; // 瞬間 FPS（ブラウザが算出済みなら優先利用）
}

export interface StatsDelta {
  bitrateKbps: number;
  packetLossRate: number; // 0..1
  jitterMs: number;
  fps: number; // framesPerSecond があれば採用、なければ framesDecoded 差分/秒
  framesDropped: number; // 期間中に drop したフレーム数（累積差分）
}

export function computeStatsDelta(
  prev: StatsSnapshot,
  curr: StatsSnapshot,
): StatsDelta {
  const dtSec = (curr.timestamp - prev.timestamp) / 1000;
  if (dtSec <= 0) {
    return {
      bitrateKbps: 0,
      packetLossRate: 0,
      jitterMs: 0,
      fps: 0,
      framesDropped: 0,
    };
  }
  const deltaBytes = Math.max(0, curr.bytesReceived - prev.bytesReceived);
  const deltaLost = Math.max(0, curr.packetsLost - prev.packetsLost);
  const deltaRecv = Math.max(0, curr.packetsReceived - prev.packetsReceived);
  const denom = deltaLost + deltaRecv;
  const fps =
    curr.framesPerSecond ??
    Math.max(0, (curr.framesDecoded ?? 0) - (prev.framesDecoded ?? 0)) / dtSec;
  const framesDropped = Math.max(
    0,
    (curr.framesDropped ?? 0) - (prev.framesDropped ?? 0),
  );
  return {
    bitrateKbps: (deltaBytes * 8) / dtSec / 1000,
    packetLossRate: denom === 0 ? 0 : deltaLost / denom,
    jitterMs: (curr.jitter ?? 0) * 1000,
    fps,
    framesDropped,
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
      framesReceived?: number;
      framesDropped?: number;
      framesDecoded?: number;
      framesPerSecond?: number;
    };
    if (s.type === 'inbound-rtp' && s.kind === kind) {
      return {
        timestamp: s.timestamp,
        bytesReceived: s.bytesReceived ?? 0,
        packetsReceived: s.packetsReceived ?? 0,
        packetsLost: s.packetsLost ?? 0,
        jitter: s.jitter,
        framesReceived: s.framesReceived,
        framesDropped: s.framesDropped,
        framesDecoded: s.framesDecoded,
        framesPerSecond: s.framesPerSecond,
      };
    }
  }
  return null;
}

// ---- 送信側（outbound-rtp / remote-inbound-rtp）-----------------------------
// loss は outbound-rtp には乗らず、対向から返ってくる remote-inbound-rtp の
// fractionLost / packetsLost に乗る。RTT も remote-inbound-rtp 側にある。

export interface OutboundSnapshot {
  timestamp: number;
  kind: 'video' | 'audio';
  bytesSent: number;
  packetsSent: number;
  framesEncoded?: number;
  framesPerSecond?: number;
  qualityLimitationReason?: string; // none|cpu|bandwidth|other（送信側の劣化要因）
  // 対向の remote-inbound-rtp 由来（存在すれば）
  packetsLost?: number;
  fractionLost?: number; // 0..1（直近区間の瞬間損失率）
  roundTripTime?: number; // 秒
}

export interface OutboundDelta {
  bitrateKbps: number;
  fps: number;
  packetLossRate: number; // 0..1
  roundTripTimeMs: number;
  qualityLimitationReason?: string;
}

export function extractOutboundRtp(
  report: RTCStatsReport,
  kind: 'video' | 'audio',
): OutboundSnapshot | null {
  let out: (RTCStats & Record<string, unknown>) | null = null;
  let remoteInbound: (RTCStats & Record<string, unknown>) | null = null;
  for (const stat of report.values()) {
    const s = stat as RTCStats & { kind?: string };
    if (s.type === 'outbound-rtp' && s.kind === kind) {
      out = s as RTCStats & Record<string, unknown>;
    } else if (s.type === 'remote-inbound-rtp' && s.kind === kind) {
      remoteInbound = s as RTCStats & Record<string, unknown>;
    }
  }
  if (!out) return null;
  return {
    timestamp: out.timestamp,
    kind,
    bytesSent: (out.bytesSent as number) ?? 0,
    packetsSent: (out.packetsSent as number) ?? 0,
    framesEncoded: out.framesEncoded as number | undefined,
    framesPerSecond: out.framesPerSecond as number | undefined,
    qualityLimitationReason: out.qualityLimitationReason as string | undefined,
    packetsLost: remoteInbound?.packetsLost as number | undefined,
    fractionLost: remoteInbound?.fractionLost as number | undefined,
    roundTripTime: remoteInbound?.roundTripTime as number | undefined,
  };
}

export function computeOutboundDelta(
  prev: OutboundSnapshot,
  curr: OutboundSnapshot,
): OutboundDelta {
  const dtSec = (curr.timestamp - prev.timestamp) / 1000;
  if (dtSec <= 0) {
    return { bitrateKbps: 0, fps: 0, packetLossRate: 0, roundTripTimeMs: 0 };
  }
  const deltaBytes = Math.max(0, curr.bytesSent - prev.bytesSent);
  const fps =
    curr.framesPerSecond ??
    Math.max(0, (curr.framesEncoded ?? 0) - (prev.framesEncoded ?? 0)) / dtSec;
  // fractionLost が来ていれば瞬間値を採用。無ければ packetsSent との比で近似。
  let loss = curr.fractionLost ?? 0;
  if (curr.fractionLost === undefined && curr.packetsLost !== undefined) {
    const deltaLost = Math.max(0, (curr.packetsLost ?? 0) - (prev.packetsLost ?? 0));
    const deltaSent = Math.max(0, curr.packetsSent - prev.packetsSent);
    const denom = deltaLost + deltaSent;
    loss = denom === 0 ? 0 : deltaLost / denom;
  }
  return {
    bitrateKbps: (deltaBytes * 8) / dtSec / 1000,
    fps,
    packetLossRate: loss,
    roundTripTimeMs: (curr.roundTripTime ?? 0) * 1000,
    qualityLimitationReason: curr.qualityLimitationReason,
  };
}
