import { NextResponse } from 'next/server';
import { RoomServiceClient } from 'livekit-server-sdk';

export async function POST(request: Request) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const serverUrl = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !serverUrl) {
    return NextResponse.json({ error: 'Missing env' }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    room_name?: string;
    identity?: string;
  };
  if (!body.room_name || !body.identity) {
    return NextResponse.json(
      { error: 'room_name and identity required' },
      { status: 400 },
    );
  }

  // POC simplification: 呼び出し元の roomAdmin 権限確認は省略。
  // 本番（Rails 側）では呼出元トークンの video grant.roomAdmin を検証すること。
  const httpUrl = serverUrl
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:');
  const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);

  try {
    await svc.removeParticipant(body.room_name, body.identity);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[participants/remove]', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

