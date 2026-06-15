# 案E 実装案（サンプルコード）— ECS Fargate + Socket.IO + Redis + RDS

> 将来の独立 Next.js 実査アプリ向けの**実装提案**。現 PoC（LiveKit Text streams 直）には組み込まない参照用コード。
> 構成の解説は [`chat-realtime-architecture.md` §5](./chat-realtime-architecture.md)、PoC 所見は [`../CHAT_POC_FINDINGS.md`](../CHAT_POC_FINDINGS.md)。

## 設計の要点

- **認可マトリクスは PoC の `lib/livekit/chat.ts` を共有パッケージ `@app/chat-core` に抽出して再利用**（`Role` / `ChatChannel` / `CHAT_CHANNELS` / `canSendTo` / `canReceiveFrom` / `visibleChannels`）。LiveKit 固有の `CHANNEL_TOPIC` / `destinationIdentitiesFor` は使わず、**Socket.IO の room** に置き換える。
- **room = チャネル**：`room:{roomName}:{channel}`。接続時に **`visibleChannels(role)` の room にだけ join**（＝受信認可）。送信時に **`canSendTo(role, channel)` を検証**（＝送信認可のサーバー強制）。
- **送信経路は (a) Socket.IO 集約**：client `emit('chat:send')` → サーバーで認可 → RDS 保存 → room へ配信。履歴は Next.js Route Handler が RDS から返す。
- 送信者は自分が送る channel の room に必ず join 済み（`send ⊆ receive` がマトリクス上成立）なので、`io.to(room).emit` で**自分にもエコーされる**（LiveKit のような手動エコー不要）。

### ディレクトリ構成（例）
```
packages/chat-core/                     # 共有：ロール/チャネル/認可マトリクス（= PoC lib/livekit/chat.ts を抽出）
services/chat-server/                   # 案E の Socket.IO 常駐サービス（Fargate）
  src/{server,auth,db}.ts
  Dockerfile
apps/web/                               # Next.js（next-web）
  app/api/chat/history/route.ts         #   履歴 API（RDS 読取）
  app/room/[roomName]/useChatSocket.ts  #   クライアントフック
migrations/001_chat_messages.sql
```

---

## 1. DB スキーマ — `migrations/001_chat_messages.sql`

```sql
create table chat_messages (
  id              bigserial primary key,
  room            text not null,
  channel         text not null check (channel in ('public','private','observer_only')),
  sender_identity text not null,
  sender_name     text,
  sender_role     text not null check (sender_role in ('moderator','panelist','observer')),
  body            text not null,
  created_at      timestamptz not null default now()
);
-- 履歴取得（room × channel × 時系列）用
create index chat_messages_room_channel_time_idx
  on chat_messages (room, channel, created_at);
```

## 2. 永続化 — `services/chat-server/src/db.ts`

```ts
import { Pool } from 'pg';
import type { Role, ChatChannel } from '@app/chat-core';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10), // タスク数 × max ≤ RDS max_connections
});

export interface ChatMessage {
  id: string;
  room: string;
  channel: ChatChannel;
  senderIdentity: string;
  senderName: string | null;
  senderRole: Role;
  body: string;
  createdAt: string;
}

export async function insertMessage(
  m: Omit<ChatMessage, 'id' | 'createdAt'>,
): Promise<ChatMessage> {
  const { rows } = await pool.query(
    `insert into chat_messages
       (room, channel, sender_identity, sender_name, sender_role, body)
     values ($1,$2,$3,$4,$5,$6)
     returning *`,
    [m.room, m.channel, m.senderIdentity, m.senderName, m.senderRole, m.body],
  );
  return toMessage(rows[0]);
}

export async function listHistory(
  room: string,
  channels: ChatChannel[],
  limit = 100,
): Promise<ChatMessage[]> {
  const { rows } = await pool.query(
    `select * from chat_messages
      where room = $1 and channel = any($2)
      order by created_at desc
      limit $3`,
    [room, channels, limit],
  );
  return rows.map(toMessage).reverse();
}

function toMessage(r: any): ChatMessage {
  return {
    id: String(r.id),
    room: r.room,
    channel: r.channel,
    senderIdentity: r.sender_identity,
    senderName: r.sender_name,
    senderRole: r.sender_role,
    body: r.body,
    createdAt: r.created_at.toISOString(),
  };
}
```

## 3. 認証 — `services/chat-server/src/auth.ts`

```ts
import jwt from 'jsonwebtoken';
import { ROLES, type Role } from '@app/chat-core';

export interface ChatUser {
  identity: string;
  name: string | null;
  role: Role;
}

/** ハンドシェイクの JWT を検証して identity / role を取り出す（role 改ざんは署名で防止）。 */
export function verifyToken(token: string | undefined): ChatUser {
  if (!token) throw new Error('missing token');
  const payload = jwt.verify(token, process.env.CHAT_JWT_SECRET!) as Record<string, unknown>;
  const role = payload.role as Role;
  if (!ROLES.includes(role)) throw new Error('invalid role');
  return {
    identity: String(payload.sub ?? payload.identity),
    name: (payload.name as string | undefined) ?? null,
    role,
  };
}
```

## 4. Socket.IO サーバー — `services/chat-server/src/server.ts`

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { CHAT_CHANNELS, canSendTo, visibleChannels, type ChatChannel } from '@app/chat-core';
import { verifyToken } from './auth';
import { insertMessage } from './db';

const PORT = Number(process.env.PORT ?? 4000);
const roomKey = (room: string, channel: ChatChannel) => `room:${room}:${channel}`;

async function main() {
  // ヘルスチェック用の素の HTTP（/socket.io ではなく /healthz を使う）
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    res.writeHead(404); res.end();
  });

  const io = new Server(httpServer, {
    transports: ['websocket'],                 // polling を使わない → ALB sticky 不要
    cors: { origin: process.env.WEB_ORIGIN, credentials: true },
  });

  // 複数 Fargate タスク間の fan-out（ElastiCache Redis）
  const pub = createClient({ url: process.env.REDIS_URL });
  const sub = pub.duplicate();
  await Promise.all([pub.connect(), sub.connect()]);
  io.adapter(createAdapter(pub, sub));

  // 認証：ハンドシェイク時に JWT を検証
  io.use((socket, next) => {
    try {
      socket.data.user = verifyToken(socket.handshake.auth?.token);
      socket.data.room = String(socket.handshake.auth?.room ?? '');
      if (!socket.data.room) throw new Error('missing room');
      next();
    } catch (e) {
      next(e instanceof Error ? e : new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { identity, name, role } = socket.data.user;
    const room: string = socket.data.room;

    // 受信認可：見られるチャネルの room にだけ join
    for (const channel of visibleChannels(role)) socket.join(roomKey(room, channel));

    socket.on('chat:send', async (payload: { channel: ChatChannel; body: string }, ack?: (r: unknown) => void) => {
      const channel = payload?.channel;
      const body = (payload?.body ?? '').trim();

      // 送信認可（サーバー強制）— ここが LiveKit 単体では出来なかった点
      if (!CHAT_CHANNELS.includes(channel) || !canSendTo(role, channel)) {
        return ack?.({ ok: false, error: 'forbidden' });
      }
      if (!body || body.length > 2000) return ack?.({ ok: false, error: 'invalid' });

      const msg = await insertMessage({
        room, channel, senderIdentity: identity, senderName: name, senderRole: role, body,
      });

      // 配信：room = チャネル。送信者も同じ room にいるのでエコー不要
      io.to(roomKey(room, channel)).emit('chat:message', msg);
      ack?.({ ok: true, id: msg.id });
    });
  });

  httpServer.listen(PORT, () => console.log(`chat-server on :${PORT}`));

  // graceful shutdown（デプロイ時の接続断対策。client は自動再接続）
  const shutdown = () => {
    io.close(() => httpServer.close(() => {
      Promise.all([pub.quit(), sub.quit()]).finally(() => process.exit(0));
    }));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

## 5. 履歴 API（next-web）— `apps/web/app/api/chat/history/route.ts`

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { visibleChannels } from '@app/chat-core';
import { verifyToken } from '@/lib/chat-auth';   // server.ts の auth.ts と同じ検証
import { listHistory } from '@/lib/chat-db';      // db.ts の listHistory を共有

export async function GET(req: NextRequest) {
  let user;
  try {
    user = verifyToken(req.headers.get('authorization')?.replace(/^Bearer /, ''));
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const room = req.nextUrl.searchParams.get('room');
  if (!room) return NextResponse.json({ error: 'room required' }, { status: 400 });

  // 見られるチャネルだけ返す（受信認可をサーバーで担保）
  const messages = await listHistory(room, visibleChannels(user.role));
  return NextResponse.json({ messages });
}
```

## 6. クライアントフック — `apps/web/app/room/[roomName]/useChatSocket.ts`

```ts
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { canSendTo, visibleChannels, type ChatChannel, type Role } from '@app/chat-core';

interface ChatMessage {
  id: string; room: string; channel: ChatChannel;
  senderIdentity: string; senderName: string | null; senderRole: Role;
  body: string; createdAt: string;
}

export function useChatSocket(opts: { room: string; token: string; role: Role }) {
  const { room, token, role } = opts;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(process.env.NEXT_PUBLIC_CHAT_WS_URL!, {
      transports: ['websocket'],
      auth: { token, room },
    });
    socketRef.current = socket;

    const seen = new Set<string>();
    const add = (m: ChatMessage) =>
      setMessages((prev) => {
        if (seen.has(m.id)) return prev;          // 履歴とリアルタイムの重複排除
        seen.add(m.id);
        return [...prev, m].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      });

    socket.on('chat:message', add);
    // 取りこぼし防止：接続確立 → 履歴ロードの順（接続後に流れた分は chat:message で受信）
    socket.on('connect', () => {
      fetch(`/api/chat/history?room=${encodeURIComponent(room)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => r.json())
        .then((d: { messages: ChatMessage[] }) => d.messages.forEach(add))
        .catch(() => {});
    });

    return () => { socket.disconnect(); socketRef.current = null; };
  }, [room, token]);

  const send = useCallback(
    (channel: ChatChannel, body: string) => {
      if (!canSendTo(role, channel)) return Promise.resolve({ ok: false, error: 'forbidden' });
      return new Promise<unknown>((resolve) =>
        socketRef.current?.emit('chat:send', { channel, body }, resolve),
      );
    },
    [role],
  );

  // channels は UI のタブに使う（= 受信できるチャネル）
  return { messages, send, channels: visibleChannels(role) };
}
```

## 7. Dockerfile（chat-server）— `services/chat-server/Dockerfile`

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build                      # tsc -> dist/

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4000
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
EXPOSE 4000
HEALTHCHECK CMD wget -qO- http://localhost:4000/healthz || exit 1
CMD ["node", "dist/server.js"]
```

### 環境変数
| 変数 | 用途 |
|---|---|
| `DATABASE_URL` | RDS Postgres 接続 |
| `REDIS_URL` | ElastiCache（Socket.IO アダプタ） |
| `CHAT_JWT_SECRET` | チャット JWT 署名鍵（role 改ざん防止） |
| `WEB_ORIGIN` | CORS 許可オリジン |
| `NEXT_PUBLIC_CHAT_WS_URL` | フロントが繋ぐ Socket.IO エンドポイント |

---

## 8. 本番化チェックリスト（サンプルからの差分）

- **入力検証**：`zod` 等で payload を検証。`body` 長さ・チャネル enum を厳格化。
- **レート制限**：socket あたり N msg/s（メモリ or Redis トークンバケット）。
- **再接続の取りこぼし**：本サンプルは「全件取得 → id で重複排除」。本番は `since`（最終受信 `created_at` or `id`）カーソルで差分取得に。
- **sticky**：`transports:['websocket']` 固定なので ALB sticky 不要。polling を許す場合は **ALB スティッキー必須**。
- **コネクションプール**：`タスク数 × PG_POOL_MAX ≤ RDS max_connections`。常駐プールなので **RDS Proxy は原則不要**。
- **Redis**：ElastiCache が**クラスタモード**なら標準アダプタ不可 → `@socket.io/redis-streams-adapter`（sharded）。
- **CSV / 添付**：CSV は `chat_messages` のクエリ。添付は S3 presigned アップロード→ メッセージに `attachment_key` 列を追加。
- **監視**：同時接続数・メッセージ/s・**送信拒否数（forbidden）**・DB レイテンシ・Redis 健全性。
- **認可の単一情報源**：`@app/chat-core` のマトリクスをサーバー（送信・受信 join）と Next.js（履歴の可視チャネル）で共有し、**二重定義を避ける**。
