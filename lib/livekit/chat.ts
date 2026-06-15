import type { Role } from './roles';

/**
 * 実査チャットの 3 階層チャネル。現行 minedia-www（ActionCable 版）の
 * public / private / observer_only に対応する。
 *
 * LiveKit には「チャネル」概念がないため、Text streams の topic で表現し、
 * private / observer_only は sendText の destinationIdentities で宛先を限定する。
 */
export type ChatChannel = 'public' | 'private' | 'observer_only';

export const CHAT_CHANNELS: ChatChannel[] = [
  'public',
  'private',
  'observer_only',
];

/** チャネル → Text stream topic。受信ハンドラの登録キーにもなる。 */
export const CHANNEL_TOPIC: Record<ChatChannel, string> = {
  public: 'chat.public',
  private: 'chat.private',
  observer_only: 'chat.observer_only',
};

/**
 * 送信権限マトリクス（現行実査仕様）。
 *
 * | role      | public | private | observer_only |
 * |-----------|--------|---------|---------------|
 * | moderator | ✓      | ✓       | ✗             |
 * | panelist  | ✓      | ✗       | ✗             |
 * | observer  | ✗(閲覧) | ✓       | ✓             |
 *
 * 注意: LiveKit の canPublishData grant は all-or-nothing。サーバー側で
 * 「このトピックには送れない」を強制できないため、この表はクライアント
 * （UI）と、必要なら検証用サーバー/agent で担保する設計上の契約である。
 */
const SEND_MATRIX: Record<Role, ChatChannel[]> = {
  moderator: ['public', 'private'],
  panelist: ['public'],
  observer: ['private', 'observer_only'],
};

/**
 * 受信権限マトリクス。送信に observer の public を加えたもの
 * （observer は public を閲覧できる）。
 */
const RECEIVE_MATRIX: Record<Role, ChatChannel[]> = {
  moderator: ['public', 'private'],
  panelist: ['public'],
  observer: ['public', 'private', 'observer_only'],
};

export function canSendTo(role: Role, channel: ChatChannel): boolean {
  return SEND_MATRIX[role].includes(channel);
}

export function canReceiveFrom(role: Role, channel: ChatChannel): boolean {
  return RECEIVE_MATRIX[role].includes(channel);
}

/** UI タブとして表示する（=受信できる）チャネル。CHAT_CHANNELS の順序を保つ。 */
export function visibleChannels(role: Role): ChatChannel[] {
  return CHAT_CHANNELS.filter((c) => canReceiveFrom(role, c));
}

/**
 * トークンに付与する canPublishData。全ロール true。
 * observer は映像 publish (canPublish) は不可だが、private / observer_only に
 * テキストを送る必要があるためデータ publish は許可する。
 * → 「データ送信権限は映像送信権限と独立」が本 PoC の主要な所見。
 */
export function canPublishDataFor(_role: Role): boolean {
  return true;
}

export interface ChatParticipant {
  identity: string;
  role: Role;
}

/** どのロールがそのチャネルを「受信」できるか（宛先計算用）。 */
function receiverRolesFor(channel: ChatChannel): Role[] {
  return (Object.keys(RECEIVE_MATRIX) as Role[]).filter((role) =>
    RECEIVE_MATRIX[role].includes(channel),
  );
}

/**
 * チャネルへ送る際の destinationIdentities を算出する。
 * - public: 空配列（全員ブロードキャスト = destinationIdentities 未指定相当）
 * - private / observer_only: 受信可能ロールの参加者 identity に限定
 */
export function destinationIdentitiesFor(
  channel: ChatChannel,
  participants: ChatParticipant[],
): string[] {
  if (channel === 'public') return [];
  const roles = new Set(receiverRolesFor(channel));
  return participants
    .filter((p) => roles.has(p.role))
    .map((p) => p.identity);
}

export interface SendPlan {
  topic: string;
  destinationIdentities: string[];
}

/**
 * 送信プランを構築する。送信権限が無ければ null。
 * UI 側はこの結果を localParticipant.sendText(text, plan) に渡す。
 */
export function buildSendPlan(
  role: Role,
  channel: ChatChannel,
  participants: ChatParticipant[],
): SendPlan | null {
  if (!canSendTo(role, channel)) return null;
  return {
    topic: CHANNEL_TOPIC[channel],
    destinationIdentities: destinationIdentitiesFor(channel, participants),
  };
}
