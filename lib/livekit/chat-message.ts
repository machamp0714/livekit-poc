import type { Role } from './roles';
import type { ChatChannel } from './chat';

/** クライアント／サーバー間でやり取りするチャットメッセージ（data packet ペイロード）。 */
export interface ChatMessage {
  id: string;
  room: string;
  channel: ChatChannel;
  senderIdentity: string;
  senderName: string | null;
  senderRole: Role;
  body: string;
  createdAt: string; // ISO8601
}

export function encodeChatMessage(m: ChatMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(m));
}

export function decodeChatMessage(payload: Uint8Array): ChatMessage {
  return JSON.parse(new TextDecoder().decode(payload)) as ChatMessage;
}
