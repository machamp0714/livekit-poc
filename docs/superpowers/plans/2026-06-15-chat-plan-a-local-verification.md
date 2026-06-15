# 案A（LiveKit データチャネル再利用）ローカル検証 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 案A（チャット送信を Next.js Route Handler で受け、認可・RDS 保存のうえ `RoomServiceClient.sendData()` で配信し、クライアントは `RoomEvent.DataReceived` で受信する「サーバー権威 + LiveKit データチャネル再利用」方式）を、本リポジトリでローカルにフル（永続化・履歴・リロード復元込み）で動かして実機検証する。

**Architecture:** 既存のローカル LiveKit（`compose.yaml`）とトークン発行・ロール・`lib/livekit/chat.ts`（`canSendTo` / `destinationIdentitiesFor`）を再利用する。新たに (1) ローカル Postgres（RDS 代替）、(2) チャット送信/履歴の Route Handler `app/api/chat/route.ts`、(3) `ChatPanel` を「直 `sendText`/`registerTextStreamHandler`」から「`fetch` POST 送信 / `RoomEvent.DataReceived` 受信 / 履歴 API ロード」へ変更、を足す。送信は必ずサーバーを経由し、宛先（`destinationIdentities`）と送信可否（`canSendTo`）はサーバーが決定するため、PoC で残課題だった「クライアントの宛先詐称・サーバー認可なし・永続化なし」が解消される。

**Tech Stack:** Next.js 16 App Router / TypeScript / `livekit-client`（`RoomEvent.DataReceived`）/ `livekit-server-sdk`（`RoomServiceClient.sendData`・`TokenVerifier`・`DataPacket_Kind`）/ `pg`（PostgreSQL）/ Docker Compose / Vitest。

---

## File Structure

| ファイル | 責務 |
|---|---|
| `compose.yaml`（変更） | `postgres` サービス追加（RDS 代替） |
| `db/init/001_chat_messages.sql`（新規） | `chat_messages` テーブル定義。postgres 起動時に自動実行 |
| `lib/livekit/chat-message.ts`（新規） | `ChatMessage` 型と data packet の encode/decode（純粋関数） |
| `lib/livekit/chat-message.test.ts`（新規） | encode/decode のラウンドトリップテスト |
| `lib/livekit/chat-db.ts`（新規） | `pg` プール・`rowToMessage`・`insertMessage`・`listHistory` |
| `lib/livekit/chat-db.test.ts`（新規） | `rowToMessage`（純粋）のテスト |
| `lib/livekit/chat-auth.ts`（新規） | `livekitHttpHost`・`verifyChatToken`・`getRoomService`・`participantsToChatParticipants` |
| `lib/livekit/chat-auth.test.ts`（新規） | `livekitHttpHost`・`participantsToChatParticipants`・`verifyChatToken`（ラウンドトリップ）のテスト |
| `app/api/chat/route.ts`（新規） | `POST`=認可+保存+`sendData`配信 / `GET`=履歴 |
| `app/room/[roomName]/ChatPanel.tsx`（変更） | DataReceived 受信 + fetch POST 送信 + 履歴ロード |
| `app/room/[roomName]/RoomBody.tsx`（変更） | `token` を受け取り `ChatPanel` に渡す |
| `app/room/[roomName]/RoomClient.tsx`（変更） | `token` を `RoomBody` に渡す |
| `.env.local`（変更・gitignore） | `DATABASE_URL` 追加 |

> **再利用（変更しない）**：`lib/livekit/chat.ts`（`canSendTo` / `canReceiveFrom` / `visibleChannels` / `CHANNEL_TOPIC` / `destinationIdentitiesFor` / `ChatParticipant` / `CHAT_CHANNELS`）、`lib/livekit/roles.ts`（`Role` / `ROLES`）、`app/api/token/route.ts`。

---

## Task 1: ローカル Postgres（RDS 代替）

**Files:**
- Modify: `compose.yaml`
- Create: `db/init/001_chat_messages.sql`
- Modify: `.env.local`
- Modify: `package.json`（`pg` 依存）

- [ ] **Step 1: `pg` を追加**

Run:
```bash
pnpm add pg
pnpm add -D @types/pg
```
Expected: `package.json` の `dependencies` に `"pg"`、`devDependencies` に `"@types/pg"` が入る。

- [ ] **Step 2: スキーマ SQL を作成**

Create `db/init/001_chat_messages.sql`:
```sql
create table if not exists chat_messages (
  id              bigserial primary key,
  room            text not null,
  channel         text not null check (channel in ('public','private','observer_only')),
  sender_identity text not null,
  sender_name     text,
  sender_role     text not null check (sender_role in ('moderator','panelist','observer')),
  body            text not null,
  created_at      timestamptz not null default now()
);
create index if not exists chat_messages_room_channel_time_idx
  on chat_messages (room, channel, created_at);
```

- [ ] **Step 3: `compose.yaml` に postgres サービスを追加**

`compose.yaml` の `volumes:` ブロックの直前（最後のサービス定義のあと）に以下を追加:
```yaml
  postgres:
    image: postgres:16-alpine
    container_name: livekit-poc-postgres
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: chat
    ports:
      - "5432:5432"
    volumes:
      - ./db/init:/docker-entrypoint-initdb.d:ro
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d chat"]
      interval: 5s
      timeout: 3s
      retries: 10
```
そして既存の `volumes:` ブロックに `postgres-data:` を追加（`minio-data:` の隣）:
```yaml
volumes:
  minio-data:
  postgres-data:
```

- [ ] **Step 4: postgres を起動してスキーマ適用を確認**

Run:
```bash
docker compose up -d postgres
sleep 5
docker exec livekit-poc-postgres psql -U postgres -d chat -c "\d chat_messages"
```
Expected: `chat_messages` テーブルの列定義（id, room, channel, …）が表示される。

- [ ] **Step 5: `.env.local` に `DATABASE_URL` を追加**

`.env.local` に追記:
```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/chat
```

- [ ] **Step 6: コミット**

```bash
git add compose.yaml db/init/001_chat_messages.sql package.json pnpm-lock.yaml
git commit -m "feat(chat-a): add local postgres (RDS stand-in) + chat_messages schema"
```

---

## Task 2: data packet の encode/decode（`chat-message.ts`）

**Files:**
- Create: `lib/livekit/chat-message.ts`
- Test: `lib/livekit/chat-message.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `lib/livekit/chat-message.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { encodeChatMessage, decodeChatMessage, type ChatMessage } from './chat-message';

const msg: ChatMessage = {
  id: '1',
  room: 'room-1',
  channel: 'private',
  senderIdentity: 'mod-abc',
  senderName: 'mod',
  senderRole: 'moderator',
  body: 'こんにちは',
  createdAt: '2026-06-15T00:00:00.000Z',
};

describe('chat-message encode/decode', () => {
  it('encode→decode でラウンドトリップする', () => {
    const decoded = decodeChatMessage(encodeChatMessage(msg));
    expect(decoded).toEqual(msg);
  });

  it('encode は Uint8Array を返す', () => {
    expect(encodeChatMessage(msg)).toBeInstanceOf(Uint8Array);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm test chat-message.test.ts`
Expected: FAIL（`./chat-message` が存在しない）。

- [ ] **Step 3: 最小実装を書く**

Create `lib/livekit/chat-message.ts`:
```ts
import type { Role } from './roles';
import type { ChatChannel } from './chat';

/** クライアント／サーバー間でやり取りするチャットメッセージ（data packet ペイロード）。 */
export interface ChatMessage {
  id: string;
  room: string;
  channel: ChatChannel;
  senderIdentity: string;
  senderName: string | null;
  senderRole: Role;
  body: string;
  createdAt: string; // ISO8601
}

export function encodeChatMessage(m: ChatMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(m));
}

export function decodeChatMessage(payload: Uint8Array): ChatMessage {
  return JSON.parse(new TextDecoder().decode(payload)) as ChatMessage;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm test chat-message.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: コミット**

```bash
git add lib/livekit/chat-message.ts lib/livekit/chat-message.test.ts
git commit -m "feat(chat-a): add ChatMessage encode/decode for data packets"
```

---

## Task 3: 永続化（`chat-db.ts`）

**Files:**
- Create: `lib/livekit/chat-db.ts`
- Test: `lib/livekit/chat-db.test.ts`

> `insertMessage` / `listHistory` は実 DB が要るため Task 7 の手動検証で確認する。ここでは純粋関数 `rowToMessage` を TDD する。

- [ ] **Step 1: 失敗するテストを書く**

Create `lib/livekit/chat-db.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { rowToMessage } from './chat-db';

describe('rowToMessage', () => {
  it('DB 行を ChatMessage に変換する（id は文字列・created_at は ISO 文字列）', () => {
    const row = {
      id: 42,
      room: 'room-1',
      channel: 'public',
      sender_identity: 'pan-1',
      sender_name: 'panelist',
      sender_role: 'panelist',
      body: 'hi',
      created_at: new Date('2026-06-15T01:02:03.000Z'),
    };
    expect(rowToMessage(row)).toEqual({
      id: '42',
      room: 'room-1',
      channel: 'public',
      senderIdentity: 'pan-1',
      senderName: 'panelist',
      senderRole: 'panelist',
      body: 'hi',
      createdAt: '2026-06-15T01:02:03.000Z',
    });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm test chat-db.test.ts`
Expected: FAIL（`./chat-db` が存在しない）。

- [ ] **Step 3: 最小実装を書く**

Create `lib/livekit/chat-db.ts`:
```ts
import { Pool } from 'pg';
import type { Role } from './roles';
import type { ChatChannel } from './chat';
import type { ChatMessage } from './chat-message';

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

export interface ChatMessageRow {
  id: string | number;
  room: string;
  channel: string;
  sender_identity: string;
  sender_name: string | null;
  sender_role: string;
  body: string;
  created_at: Date;
}

export function rowToMessage(r: ChatMessageRow): ChatMessage {
  return {
    id: String(r.id),
    room: r.room,
    channel: r.channel as ChatChannel,
    senderIdentity: r.sender_identity,
    senderName: r.sender_name,
    senderRole: r.sender_role as Role,
    body: r.body,
    createdAt: r.created_at.toISOString(),
  };
}

export async function insertMessage(
  m: Omit<ChatMessage, 'id' | 'createdAt'>,
): Promise<ChatMessage> {
  const { rows } = await getPool().query<ChatMessageRow>(
    `insert into chat_messages
       (room, channel, sender_identity, sender_name, sender_role, body)
     values ($1,$2,$3,$4,$5,$6)
     returning *`,
    [m.room, m.channel, m.senderIdentity, m.senderName, m.senderRole, m.body],
  );
  return rowToMessage(rows[0]);
}

export async function listHistory(
  room: string,
  channels: ChatChannel[],
  limit = 100,
): Promise<ChatMessage[]> {
  const { rows } = await getPool().query<ChatMessageRow>(
    `select * from chat_messages
      where room = $1 and channel = any($2)
      order by created_at desc
      limit $3`,
    [room, channels, limit],
  );
  return rows.map(rowToMessage).reverse();
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm test chat-db.test.ts`
Expected: PASS（1 test）。

- [ ] **Step 5: コミット**

```bash
git add lib/livekit/chat-db.ts lib/livekit/chat-db.test.ts
git commit -m "feat(chat-a): add chat-db (pg pool, insertMessage, listHistory, rowToMessage)"
```

---

## Task 4: サーバー認証・LiveKit クライアント（`chat-auth.ts`）

**Files:**
- Create: `lib/livekit/chat-auth.ts`
- Test: `lib/livekit/chat-auth.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `lib/livekit/chat-auth.test.ts`:
```ts
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm test chat-auth.test.ts`
Expected: FAIL（`./chat-auth` が存在しない）。

- [ ] **Step 3: 最小実装を書く**

Create `lib/livekit/chat-auth.ts`:
```ts
import {
  RoomServiceClient,
  TokenVerifier,
  type ParticipantInfo,
} from 'livekit-server-sdk';
import { ROLES, type Role } from './roles';
import type { ChatParticipant } from './chat';

/** LiveKit の ws(s) URL を RoomServiceClient 用の http(s) ホストへ変換する。 */
export function livekitHttpHost(url: string): string {
  return url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

export interface ChatCaller {
  identity: string;
  name: string | null;
  role: Role;
}

/** トークンを検証して呼び出し元の identity / name / role を取り出す（role 改ざんは署名で防止）。 */
export async function verifyChatToken(token: string): Promise<ChatCaller> {
  const verifier = new TokenVerifier(
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );
  const claims = await verifier.verify(token);
  const meta = claims.metadata
    ? (JSON.parse(claims.metadata) as { role?: Role })
    : {};
  const role = meta.role;
  if (!role || !ROLES.includes(role)) throw new Error('invalid or missing role');
  return { identity: claims.sub ?? '', name: claims.name ?? null, role };
}

/** RoomServiceClient（宛先算出・配信に使用）。 */
export function getRoomService(): RoomServiceClient {
  return new RoomServiceClient(
    livekitHttpHost(process.env.LIVEKIT_URL!),
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );
}

/** listParticipants の結果を、宛先算出用の ChatParticipant[] に変換する。 */
export function participantsToChatParticipants(
  parts: Pick<ParticipantInfo, 'identity' | 'metadata'>[],
): ChatParticipant[] {
  return parts
    .map((p): ChatParticipant | null => {
      try {
        const meta = p.metadata
          ? (JSON.parse(p.metadata) as { role?: Role })
          : {};
        return meta.role && ROLES.includes(meta.role)
          ? { identity: p.identity, role: meta.role }
          : null;
      } catch {
        return null;
      }
    })
    .filter((p): p is ChatParticipant => p !== null);
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm test chat-auth.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 5: 全テストが緑であることを確認**

Run: `pnpm test`
Expected: 既存 + 新規すべて PASS。

- [ ] **Step 6: コミット**

```bash
git add lib/livekit/chat-auth.ts lib/livekit/chat-auth.test.ts
git commit -m "feat(chat-a): add chat-auth (token verify, room service, participant mapping)"
```

---

## Task 5: チャット Route Handler（`app/api/chat/route.ts`）

**Files:**
- Create: `app/api/chat/route.ts`

> ルートハンドラは実 LiveKit / DB が要る統合層のため、ここでは型・ビルド通過で確認し、振る舞いは Task 7 の手動検証で確認する。

- [ ] **Step 1: 実装を書く**

Create `app/api/chat/route.ts`:
```ts
import { NextResponse, type NextRequest } from 'next/server';
import { DataPacket_Kind } from 'livekit-server-sdk';
import {
  CHAT_CHANNELS,
  CHANNEL_TOPIC,
  canSendTo,
  destinationIdentitiesFor,
  visibleChannels,
  type ChatChannel,
} from '@/lib/livekit/chat';
import {
  getRoomService,
  participantsToChatParticipants,
  verifyChatToken,
  type ChatCaller,
} from '@/lib/livekit/chat-auth';
import { insertMessage, listHistory } from '@/lib/livekit/chat-db';
import { encodeChatMessage } from '@/lib/livekit/chat-message';

function bearer(req: NextRequest): string {
  return req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
}

async function authenticate(req: NextRequest): Promise<ChatCaller | null> {
  try {
    return await verifyChatToken(bearer(req));
  } catch {
    return null;
  }
}

// 送信：認可 → 保存 → LiveKit data 配信
export async function POST(req: NextRequest) {
  const caller = await authenticate(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { room, channel, body } = (await req.json().catch(() => ({}))) as {
    room?: string;
    channel?: ChatChannel;
    body?: string;
  };
  if (!room || !channel || !CHAT_CHANNELS.includes(channel)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  // 送信認可（サーバー強制）
  if (!canSendTo(caller.role, channel)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const text = (body ?? '').trim();
  if (!text || text.length > 2000) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const svc = getRoomService();
  const participants = participantsToChatParticipants(await svc.listParticipants(room));

  // ① 保存（DB が真実）
  const message = await insertMessage({
    room,
    channel,
    senderIdentity: caller.identity,
    senderName: caller.name,
    senderRole: caller.role,
    body: text,
  });

  // ② 配信（宛先はサーバーが算出。public は [] = 全員）
  await svc.sendData(
    room,
    encodeChatMessage(message),
    DataPacket_Kind.RELIABLE,
    {
      destinationIdentities: destinationIdentitiesFor(channel, participants),
      topic: CHANNEL_TOPIC[channel],
    },
  );

  return NextResponse.json({ ok: true, message });
}

// 履歴：見られるチャネルだけ返す
export async function GET(req: NextRequest) {
  const caller = await authenticate(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const room = req.nextUrl.searchParams.get('room');
  if (!room) return NextResponse.json({ error: 'room required' }, { status: 400 });

  const messages = await listHistory(room, visibleChannels(caller.role));
  return NextResponse.json({ messages });
}
```

- [ ] **Step 2: 型チェックが通ることを確認**

Run: `pnpm exec tsc --noEmit`
Expected: 終了コード 0（エラーなし）。

- [ ] **Step 3: コミット**

```bash
git add app/api/chat/route.ts
git commit -m "feat(chat-a): add /api/chat route (POST send via sendData, GET history)"
```

---

## Task 6: クライアントを案A方式へ（`ChatPanel` / `RoomBody` / `RoomClient`）

**Files:**
- Modify: `app/room/[roomName]/RoomClient.tsx`
- Modify: `app/room/[roomName]/RoomBody.tsx`
- Modify: `app/room/[roomName]/ChatPanel.tsx`（全面置換）

- [ ] **Step 1: `RoomClient.tsx` で `token` を `RoomBody` に渡す**

`app/room/[roomName]/RoomClient.tsx` の `<RoomBody role={role} roomName={roomName} />` を以下に変更:
```tsx
      <RoomBody role={role} roomName={roomName} token={token} />
```
（`token` は同コンポーネントの state で、この時点で非 null。）

- [ ] **Step 2: `RoomBody.tsx` で `token` を受け取り `ChatPanel` に渡す**

`app/room/[roomName]/RoomBody.tsx` の関数シグネチャを変更:
```tsx
export function RoomBody({ role, roomName, token }: { role: Role, roomName: string, token: string }) {
```
そして `<ChatPanel role={role} />` を以下に変更:
```tsx
      <ChatPanel role={role} roomName={roomName} token={token} />
```

- [ ] **Step 3: `ChatPanel.tsx` を案A方式に全面置換**

`app/room/[roomName]/ChatPanel.tsx` の内容を以下で**置き換える**:
```tsx
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const seen = useRef<Set<string>>(new Set());

  const add = useCallback((m: ChatMessage) => {
    setMessages((prev) => {
      if (seen.current.has(m.id)) return prev;
      seen.current.add(m.id);
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
      .then((r) => r.json())
      .then((d: { messages?: ChatMessage[] }) => {
        if (!cancelled) d.messages?.forEach(add);
      })
      .catch(() => {});
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
```

- [ ] **Step 4: 型チェック＋本番ビルドが通ることを確認**

Run:
```bash
pnpm exec tsc --noEmit
pnpm build
```
Expected: `tsc` 終了コード 0、`build` が `Compiled successfully`（`/api/chat` と `/room/[roomName]` が出力される）。

- [ ] **Step 5: 全テストが緑であることを確認**

Run: `pnpm test`
Expected: 全 PASS（`chat.test.ts` の既存テストは未変更で緑）。

- [ ] **Step 6: コミット**

```bash
git add "app/room/[roomName]/RoomClient.tsx" "app/room/[roomName]/RoomBody.tsx" "app/room/[roomName]/ChatPanel.tsx"
git commit -m "feat(chat-a): switch ChatPanel to server-authoritative POST + DataReceived + history"
```

---

## Task 7: エンドツーエンドのローカル手動検証

**Files:** （コード変更なし。`docker compose` + `pnpm dev` + ブラウザ）

> 自動テストはロジック層でカバー済み。送受信・宛先限定・サーバー認可・永続化は 2〜3 タブのブラウザで確認する。

- [ ] **Step 1: 依存サービスを起動**

Run:
```bash
docker compose up -d postgres livekit redis minio
docker compose ps
```
Expected: `livekit-poc-postgres` が `healthy`、`livekit-poc-livekit` が稼働。
（`.env.local` の `LIVEKIT_URL` は既存の LiveKit Cloud のままで可。完全オフラインにするなら `LIVEKIT_URL=ws://localhost:7880` と devkey/secret に差し替え、`docker compose up -d livekit` を使う。）

- [ ] **Step 2: 開発サーバーを起動**

Run: `pnpm dev`
Expected: `http://localhost:3000` で起動。

- [ ] **Step 3: 3 タブで入室**

- タブA: ルーム名 `chat-a`、名前 `mod`、役割 **moderator**
- タブB（別ウィンドウ/シークレット）: 同ルーム、名前 `obs`、役割 **observer**
- タブC: 同ルーム、名前 `pan`、役割 **panelist**

- [ ] **Step 4: public 送受信を確認**

タブA「全体 (public)」で送信 → **タブB・タブC 両方**に表示される。
タブB（observer）は public の入力欄が disabled（閲覧のみ）であることを確認。

- [ ] **Step 5: private 宛先限定を確認**

タブA（moderator）「関係者 (private)」で送信 → **タブB（observer）には表示**、**タブC（panelist）には表示されない**（サーバーが `destinationIdentities` を mod+observer に限定）。

- [ ] **Step 6: サーバー認可（送信拒否）を確認**

ブラウザの devtools で、observer のトークンを使って public へ送信してみる（または observer タブで public タブが押せないことを確認）。サーバーが `403 forbidden` を返すこと（Network タブ）を確認。

- [ ] **Step 7: 永続化・履歴復元を確認**

メッセージがある状態で**いずれかのタブをリロード** → 履歴 API（`GET /api/chat`）から**過去メッセージが復元表示**されることを確認（案A が現 PoC と決定的に違う点）。
DB を直接確認:
```bash
docker exec livekit-poc-postgres psql -U postgres -d chat -c "select channel, sender_role, body from chat_messages order by id;"
```
Expected: 送信したメッセージが行として保存されている。

- [ ] **Step 8: 検証結果を所見として記録（任意）**

確認できた項目（public / private 宛先限定 / 403 / 永続化・リロード復元）を `docs/` のメモまたは PR 本文に残す。

---

## Self-Review 結果

- **Spec 網羅**: 「案A をローカルでフル検証」= 永続化(Task1,3)・送信のサーバー認可(Task5,Step6 検証)・宛先サーバー算出(Task5)・DataReceived 受信(Task6)・履歴/リロード復元(Task5 GET, Task7 Step7)・配信(Task5 sendData)。すべてタスクに対応。
- **Placeholder**: なし（各 Step に実コード・実コマンド・期待結果を記載）。
- **型整合**: `ChatMessage`（chat-message.ts）を chat-db / route / ChatPanel で一貫使用。`ChatCaller`（chat-auth）→ route で使用。`destinationIdentitiesFor` / `CHANNEL_TOPIC` / `canSendTo` / `visibleChannels` は既存 `lib/livekit/chat.ts` の実シグネチャに一致。`verifyChatToken` は `claims.sub` を identity に使用（ClaimGrants は JWTPayload を継承し identity は sub）。
```
