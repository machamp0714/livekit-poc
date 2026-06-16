import { NextResponse, type NextRequest } from 'next/server';
import { DataPacket_Kind } from 'livekit-server-sdk';
import {
  CHAT_CHANNELS,
  CHANNEL_TOPIC,
  canSendTo,
  destinationIdentitiesFor,
  visibleChannels,
  type ChatChannel,
} from '@/lib/livekit/chat';
import {
  getRoomService,
  participantsToChatParticipants,
  verifyChatToken,
  type ChatCaller,
} from '@/lib/livekit/chat-auth';
import { insertMessage, listHistory } from '@/lib/livekit/chat-db';
import { encodeChatMessage } from '@/lib/livekit/chat-message';

function bearer(req: NextRequest): string {
  return req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
}

async function authenticate(req: NextRequest): Promise<ChatCaller | null> {
  try {
    return await verifyChatToken(bearer(req));
  } catch {
    return null;
  }
}

// 送信：認可 → 保存 → LiveKit data 配信
export async function POST(req: NextRequest) {
  const caller = await authenticate(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { room, channel, body } = (await req.json().catch(() => ({}))) as {
    room?: string;
    channel?: ChatChannel;
    body?: string;
  };
  if (!room || !channel || !CHAT_CHANNELS.includes(channel)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  // 送信認可（サーバー強制）
  if (!canSendTo(caller.role, channel)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const text = (body ?? '').trim();
  if (!text || text.length > 2000) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const svc = getRoomService();
  const participants = participantsToChatParticipants(await svc.listParticipants(room));

  // ① 保存（DB が真実）
  const message = await insertMessage({
    room,
    channel,
    senderIdentity: caller.identity,
    senderName: caller.name,
    senderRole: caller.role,
    body: text,
  });

  // ② 配信（宛先はサーバーが算出。public は [] = 全員）
  await svc.sendData(
    room,
    encodeChatMessage(message),
    DataPacket_Kind.RELIABLE,
    {
      destinationIdentities: destinationIdentitiesFor(channel, participants),
      topic: CHANNEL_TOPIC[channel],
    },
  );

  return NextResponse.json({ ok: true, message });
}

// 履歴：見られるチャネルだけ返す
export async function GET(req: NextRequest) {
  const caller = await authenticate(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const room = req.nextUrl.searchParams.get('room');
  if (!room) return NextResponse.json({ error: 'room required' }, { status: 400 });

  const messages = await listHistory(room, visibleChannels(caller.role));
  return NextResponse.json({ messages });
}
