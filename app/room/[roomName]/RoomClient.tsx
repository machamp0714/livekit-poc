'use client';

import { useEffect, useState } from 'react';
import {
  LiveKitRoom,
  RoomAudioRenderer,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { canBroadcast, type Role } from '@/lib/livekit/roles';
import { RoomBody } from './RoomBody';

type Props = { roomName: string; name: string; role: Role };

export function RoomClient({ roomName, name, role }: Props) {
  const [identity] = useState(
    () => `${name}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const [token, setToken] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_name: roomName,
        participant_identity: identity,
        participant_name: name,
        role,
      }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`token endpoint: HTTP ${res.status}`);
        return res.json() as Promise<{
          server_url: string;
          participant_token: string;
        }>;
      })
      .then((data) => {
        if (cancelled) return;
        setServerUrl(data.server_url);
        setToken(data.participant_token);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [roomName, identity, name, role]);

  if (error) return <p style={{ color: 'red' }}>接続エラー: {error}</p>;
  if (!token || !serverUrl) return <p>トークン取得中…</p>;

  const broadcast = canBroadcast(role);

  return (
    <LiveKitRoom
      token={token}
      serverUrl={serverUrl}
      connect
      audio={broadcast}
      video={broadcast}
      data-lk-theme="default"
    >
      <RoomBody role={role} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

