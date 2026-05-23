import { describe, it, expect } from 'vitest';
import { createAccessToken } from './token';

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payloadSegment = jwt.split('.')[1];
  return JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
}

const cfg = {
  apiKey: 'devkey',
  apiSecret: 'test-secret-at-least-32-characters-long',
};

describe('createAccessToken', () => {
  it('identity・name・role(metadata) を埋め込む', async () => {
    const jwt = await createAccessToken({
      ...cfg,
      roomName: 'r1',
      identity: 'u1',
      name: 'Alice',
      role: 'panelist',
    });
    const payload = decodeJwtPayload(jwt);
    expect(payload.sub).toBe('u1');
    expect(payload.name).toBe('Alice');
    expect(JSON.parse(payload.metadata as string)).toEqual({ role: 'panelist' });
  });

  it('オブザーバーには subscribe のみの権限を与える', async () => {
    const jwt = await createAccessToken({
      ...cfg,
      roomName: 'r1',
      identity: 'u2',
      name: 'Bob',
      role: 'observer',
    });
    const payload = decodeJwtPayload(jwt) as {
      video: { room?: string; canPublish?: boolean; canSubscribe?: boolean };
    };
    expect(payload.video.room).toBe('r1');
    expect(payload.video.canPublish).toBe(false);
    expect(payload.video.canSubscribe).toBe(true);
  });
});

