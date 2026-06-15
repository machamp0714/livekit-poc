import type { VideoGrant } from 'livekit-server-sdk';
import { canPublishDataFor } from './chat';

export type Role = 'moderator' | 'panelist' | 'observer';

export const ROLES: Role[] = ['moderator', 'panelist', 'observer'];

export function videoGrantFor(role: Role, roomName: string): VideoGrant {
  const base: VideoGrant = {
    roomJoin: true,
    room: roomName,
    canSubscribe: true,
    // チャット（Text streams / data packets）の送信に必要。映像の
    // canPublish とは独立した権限で、observer も送信する必要があるため
    // 全ロールに付与する。チャネル別の送信制限は grant では表現できない。
    canPublishData: canPublishDataFor(role),
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

export function canBroadcast(role: Role): boolean {
  return role === 'moderator' || role === 'panelist';
}

