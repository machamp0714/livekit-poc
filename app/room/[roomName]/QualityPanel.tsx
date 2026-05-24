'use client';

import { useEffect, useRef, useState } from 'react';
import { useTracks } from '@livekit/components-react';
import { Track, type RemoteTrack } from 'livekit-client';
import {
  computeStatsDelta,
  extractInboundRtp,
  type StatsDelta,
  type StatsSnapshot,
} from '@/lib/livekit/stats';

interface Row {
  identity: string;
  delta: StatsDelta;
}

export function QualityPanel() {
  const trackRefs = useTracks([Track.Source.Camera], { onlySubscribed: true });
  const prevRef = useRef(new Map<string, StatsSnapshot>());
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    const interval = setInterval(async () => {
      const next: Row[] = [];
      for (const ref of trackRefs) {
        const track = ref.publication?.track;
        if (!track || !('getRTCStatsReport' in track)) continue;
        const report = await (track as RemoteTrack).getRTCStatsReport();
        if (!report) continue;
        const snap = extractInboundRtp(report, 'video');
        if (!snap) continue;
        const identity = ref.participant.identity;
        const prev = prevRef.current.get(identity);
        prevRef.current.set(identity, snap);
        if (!prev) continue;
        next.push({ identity, delta: computeStatsDelta(prev, snap) });
      }
      setRows(next);
    }, 500);
    return () => clearInterval(interval);
  }, [trackRefs]);

  if (trackRefs.length === 0) return null;

  return (
    <aside
      style={{
        fontSize: 12,
        padding: 8,
        border: '1px solid #ccc',
        borderRadius: 4,
      }}
    >
      <h3 style={{ margin: '0 0 8px' }}>品質パネル（リモート映像）</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>identity</th>
            <th style={{ textAlign: 'right' }}>bitrate</th>
            <th style={{ textAlign: 'right' }}>loss</th>
            <th style={{ textAlign: 'right' }}>jitter</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.identity}>
              <td>{r.identity}</td>
              <td style={{ textAlign: 'right' }}>{r.delta.bitrateKbps.toFixed(1)} kbps</td>
              <td style={{ textAlign: 'right' }}>{(r.delta.packetLossRate * 100).toFixed(2)}%</td>
              <td style={{ textAlign: 'right' }}>{r.delta.jitterMs.toFixed(1)} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </aside>
  );
}
