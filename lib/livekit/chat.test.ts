import { describe, it, expect } from 'vitest';
import {
  CHAT_CHANNELS,
  CHANNEL_TOPIC,
  canSendTo,
  canReceiveFrom,
  visibleChannels,
  canPublishDataFor,
  destinationIdentitiesFor,
  buildSendPlan,
  type ChatParticipant,
} from './chat';

describe('CHANNEL_TOPIC', () => {
  it('3 階層それぞれに一意な topic が割り当てられている', () => {
    const topics = CHAT_CHANNELS.map((c) => CHANNEL_TOPIC[c]);
    expect(new Set(topics).size).toBe(CHAT_CHANNELS.length);
    expect(CHANNEL_TOPIC.public).toMatch(/public/);
    expect(CHANNEL_TOPIC.private).toMatch(/private/);
    expect(CHANNEL_TOPIC.observer_only).toMatch(/observer/);
  });
});

describe('canSendTo — 送信権限マトリクス', () => {
  it.each([
    // role, channel, expected
    ['moderator', 'public', true],
    ['moderator', 'private', true],
    ['moderator', 'observer_only', false],
    ['panelist', 'public', true],
    ['panelist', 'private', false],
    ['panelist', 'observer_only', false],
    ['observer', 'public', false], // オブザーバーは public 閲覧のみ
    ['observer', 'private', true], // E+O チャネル
    ['observer', 'observer_only', true],
  ] as const)('%s -> %s = %s', (role, channel, expected) => {
    expect(canSendTo(role, channel)).toBe(expected);
  });
});

describe('canReceiveFrom — 受信権限マトリクス', () => {
  it.each([
    ['moderator', 'public', true],
    ['moderator', 'private', true],
    ['moderator', 'observer_only', false],
    ['panelist', 'public', true],
    ['panelist', 'private', false],
    ['panelist', 'observer_only', false],
    ['observer', 'public', true], // 閲覧可
    ['observer', 'private', true],
    ['observer', 'observer_only', true],
  ] as const)('%s -> %s = %s', (role, channel, expected) => {
    expect(canReceiveFrom(role, channel)).toBe(expected);
  });
});

describe('visibleChannels — UI タブに出すチャネル', () => {
  it('moderator は public と private', () => {
    expect(visibleChannels('moderator')).toEqual(['public', 'private']);
  });
  it('panelist は public のみ', () => {
    expect(visibleChannels('panelist')).toEqual(['public']);
  });
  it('observer は 3 階層すべて', () => {
    expect(visibleChannels('observer')).toEqual([
      'public',
      'private',
      'observer_only',
    ]);
  });
});

describe('canPublishDataFor — トークン grant', () => {
  it.each([
    ['moderator', true],
    ['panelist', true],
    ['observer', true], // observer は canPublish:false だがデータは送れる必要がある
  ] as const)('%s -> %s', (role, expected) => {
    expect(canPublishDataFor(role)).toBe(expected);
  });
});

const PARTICIPANTS: ChatParticipant[] = [
  { identity: 'mod-1', role: 'moderator' },
  { identity: 'mod-2', role: 'moderator' },
  { identity: 'pan-1', role: 'panelist' },
  { identity: 'obs-1', role: 'observer' },
  { identity: 'obs-2', role: 'observer' },
];

describe('destinationIdentitiesFor — 宛先限定', () => {
  it('public は空配列（全員ブロードキャスト）', () => {
    expect(destinationIdentitiesFor('public', PARTICIPANTS)).toEqual([]);
  });

  it('private は moderator + observer の identity', () => {
    expect(destinationIdentitiesFor('private', PARTICIPANTS).sort()).toEqual(
      ['mod-1', 'mod-2', 'obs-1', 'obs-2'].sort(),
    );
  });

  it('observer_only は observer の identity のみ', () => {
    expect(
      destinationIdentitiesFor('observer_only', PARTICIPANTS).sort(),
    ).toEqual(['obs-1', 'obs-2'].sort());
  });
});

describe('buildSendPlan — 送信プラン構築', () => {
  it('権限がある送信は topic と destinationIdentities を返す', () => {
    const plan = buildSendPlan('observer', 'observer_only', PARTICIPANTS);
    expect(plan).toEqual({
      topic: CHANNEL_TOPIC.observer_only,
      destinationIdentities: ['obs-1', 'obs-2'],
    });
  });

  it('public は destinationIdentities なし（全員）', () => {
    const plan = buildSendPlan('panelist', 'public', PARTICIPANTS);
    expect(plan).toEqual({
      topic: CHANNEL_TOPIC.public,
      destinationIdentities: [],
    });
  });

  it('権限のない送信は null を返す（panelist は private に送れない）', () => {
    expect(buildSendPlan('panelist', 'private', PARTICIPANTS)).toBeNull();
  });

  it('権限のない送信は null を返す（observer は public に送れない）', () => {
    expect(buildSendPlan('observer', 'public', PARTICIPANTS)).toBeNull();
  });
});
