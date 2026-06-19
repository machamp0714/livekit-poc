import { Pool } from 'pg';
import type { Role } from './roles';
import type { ChatChannel } from './chat';
import type { ChatMessage } from './chat-message';

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

export interface ChatMessageRow {
  id: string | number;
  room: string;
  channel: string;
  sender_identity: string;
  sender_name: string | null;
  sender_role: string;
  body: string;
  created_at: Date;
}

export function rowToMessage(r: ChatMessageRow): ChatMessage {
  return {
    id: String(r.id),
    room: r.room,
    channel: r.channel as ChatChannel,
    senderIdentity: r.sender_identity,
    senderName: r.sender_name,
    senderRole: r.sender_role as Role,
    body: r.body,
    createdAt: r.created_at.toISOString(),
  };
}

export async function insertMessage(
  m: Omit<ChatMessage, 'id' | 'createdAt'>,
): Promise<ChatMessage> {
  const { rows } = await getPool().query<ChatMessageRow>(
    `insert into chat_messages
       (room, channel, sender_identity, sender_name, sender_role, body)
     values ($1,$2,$3,$4,$5,$6)
     returning *`,
    [m.room, m.channel, m.senderIdentity, m.senderName, m.senderRole, m.body],
  );
  return rowToMessage(rows[0]);
}

export async function listHistory(
  room: string,
  channels: ChatChannel[],
  limit = 100,
): Promise<ChatMessage[]> {
  const { rows } = await getPool().query<ChatMessageRow>(
    `select * from chat_messages
      where room = $1 and channel = any($2)
      order by created_at desc
      limit $3`,
    [room, channels, limit],
  );
  return rows.map(rowToMessage).reverse();
}
