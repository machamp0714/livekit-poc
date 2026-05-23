import type { VideoGrant } from 'livekit-server-sdk';

export type Role = 'moderator' | 'panelist' | 'observer';

export const ROLES: Role[] = ['moderator', 'panelist', 'observer'];

export function videoGrantFor(role: Role, roomName: string): VideoGrant {
  const base: VideoGrant = {
    roomJoin: true,
    room: roomName,
    canSubscribe: true,
  };
  switch (role) {
    case 'moderator':
      return { ...base, canPublish: true, roomAdmin: true };
    case 'panelist':
      return { ...base, canPublish: true };
    case 'observer':
      return { ...base, canPublish: false };
  }
}

