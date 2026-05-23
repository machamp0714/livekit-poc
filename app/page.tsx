'use client';

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ROLES, type Role } from '@/lib/livekit/roles';

export default function LobbyPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [roomName, setRoomName] = useState('interview-poc');
  const [role, setRole] = useState<Role>('panelist');

  function join(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !roomName.trim()) return;
    const query = new URLSearchParams({ name: name.trim(), role });
    router.push(`/precall?${query.toString()}`);
  }

  return (
    <main style={{ padding: 24, maxWidth: 420 }}>
      <h1>LiveKit POC — ロビー</h1>
      <form onSubmit={join} style={{ display: 'grid', gap: 12, marginTop: 16 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          名前
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          ルーム名
          <input
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            required
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          役割
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">接続テストへ</button>
      </form>
    </main>
  )
}
