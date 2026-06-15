# チャット機能 検証 PoC 所見（LiveKit Data / Text streams）

| 項目 | 内容 |
|---|---|
| 対象 Issue | `machamp0714/livekit-poc#4` |
| 親 | `minedia/minedia-www#5317`（インタビュー機能の外だし） |
| 検証日 | 2026-06-15 |
| 検証バージョン | `livekit-client@2.19.0` / `@livekit/components-react@2.9.21` / `livekit-server-sdk@2.15.3` |
| ステータス | PoC（意思決定のための検証。本番品質は対象外） |
| 前提 | 実査機能は独立 Next.js アプリへ外だしし **Rails を使わない**（→ ActionCable は選択肢から外れる）。 |
| 結論（先出し） | **チャットは AV ベンダー(LiveKit)から分離し、チャット専用バックエンド（Supabase 等の BaaS = Postgres + Realtime + RLS + Storage）に集約することを推奨。** LiveKit Text streams は「全体チャットの送受信」は容易だが、実査チャットの中核要件（永続化・履歴・CSV・ロール別チャネル権限のサーバー強制）は LiveKit ネイティブに欠落しており、結局 DB と認可層が必要。現行が ActionCable で実現していた「チャット＝AV非依存」を Rails 無しで継承するのが BaaS 集約。詳細は §4。 |

---

## 0. このリポジトリで実装した範囲

| 成果物 | 内容 |
|---|---|
| `lib/livekit/chat.ts` | 3 階層チャネル定義・topic マッピング・ロール別送受信マトリクス・`destinationIdentities` 算出・送信プラン構築（純ロジック、テスト済み） |
| `lib/livekit/chat.test.ts` | 上記の最小テスト（32 ケース）。`pnpm test` で緑 |
| `lib/livekit/roles.ts` | `videoGrantFor` に `canPublishData` を追加（全ロール `true`） |
| `app/room/[roomName]/ChatPanel.tsx` | `sendText` / `registerTextStreamHandler` の生 API による最小チャット UI。チャネルタブ + 送受信 + ローカルエコー |
| `app/room/[roomName]/RoomBody.tsx` | ChatPanel を配線 |

> スコープ確認: **public（全体）と private（宛先限定）をコードで実装**し、添付・スタンプ・永続化・CSV・録画状態通知は本書で「可/不可/要追加」を整理する方針（Issue の必須=public、推奨=private に一致）。

---

## 1. 3 階層チャネル + ロール別送受信権限の実現可否

### 1-1. マッピング方針

LiveKit に「チャネル」概念は無い。**Text stream の `topic` でチャネルを表現**し、宛先限定は **`sendText(text, { destinationIdentities })`** で行う。

| 現行チャネル | LiveKit 表現 | 宛先 |
|---|---|---|
| `public`（全員） | `topic: chat.public` | `destinationIdentities: []`（=全員ブロードキャスト） |
| `private`（モデレーター+オブザーバー） | `topic: chat.private` | moderator + observer の identity に限定 |
| `observer_only`（オブザーバー同士） | `topic: chat.observer_only` | observer の identity に限定 |

ロール別マトリクス（本 PoC の 3 ロールに射影。Operator は全チャネル参加の上位ロールで PoC 対象外）:

| 送信元 | public | private | observer_only |
|---|---|---|---|
| moderator（≒Employee） | 送信可 | 送信可 | 不可 |
| panelist（≒User） | 送信可 | 不可 | 不可 |
| observer（≒Observer） | **閲覧のみ** | 送信可（E+O） | 送信可（O 同士） |

→ `lib/livekit/chat.ts` の `SEND_MATRIX` / `RECEIVE_MATRIX` として実装・テスト済み。

### 1-2. 実現可否と制約

| 観点 | 可否 | 補足 |
|---|---|---|
| 全体（public）の送受信 | ✅ 容易 | `sendText` + `registerTextStreamHandler` で動作 |
| 宛先限定（private / observer_only） | ✅ 可能 | `destinationIdentities` に対象ロールの identity を列挙。SFU が配信先を絞るため非対象には届かない |
| **ロール別の「送信」権限のサーバー強制** | ⚠️ **不可（重要制約）** | LiveKit のデータ送信権限は **`canPublishData`（boolean）の all-or-nothing**。「public には送れるが private には送れない」のような *チャネル単位の送信制限をトークンで表現できない*。本 PoC では UI（`canSendTo`）で担保しているが、悪意あるクライアントは任意 topic / 任意 `destinationIdentities` で送信できてしまう |
| 宛先の正しさの担保 | ⚠️ 送信側依存 | `destinationIdentities` は **送信クライアントが指定**する。受信フィルタは「正直な送信者」前提。なりすまし送信を防ぐにはサーバー検証層（後述）が必要 |
| identity からロール解決 | ✅ | 参加者の `metadata`（`{ role }`）から復元。トークン発行時に確定するため信頼できる |

> **結論（チャネル権限）**: 「チャネル分離」と「正直な前提での宛先限定」は LiveKit ネイティブで実現できる。しかし **ロール別送信権限をサーバーで強制する**には、(a) 各クライアントが送信前にバックエンドへ問い合わせる、(b) LiveKit Agent / サーバーが全データを中継して検証する、のいずれかが必要。これは現行 ActionCable（チャネルごとに `subscribed` 認可、サーバー経由配信）が標準で持つ性質であり、LiveKit ネイティブでは追加実装になる。

---

## 2. 機能別 LiveKit 対応表（可 / 不可 / 要追加実装）

| 機能 | 現行（ActionCable + DB） | LiveKit ネイティブ | 判定 | 備考 |
|---|---|---|---|---|
| リアルタイム送受信 | ActionCable | Text streams（`sendText`） | ✅ 可 | 低レイテンシ。reliable 配信 |
| チャネル 3 階層 | 専用 Channel クラス | `topic` + `destinationIdentities` | ✅ 可（要設計） | §1 の通り。権限のサーバー強制は要追加 |
| ロール別送信権限の強制 | `subscribed` で認可 | `canPublishData` は boolean | ⚠️ 要追加実装 | チャネル単位制御は検証層が必要 |
| **永続化** | DB 全保存（`room_chat_messages`） | **無し（公式明記）** | ❌ 要追加実装 | LiveKit は履歴を保持しない。DB 等を自前で用意 |
| **履歴取得**（後入室・リロード） | `GET /api/{role}/room_chat_messages` | 不可 | ❌ 要追加実装 | ストリームは「開始時に接続済みの参加者」のみ受信。後から入室した人・リロードした人は過去分を受け取れない |
| **CSV エクスポート** | Operator 管理画面 | 不可（永続化が無いため） | ❌ 要追加実装 | DB がある前提の機能。LiveKit 単体では不可能 |
| 添付ファイル（モデレーターのみ） | DB + ストレージ | **Byte streams**（`sendFile`） | △ 可だが要追加 | 転送は可能。保存・履歴・モデレーター限定の権限制御は別途。`sendText` の `attachments?: File[]` も利用可 |
| スタンプ（ロール別定型） | `content_type: stamp` | Text/Data + `attributes` | ✅ 可 | スタンプ ID を本文 or `attributes`（string dict）に載せる。定型一覧の管理はアプリ側 |
| 録画状態通知（`archive_status`） | `content_type: archive_status` | Data packets / metadata | △ 可だが要追加 | LiveKit の録画状態は **Egress Webhook（サーバー側）**で受ける。クライアントへ通知するには data packet 中継 or room/participant metadata 更新が必要。本 PoC は既に `app/api/webhooks/livekit` を保有 |

凡例: ✅ ネイティブで可 / △ 可だが追加実装あり / ⚠️ 制約あり要設計 / ❌ ネイティブ単体では不可

---

## 3. `useChat` / 既製 Chat コンポーネントの流用可否

`@livekit/components-react` の `useChat` フックを調査した。

```ts
function useChat(options?: ChatOptions & { room?: Room }): {
  send: (message: string, options?: SendTextOptions) => Promise<ReceivedChatMessage>;
  chatMessages: ReceivedChatMessage[];
  isSending: boolean;
};
// ChatOptions.channelTopic?: string  ← 受信トピックを指定可能
```

| 観点 | 評価 |
|---|---|
| 単一チャネル（全体チャット） | ✅ そのまま流用可。`useChat()` で `chatMessages` / `send` が得られる |
| 複数チャネル | ✅ 可。`useChat({ channelTopic: 'chat.private' })` のように **topic ごとにインスタンス化**すれば、チャネル別の `chatMessages` / `send` が得られる |
| 宛先限定（private） | ✅ 可。`send(msg, { destinationIdentities })` に `SendTextOptions` を渡せる |
| ロール別送信制限 | ❌ フック側には無い。アプリ側（`canSendTo`）で UI 制御が必要 |
| 永続化 | ❌ 無し（公式 remark に「リフレッシュで消える」と明記） |

**評価**: 全体チャットだけなら `useChat` が最短。ただし本 PoC では「生 API（`sendText`/`registerTextStreamHandler`）の挙動確認」を主目的としたため、`ChatPanel.tsx` は生 API で実装した（チャネル別ロジック・宛先計算を `chat.ts` に分離してテスト可能にする意図もある）。本番で全体チャットのみを LiveKit に寄せるなら `useChat` 流用は有力。

---

## 4. 独立 Next.js 実査アプリでのチャット構成

### 4-0. 前提の訂正

当初は「チャットは ActionCable + DB のまま継続」を推奨していたが、これは **Rails が残る前提**だった。
実査機能は独立 Next.js アプリへ外だしし **Rails を使わない**方針のため、ActionCable は選べない。
よって本節を「独立アプリでの構成」として書き直す。

ただし重要なのは **ActionCable は手段であって要件ではない**こと。現行チャットが本当に必要とする
*能力*は次の 4 つで、いずれも Rails 固有ではない。独立アプリでは「ActionCable を別物で置換」
ではなく、**この①〜④を満たすサーバー権威型のチャット層を新スタックで組む**のが本質。

| 能力 | 旧: ActionCable + DB | LiveKit ネイティブの欠落（本 PoC 所見） |
|---|---|---|
| ① リアルタイム配信 | ActionCable | ✅ LiveKit でも可 |
| ② 永続化・履歴・CSV | DB | ❌ 非対応（§2） |
| ③ ロール別チャネル送信権限の**サーバー強制** | `subscribed` 認可 | ❌ `canPublishData` は all-or-nothing（§1-2） |
| ④ 添付の保存 | DB + ストレージ | △ Byte streams で転送のみ |

### 4-1. 設計の分岐点

構成を分ける本質的な問いは **「チャットを AV ベンダー(LiveKit)から独立に保つか、LiveKit に集約するか」**。
現行が OpenTok signal を使わず ActionCable にしたのは、まさにチャットを AV ベンダーから切り離すため。
この設計思想を継ぐかどうかで構成が決まる。

### 4-2. 構成案

**案B（採用）: チャット専用バックエンドで AV から分離 — BaaS 集約**

```
[Next.js 実査アプリ] ──AV──> LiveKit（映像 / 音声のみ）
        │
        └──chat──> BaaS（Supabase 等）
                    ├ Postgres      … 永続化・履歴・CSV（②）
                    ├ Realtime(WS)  … リアルタイム配信（①）
                    ├ RLS           … ロール別チャネル認可を DB で強制（③）
                    └ Storage       … 添付（④）
```

- 現行アーキテクチャの美点（**チャット＝AV 非依存**）をそのまま維持。将来 LiveKit を差し替えてもチャット無改修。
- ActionCable + DB が持っていた①〜④を Rails 無しでほぼ等価に再現。サーバーレス / App Router と相性良。
- 本 PoC の `SEND_MATRIX` / `RECEIVE_MATRIX`（`lib/livekit/chat.ts`）を **RLS ポリシーへ移植**して③を担保。
- Supabase は一例。Convex / Firestore / 「Ably・Pusher + managed Postgres」等でも同型。
- 欠点: 新ベンダー依存、RLS（行レベルセキュリティ）の設計コスト。

**案A（次点）: LiveKit に集約 — Next.js Route Handler 権威 + `sendData`**

```
[Client] ──POST /api/chat──> [Next.js Route Handler]
                              ├ JWT で identity/role 検証 → canSendTo() でサーバー判定（③）
                              ├ DB（Neon / RDS 等）へ永続化（②）
                              └ RoomServiceClient.sendData() で対象 identity に配信（①）
[Client] <──RoomEvent.DataReceived── LiveKit
履歴: GET /api/chat（DB から）／ 添付: presigned URL → S3 / R2（④）
```

- realtime 用インフラを増やさず **LiveKit 接続を再利用**。PoC の `chat.ts` ロジックを**サーバー側で流用**できる。
- 宛先をサーバーが決定するため、PoC で残課題だった「クライアントによる `destinationIdentities` 詐称」（§1-2）が解消。
- 欠点: **チャットが LiveKit に再結合**（AV 差し替え時に影響）。DB は結局必要で、永続化の自前実装からは逃げられない。LiveKit data は ephemeral と割り切り「DB が真実、配信は通知」とする。

**案C（非推奨）: フル自前 WebSocket / SSE + Postgres**

- ベンダー中立だが、サーバーレス環境で常時接続 WS の接続管理・スケールを自作するのは負荷が高い。

### 4-3. 比較と推奨

| 観点 | 案B（BaaS 分離） | 案A（LiveKit 集約） | 案C（自前 WS） |
|---|---|---|---|
| AV からの独立性 | ◎ | ✕ 再結合 | ◎ |
| ①〜④の充足 | ◎ ほぼ標準機能 | ○ 要実装だが可 | △ 全部自前 |
| 新規インフラ | BaaS 1 つ | DB 1 つ | DB + WS 基盤 |
| PoC コード再利用 | ロジックを RLS へ移植 | `chat.ts` をサーバーで流用 | 流用可 |
| 運用負荷 | 低 | 中 | 高 |

**推奨は案B（BaaS でチャットを AV から分離）。**

理由:
1. 現行が ActionCable を採用した本来の狙い（チャットを AV ベンダーから独立させる）を、Rails 無しで最も素直に継承できる。
2. ②永続化・履歴・CSV、③ロール別認可、④添付が、新スタックの**標準機能**として手に入る（自前実装が最小）。
3. LiveKit を将来差し替えても、また AV と無関係な拡張（Slack 連携・archive_status 通知など）を足しても、チャット側が影響を受けない。

> `minedia/minedia-www#5317` へのインプット: 独立アプリのチャットは **「LiveKit に乗せず、Postgres ベースの BaaS（Supabase 等）に集約」**を前提にスコープを切る。LiveKit データチャネルは「揮発的なリアルタイム通知」（入力中表示・録画状態の即時通知等）の補助用途に限定し、永続が要るチャット本体は BaaS 側に置く。運用都合でインフラを増やしたくない場合の次点が案A（Route Handler 権威 + `sendData`）。

---

## 5. ブラウザでの手動検証手順（受け入れ条件 #1, #2）

> 自動テストはロジック層（`chat.test.ts`）でカバー済み。2 名以上のブラウザ送受信は以下で手動確認する。

### 前提
- `.env.local` に LiveKit Cloud（または `livekit.yaml` のローカルサーバー）の鍵が設定済みであること。

### 手順
1. このブランチをチェックアウトして開発サーバーを起動:
   ```bash
   pnpm install
   pnpm dev
   ```
2. ブラウザ A で `http://localhost:3000/` を開き、ルーム名（例 `chat-test`）・名前 `mod`・役割 **moderator** で入室。
3. ブラウザ B（別ウィンドウ/シークレット）で同じルーム名・名前 `obs`・役割 **observer** で入室。
4. **public 検証**: A の「全体 (public)」タブで送信 → B の「全体」タブに表示される。逆に B（observer）は public タブの入力欄が disabled（閲覧のみ）であることを確認。
5. **private 検証**: A（moderator）の「関係者 (private)」タブで送信 → B（observer）の「関係者」タブに表示。3 つ目のブラウザ C を **panelist** で入室させ、C には private が**届かない**ことを確認（宛先限定）。
6. **observer_only 検証**（任意）: observer を 2 名にして、片方の「オブザーバー間」タブ送信が他方の observer にのみ届くことを確認。
7. **永続化なしの確認**: メッセージのあるタブでブラウザをリロード → 履歴が消えることを確認（=要追加実装の裏取り）。

### 期待結果（受け入れ条件への対応）
- [ ] AC#1: 2 名以上でテキスト送受信が確認できる（手順 4）
- [ ] AC#2: public 動作 + private 宛先限定の可否判定（手順 4, 5）
- [x] AC#3: 3 階層チャネル + ロール権限の実現可否・制約（本書 §1）
- [x] AC#4: 永続化・履歴・CSV・添付・スタンプ・録画状態通知の扱い（本書 §2）
- [x] AC#5: 独立アプリでのチャット構成（BaaS 分離 vs LiveKit 集約）の比較・推奨（本書 §4）
- [x] AC#6: 最小テスト `chat.test.ts` が `pnpm test` で通る

---

## 6. 参考

- Text streams: https://docs.livekit.io/transport/data/text-streams/ （「No message persistence」「Joining mid-stream」節に履歴非保持・後入室非配信が明記）
- Data packets: https://docs.livekit.io/transport/data/packets/
- Byte streams（添付）: https://docs.livekit.io/transport/data/byte-streams/
- Chat components / useChat: https://docs.livekit.io/frontends/agents-ui/chat/
- 現行解説: minedia-www `.claude/explanation/interview/04-chat-and-realtime.md`
