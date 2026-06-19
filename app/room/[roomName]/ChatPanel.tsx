'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import type { Role } from '@/lib/livekit/roles';
import { canSendTo, visibleChannels, type ChatChannel } from '@/lib/livekit/chat';
import { decodeChatMessage, type ChatMessage } from '@/lib/livekit/chat-message';

const CHANNEL_LABEL: Record<ChatChannel, string> = {
  public: '全体 (public)',
  private: '関係者 (private)',
  observer_only: 'オブザーバー間 (observer_only)',
};

/**
 * 案A：サーバー権威 + LiveKit データチャネル再利用。
 * 送信は /api/chat へ POST（サーバーが認可・保存・sendData 配信）。
 * 受信は RoomEvent.DataReceived（data packet を decode）。
 * 履歴は GET /api/chat（リロードしても復元）。
 */
export function ChatPanel({
  role,
  roomName,
  token,
}: {
  role: Role;
  roomName: string;
  token: string;
}) {
  const room = useRoomContext();
  const channels = useMemo(() => visibleChannels(role), [role]);
  const [activeChannel, setActiveChannel] = useState<ChatChannel>(
    channels[0] ?? 'public',
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');

  // 純粋なupdater（prev 配列で重複排除）。ref の副作用を updater 内に持つと
  // React StrictMode の二重呼び出しで「2 回目が重複扱い」になりメッセージが
  // 落ちるため、seen ref は使わず prev に対して id 重複を判定する。
  const add = useCallback((m: ChatMessage) => {
    setMessages((prev) => {
      if (prev.some((x) => x.id === m.id)) return prev;
      return [...prev, m].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }, []);

  // 受信：data packet
  useEffect(() => {
    const handler = (payload: Uint8Array) => {
      try {
        add(decodeChatMessage(payload));
      } catch {
        /* チャット以外の data packet は無視 */
      }
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => {
      room.off(RoomEvent.DataReceived, handler);
    };
  }, [room, add]);

  // 履歴ロード（リロード・後入室の復元）
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/chat?room=${encodeURIComponent(roomName)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        const text = await r.text();
        const d = (text ? JSON.parse(text) : {}) as {
          messages?: ChatMessage[];
          error?: string;
        };
        if (!r.ok) throw new Error(`history ${r.status}: ${d.error ?? text}`);
        if (!cancelled) d.messages?.forEach(add);
      })
      .catch((e) => {
        console.error('[chat] history load failed', e);
      });
    return () => {
      cancelled = true;
    };
  }, [roomName, token, add]);

  const maySend = canSendTo(role, activeChannel);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !maySend) return;
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ room: roomName, channel: activeChannel, body: text }),
    });
    if (res.ok) {
      // 送信者には sendData がループバックしないので応答からローカル反映
      const d = (await res.json()) as { message: ChatMessage };
      add(d.message);
      setDraft('');
    }
  }, [draft, maySend, token, roomName, activeChannel, add]);

  const visibleLines = messages.filter((m) => m.channel === activeChannel);

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
          visibleLines.map((m) => (
            <div key={m.id} style={{ marginBottom: 6 }}>
              <span style={{ color: m.senderIdentity === room.localParticipant.identity ? '#7fb0ff' : '#9fdf9f' }}>
                {m.senderName ?? m.senderIdentity}
              </span>
              <span style={{ color: '#bbb' }}>: {m.body}</span>
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
