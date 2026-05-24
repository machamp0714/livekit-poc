import { PrecallClient } from './PrecallClient';
import { ROLES, type Role } from '@/lib/livekit/roles';

export default async function PrecallPage({
  searchParams,
}: {
  searchParams: Promise<{ name?: string; roomName?: string; role?: string }>;
}) {
  const sp = await searchParams;
  const name = (sp.name ?? '').trim() || 'ゲスト';
  const roomName = (sp.roomName ?? '').trim() || 'interview-poc';
  const role: Role = ROLES.includes(sp.role as Role)
    ? (sp.role as Role)
    : 'panelist';

  return <PrecallClient name={name} roomName={roomName} role={role} />;
}

