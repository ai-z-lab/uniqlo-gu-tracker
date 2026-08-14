# uniqlo-gu-tracker

UNIQLO / GU の「セール一覧」「期間限定価格一覧」などのカテゴリ・一覧ページを
毎日自動巡回し、掲載されている商品を自動的に発見して価格をチェック、変わって
いたら Supabase の `price_events` テーブルに記録、GitHub Pages 上の静的サイト
でグラフ表示する価格トラッカーです。個々の商品URLを事前登録する必要はなく、
一覧ページに載っている商品を都度拾い直すので、値下げ・新作・期間限定の対象
商品を網羅的に追跡できます。

## 構成

```
config/sources.json           巡回するカテゴリ・一覧ページの一覧(編集して使う)
supabase/migrations/          price_events テーブルの作成SQL
scripts/scrape.mjs            一覧ページから商品を発見し、価格を取得して Supabase に記録するスクリプト
.github/workflows/scrape.yml  毎日実行するスクレイパー(GitHub Actions)
.github/workflows/pages.yml   docs/ を GitHub Pages にデプロイ
docs/                         公開する静的サイト(Supabase から直接データ取得)
```

- 商品の発見は一覧ページ内の `href="...  /products/ ..."` 形式のリンクを
  スキャンして行います(一覧ページ自体はサーバーサイドでリンクが描画されて
  いるため、素の HTML 取得で十分)。
- 一方、価格・在庫は UNIQLO/GU いずれもページ読み込み後に API 経由で取得する
  クライアントサイドレンダリングのため、素の HTML には含まれません。そのため
  価格取得は Playwright (Chromium ヘッドレスブラウザ) で商品ページを実際に
  レンダリングしてから、(1) レンダリング後の DOM 内の JSON-LD/OGP meta/
  埋め込みデータ、(2) 見つからなければページが投げた JSON API レスポンスの
  うち URL に商品コードを含むもの、の順で価格らしき値を探すベストエフォート
  実装です。サイト構造の変更で取れなくなることがあります。
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

## 巡回する一覧ページの追加方法

`config/sources.json` にカテゴリ・一覧ページを追加してください(書式は
[`config/sources.example.json`](./config/sources.example.json) を参照)。

```json
{
  "id": "uniqlo-sale",
  "brand": "uniqlo",
  "label": "UNIQLO セール一覧(表示用・任意)",
  "urls": [
    "https://www.uniqlo.com/jp/ja/feature/sale",
    "https://www.uniqlo.com/jp/ja/feature/sale?page=2"
  ],
  "maxProducts": 200
}
```

- `id`: `price_events.product_id` の接頭辞にも使う一意な文字列(自由に決めてOK)
- `brand`: `"uniqlo"` または `"gu"`
- `urls`: 巡回する一覧ページのURL配列。ページネーションがある場合は、2ページ目
  以降のURLも配列に追加してください(自動ページ送りは行いません)
- `maxProducts`: 1つの `source` あたり最大何商品まで追跡するかの上限(省略時 200)。
  一覧ページの規模が大きいと1回のスクレイパー実行に時間がかかるための安全弁です

商品ページのURLは各一覧ページ内の `href="…/products/…"` リンクから自動的に
収集されるため、個別に登録する必要はありません。`product_id` は URL 中の
商品コードから自動生成されます(例: `uniqlo-E459958-000`)。

`urls` に設定するUNIQLO/GUの実際の「セール一覧」「期間限定価格一覧」ページ
のURLは、ブラウザで実際に開いて確認・コピーしてください(サイト構造は
予告なく変わることがあります)。

追加後、`.github/workflows/scrape.yml` の定期実行(毎日 06:00 JST)を待つか、
Actions タブから `Scrape prices` を手動実行 (workflow_dispatch) すると
反映されます。
