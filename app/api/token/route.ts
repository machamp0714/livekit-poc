import { NextResponse } from "next/server";
import { createAccessToken } from "@/lib/livekit/token";
import { ROLES, type Role } from "@/lib/livekit/roles";

export async function POST(request: Request) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const serverUrl = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !serverUrl) {
    return NextResponse.json(
      { error: 'Server configuration error: LIVEKIT_* env vars missing' },
      { status: 500 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const roomName = body.room_name ?? 'interview-poc';
  const identity = body.participant_identity ?? `user-${Date.now()}`;
  const name: string = body.participant_name ?? 'User';
  const role: Role = ROLES.includes(body.role) ? body.role : 'panelist';

  const participantToken = await createAccessToken({
    apiKey,
    apiSecret,
    roomName,
    identity,
    name,
    role,
  });

  return NextResponse.json(
    { server_url: serverUrl, participant_token: participantToken },
    { status: 201 },
  );
}

