import { describe, it, expect } from 'vitest';
import { videoGrantFor } from './roles';

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
});

