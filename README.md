# uniqlo-gu-tracker

UNIQLO / GU の商品ページを毎日自動チェックし、価格が変わったら Supabase の
`price_events` テーブルに記録、GitHub Pages 上の静的サイトでグラフ表示する
価格トラッカーです。

## 構成

```
config/products.json          追跡する商品の一覧(編集して使う)
supabase/migrations/          price_events テーブルの作成SQL
scripts/scrape.mjs            商品ページから価格を取得し Supabase に記録するスクリプト
.github/workflows/scrape.yml  毎日実行するスクレイパー(GitHub Actions)
.github/workflows/pages.yml   docs/ を GitHub Pages にデプロイ
docs/                         公開する静的サイト(Supabase から直接データ取得)
```

- 価格取得は商品ページ内の JSON-LD (`Product`/`Offers`) → OGP price meta タグ
  → Next.js の埋め込みデータ、の順で価格らしき値を探すベストエフォート実装です。
  サイト構造の変更で取れなくなることがあります。
- フロントエンドは `docs/config.js` に埋め込んだ **publishable key** で
  `price_events` を読み取り専用アクセスします。このキーは公開しても問題ない
  設計です(RLS で SELECT のみ許可、INSERT/UPDATE/DELETE は不可)。
- 価格の書き込みは GitHub Actions 上のスクレイパーが **service_role key**
  (RLSをバイパスする秘匿キー)を使って行います。このキーはリポジトリに
  コミットせず、GitHub Secrets にのみ保存します。

## セットアップ(このリポジトリのコードだけでは完結しない、手動で必要な3ステップ)

Supabase のテーブル作成・GitHub Pages の有効化には、このセッションが
持たない認証情報や管理者権限が必要なため、以下は手動で行ってください。

### 1. Supabase に `price_events` テーブルを作成する

Supabase ダッシュボード → 該当プロジェクト → **SQL Editor** で、
[`supabase/migrations/0001_create_price_events.sql`](./supabase/migrations/0001_create_price_events.sql)
の内容をそのまま貼り付けて実行してください。

### 2. スクレイパー用の Secrets を GitHub リポジトリに追加する

Settings → Secrets and variables → Actions → New repository secret で以下を追加:

| Name | Value |
| --- | --- |
| `SUPABASE_URL` | `https://noiipcsglzhsdjrgjpet.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase ダッシュボード → Settings → API → `service_role` key |

(`SUPABASE_SERVICE_ROLE_KEY` は Publishable key とは別物です。RLS を
バイパスして書き込みできる秘匿キーなので、Secrets 以外の場所に貼らないで
ください。)

### 3. GitHub Pages を有効化する

Settings → Pages → Build and deployment → Source を **GitHub Actions** に設定してください。
(このセッションからは Pages 設定を変更する権限がないため、初回のみ手動が必要です。)

一度有効化すれば、`main` への push、または Actions タブから
`Deploy GitHub Pages` ワークフローを手動実行 (workflow_dispatch) するたびに
`https://<owner>.github.io/uniqlo-gu-tracker/` へ自動デプロイされます。

## 商品の追加方法

`config/products.json` に商品を追加してください(書式は
[`config/products.example.json`](./config/products.example.json) を参照)。

```json
{
  "id": "uniqlo-000000-00",
  "brand": "uniqlo",
  "name": "商品名(表示用・任意)",
  "url": "https://www.uniqlo.com/jp/ja/products/E000000-000/00"
}
```

- `id`: `price_events.product_id` に使う一意な文字列(自由に決めてOK)
- `brand`: `"uniqlo"` または `"gu"`
- `url`: 価格を取得する商品ページのURL

追加後、`.github/workflows/scrape.yml` の定期実行(毎日 06:00 JST)を待つか、
Actions タブから `Scrape prices` を手動実行 (workflow_dispatch) すると
反映されます。
