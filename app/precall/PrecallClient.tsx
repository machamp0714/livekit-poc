'use client';

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckStatus, ConnectionCheck } from "livekit-client";
import type { Role } from "@/lib/livekit/roles";

type Props = {
  name: string;
  roomName: string;
  role: Role;
};

type CheckRow = {
  name: string;
  status: CheckStatus;
  description?: string;
};

const STEPS: ReadonlyArray<{
  name: string;
  run: (c: ConnectionCheck) => Promise<{ status: CheckStatus; description?: string }>;
}> = [
    { name: 'WebSocket', run: (c) => c.checkWebsocket() },
    { name: 'WebRTC', run: (c) => c.checkWebRTC() },
    { name: 'TURN', run: (c) => c.checkTURN() },
    { name: 'Reconnect', run: (c) => c.checkReconnect() },
    { name: 'Publish Audio', run: (c) => c.checkPublishAudio() },
    { name: 'Publish Video', run: (c) => c.checkPublishVideo() },
    { name: 'Connection Protocol', run: (c) => c.checkConnectionProtocol() },
    { name: 'Cloud Region', run: (c) => c.checkCloudRegion() },
  ];

export function PrecallClient({ name, roomName, role }: Props) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<CheckRow[]>([]);
  const [passed, setPassed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setRunning(true);
    setRows([]);
    setPassed(null);
    setError(null);
    try {
      const tokenRes = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_name: `precall-${Math.random().toString(36).slice(2, 8)}`,
          participant_identity: `precall-${name}-${Date.now()}`,
          participant_name: name,
          role: 'panelist',
        }),
      });
      if (!tokenRes.ok) {
        throw new Error(`token endpoint: HTTP ${tokenRes.status}`);
      }
      const { server_url, participant_token } = (await tokenRes.json()) as {
        server_url: string;
        participant_token: string;
      };

      const check = new ConnectionCheck(server_url, participant_token);
      const out: CheckRow[] = [];
      for (const step of STEPS) {
        const info = await step.run(check);
        out.push({ name: step.name, status: info.status, description: info.description });
        setRows([...out]);
      }
      setPassed(check.isSuccess());
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  function proceed() {
    const q = new URLSearchParams({ name, role });
    router.push(`/room/${encodeURIComponent(roomName)}?${q.toString()}`);
  }

  return (
    <section style={{ padding: 24, maxWidth: 640 }}>
      <h1>接続テスト</h1>
      <p>
        名前: {name} / ルーム: {roomName} / 役割: {role}
      </p>
      <button onClick={start} disabled={running}>
        {running ? 'テスト中…' : 'テストを開始'}
      </button>
      <button onClick={proceed} disabled={running} style={{ marginLeft: 8 }}>
        テストをスキップして入室
      </button>
      {error && <p style={{ color: 'red' }}>エラー: {error}</p>}

      <ul style={{ marginTop: 16, listStyle: 'none', paddingLeft: 0 }}>
        {rows.map((r) => (
          <li key={r.name} style={{ marginBottom: 4 }}>
            <strong>
              {r.status === CheckStatus.SUCCESS && '✓ '}
              {r.status === CheckStatus.FAILED && '✗ '}
              {r.status === CheckStatus.SKIPPED && '– '}
              {r.status === CheckStatus.RUNNING && '… '}
              {r.name}
            </strong>
            {r.description && <span style={{ marginLeft: 8 }}>— {r.description}</span>}
          </li>
        ))}
      </ul>

      {passed === true && (
        <button onClick={proceed} style={{ marginTop: 12 }}>
          ルームへ進む
        </button>
      )}
      {passed === false && (
        <div style={{ marginTop: 12 }}>
          <p style={{ color: 'red' }}>
            接続テストに一部失敗しました。UDP 遮断時は「Connection Protocol」が失敗しますが、
            TURN/TLS:443 経由で通話自体は可能です。
          </p>
          <button onClick={proceed}>このまま入室する</button>
        </div>
      )}
    </section>
  );
}


