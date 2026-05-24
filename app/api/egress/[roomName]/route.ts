import { NextResponse } from 'next/server';
import { getByRoom } from '@/lib/livekit/egress-store';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ roomName: string }> },
) {
  const { roomName } = await params;
  const rec = getByRoom(decodeURIComponent(roomName));
  return NextResponse.json(rec ?? null);
}

