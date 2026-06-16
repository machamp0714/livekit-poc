import {
  RoomServiceClient,
  TokenVerifier,
  type ParticipantInfo,
} from 'livekit-server-sdk';
import { ROLES, type Role } from './roles';
import type { ChatParticipant } from './chat';

/** LiveKit の ws(s) URL を RoomServiceClient 用の http(s) ホストへ変換する。 */
export function livekitHttpHost(url: string): string {
  return url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

export interface ChatCaller {
  identity: string;
  name: string | null;
  role: Role;
}

/** トークンを検証して呼び出し元の identity / name / role を取り出す（role 改ざんは署名で防止）。 */
export async function verifyChatToken(token: string): Promise<ChatCaller> {
  const verifier = new TokenVerifier(
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );
  const claims = await verifier.verify(token);
  const meta = claims.metadata
    ? (JSON.parse(claims.metadata) as { role?: Role })
    : {};
  const role = meta.role;
  if (!role || !ROLES.includes(role)) throw new Error('invalid or missing role');
  return { identity: claims.sub ?? '', name: claims.name ?? null, role };
}

/** RoomServiceClient（宛先算出・配信に使用）。 */
export function getRoomService(): RoomServiceClient {
  return new RoomServiceClient(
    livekitHttpHost(process.env.LIVEKIT_URL!),
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );
}

/** listParticipants の結果を、宛先算出用の ChatParticipant[] に変換する。 */
export function participantsToChatParticipants(
  parts: Pick<ParticipantInfo, 'identity' | 'metadata'>[],
): ChatParticipant[] {
  return parts
    .map((p): ChatParticipant | null => {
      try {
        const meta = p.metadata
          ? (JSON.parse(p.metadata) as { role?: Role })
          : {};
        return meta.role && ROLES.includes(meta.role)
          ? { identity: p.identity, role: meta.role }
          : null;
      } catch {
        return null;
      }
    })
    .filter((p): p is ChatParticipant => p !== null);
}
