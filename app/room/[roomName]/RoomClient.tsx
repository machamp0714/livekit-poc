'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LiveKitRoom,
  RoomAudioRenderer,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { canBroadcast, type Role } from '@/lib/livekit/roles';
import { RoomBody } from './RoomBody';

type Props = { roomName: string; name: string; role: Role };

export function RoomClient({ roomName, name, role }: Props) {
  const router = useRouter();
  // identity をリロード（JS コンテキスト消失）をまたいで永続化する。
  // sessionStorage はタブを閉じると消える＝「同一セッション」の意味論に一致。
  // 同一 identity で再接続すると LiveKit が古い接続を DuplicateIdentity で
  // 切断し、新しい接続を通すため「同じ参加者として復帰」が成立する。
  const [identity] = useState(() => {
    // SSR 時は sessionStorage が無い。ここで返す値は使われず、
    // クライアントの hydration 時に initializer が再実行されて確定する
    // （identity は描画に出ないので hydration mismatch にならない）。
    if (typeof window === 'undefined') return `${name}-pending`;
    const key = `lk-identity-${roomName}`;
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const fresh = `${name}-${crypto.randomUUID()}`;
    window.sessionStorage.setItem(key, fresh);
    return fresh;
  });
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
      onDisconnected={() => router.push('/')}
    >
      <RoomBody role={role} roomName={roomName} token={token} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

