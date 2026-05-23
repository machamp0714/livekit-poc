import { AccessToken } from 'livekit-server-sdk';
import { videoGrantFor, type Role } from './roles';

export interface CreateAccessTokenOptions {
  apiKey: string;
  apiSecret: string;
  roomName: string;
  identity: string;
  name: string;
  role: Role;
}

export async function createAccessToken(
  opts: CreateAccessTokenOptions,
): Promise<string> {
  const at = new AccessToken(opts.apiKey, opts.apiSecret, {
    identity: opts.identity,
    name: opts.name,
    metadata: JSON.stringify({ role: opts.role }),
    ttl: '1h',
  });
  at.addGrant(videoGrantFor(opts.role, opts.roomName));
  return at.toJwt();
}

