# チャット機能 検証 PoC 所見（LiveKit Data / Text streams）

| 項目 | 内容 |
|---|---|
| 対象 Issue | `machamp0714/livekit-poc#4` |
| 親 | `minedia/minedia-www#5317`（インタビュー機能の外だし） |
| 検証日 | 2026-06-15 |
| 検証バージョン | `livekit-client@2.19.0` / `@livekit/components-react@2.9.21` / `livekit-server-sdk@2.15.3` |
| ステータス | PoC（意思決定のための検証。本番品質は対象外） |
| 結論（先出し） | **チャットは ActionCable + DB のまま継続を推奨。** LiveKit Text streams は「全体チャットの送受信」は容易に実現できるが、現行実査チャットの中核要件（永続化・履歴・CSV・ロール別チャネル権限のサーバー強制）を満たすには結局 DB と権限検証層の自前実装が必要で、LiveKit ネイティブに寄せる利点が小さい。 |

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

## 4. ActionCable 継続 vs LiveKit ネイティブ 比較

| 観点 | ActionCable + DB（現行継続） | LiveKit ネイティブ（Text/Data streams） |
|---|---|---|
| 全体チャット送受信 | ◎ 実績あり | ◎ 容易 |
| 永続化・履歴・CSV | ◎ DB で標準対応済み | ✕ 自前 DB が必須（LiveKit は非保持） |
| ロール別チャネル権限のサーバー強制 | ◎ `subscribed` 認可で標準 | △ 検証層（API 問い合わせ or Agent 中継）が必要 |
| 後入室・リロード時の履歴 | ◎ API で取得 | ✕ ストリームは過去分を配信しない |
| WebRTC 基盤差し替えの影響 | ◎ 影響を受けない（OpenTok→LiveKit でもチャットは無改修） | △ 移行と密結合になる |
| Slack 連携・配信ジョブ | ◎ 既存ジョブ流用 | △ 別途実装 |
| 実装コスト（移行時） | ◎ ほぼゼロ（現状維持） | ✕ DB + 権限層 + 履歴 API を作り直し |
| メリット | シグナリングを基盤非依存に保てる | シグナリング層を SDK に寄せられる（依存が 1 つ減る） |

### 推奨

**チャットは現行の ActionCable + DB を継続する。**

理由:
1. 現行チャットの中核価値は **永続化・履歴・CSV・ロール別権限のサーバー強制**にある。これらは LiveKit ネイティブでは結局 DB と検証層の自前実装になり、「SDK に寄せる」利点（依存削減）を上回る再実装コストが発生する。
2. チャットは元々 OpenTok signal ではなく ActionCable で実装されており、**WebRTC 基盤（OpenTok→LiveKit）の差し替えと独立**している。基盤移行のスコープからチャットを外せること自体が低リスク化に寄与する。
3. LiveKit Text streams は「揮発的なリアルタイム通知」（例: 入力中表示、録画状態の即時通知、軽量な運営アナウンス）には適する。**全面置換ではなく、補助用途での部分採用**なら検討余地あり。

> `minedia/minedia-www#5317` へのインプット: 「チャットは ActionCable 継続」を前提に基盤移行のスコープを切ると、移行リスクと工数を圧縮できる。LiveKit データチャネルは将来の補助機能（録画状態のクライアント通知等）として残す。

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
- [x] AC#5: ActionCable 継続 / LiveKit ネイティブ比較・推奨（本書 §4）
- [x] AC#6: 最小テスト `chat.test.ts` が `pnpm test` で通る

---

## 6. 参考

- Text streams: https://docs.livekit.io/transport/data/text-streams/ （「No message persistence」「Joining mid-stream」節に履歴非保持・後入室非配信が明記）
- Data packets: https://docs.livekit.io/transport/data/packets/
- Byte streams（添付）: https://docs.livekit.io/transport/data/byte-streams/
- Chat components / useChat: https://docs.livekit.io/frontends/agents-ui/chat/
- 現行解説: minedia-www `.claude/explanation/interview/04-chat-and-realtime.md`
