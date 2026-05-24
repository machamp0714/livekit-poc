'use client';

import { useEffect, useState } from 'react';

type EgressView = {
  egressId: string;
  roomName: string;
  status: 'starting' | 'active' | 'ended' | 'failed';
  filepath: string;
  startedAt: number;
  endedAt?: number;
  durationSec?: number;
  fileSize?: number;
} | null;

export function RecordingControls({ roomName }: { roomName: string }) {
  const [state, setState] = useState<EgressView>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const res = await fetch(
        `/api/egress/${encodeURIComponent(roomName)}`,
      );
      if (!res.ok) return;
      const json = (await res.json()) as EgressView;
      if (!cancelled) setState(json);
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [roomName]);

  async function startRecording() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/egress/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_name: roomName }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const recording =
    state?.status === 'starting' || state?.status === 'active';

  return (
    <section
      style={{
        padding: 8,
        border: '1px solid #ccc',
        borderRadius: 4,
        fontSize: 13,
      }}
    >
      <strong>録画</strong>
      {' '}
      <button onClick={startRecording} disabled={busy || recording}>
        {recording ? '録画中…' : '録画開始'}
      </button>
      {error && <span style={{ color: 'red', marginLeft: 8 }}>{error}</span>}
      {state && (
        <div style={{ marginTop: 4 }}>
          status: <strong>{state.status}</strong>
          {' / '}filepath: <code>{state.filepath}</code>
          {state.durationSec != null && (
            <> {' / '}duration: {state.durationSec.toFixed(1)}s</>
          )}
          {state.fileSize != null && (
            <> {' / '}size: {(state.fileSize / 1024 / 1024).toFixed(2)} MB</>
          )}
        </div>
      )}
    </section>
  );
}
