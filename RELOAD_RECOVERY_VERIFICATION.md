# リロード時のトークン再取得・同一参加者復帰の検証（Issue #1 / DEC-04）

> **結論: PASS。** リロード（JS コンテキスト消失）後も **同一 identity・同一 role で再接続**し、
> **再び publish でき**、**録画(egress)はリロードを跨いで継続する**ことを実機（ローカル自己ホスト
> LiveKit + Playwright 実ブラウザ）で確認した。古いゴースト参加者は残らず、二重タイルも発生しない。
>
> これにより **DEC-04 の「UX が成立するか」は本PoCで完全に潰せた**。
> 「identity の供給源（誰が払い出すか）」は TVM 実装（別タスク）に残る（スコープ境界参照）。

## 1. 背景と問題

`app/room/[roomName]/RoomClient.tsx` の identity がマウントごとに新規生成されており、
リロードのたびに「別人」として入り直していた。

```ts
// 修正前
const [identity] = useState(
  () => `${name}-${Math.random().toString(36).slice(2, 8)}`,
);
```

これでは「リロードしても同じ参加者として復帰する」が検証できない。

## 2. 改修内容

identity を `sessionStorage` でリロードをまたいで永続化する（タブを閉じたら消える＝
「同一セッション」の意味論に一致）。

```ts
// 修正後（app/room/[roomName]/RoomClient.tsx）
const [identity] = useState(() => {
  // SSR 時は sessionStorage が無い。ここで返す値は使われず、クライアントの
  // hydration 時に initializer が再実行されて確定する（identity は描画に出ないので
  // hydration mismatch にならない）。
  if (typeof window === 'undefined') return `${name}-pending`;
  const key = `lk-identity-${roomName}`;
  const existing = window.sessionStorage.getItem(key);
  if (existing) return existing;
  const fresh = `${name}-${crypto.randomUUID()}`;
  window.sessionStorage.setItem(key, fresh);
  return fresh;
});
```

**Issue 記載の案からの差分（重要）:** `RoomClient` は client component だが Next.js では
SSR もされる。`sessionStorage` はサーバに存在しないため、生の案のままだと SSR 時に
`ReferenceError` でページが落ちる。`typeof window === 'undefined'` ガードを追加した。

- **role は元から URL クエリ（`?role=`）で渡るため、リロードしても保持される**
  （`app/room/[roomName]/page.tsx`）。本 Issue で永続化が必要だったのは identity のみ。
- 既存の `useEffect` が mount 時に `/api/token` を取り直すため、identity さえ固定されれば
  「同一 identity で token 再取得 → 再接続」「同一 role で token 再付与」が自然に走る。

## 3. 検証環境・方法

| 項目 | 内容 |
|---|---|
| LiveKit | ローカル自己ホスト `livekit/livekit-server:1.12.0`（`compose.yaml` / redis / minio / egress） |
| アプリ | `next dev -p 3001`（HMR で改修コードが反映済みであることを sessionStorage キーで確認） |
| ブラウザ操作 | **Playwright MCP（実ブラウザ Chromium）** で 2 タブ（パネリスト / モデレーター）を駆動 |
| サーバ側の真実 | `RoomServiceClient.listParticipants` / `EgressClient.listEgress` で identity・sid・権限・録画状態を直接取得 |
| 録画 | `startRoomCompositeEgress`（ルーム単位）→ minio(S3) へアップロード |

改修コードが実際に配信されている確証として、ブラウザの `sessionStorage` に
`lk-identity-reload-test = Alice-116ae3e1-9e61-4e98-9838-61378d56ba8f`（`crypto.randomUUID()` 形式）が
存在することを確認した（修正前の 6 文字 `Math.random` 形式ではない）。

## 4. 検証結果（DEC-04 エビデンス）

### チェックリスト

| 項目 | 結果 | 根拠 |
|---|:--:|---|
| パネリストでリロード → 同じ identity・同じ role で復帰し、再び publish できる | ✅ | §4.1 |
| モデレーターでリロード → モデレーター制御が復元される | ✅ | §4.3 |
| 古いゴースト参加者が残らない／何秒で退去するか／二重タイルが出ないか | ✅ | §4.2 |
| 録画(egress)がリロードを跨いで継続する | ✅ | §4.4 |
| （任意）ttl 1h 超の長時間セッションでのトークン期限切れ挙動 | ⚠️ 設計上低リスク | §4.5 |

### 4.1 パネリスト リロード（identity / role / publish）

`listParticipants` の before/after（identity は不変、sid のみ更新＝新規接続に差し替わった）:

```
# リロード前
identity=Alice-116ae3e1-9e61-4e98-9838-61378d56ba8f  sid=PA_rJ5TzKqob85p  name=Alice  canPublish=true  tracks=2
# リロード後（identity 同一・sid 更新・再 publish 済み）
identity=Alice-116ae3e1-9e61-4e98-9838-61378d56ba8f  sid=PA_fA8QuqgRXDMC  name=Alice  canPublish=true  tracks=2
```

ブラウザ側 console（再接続ライフサイクル）:

```
connection state changed: disconnected -> connecting
connection state changed: connecting -> connected   participant: Alice-116ae3e1-9e61-4e98-9838-61378d56ba8f
publishing track   (×2: audio + video を自動で再 publish)
```

- **identity 同一**（`Alice-116ae3e1-…`）／**role = panelist**（ヘッダ「あなた: Alice（panelist）」、`canPublish=true`）。
- **再 publish 成功**（`tracks=2`、console に `publishing track` ×2）。

### 4.2 ゴースト退去のタイミング（二重タイル無し）

リロード中に 0.4 秒間隔でサーバの参加者を観測（Alice の sid のみ抽出）:

```
06:26:57.364  total=3  aliceCount=1  sids=[PA_fA8QuqgRXDMC]   ← 旧接続
06:26:57.773  total=2  aliceCount=0  sids=[]                  ← 旧接続が抜けた瞬間（< 0.4s の空白）
06:26:58.178  total=3  aliceCount=1  sids=[PA_JbXAVkCXGs8P]   ← 新接続が join
```

- **Alice が 2 接続同時に存在する瞬間は一度も無い**（aliceCount は 1 → 0 → 1）。
  通常のリロードでは page-unload で旧 WebSocket が即座に閉じるため、**ゴーストは「短い不在
  （約 0.4〜0.8 秒）」として現れ、二重タイルにはならない**。
- 異常終了（プロセスクラッシュ等）で旧接続が綺麗に閉じない場合でも、同一 identity の新規
  接続が来た時点で LiveKit が旧接続を **DuplicateIdentity で切断**するため、恒久的なゴーストは
  残らない（セーフティネット）。
- モデレーター画面の「参加者管理」も Alice を **1 件のみ**表示（重複なし）、参加者数も 2 に復帰。

### 4.3 モデレーター リロード（制御の復元）

```
# リロード前  identity=Mod-5bee89b3-e4d9-480f-bf16-83f9fed5ea58  sid=PA_Egq8eZHfk6Fm
# リロード後  identity=Mod-5bee89b3-e4d9-480f-bf16-83f9fed5ea58  sid=PA_BqKU3iQDNLmG  canPublish=true  tracks=2
```

- **identity 同一・role = moderator**。リロード後に **「録画」パネル・「参加者管理（モデレーター
  のみ）」パネルが再描画**される（`role==='moderator'` 分岐で復元）。
- **制御が「描画だけ」でなく機能することも確認**: 復帰後のモデレーターから Alice を「退出させる」→
  確認ダイアログ（対象 `Alice-116ae3e1-…`）→ 実行で **Alice がサーバから除去**された（参加者 3→2）。
- 録画パネルは復帰直後から `status: active` を表示（後述の継続中 egress をポーリング API 経由で復元）。

### 4.4 録画(egress)のリロード跨ぎ継続

同一 `egressId`・同一 `startedAt` が、**パネリスト 2 回 + モデレーター 1 回のリロードを跨いで
ずっと active** のまま維持された:

```
egressId=EG_xqpT5tkCoqhf  status=1(active)  startedAt=1782627880933476925  endedAt=0   ← 全リロードを通じて不変
egressId=EG_xqpT5tkCoqhf  status=3(complete) endedAt=1782628189994720554              ← 明示停止後
```

停止後、minio に **単一の連続ファイル**が生成されていることを確認（約 5 分・全リロードを内包）:

```
[2026-06-28 06:29:49 UTC]  114MiB  livekit-poc/reload-test/1782627880359.mp4
```

→ ルーム単位の room composite egress は **参加者個々のリロードから独立**しており、ルームが生存
する限り（他参加者が在室）録画は中断せず単一ファイルとして継続する。

### 4.5 トークン TTL（任意項目）

`lib/livekit/token.ts` の TTL は `1h`。ただし `RoomClient` の `useEffect` は **mount のたびに
`/api/token` を取り直す**ため、**リロードのたびに新しい 1h トークンが再発行される**。
よって「リロード復帰」が TTL 切れの影響を受けることはない（リロード＝常に再ミント）。
1 時間連続接続かつ**ノーリロード**の場合の自動再接続のみが理論上の境界だが、実時間 1h を要する
ため本検証ではスコープ外とした（再ミント設計のため低リスク）。

## 5. スコープ境界

| 対象 | 本PoCで潰せたか |
|---|---|
| リロード復帰の UX/技術的実現性（再接続・role 復元・録画継続） | ✅ 本検証で確定（PASS） |
| 本番で identity を「誰が」発行するか（テナントが払い出す） | ⚠️ 委譲信頼/TVM 実装の一部として別タスク |

- **DEC-04 の「UX が成立するか」は本PoCで完全に潰せた。**
- **DEC-04 の「identity の供給源」は TVM 実装（別タスク）に残る。**

## 6. 補足（観測メモ）

- 検証用の一時スクリプト（`listParticipants`/`listEgress` ダンプ、退去タイミングのポーリング）と
  Playwright スクショは手元で取得済み。スクショには実カメラ映像が映り得るためコミットには含めず、
  本書には再現可能なサーバ側テキスト・エビデンスを掲載した。
- ローカルスタックは検証開始時に `livekit`/`egress` コンテナが redis 解決失敗で再起動ループに
  陥っていたため、`docker compose down && up` で再生成して健全化してから検証した
  （compose 定義自体は正常。起動順ドリフトによる一過性の不整合）。
