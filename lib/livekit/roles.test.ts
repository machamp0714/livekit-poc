import { describe, it, expect } from 'vitest';
import { videoGrantFor, canBroadcast } from './roles';

describe('videoGrantFor', () => {
  it('モデレーターはpublish/subscribe可能で roomAdmin', () => {
    const grant = videoGrantFor('moderator', 'room-1');
    expect(grant).toMatchObject({
      roomJoin: true,
      room: 'room-1',
      canPublish: true,
      canSubscribe: true,
      roomAdmin: true,
    })
  });

  it('パネリストは publish/subscribe 可能だが roomAdmin ではない', () => {
    const grant = videoGrantFor('panelist', 'room-1');
    expect(grant).toMatchObject({
      roomJoin: true,
      room: 'room-1',
      canPublish: true,
      canSubscribe: true,
    });
    expect(grant.roomAdmin).toBeFalsy();
  });

  it('オブザーバーは subscribe のみ（publish 不可）', () => {
    const grant = videoGrantFor('observer', 'room-1');
    expect(grant).toMatchObject({
      roomJoin: true,
      room: 'room-1',
      canPublish: false,
      canSubscribe: true,
    });
  });

  it.each(['moderator', 'panelist', 'observer'] as const)(
    '%s は canPublishData が付与される（チャットのデータ送信に必要）',
    (role) => {
      expect(videoGrantFor(role, 'room-1').canPublishData).toBe(true);
    },
  );

  it('オブザーバーは映像 publish 不可だがデータ publish は可（独立した権限）', () => {
    const grant = videoGrantFor('observer', 'room-1');
    expect(grant.canPublish).toBe(false);
    expect(grant.canPublishData).toBe(true);
  });
});

describe('canBroadcast', () => {
  it.each([
    ['moderator', true],
    ['panelist', true],
    ['observer', false],
  ] as const)('%s -> %s', (role, expected) => {
    expect(canBroadcast(role)).toBe(expected);
  });
});

