'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useLocalParticipant,
  useParticipants,
  useTracks,
} from '@livekit/components-react';
import {
  Track,
  type LocalTrack,
  type RemoteTrack,
} from 'livekit-client';
import {
  computeOutboundDelta,
  computeStatsDelta,
  extractInboundRtp,
  extractOutboundRtp,
  type OutboundDelta,
  type OutboundSnapshot,
  type StatsDelta,
  type StatsSnapshot,
} from '@/lib/livekit/stats';
import {
  classifyPath,
  extractSelectedPair,
  type PathVerdict,
  type SelectedPair,
} from '@/lib/livekit/candidate';
import {
  comparePhases,
  summarize,
  type MetricSummary,
  type PhaseComparison,
  type TickSample,
} from '@/lib/livekit/measure';

type Kind = 'video' | 'audio';

interface RemoteRow {
  identity: string;
  kind: Kind;
  delta: StatsDelta;
}
interface LocalRow {
  kind: Kind;
  delta: OutboundDelta;
}
interface PathView {
  pair: SelectedPair | null;
  verdict: PathVerdict;
}
interface QualityRow {
  identity: string;
  quality: string;
  isLocal: boolean;
}

type Phase = 'idle' | 'baseline' | 'load';

const POLL_MS = 500;

function getStatsReport(
  track: unknown,
): Promise<RTCStatsReport | undefined> | null {
  if (track && typeof (track as { getRTCStatsReport?: unknown }).getRTCStatsReport === 'function') {
    return (track as RemoteTrack | LocalTrack).getRTCStatsReport();
  }
  return null;
}

export function DiagnosticsPanel() {
  const videoTracks = useTracks([Track.Source.Camera], { onlySubscribed: true });
  const audioTracks = useTracks([Track.Source.Microphone], {
    onlySubscribed: true,
  });
  const { localParticipant } = useLocalParticipant();
  const participants = useParticipants();

  // 最新値を ref に逃がして、interval から安定参照する（毎tickでinterval再生成しない）。
  const latest = useRef({ videoTracks, audioTracks, localParticipant, participants });
  latest.current = { videoTracks, audioTracks, localParticipant, participants };

  const prevInbound = useRef(new Map<string, StatsSnapshot>());
  const prevOutbound = useRef(new Map<string, OutboundSnapshot>());
  const baselineBuf = useRef<TickSample[]>([]);
  const loadBuf = useRef<TickSample[]>([]);
  const phaseRef = useRef<Phase>('idle');
  const targetTicksRef = useRef(0); // 0 = 自動停止しない
  const durationRef = useRef(10);
  const finalizeRef = useRef<(p: Phase) => void>(() => {});

  const [remoteRows, setRemoteRows] = useState<RemoteRow[]>([]);
  const [localRows, setLocalRows] = useState<LocalRow[]>([]);
  const [subPath, setSubPath] = useState<PathView | null>(null);
  const [pubPath, setPubPath] = useState<PathView | null>(null);
  const [quality, setQuality] = useState<QualityRow[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [durationSec, setDurationSec] = useState(10);
  const [elapsedTicks, setElapsedTicks] = useState(0);
  durationRef.current = durationSec;
  const [baseline, setBaseline] = useState<MetricSummary | null>(null);
  const [load, setLoad] = useState<MetricSummary | null>(null);
  const [comparison, setComparison] = useState<PhaseComparison | null>(null);
  const [lastExport, setLastExport] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const interval = setInterval(async () => {
      const cur = latest.current;
      const nextRemote: RemoteRow[] = [];
      let subPair: SelectedPair | null = null;

      // --- リモート（受信）: inbound-rtp + subscriber PC の selected pair ---
      for (const kind of ['video', 'audio'] as const) {
        const refs = kind === 'video' ? cur.videoTracks : cur.audioTracks;
        for (const ref of refs) {
          const track = ref.publication?.track;
          const p = getStatsReport(track);
          if (!p) continue;
          const report = await p;
          if (!report) continue;
          if (!subPair) subPair = extractSelectedPair(report);
          const snap = extractInboundRtp(report, kind);
          if (!snap) continue;
          const key = `${ref.participant.identity}:${kind}`;
          const prev = prevInbound.current.get(key);
          prevInbound.current.set(key, snap);
          if (!prev) continue;
          nextRemote.push({
            identity: ref.participant.identity,
            kind,
            delta: computeStatsDelta(prev, snap),
          });
        }
      }

      // --- ローカル（送信）: outbound-rtp + publisher PC の selected pair ---
      const nextLocal: LocalRow[] = [];
      let pubPair: SelectedPair | null = null;
      const lp = cur.localParticipant;
      if (lp) {
        for (const pub of lp.trackPublications.values()) {
          const track = pub.track;
          const kind = track?.kind as Kind | undefined;
          if (!track || (kind !== 'video' && kind !== 'audio')) continue;
          const p = getStatsReport(track);
          if (!p) continue;
          const report = await p;
          if (!report) continue;
          if (!pubPair) pubPair = extractSelectedPair(report);
          const snap = extractOutboundRtp(report, kind);
          if (!snap) continue;
          const prev = prevOutbound.current.get(kind);
          prevOutbound.current.set(kind, snap);
          if (!prev) continue;
          nextLocal.push({ kind, delta: computeOutboundDelta(prev, snap) });
        }
      }

      // --- ConnectionQuality（プロパティをポーリング）---
      const q: QualityRow[] = cur.participants.map((part) => ({
        identity: part.identity,
        quality: String(part.connectionQuality),
        isLocal: part.identity === lp?.identity,
      }));

      if (stopped) return;
      setRemoteRows(nextRemote);
      setLocalRows(nextLocal);
      setSubPath({ pair: subPair, verdict: classifyPath(subPair) });
      setPubPath({ pair: pubPair, verdict: classifyPath(pubPair) });
      setQuality(q);

      // --- 計測中なら1tickを集約してバッファへ ---
      const ph = phaseRef.current;
      if (ph !== 'idle') {
        const vids = nextRemote.filter((r) => r.kind === 'video');
        const sample: TickSample = {
          timestamp: 0, // クライアント相対時刻は集計に不要なため省略
          trackCount: vids.length,
          totalBitrateKbps: vids.reduce((a, r) => a + r.delta.bitrateKbps, 0),
          avgLossRate: vids.length
            ? vids.reduce((a, r) => a + r.delta.packetLossRate, 0) / vids.length
            : 0,
          maxJitterMs: vids.reduce((a, r) => Math.max(a, r.delta.jitterMs), 0),
          minFps: vids.length
            ? vids.reduce((a, r) => Math.min(a, r.delta.fps), Infinity)
            : 0,
          totalFramesDropped: vids.reduce((a, r) => a + r.delta.framesDropped, 0),
        };
        const buf = ph === 'baseline' ? baselineBuf : loadBuf;
        buf.current.push(sample);
        const collected = buf.current.length;
        setElapsedTicks(collected);
        // 一定秒数に達したら自動停止（Issue: 「一定秒数集計」）。
        if (targetTicksRef.current > 0 && collected >= targetTicksRef.current) {
          finalizeRef.current(ph);
        }
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, []);

  const startPhase = useCallback((p: Phase) => {
    if (p === 'baseline') baselineBuf.current = [];
    if (p === 'load') loadBuf.current = [];
    targetTicksRef.current = Math.max(
      1,
      Math.round((durationRef.current * 1000) / POLL_MS),
    );
    setElapsedTicks(0);
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const stopPhase = useCallback(() => {
    finalizeRef.current(phaseRef.current);
  }, []);

  // 集計の確定（手動「停止」・自動停止 共通）。毎レンダで最新の setter を束ねる。
  finalizeRef.current = (p: Phase) => {
    phaseRef.current = 'idle';
    targetTicksRef.current = 0;
    setPhase('idle');
    setElapsedTicks(0);
    if (p === 'baseline') setBaseline(summarize(baselineBuf.current));
    if (p === 'load') setLoad(summarize(loadBuf.current));
  };

  const compute = useCallback(() => {
    if (baseline && load) setComparison(comparePhases(baseline, load));
  }, [baseline, load]);

  const exportJson = useCallback(() => {
    const payload = {
      subscriberPath: subPath,
      publisherPath: pubPath,
      connectionQuality: quality,
      remoteNow: remoteRows,
      localNow: localRows,
      baseline,
      load,
      comparison,
    };
    const json = JSON.stringify(payload, null, 2);
    setLastExport(json);
    try {
      void navigator.clipboard?.writeText(json);
    } catch {
      /* クリップボード不可環境は無視 */
    }
    console.info('[diagnostics] export', payload);
  }, [subPath, pubPath, quality, remoteRows, localRows, baseline, load, comparison]);

  return (
    <aside
      style={{
        fontSize: 12,
        padding: 8,
        border: '1px solid #ccc',
        borderRadius: 4,
        // ルームは LiveKit のダークテーマなので、診断パネルは自前で
        // 明色背景＋濃色文字に固定して可読性を担保する。
        background: '#fff',
        color: '#111',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <h3 style={{ margin: 0 }}>接続診断（webrtc-internals 相当）</h3>

      <PathBlock title="受信経路（subscriber）" view={subPath} />
      <PathBlock title="送信経路（publisher）" view={pubPath} />

      <details>
        <summary>受信メトリクス（リモート inbound-rtp）</summary>
        <MetricTable rows={remoteRows} />
      </details>

      <details>
        <summary>送信メトリクス（ローカル outbound-rtp）</summary>
        <OutboundTable rows={localRows} />
      </details>

      <details>
        <summary>ConnectionQuality（参加者別）</summary>
        <ul style={{ margin: '4px 0', paddingLeft: 16 }}>
          {quality.map((q) => (
            <li key={q.identity}>
              {q.identity}
              {q.isLocal && '（自分）'}: <strong>{q.quality}</strong>
            </li>
          ))}
        </ul>
      </details>

      <fieldset style={{ border: '1px solid #ddd', borderRadius: 4 }}>
        <legend>Baseline vs Load 計測</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <button onClick={() => startPhase('baseline')} disabled={phase !== 'idle'}>
            ① Baseline 開始
          </button>
          <button onClick={() => startPhase('load')} disabled={phase !== 'idle'}>
            ② Load 開始（ダミー追加後）
          </button>
          <button onClick={stopPhase} disabled={phase === 'idle'}>
            停止
          </button>
          <button onClick={compute} disabled={!baseline || !load}>
            Delta 算出
          </button>
          <button onClick={exportJson}>JSON 出力（クリップボードへ）</button>
        </div>
        <label style={{ display: 'block', margin: '4px 0' }}>
          集計秒数:{' '}
          <input
            type="number"
            min={1}
            max={120}
            value={durationSec}
            disabled={phase !== 'idle'}
            onChange={(e) => setDurationSec(Math.max(1, Number(e.target.value) || 1))}
            style={{ width: 56 }}
          />{' '}
          秒（{POLL_MS}ms ポーリング → 経過で自動停止）
        </label>
        <p style={{ margin: '4px 0' }}>
          状態: <strong>{phase}</strong>
          {phase !== 'idle' &&
            `（収集中 ${elapsedTicks}/${targetTicksRef.current} tick・残り ${Math.max(
              0,
              Math.ceil(((targetTicksRef.current - elapsedTicks) * POLL_MS) / 1000),
            )}秒）`}
        </p>
        <SummaryBlock title="Baseline" s={baseline} />
        <SummaryBlock title="Load" s={load} />
        {comparison && <ComparisonBlock c={comparison} />}
      </fieldset>

      {lastExport && (
        <details>
          <summary>最新の出力 JSON</summary>
          <pre
            style={{
              maxHeight: 200,
              overflow: 'auto',
              background: '#f6f6f6',
              color: '#111',
              padding: 8,
            }}
          >
            {lastExport}
          </pre>
        </details>
      )}
    </aside>
  );
}

function PathBlock({ title, view }: { title: string; view: PathView | null }) {
  const v = view?.verdict;
  const local = view?.pair?.local;
  return (
    <div style={{ background: '#fafafa', padding: 6, borderRadius: 4 }}>
      <strong>{title}:</strong>{' '}
      {v ? (
        <>
          <span>{v.label}</span>
          {v.is443 && (
            <span style={{ marginLeft: 6, color: '#0a0', fontWeight: 700 }}>
              [443]
            </span>
          )}
          <div style={{ color: '#666' }}>
            type={local?.candidateType ?? '—'} / relayProtocol=
            {local?.relayProtocol ?? '—'} / url={local?.url ?? '—'} / rtt=
            {view?.pair?.currentRoundTripTimeMs?.toFixed(1) ?? '—'}ms
          </div>
        </>
      ) : (
        '取得中…'
      )}
    </div>
  );
}

function MetricTable({ rows }: { rows: RemoteRow[] }) {
  if (rows.length === 0) return <p style={{ margin: 4 }}>受信トラックなし</p>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ textAlign: 'left' }}>identity</th>
          <th>kind</th>
          <th style={{ textAlign: 'right' }}>bitrate</th>
          <th style={{ textAlign: 'right' }}>loss</th>
          <th style={{ textAlign: 'right' }}>jitter</th>
          <th style={{ textAlign: 'right' }}>fps</th>
          <th style={{ textAlign: 'right' }}>drop</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.identity}:${r.kind}`}>
            <td>{r.identity}</td>
            <td>{r.kind}</td>
            <td style={{ textAlign: 'right' }}>{r.delta.bitrateKbps.toFixed(1)}</td>
            <td style={{ textAlign: 'right' }}>
              {(r.delta.packetLossRate * 100).toFixed(2)}%
            </td>
            <td style={{ textAlign: 'right' }}>{r.delta.jitterMs.toFixed(1)}</td>
            <td style={{ textAlign: 'right' }}>
              {r.kind === 'video' ? r.delta.fps.toFixed(0) : '—'}
            </td>
            <td style={{ textAlign: 'right' }}>
              {r.kind === 'video' ? r.delta.framesDropped : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OutboundTable({ rows }: { rows: LocalRow[] }) {
  if (rows.length === 0) return <p style={{ margin: 4 }}>送信トラックなし</p>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th>kind</th>
          <th style={{ textAlign: 'right' }}>bitrate</th>
          <th style={{ textAlign: 'right' }}>loss</th>
          <th style={{ textAlign: 'right' }}>rtt</th>
          <th style={{ textAlign: 'right' }}>fps</th>
          <th>limit</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.kind}>
            <td>{r.kind}</td>
            <td style={{ textAlign: 'right' }}>{r.delta.bitrateKbps.toFixed(1)}</td>
            <td style={{ textAlign: 'right' }}>
              {(r.delta.packetLossRate * 100).toFixed(2)}%
            </td>
            <td style={{ textAlign: 'right' }}>{r.delta.roundTripTimeMs.toFixed(1)}</td>
            <td style={{ textAlign: 'right' }}>
              {r.kind === 'video' ? r.delta.fps.toFixed(0) : '—'}
            </td>
            <td>{r.delta.qualityLimitationReason ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SummaryBlock({ title, s }: { title: string; s: MetricSummary | null }) {
  if (!s) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <strong>{title}</strong>（{s.tickCount} ticks, 平均トラック数{' '}
      {s.trackCount.average.toFixed(1)}）:
      <div style={{ color: '#444' }}>
        bitrate 合算 avg {s.bitrate.average.toFixed(0)} / worst(min){' '}
        {s.bitrate.min.toFixed(0)} kbps、loss avg{' '}
        {(s.loss.average * 100).toFixed(2)}% / worst {(s.loss.max * 100).toFixed(2)}%、
        jitter worst {s.jitter.max.toFixed(1)}ms、fps worst(min){' '}
        {s.fps.min.toFixed(0)}、drop 合計 {s.framesDropped.max.toFixed(0)}
      </div>
    </div>
  );
}

function ComparisonBlock({ c }: { c: PhaseComparison }) {
  const fmt = (n: number) => (n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1));
  return (
    <div style={{ marginTop: 4, background: '#f0f7ff', padding: 6, borderRadius: 4 }}>
      <strong>Delta（Load − Baseline）</strong>
      <ul style={{ margin: '4px 0', paddingLeft: 16 }}>
        <li>bitrate(avg) {fmt(c.bitrate.averageDelta)} kbps</li>
        <li>
          loss(worst) {fmt(c.loss.worstDelta * 100)} pt / fps(worst){' '}
          {fmt(c.fps.worstDelta)}
        </li>
        <li>
          jitter(worst) {fmt(c.jitter.worstDelta)} ms / drop(worst){' '}
          {fmt(c.framesDropped.worstDelta)}
        </li>
      </ul>
    </div>
  );
}
