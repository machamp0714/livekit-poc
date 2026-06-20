# LiveKit Webhook イベントペイロード 実地確認 (Issue #8)

self-host LiveKit スタック + Next.js dev (port 3001) + Playwright で実際にブラウザ操作し、
`app/api/webhooks/livekit` が受信した **デコード後の生ペイロード** を採取した記録。
全イベントで `WebhookReceiver`（署名 JWT / sha256）の検証を通過した（auth 失敗ゼロ）。

- 採取コード: `app/api/webhooks/livekit/route.ts`（`capturePayload()` が全イベントを `webhook-captures/` へ保存。生キャプチャは gitignore）
- 代表サンプル: [`samples/`](./webhook-payloads/samples/)
- 採取日時: 2026-06-19

## 採取方法

| 操作 | 発火イベント |
|---|---|
| ロビー → 接続テスト（`ConnectionCheck`：一時ルーム `precall-xxxxxx` へ接続/Publish 検証） | `room_started` / `participant_joined` / `participant_left` / `participant_connection_aborted` / `track_published` / `track_unpublished` / `room_finished` |
| `/room/interview-poc`（panelist で audio/video publish）+ `POST /api/egress/start` → Leave | `egress_started` / `egress_updated` / `egress_ended` |

> 接続テストのダミー映像は `ConnectionCheck` が生成するため、実カメラ無しのヘッドレスでも `track_published`(VIDEO/VP8/simulcast) が発火する。Publish Audio はデバイス無しで失敗するが他イベントには影響しない。

## 採取できたイベント種別

| event | 件数 | 採取元 |
|---|---|---|
| `room_started` | 2 | 接続テスト / room |
| `room_finished` | 2 | empty timeout 経過 |
| `participant_joined` | 9 | 接続/再接続の各ステップ |
| `participant_left` | 9 | 同上 |
| `participant_connection_aborted` | 2 | signal close 検証 |
| `track_published` | 5 | Publish Video 検証 / room publish |
| `track_unpublished` | 5 | 同上 |
| `egress_started` | 1 | RoomComposite egress |
| `egress_updated` | 2 | 録画中（ACTIVE / ENDING） |
| `egress_ended` | 1 | 退室で source closed |

> `ingress_*` は本 POC に Ingress 機能が無いため対象外（未採取）。

## 共通事項（ドキュメントとの差分含む）

- 全イベント共通: `event` / `id`（`EV_...`）/ `createdAt`（UNIX 秒・**文字列**）+ `numDropped`。
- protobuf-es デコード結果は **camelCase**（`emptyTimeout` / `creationTimeMs` / `joinedAtMs` 等）。LiveKit ドキュメントの snake_case 表記とはキー名が異なる。
- bigint 値（timestamp / size / duration）は **文字列**で届く（ns 単位の `duration` 等）。
- 秒とミリ秒の両方が並存（`creationTime` 秒 / `creationTimeMs` ミリ秒、`joinedAt` / `joinedAtMs`）。

## イベント別の要点（実値つき）

### `room_started` / `room_finished`
`room` オブジェクトに `sid`(`RM_...`) / `name` / `emptyTimeout`(=300) / `departureTimeout`(=20) / `enabledCodecs[]` / `creationTimeMs` 等。`room_finished` は同形で `event` のみ差。
→ セッション開始/終了の記録に使える（OpenTok `sessionCreated`/`sessionDestroyed` 相当）。

### `participant_joined` / `participant_left`
`participant` に **フル情報**:
- `identity`(`precall-PanelistA-...`) / `sid`(`PA_...`) / `name` / `state`(`ACTIVE`)
- **`metadata: "{\"role\":\"panelist\"}"`** ← ロールが取得できる
- `permission{ canPublish, canSubscribe, recorder, ... }` / `kind`(`STANDARD`) / `attributes{}` / `disconnectReason`

### `participant_connection_aborted`
`participant.state: "DISCONNECTED"` かつ **`participant.disconnectReason: "SIGNAL_CLOSE"`**。
→ **重要**: LiveKit も切断理由を `disconnectReason` で持つ（`UNKNOWN_REASON` / `SIGNAL_CLOSE` 等）。「LiveKit は reason を持たない」は誤りで、participant オブジェクトに含まれる。

### `track_published` / `track_unpublished`（最重要の確認）
- `track` は詳細: `sid`(`TR_...`) / `type`(`VIDEO`) / `source`(`CAMERA`) / `width`/`height` / `simulcast` / `layers[]`(q/h/f) / `mimeType`(`video/VP8`) / `codecs[]`。
- **`participant` は最小限**: `identity` と `sid` は入るが **`name` と `metadata` は空文字**、`state: "JOINING"`、他フィールドは 0/既定値。`room` も `sid`+`name` 以外は 0/空。
- → **Issue #8 の確認事項の結論**: `track_published.participant.metadata` からロールは取れない（空）。**出席記録などでロール判定が要る場合は `identity` で `participant_joined` と突き合わせる**設計にする。

### `egress_started` / `egress_updated` / `egress_ended`
- `egressInfo.status` は `EGRESS_STARTING` → `EGRESS_ACTIVE` → `EGRESS_ENDING` → `EGRESS_COMPLETE` と遷移（`egress_updated` で ACTIVE/ENDING を通知）。
- `egress_ended` の `egressInfo.fileResults[0]`:
  - `location`: `http://localhost:9000/livekit-poc-recordings/.../<ts>.mp4`（完成ファイルの URL）
  - `size`: `"6089393"`（バイト）/ `duration`: `"34520500169"`（**ns** = 34.5s）/ `startedAt`/`endedAt`（ns）
  - → **自動文字起こしの起点に直結**。OpenTok 実装が ffmpeg で算出していた duration は **`duration` で提供される**ため計測工程を省ける。
- その他: `sourceType: "EGRESS_SOURCE_TYPE_WEB"` / `details: "End reason: Source closed"` / `manifestLocation` / `backupStorageUsed: false` / `errorCode: 0`。
- **セキュリティ**: 受信ペイロードの `egressInfo.roomComposite.fileOutputs[].s3` 内 **`accessKey`/`secret` は `{access_key}`/`{secret}` にマスク**されて届く（実値は echo されない）。

## OpenTok → LiveKit 検証メモ（[実査機能ユースケース] 第5章との対応）

| OpenTok 業務 | LiveKit 実地確認の結論 |
|---|---|
| 出席記録（streamCreated → 初回入室） | `track_published`（or `participant_joined`）で再現可。ただし role は `track_published` から取れないため identity 突合が必要 |
| 録画状態 DB 永続化（archive 全 status） | `egress_started/updated/ended` の `egressInfo.status` で再現可。`paused` は LiveKit に無し |
| 自動文字起こしキック（uploaded） | `egress_ended.fileResults[].location/size/duration` で再現可。**duration 提供で ffmpeg 不要化** |
| 録画状態のチャット通知（started/paused/stopped） | started/stopped は可。**paused は対応イベント無し** |
| 送信元検証なし（OpenTok の弱点） | LiveKit は **署名 JWT 検証が全イベントで通過**（改善） |

詳細な対応・差分は Obsidian `02_Knowledge/LiveKit/LiveKit Webhook` ノート参照。
