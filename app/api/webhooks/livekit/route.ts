import { NextResponse } from 'next/server';
import { WebhookReceiver } from 'livekit-server-sdk';
import {
  recordUpdate,
  type EgressStatus,
} from '@/lib/livekit/egress-store';

const STATUS_MAP: Record<string, EgressStatus> = {
  EGRESS_STARTING: 'starting',
  EGRESS_ACTIVE: 'active',
  EGRESS_ENDING: 'active',
  EGRESS_COMPLETE: 'ended',
  EGRESS_FAILED: 'failed',
  EGRESS_ABORTED: 'failed',
};

export async function POST(request: Request) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    return NextResponse.json({ error: 'Missing env' }, { status: 500 });
  }

  const body = await request.text(); // raw が必要
  const authHeader = request.headers.get('authorization') ?? undefined;
  const receiver = new WebhookReceiver(apiKey, apiSecret);

  let event;
  try {
    event = await receiver.receive(body, authHeader);
  } catch (e) {
    console.error('[webhook] auth failed:', e);
    return NextResponse.json({ error: `auth failed: ${e}` }, { status: 401 });
  }

  console.log('[webhook]', event.event, event.egressInfo?.egressId ?? '');

  if (event.egressInfo) {
    const info = event.egressInfo;
    const statusKey = (info.status as unknown as string) ?? '';
    const fileResult = info.fileResults?.[0];
    const durationNs =
      fileResult?.duration ??
      (info.endedAt && info.startedAt ? info.endedAt - info.startedAt : undefined);

    recordUpdate(info.egressId, {
      status: STATUS_MAP[statusKey] ?? 'active',
      endedAt: event.event === 'egress_ended' ? Date.now() : undefined,
      durationSec:
        typeof durationNs === 'bigint' && durationNs > BigInt(0)
          ? Number(durationNs) / 1_000_000_000
          : undefined,
      fileSize:
        fileResult?.size != null ? Number(fileResult.size) : undefined,
    });
  }

  return NextResponse.json({ ok: true });
}
