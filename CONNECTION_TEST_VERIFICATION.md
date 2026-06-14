# 接続テスト系の動作検証（Issue #2）

> webrtc-internals 同等の取得 & minedia-www（OpenTok）同等メトリクスの再現可否。
> 本書は **コード側の実装内容** と、**ライブ環境での実測手順** をまとめる。
> 実測サンプルの取得（UI の「JSON 出力」）と UDP 遮断テストは運用者が実機で行う。

## 1. このPoCで取得できるもの（実装サマリ）

| 取得対象 | 実装 | 由来する RTCStats |
|---|---|---|
| 「どの経路で繋がったか」（selected pair） | `lib/livekit/candidate.ts` `extractSelectedPair` / `classifyPath` | `transport` → `candidate-pair` → `local/remote-candidate` |
| relayProtocol / url（`turns:…:443` 判定） | `classifyPath`（`relay-tls` / `is443`） | `local-candidate.relayProtocol`, `.url`, `.port` |
| 受信メトリクス bitrate / loss / jitter / fps / framesDropped | `lib/livekit/stats.ts` `extractInboundRtp` / `computeStatsDelta` | `inbound-rtp` |
| 送信メトリクス bitrate / loss / RTT / fps / 劣化要因 | `extractOutboundRtp` / `computeOutboundDelta` | `outbound-rtp` + `remote-inbound-rtp` |
| ConnectionQuality（参加者別） | `DiagnosticsPanel`（`Participant.connectionQuality` をポーリング、`RoomEvent.ConnectionQualityChanged` 相当） | LiveKit シグナリング |
| Baseline vs Load 2段計測 / 移動平均 / average & worst / Delta | `lib/livekit/measure.ts` + `DiagnosticsPanel` | 上記を 0.5 秒ポーリングで集約 |

`RTCStatsReport` は `RemoteTrack.getRTCStatsReport()`（subscriber PC）/
`LocalTrack.getRTCStatsReport()`（publisher PC）から取得する。返るのは**その
PeerConnection 全体の標準 `RTCStatsReport`** なので、candidate-pair・transport・
inbound/outbound-rtp までこの1コールで揃う。

UI は `app/room/[roomName]/DiagnosticsPanel.tsx`（ルーム画面の品質パネル）。

## 2. webrtc-internals 相当の「selected pair」の読み方

`chrome://webrtc-internals` の "candidate-pair (state=succeeded, nominated=true)"
と同じ情報を、次の優先順で機械的に特定している（`extractSelectedPair`）。

1. `transport.selectedCandidatePairId` が指す `candidate-pair`
2. 無ければ `nominated && state==='succeeded'` の pair（Firefox は `selected===true`）

そこから `localCandidateId` / `remoteCandidateId` を解決し、ローカル候補の
以下を取り出す。

- `candidateType`: `host` / `srflx` / `prflx` / `relay`
- `relayProtocol`（relay 候補のみ）: `udp` / `tcp` / `tls`
- `url`: 例 `turns:xxx.livekit.cloud:443?transport=tcp`
- `port`

`classifyPath` の判定:

| candidateType | relayProtocol | 分類 | 意味 |
|---|---|---|---|
| host | – | `host` | 同一 LAN 直結 |
| srflx/prflx | – | `srflx` | STUN 反射（P2P / UDP 直） |
| relay | udp | `relay-udp` | TURN/UDP 退避 |
| relay | tcp | `relay-tcp` | TURN/TCP 退避 |
| relay | tls | `relay-tls` | **TURN/TLS（443）退避** — 制限網の最終手段 |

`is443` は `url` または `port` が 443 のとき真。制限ネットワーク下で
`relay-tls` かつ `is443` になっていれば「`turns:…:443` へ退避して繋がった」ことを
アプリ内で確定できる（= Issue の受け入れ条件1）。

## 3. minedia-www（OpenTok）接続テスト指標 → LiveKit 対応表

| minedia-www（OpenTok）指標 | LiveKit（getRTCStatsReport）での出どころ | 本PoCでの算出 |
|---|---|---|
| video bitrate | `inbound-rtp.bytesReceived` 差分 ×8 / dt | `computeStatsDelta.bitrateKbps` |
| audio bitrate | 同上（kind=audio） | 同上 |
| packet loss ratio | `inbound-rtp.packetsLost` / (lost+received) 差分 | `computeStatsDelta.packetLossRate` |
| jitter | `inbound-rtp.jitter`（秒）→ ms | `computeStatsDelta.jitterMs` |
| frames dropped | `inbound-rtp.framesDropped` 差分 | `computeStatsDelta.framesDropped` |
| FPS（video） | `inbound-rtp.framesPerSecond`（無ければ `framesDecoded` 差分/秒） | `computeStatsDelta.fps` |
| 送信側 loss / RTT | `remote-inbound-rtp.fractionLost` / `roundTripTime` | `computeOutboundDelta` |
| 送信側 劣化要因 | `outbound-rtp.qualityLimitationReason`（cpu/bandwidth） | `computeOutboundDelta.qualityLimitationReason` |

**結論（コード側）**: minedia-www の接続テスト指標は LiveKit の標準
`getRTCStatsReport` で**同等に再現可能**。OpenTok 固有の集計（average / worst、
移動平均、一定秒集計）も `lib/livekit/measure.ts` で再現している。実測サンプルは
UI の「JSON 出力」で採取する（§5）。

## 4. ギャップ：webrtc-internals で取れて getRTCStatsReport で取れないもの

`getRTCStatsReport` は **stats** は完全に取れるが、LiveKit SDK は生
`RTCPeerConnection` を公開 API として露出しないため、**PC のイベント**は取れない。

| 項目 | webrtc-internals | getRTCStatsReport | 備考 |
|---|---|---|---|
| `icecandidateerror`（STUN/TURN 割当失敗・701 等のエラーコード/URL） | ✅ イベントログに表示 | ❌ stats に出ない | **最大のギャップ**。TURN 認証失敗・到達不可の一次情報が取れない |
| ICE candidate ごとの gathering タイムライン | ✅ | △ candidate は stats に残るが時系列イベントは無し | |
| `iceconnectionstatechange` / `connectionstatechange`（PC 単位） | ✅ | ❌（PC 非公開） | LiveKit は `RoomEvent.ConnectionStateChanged` で room 単位のみ提供 |
| SDP offer/answer 本文 | ✅ | ❌ | |
| DTLS/SRTP ハンドシェイクエラー | ✅ | ❌ | `transport.dtlsState` の現在値のみ stats で参照可 |
| 時系列グラフ | ✅（内蔵） | ❌ | 本PoCは 0.5 秒ポーリングで自前再現 |

> `icecandidateerror` をどうしても取りたい場合、公開 API では不可。
> `RTCPeerConnection.prototype.addEventListener` を**グローバルにモンキーパッチ**して
> `icecandidateerror` を拾う回避策はあるが、SDK の内部実装に依存し非推奨。
> 制限網の到達性そのものは別途実機検証済み（Issue 記載）なので、本PoCでは
> 「エラーの一次情報は取れない」というギャップの**明文化**を結論とする。

## 5. Baseline vs Load 計測の実行手順（UI）

1. ルーム入室（`/room/[roomName]`）。診断パネルが表示される。
2. 自分1ストリームの状態で **「① Baseline 開始」→ 一定秒後「停止」**。
3. ダミー参加者を流し込む（§6）。受信ストリームが増える。
4. **「② Load 開始」→ 同じ秒数で「停止」**。
5. **「Delta 算出」** で Load − Baseline を表示。
6. **「JSON 出力」** で subscriberPath / publisherPath / quality / baseline /
   load / comparison を JSON 化（クリップボードへコピー、`console.info` にも出力）。
   → これが「取得サンプル」。Issue に貼る。

集約仕様: 0.5 秒ポーリング、各 tick で受信中の全リモート映像トラックを
「合計ビットレート・平均 loss・最悪 jitter・最低 fps・合計 drop」に畳み、区間で
average / worst を出す（`measure.ts`）。移動平均は `movingAverage` を用意。

## 6. ダミー参加者の流し込み（Load 生成）

LiveKit CLI（`lk`）を使うのが最も手軽。

```bash
# 複数のシミュレート映像パブリッシャを部屋に投入（subscriber=ブラウザ側が複数受信）
lk load-test \
  --url "$LIVEKIT_URL" --api-key "$LIVEKIT_API_KEY" --api-secret "$LIVEKIT_API_SECRET" \
  --room "<roomName>" --video-publishers 3 --duration 2m

# あるいはデモ映像を1体ずつ参加させる
lk room join --url "$LIVEKIT_URL" --api-key ... --api-secret ... \
  --room "<roomName>" --identity bot1 --publish-demo
```

`--video-publishers N` の N を増やして「複数ストリーム同時受信」を作る。
ブラウザ側 Baseline は自分1ストリーム、Load は bot 追加後に計測する。

## 7. 制限ネットワーク（UDP 遮断 / 443-only）での確認手順

**ネットワーク層で UDP を落として ICE を TURN/TLS:443 に追い込むのが本筋。**

macOS（pf）の例 — 送信 UDP をブロック（DNS/53 は残す）:

```
# /etc/pf.anchors/udpblock
block drop out proto udp from any to any port != 53
```

```bash
sudo pfctl -a udpblock -f /etc/pf.anchors/udpblock
sudo pfctl -e            # 反映
# 検証後
sudo pfctl -a udpblock -F all && sudo pfctl -d
```

この状態でルームに入り直し、診断パネルの **受信経路 / 送信経路** が
`relay-tls` かつ `[443]` バッジになることを確認 → JSON 出力で採取。
（補助的に、アプリ側で `Room` の `rtcConfig.iceTransportPolicy='relay'` を
強制すると relay 限定までは確認できるが、443-only の本検証は網側遮断で行う。）

precall 画面（`/precall`）では UDP 遮断時に SDK の `checkConnectionProtocol` が
失敗するが、TURN/TLS:443 経由で通話自体は可能、という挙動を表示済み。

## 8. 受け入れ条件への対応状況

- [x] selected pair（relayProtocol / url 含む）をアプリ内で取得・表示 — `candidate.ts` + パネル
- [x] 取れない項目（`icecandidateerror` 等）を列挙 — §4
- [x] minedia-www 指標を LiveKit で再現するコード — `stats.ts` / `measure.ts`、対応表 §3
- [ ] **実測サンプル付きの結論** — UI から運用者が採取（§5）
- [ ] **UDP 遮断 / 443-only 条件での実測** — §7 の手順で運用者が確認

> コード・計測UI・ドキュメントは完了。残るチェックボックスはライブ環境での
> 実測（サンプル採取 / UDP 遮断テスト）で、実機・ネットワーク操作が必要なため
> 運用者が実施する。
