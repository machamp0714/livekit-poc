import { NextResponse } from 'next/server';
import {
  EgressClient,
  EncodedFileOutput,
  S3Upload,
} from 'livekit-server-sdk';
import { recordStart } from '@/lib/livekit/egress-store';

export async function POST(request: Request) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const serverUrl = process.env.LIVEKIT_URL;
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION;
  const accessKey = process.env.S3_ACCESS_KEY;
  const secret = process.env.S3_SECRET;
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';

  if (
    !apiKey || !apiSecret || !serverUrl ||
    !endpoint || !bucket || !accessKey || !secret
  ) {
    return NextResponse.json(
      { error: 'Missing env config (LIVEKIT_* / S3_*)' },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    room_name?: string;
  };
  if (!body.room_name) {
    return NextResponse.json({ error: 'room_name required' }, { status: 400 });
  }

  const filepath = `livekit-poc/${body.room_name}/${Date.now()}.mp4`;
  const output = new EncodedFileOutput({
    filepath,
    output: {
      case: 's3',
      value: new S3Upload({
        accessKey,
        secret,
        bucket,
        region,
        endpoint,        // minio の公開エンドポイント (cloudflared URL)
        forcePathStyle,  // minio は path-style 必須
      }),
    },
  });

  const httpUrl = serverUrl
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:');
  const client = new EgressClient(httpUrl, apiKey, apiSecret);

  try {
    const info = await client.startRoomCompositeEgress(body.room_name, output);
    const record = recordStart({
      egressId: info.egressId,
      roomName: body.room_name,
      status: 'starting',
      filepath,
    });
    return NextResponse.json(record, { status: 201 });
  } catch (e) {
    console.error('[egress/start]', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
