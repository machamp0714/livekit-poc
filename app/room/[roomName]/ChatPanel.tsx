'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParticipants, useRoomContext } from '@livekit/components-react';
import type { Role } from '@/lib/livekit/roles';
import {
  CHANNEL_TOPIC,
  buildSendPlan,
  canSendTo,
  visibleChannels,
  type ChatChannel,
  type ChatParticipant,
} from '@/lib/livekit/chat';

interface ChatLine {
  id: string;
  fromName: string;
  fromIdentity: string;
  text: string;
  channel: ChatChannel;
  self: boolean;
}

const CHANNEL_LABEL: Record<ChatChannel, string> = {
  public: '全体 (public)',
  private: '関係者 (private)',
  observer_only: 'オブザーバー間 (observer_only)',
};

function roleOf(metadata: string | undefined): Role | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { role?: Role };
    return parsed.role ?? null;
  } catch {
    return null;
  }
}

/**
 * 実査チャットの最小検証 UI。
 * LiveKit Text streams（sendText / registerTextStreamHandler）の生 API で
 * 3 階層チャネルを topic + destinationIdentities として表現する。
 * 永続化・履歴は無し（LiveKit の仕様）＝リロードで消える。
 */
export function ChatPanel({ role }: { role: Role }) {
  const room = useRoomContext();
  const participants = useParticipants();

  const channels = useMemo(() => visibleChannels(role), [role]);
  const [activeChannel, setActiveChannel] = useState<ChatChannel>(
    channels[0] ?? 'public',
  );
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState('');
  const seq = useRef(0);

  // 宛先計算に使う参加者一覧（ロールは metadata から復元）。
  const chatParticipants: ChatParticipant[] = useMemo(
    () =>
      participants
        .map((p) => {
          const r = roleOf(p.metadata);
          return r ? { identity: p.identity, role: r } : null;
        })
        .filter((p): p is ChatParticipant => p !== null),
    [participants],
  );

  // 受信ハンドラ登録。可視チャネルの topic ごとに 1 つ。
  useEffect(() => {
    for (const channel of channels) {
      const topic = CHANNEL_TOPIC[channel];
      room.registerTextStreamHandler(topic, async (reader, info) => {
        const text = await reader.readAll();
        setLines((prev) => [
          ...prev,
          {
            id: `${reader.info.id}-${(seq.current += 1)}`,
            fromName: info.identity,
            fromIdentity: info.identity,
            text,
            channel,
            self: false,
          },
        ]);
      });
    }
    return () => {
      for (const channel of channels) {
        room.unregisterTextStreamHandler(CHANNEL_TOPIC[channel]);
      }
    };
  }, [room, channels]);

  const maySend = canSendTo(role, activeChannel);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    const plan = buildSendPlan(role, activeChannel, chatParticipants);
    if (!plan) return;

    await room.localParticipant.sendText(text, {
      topic: plan.topic,
      destinationIdentities: plan.destinationIdentities,
    });

    // 送信者には自分の stream は配信されないのでローカルにエコー表示する。
    setLines((prev) => [
      ...prev,
      {
        id: `self-${(seq.current += 1)}`,
        fromName: `${room.localParticipant.name ?? room.localParticipant.identity}（自分）`,
        fromIdentity: room.localParticipant.identity,
        text,
        channel: activeChannel,
        self: true,
      },
    ]);
    setDraft('');
  }, [draft, role, activeChannel, chatParticipants, room]);

  const visibleLines = lines.filter((l) => l.channel === activeChannel);

  return (
    <div
      style={{
        border: '1px solid #333',
        borderRadius: 8,
        background: '#1b1b1b',
        color: '#eee',
        display: 'flex',
        flexDirection: 'column',
        height: 280,
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', gap: 4, padding: 8, borderBottom: '1px solid #333' }}>
        {channels.map((c) => (
          <button
            key={c}
            onClick={() => setActiveChannel(c)}
            style={{
              padding: '4px 8px',
              borderRadius: 6,
              border: '1px solid #444',
              background: c === activeChannel ? '#2d6cdf' : 'transparent',
              color: '#eee',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {CHANNEL_LABEL[c]}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 8, minHeight: 0 }}>
        {visibleLines.length === 0 ? (
          <p style={{ color: '#888', margin: 0 }}>まだメッセージはありません。</p>
        ) : (
          visibleLines.map((l) => (
            <div key={l.id} style={{ marginBottom: 6 }}>
              <span style={{ color: l.self ? '#7fb0ff' : '#9fdf9f' }}>
                {l.fromName}
              </span>
              <span style={{ color: '#bbb' }}>: {l.text}</span>
            </div>
          ))
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid #333' }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && maySend) send();
          }}
          placeholder={
            maySend
              ? `${CHANNEL_LABEL[activeChannel]} に送信…`
              : 'このチャネルには送信できません（閲覧のみ）'
          }
          disabled={!maySend}
          style={{
            flex: 1,
            padding: '6px 8px',
            borderRadius: 6,
            border: '1px solid #444',
            background: '#111',
            color: '#eee',
          }}
        />
        <button
          onClick={send}
          disabled={!maySend || draft.trim() === ''}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: 'none',
            background: maySend ? '#2d6cdf' : '#444',
            color: '#fff',
            cursor: maySend ? 'pointer' : 'not-allowed',
          }}
        >
          送信
        </button>
      </div>
    </div>
  );
}
