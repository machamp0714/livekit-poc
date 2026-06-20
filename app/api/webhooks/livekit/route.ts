import { NextResponse } from 'next/server';
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EgressStatus, WebhookReceiver } from 'livekit-server-sdk';
import {
  recordUpdate,
  type EgressStatus as EgressStatusView,
} from '@/lib/livekit/egress-store';

// === Issue #8: 全 webhook イベントの生ペイロードをディスクへ採取 ===
// 採取先（gitignore 済み）。各イベントを 1 ファイル + JSONL へ追記する。
const CAPTURE_DIR = join(process.cwd(), 'webhook-captures');

// protobuf-es のメッセージは bigint を含むため、JSON 化時は文字列へ。
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

let captureSeq = 0;
async function capturePayload(event: { event?: string }): Promise<void> {
  try {
    await mkdir(CAPTURE_DIR, { recursive: true });
    const seq = String(++captureSeq).padStart(3, '0');
    const name = event.event ?? 'unknown';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const pretty = JSON.stringify(event, bigintReplacer, 2);
    // 1 イベント = 1 ファイル（種別ごとに最新を確認しやすく）
    await writeFile(join(CAPTURE_DIR, `${seq}-${name}.json`), pretty, 'utf8');
    // 時系列の全量ログ（順序確認用）
    await appendFile(
      join(CAPTURE_DIR, 'events.jsonl'),
      JSON.stringify({ seq, ts, event }, bigintReplacer) + '\n',
      'utf8',
    );
    console.log(`[webhook] captured ${seq}-${name}`);
  } catch (e) {
    console.error('[webhook] capture failed:', e);
  }
}

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

  // Issue #8: 種別を問わず全イベントの生ペイロードを採取
  await capturePayload(event);

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
