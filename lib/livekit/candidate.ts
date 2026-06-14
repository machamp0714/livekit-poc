// chrome://webrtc-internals の「selected candidate pair」相当を、標準
// RTCStatsReport（getRTCStatsReport の戻り値）から抽出・分類する。
//
// 目的: 「どの経路で繋がったか」を機械的に判定する。特に制限ネットワーク下で
// LiveKit Cloud が turns:…:443（TURN/TLS）へ退避したことを relayProtocol / url
// から確定させる。

export interface CandidateInfo {
  id?: string;
  candidateType?: string; // host | srflx | prflx | relay
  protocol?: string; // udp | tcp
  address?: string;
  port?: number;
  // 以下はローカル候補（local-candidate）にのみ乗る非標準だが Chrome が出す項目。
  relayProtocol?: string; // udp | tcp | tls（relay 候補が TURN サーバへ繋ぐ手段）
  url?: string; // 例: turns:xxx.livekit.cloud:443?transport=tcp
  networkType?: string; // wifi | cellular | ethernet ...
}

export interface SelectedPair {
  state?: string; // succeeded | waiting | failed ...
  nominated?: boolean;
  currentRoundTripTimeMs?: number;
  availableOutgoingBitrateKbps?: number;
  availableIncomingBitrateKbps?: number;
  local: CandidateInfo;
  remote: CandidateInfo;
}

export type PathKind =
  | 'host' // 直結（同一 LAN 等）
  | 'srflx' // STUN 反射（P2P / UDP 直）
  | 'relay-udp' // TURN/UDP 退避
  | 'relay-tcp' // TURN/TCP 退避
  | 'relay-tls' // TURN/TLS（443）退避 = 最も制限の強い網でも通る最終手段
  | 'unknown';

export interface PathVerdict {
  kind: PathKind;
  isRelay: boolean;
  isTurnTls: boolean; // relayProtocol === 'tls'
  is443: boolean; // url / port が 443
  label: string; // 人間可読（日本語）
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function toCandidateInfo(
  stat: (RTCStats & Record<string, unknown>) | undefined,
): CandidateInfo {
  if (!stat) return {};
  return {
    id: stat.id,
    candidateType: str(stat.candidateType),
    protocol: str(stat.protocol),
    address: str(stat.address) ?? str(stat.ip),
    port: num(stat.port),
    relayProtocol: str(stat.relayProtocol),
    url: str(stat.url),
    networkType: str(stat.networkType),
  };
}

/**
 * 選択中（nominated/selected かつ succeeded）の candidate-pair を1件抽出する。
 * transport.selectedCandidatePairId を最優先し、無ければ candidate-pair を走査。
 * 見つからなければ null。
 */
export function extractSelectedPair(
  report: RTCStatsReport,
): SelectedPair | null {
  const byId = new Map<string, RTCStats & Record<string, unknown>>();
  let transportSelectedId: string | undefined;
  const pairs: Array<RTCStats & Record<string, unknown>> = [];

  for (const stat of report.values()) {
    const s = stat as RTCStats & Record<string, unknown>;
    byId.set(s.id, s);
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
      transportSelectedId = s.selectedCandidatePairId;
    } else if (s.type === 'candidate-pair') {
      pairs.push(s);
    }
  }

  let pair: (RTCStats & Record<string, unknown>) | undefined;
  if (transportSelectedId) {
    pair = byId.get(transportSelectedId);
  }
  if (!pair) {
    // transport が無い/未選択のブラウザ向けフォールバック。
    pair =
      pairs.find((p) => p.nominated && p.state === 'succeeded') ??
      pairs.find((p) => p.selected === true) ?? // Firefox 系
      pairs.find((p) => p.state === 'succeeded');
  }
  if (!pair) return null;

  const local = byId.get(pair.localCandidateId as string);
  const remote = byId.get(pair.remoteCandidateId as string);
  const outBps = num(pair.availableOutgoingBitrate);
  const inBps = num(pair.availableIncomingBitrate);
  const rttSec = num(pair.currentRoundTripTime);

  return {
    state: str(pair.state),
    nominated: pair.nominated === true,
    currentRoundTripTimeMs: rttSec === undefined ? undefined : rttSec * 1000,
    availableOutgoingBitrateKbps:
      outBps === undefined ? undefined : outBps / 1000,
    availableIncomingBitrateKbps:
      inBps === undefined ? undefined : inBps / 1000,
    local: toCandidateInfo(local),
    remote: toCandidateInfo(remote),
  };
}

function endsWith443(info: CandidateInfo): boolean {
  if (info.port === 443) return true;
  const url = info.url ?? '';
  // turns:host:443 や turns:host:443?transport=tcp など
  return /:443(\b|\?|$)/.test(url);
}

/**
 * 抽出した selected pair を「どの経路か」に分類する。
 * ローカル候補の candidateType と relayProtocol / url を根拠にする。
 */
export function classifyPath(pair: SelectedPair | null): PathVerdict {
  if (!pair) {
    return {
      kind: 'unknown',
      isRelay: false,
      isTurnTls: false,
      is443: false,
      label: '不明（selected pair を取得できず）',
    };
  }
  const { local } = pair;
  const is443 = endsWith443(local);
  const type = local.candidateType;
  const rp = local.relayProtocol;
  const url = local.url ?? '';

  // relayProtocol は仕様上「TURN サーバ由来の候補」にしか付かない決定的な根拠。
  // candidateType が relay でなくても（prflx/srflx に見えても）、relayProtocol か
  // turns?: url があれば TURN 経由と判定する。
  const looksRelay =
    type === 'relay' || rp !== undefined || /^turns?:/i.test(url);

  if (looksRelay) {
    // relayProtocol を最優先。無ければ url スキームから推定（turns: は TLS 既定）。
    const proto = rp ?? (/^turns:/i.test(url) ? 'tls' : url ? 'tcp' : undefined);
    if (proto === 'tls') {
      return {
        kind: 'relay-tls',
        isRelay: true,
        isTurnTls: true,
        is443,
        label: `TURN/TLS 経由（${url || 'turns:…:443'}）— 制限網の最終退避経路`,
      };
    }
    if (proto === 'tcp') {
      return {
        kind: 'relay-tcp',
        isRelay: true,
        isTurnTls: false,
        is443,
        label: `TURN/TCP 経由（${url || 'turn:…'}）`,
      };
    }
    if (proto === 'udp') {
      return {
        kind: 'relay-udp',
        isRelay: true,
        isTurnTls: false,
        is443,
        label: `TURN/UDP 経由（${url || 'turn:…'}）`,
      };
    }
    return {
      kind: 'relay-udp',
      isRelay: true,
      isTurnTls: false,
      is443,
      label: `TURN 経由（プロトコル不明, ${url || '—'}）`,
    };
  }
  if (type === 'srflx' || type === 'prflx') {
    return {
      kind: 'srflx',
      isRelay: false,
      isTurnTls: false,
      is443,
      label: 'STUN 反射（P2P / UDP 直結）',
    };
  }
  if (type === 'host') {
    return {
      kind: 'host',
      isRelay: false,
      isTurnTls: false,
      is443,
      label: 'ホスト直結（同一 LAN 等）',
    };
  }
  return {
    kind: 'unknown',
    isRelay: false,
    isTurnTls: false,
    is443,
    label: `不明な候補タイプ（${type ?? 'なし'}）`,
  };
}
