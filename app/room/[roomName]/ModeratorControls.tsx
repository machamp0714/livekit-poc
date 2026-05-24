'use client';

import { useState } from 'react';
import { useRemoteParticipants } from '@livekit/components-react';

export function ModeratorControls({ roomName }: { roomName: string }) {
  const remotes = useRemoteParticipants();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function kick(identity: string) {
    if (!confirm(`${identity} を退出させますか？`)) return;
    setBusy(identity);
    setError(null);
    try {
      const res = await fetch('/api/participants/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_name: roomName, identity }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      style={{
        padding: 8,
        border: '1px solid #ccc',
        borderRadius: 4,
        fontSize: 13,
      }}
    >
      <strong>参加者管理（モデレーターのみ）</strong>
      {error && (
        <p style={{ color: 'red', margin: '4px 0' }}>エラー: {error}</p>
      )}
      <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
        {remotes.length === 0 && <li>他の参加者なし</li>}
        {remotes.map((p) => (
          <li key={p.sid}>
            {p.name || p.identity}{' '}
            <button
              onClick={() => kick(p.identity)}
              disabled={busy === p.identity}
            >
              {busy === p.identity ? '処理中…' : '退出させる'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

