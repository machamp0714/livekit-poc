import { NextResponse } from 'next/server';
import { EgressStatus, WebhookReceiver } from 'livekit-server-sdk';
import {
  recordUpdate,
  type EgressStatus as EgressStatusView,
} from '@/lib/livekit/egress-store';

// EgressStatus は protobuf-es の numeric enum なので、キーは数値で持つ。
const STATUS_MAP: Record<number, EgressStatusView> = {
  [EgressStatus.EGRESS_STARTING]: 'starting',
  [EgressStatus.EGRESS_ACTIVE]: 'active',
  [EgressStatus.EGRESS_ENDING]: 'active',
  [EgressStatus.EGRESS_COMPLETE]: 'ended',
  [EgressStatus.EGRESS_FAILED]: 'failed',
  [EgressStatus.EGRESS_ABORTED]: 'failed',
  [EgressStatus.EGRESS_LIMIT_REACHED]: 'failed',
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

  console.log(
    '[webhook]',
    event.event,
    event.egressInfo?.egressId ?? '',
    event.egressInfo?.error ? `error="${event.egressInfo.error}"` : '',
    event.egressInfo?.errorCode ? `code=${event.egressInfo.errorCode}` : '',
  );

  if (event.egressInfo) {
    const info = event.egressInfo;
    const fileResult = info.fileResults?.[0];
    const durationNs =
      fileResult?.duration ??
      (info.endedAt && info.startedAt ? info.endedAt - info.startedAt : undefined);

    recordUpdate(info.egressId, {
      status: STATUS_MAP[info.status] ?? 'active',
      endedAt: event.event === 'egress_ended' ? Date.now() : undefined,
      durationSec:
        typeof durationNs === 'bigint' && durationNs > BigInt(0)
          ? Number(durationNs) / 1_000_000_000
          : undefined,
      fileSize:
        fileResult?.size != null ? Number(fileResult.size) : undefined,
      error: info.error || undefined,
      errorCode: info.errorCode || undefined,
    });
  }

  return NextResponse.json({ ok: true });
}
