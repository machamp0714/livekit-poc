This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## PoC 検証メモ

- 接続テスト検証: [`CONNECTION_TEST_VERIFICATION.md`](./CONNECTION_TEST_VERIFICATION.md)
- リロード復帰検証（同一参加者・録画継続 / DEC-04）: [`RELOAD_RECOVERY_VERIFICATION.md`](./RELOAD_RECOVERY_VERIFICATION.md)
- チャット検証（LiveKit Data / Text streams）: [`CHAT_POC_FINDINGS.md`](./CHAT_POC_FINDINGS.md) — 3 階層チャネル・ロール別権限の実現可否、永続化/履歴/CSV/添付/スタンプ/録画状態通知の対応表、ActionCable 継続 vs LiveKit ネイティブの比較と推奨、2 ブラウザ手動検証手順を記載。
- チャット リアルタイム層 アーキテクチャ比較: [`docs/chat-realtime-architecture.md`](./docs/chat-realtime-architecture.md) — 独立 Next.js アプリ（RDS 前提）でのリアルタイム配信層 Supabase / 案D(API GW WebSocket) / 案E(Fargate+Socket.IO) を drawio 図つきで比較。
- チャット アーキテクチャ 意思決定キット: [`docs/chat-architecture-decision-kit.md`](./docs/chat-architecture-decision-kit.md) — チームで決めるためのプレリード・タイムボックス付きアジェンダ・重み付き決定マトリクス・決定ツリー図。
- 案E 実装案（サンプルコード）: [`docs/chat-plan-e-sample.md`](./docs/chat-plan-e-sample.md) — Socket.IO + Redis + RDS の参照実装（認可・永続化・履歴 API・クライアントフック）。

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
