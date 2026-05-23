import { RoomClient } from './RoomClient';
import { ROLES, type Role } from '@/lib/livekit/roles';

export default async function RoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomName: string }>;
  searchParams: Promise<{ name?: string; role?: string }>;
}) {
  const { roomName } = await params;
  const sp = await searchParams;

  const decodedRoomName = decodeURIComponent(roomName);
  const name = sp.name ?? 'ゲスト';
  const role: Role = ROLES.includes(sp.role as Role)
    ? (sp.role as Role)
    : 'panelist';

  return (
    <main style={{ padding: 24 }}>
      <h1>ルーム: {decodedRoomName}</h1>
      <p>
        あなた: {name}（{role}）
      </p>
      <RoomClient roomName={decodedRoomName} name={name} role={role} />
    </main>
  );
}

