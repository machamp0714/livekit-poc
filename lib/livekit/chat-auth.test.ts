import { describe, it, expect, beforeAll } from 'vitest';
import { AccessToken } from 'livekit-server-sdk';
import {
  livekitHttpHost,
  participantsToChatParticipants,
  verifyChatToken,
} from './chat-auth';

describe('livekitHttpHost', () => {
  it('wss:// を https:// に、ws:// を http:// に変換する', () => {
    expect(livekitHttpHost('wss://x.livekit.cloud')).toBe('https://x.livekit.cloud');
    expect(livekitHttpHost('ws://localhost:7880')).toBe('http://localhost:7880');
  });
});

describe('participantsToChatParticipants', () => {
  it('metadata.role を持つ参加者だけを ChatParticipant に変換する', () => {
    const input = [
      { identity: 'mod-1', metadata: JSON.stringify({ role: 'moderator' }) },
      { identity: 'pan-1', metadata: JSON.stringify({ role: 'panelist' }) },
      { identity: 'bad-1', metadata: 'not-json' },
      { identity: 'none-1', metadata: '' },
    ];
    expect(participantsToChatParticipants(input as never)).toEqual([
      { identity: 'mod-1', role: 'moderator' },
      { identity: 'pan-1', role: 'panelist' },
    ]);
  });
});

describe('verifyChatToken', () => {
  beforeAll(() => {
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'test_secret_at_least_32_chars_long_xx';
  });

  it('発行したトークンを検証して identity / name / role を取り出す', async () => {
    const at = new AccessToken('devkey', 'test_secret_at_least_32_chars_long_xx', {
      identity: 'mod-xyz',
      name: 'モデ',
      metadata: JSON.stringify({ role: 'moderator' }),
    });
    at.addGrant({ roomJoin: true, room: 'room-1' });
    const jwt = await at.toJwt();

    const caller = await verifyChatToken(jwt);
    expect(caller).toEqual({ identity: 'mod-xyz', name: 'モデ', role: 'moderator' });
  });

  it('role が無い／不正なら例外を投げる', async () => {
    const at = new AccessToken('devkey', 'test_secret_at_least_32_chars_long_xx', {
      identity: 'x',
      metadata: JSON.stringify({ role: 'intruder' }),
    });
    at.addGrant({ roomJoin: true });
    const jwt = await at.toJwt();
    await expect(verifyChatToken(jwt)).rejects.toThrow();
  });
});
