# uniqlo-gu-tracker

UNIQLO / GU の「セール一覧」「期間限定価格一覧」などのカテゴリ・一覧ページを
毎日自動巡回し、掲載されている商品を自動的に発見して価格をチェック、変わって
いたら Supabase の `price_events` テーブルに記録、GitHub Pages 上の静的サイト
でグラフ表示する価格トラッカーです。個々の商品URLを事前登録する必要はなく、
一覧ページに載っている商品を都度拾い直すので、値下げ・期間限定価格の対象
商品を網羅的に追跡できます。

公開URL: https://ai-z-lab.github.io/uniqlo-gu-tracker/

## 構成

```
config/sources.json           巡回するカテゴリ・一覧ページの一覧(編集して使う)
supabase/migrations/          price_events テーブルの作成・更新SQL
scripts/scrape.mjs            一覧ページから商品を発見し、価格・カテゴリ等を Supabase に記録するスクリプト
.github/workflows/scrape.yml  毎日実行するスクレイパー(GitHub Actions)
.github/workflows/pages.yml   docs/ を GitHub Pages にデプロイ
docs/                         公開する静的サイト(ブランド/性別/セクション/カテゴリ別ダッシュボード、Supabase から直接データ取得)
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
  - 色・サイズ違いのバリエーションを1つのページ(schema.org の
    ProductGroup/hasVariant)にまとめて掲載している商品は、URL(色・サイズ
    のクエリパラメータ等)と一致する `hasVariant` エントリをまず探し、
    見つかった場合はその価格・商品名を使います(`findMatchingVariant()`)。
    一致するエントリが見つからない場合のみ、配列の先頭から価格が取れる
    最初のバリエーションにフォールバックします(この場合、実際に見ている
    色・サイズと異なる価格になっている可能性があります)。
  - 商品名は、価格を実際に取得したのと同じ JSON-LD の候補(ProductGroup/
    Variant)から取得します。ページ内に複数の Product/ProductGroup の
    JSON-LD が存在する場合(関連商品ウィジェット等)、価格と商品名を別々に
    探すと異なる候補から取得してしまい、無関係な商品名と価格の組み合わせに
    なる可能性があったため、同じ候補から一緒に取得するようにしています。
- フロントエンドは `docs/config.js` に埋め込んだ **publishable key** で
  `price_events` を読み取り専用アクセスします。このキーは公開しても問題ない
  設計です(RLS で SELECT のみ許可、INSERT/UPDATE/DELETE は不可)。
- 価格の書き込みは GitHub Actions 上のスクレイパーが **service_role key**
  (RLSをバイパスする秘匿キー)を使って行います。このキーはリポジトリに
  コミットせず、GitHub Secrets にのみ保存します。
- ダッシュボードは UNIQLO/GU タブ → MEN/WOMEN タブ → 初値下げ/値下げ/
  初期間限定/期間限定/値上げのセクション → カテゴリ(値下げセクションのみ
  値下げ段階)、の階層で商品を表示します。この分類には `price_events` の
  `gender` / `event_type` / `category` 列を使います(詳細は下記「分類ロジック
  について」を参照)。商品カードはカード全体がリンクになっており、
  クリック/タップすると `url` 列の商品ページを新しいタブで開きます。
- 値下げ(`markdown`)の商品カードには、その商品が値下げ一覧経由で記録されて
  以来「何段階目の値下げ」かをバッジに表示し(例:「値下げ(3段階目)」)、
  カード内にはこれまでの値下げ推移を「¥1,990(7/8)→¥1,290(7/13)→…」の
  ような矢印付きテキストで表示します(通常の価格推移グラフの代わり)。
  「値下げ」セクション自体もこの段階ごとにグルーピングされます(「1段階目」
  「2段階目」…)。同じ価格のまま記録が続いている日は1段階として数え、
  実際に価格が変わった回数だけをカウントします(`docs/app.js` の
  `markdownStagePoints()`)。
- 期間限定(`limited`)の商品カードには「期間限定価格を確認: 7/8〜」のように、
  その商品が最初に期間限定価格として記録された日を表示します
  (`firstLimitedSeenDate()`)。値下げと違い、期間限定は継続中の1つのオファー
  として扱っているため段階分けはしていません。
- 「値下げ」「期間限定」の各セクション上部には、直近でその状態になったのが
  確認された日付を簡易的なチップ一覧として表示します(例:「7/13(5) 7/8(2)」
  のように、日付ごとの件数を新しい順・最大14日分)。値下げは各商品の直近の
  値下げ段階の日付、期間限定は各商品が最初に期間限定価格になった日付を
  集計しています(`groupProductsByDate()`)。クリックでの絞り込みなどは行わ
  ない、あくまで一覧表示のみの機能です。
- 期間限定価格の商品には、可能な場合「◯月◯日まで」を表示します。取得元は
  商品ページの schema.org JSON-LD にある `Offer.priceValidUntil`(price_events
  の `limited_price_end_date` 列)で、見つからない場合はページ内の
  「◯月◯日まで」というテキストからの推測にフォールバックします。
- 手動での追加・修正用に、公開ダッシュボードからはリンクされていない
  隠し管理UI (`docs/manage-7q2k9x4d/`) があります。URLの秘匿性そのものは
  セキュリティ境界にしておらず、実際に書き込めるのは Supabase Auth で
  ログインしたユーザーだけです(RLSは
  [`0005_add_authenticated_write_policies.sql`](./supabase/migrations/0005_add_authenticated_write_policies.sql)
  参照)。詳細は下記セットアップ手順の4番目を参照してください。

## セットアップ(このリポジトリのコードだけでは完結しない、手動で必要な3ステップ)

Supabase のテーブル作成・GitHub Pages の有効化には、このセッションが
持たない認証情報や管理者権限が必要なため、以下は手動で行ってください。

### 1. Supabase に `price_events` テーブルを作成する

Supabase ダッシュボード → 該当プロジェクト → **SQL Editor** で、以下を
この順番で貼り付けて実行してください(新規セットアップでも、既に
`0001` を実行済みの場合でも、`0002` は `add column if not exists` なので
そのまま追加実行してOKです)。

1. [`supabase/migrations/0001_create_price_events.sql`](./supabase/migrations/0001_create_price_events.sql)
2. [`supabase/migrations/0002_add_category_gender_event_type.sql`](./supabase/migrations/0002_add_category_gender_event_type.sql)
   — `category` / `gender` / `event_type` 列を追加(ダッシュボードの
   タブ・セクション分けに必要)
3. [`supabase/migrations/0003_add_limited_price_end_date.sql`](./supabase/migrations/0003_add_limited_price_end_date.sql)
   — 期間限定価格の終了日を保存する `limited_price_end_date` 列を追加
4. [`supabase/migrations/0004_replace_new_with_first_seen_labels.sql`](./supabase/migrations/0004_replace_new_with_first_seen_labels.sql)
   — `event_type` の `'new'`(新作)を `'first_markdown'`(初値下げ)/
   `'first_limited'`(初期間限定)に置き換え
5. [`supabase/migrations/0005_add_authenticated_write_policies.sql`](./supabase/migrations/0005_add_authenticated_write_policies.sql)
   — 隠し管理UI (`docs/manage-7q2k9x4d/`) からの手動追加・削除を許可する
   RLS ポリシーを追加(ログイン済みユーザーのみ)

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

### 4. 隠し管理UIでログインできるようにする(任意)

手動で価格イベントを追加・削除したい場合のみ必要です。スクレイパーだけで
運用する場合はこの手順は不要です。

1. 上記のマイグレーション `0005` を実行する。
2. Supabase ダッシュボード → Authentication → Users → **Add user** で
   管理者用のメールアドレス・パスワードを作成する(Auto Confirm User を
   有効にしてすぐログインできるようにする)。
3. `https://<owner>.github.io/uniqlo-gu-tracker/manage-7q2k9x4d/` にアクセスし、
   作成したユーザーでログインする。このURLはダッシュボードのどこからも
   リンクされていない。

## 巡回する一覧ページの追加方法

`config/sources.json` にカテゴリ・一覧ページを追加してください(書式は
[`config/sources.example.json`](./config/sources.example.json) を参照)。

```json
{
  "id": "uniqlo-sale-women",
  "brand": "uniqlo",
  "gender": "women",
  "listingType": "sale",
  "label": "UNIQLO 値下げ商品(レディース)(表示用・任意)",
  "urls": [
    "https://www.uniqlo.com/jp/ja/feature/sale/women",
    "https://www.uniqlo.com/jp/ja/feature/sale/women?page=2"
  ],
  "maxProducts": 200
}
```

- `id`: `price_events.product_id` の接頭辞にも使う一意な文字列(自由に決めてOK)
- `brand`: `"uniqlo"` または `"gu"`
- `gender`: `"men"` または `"women"`。ダッシュボードの MEN/WOMEN タブに使われます
- `listingType`: `"sale"`(値下げ)または `"limited"`(期間限定価格)。ダッシュ
  ボードの「値下げ」「期間限定」セクション振り分けの基準になります(下記
  「分類ロジックについて」を参照)
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

## 分類ロジックについて

ダッシュボードは `price_events` の各商品について**最新1件のレコード**の
`event_type` / `category` / `gender` を見て、どのセクション・カテゴリに
表示するかを決めます。そのため、価格が変わっていなくても**毎回のスクレイ
プでその商品の行を記録**します(以前は価格が変わった時だけ記録していまし
たが、そうすると「値下げ中のまま価格が動かない商品」がダッシュボードから
消えてしまうため変更しました)。

`event_type` は `scripts/scrape.mjs` の `classifyEventType()` が以下の優先
順位で決めます:

1. その商品を過去に一度も記録したことがない → 発見元の `source.listingType`
   に応じて `first_markdown`(初値下げ)または `first_limited`(初期間限定)
2. 前回記録した価格より値上がりしている → `price_up`(値上げ)
3. それ以外 → 発見元の `source.listingType` に応じて `markdown`(値下げ)
   または `limited`(期間限定)

このトラッカーが巡回しているのは UNIQLO/GU の「値下げ一覧」「期間限定価格
一覧」だけで、公式の新作一覧ページは巡回対象に含まれていません。そのため
`first_markdown`/`first_limited` は「このトラッカーがその商品を初めて検出
した」という意味であり、「本当にその日発売された新商品」であることを保証
するものではありません。この理由から独立した「新作」セクションは設けず、
値下げ/期間限定それぞれの「初めて検出した」バリエーションとして扱ってい
ます。

一覧ページは同じ商品を色・サイズ違いで複数回リンクしていることが多いため
(`?colorDisplayCode=...` などクエリパラメータ違いの同一商品)、
`product_id`(商品コードのみで決まる)は同じでもURLとしては別物として発見
されます。さらに、同じ商品が「値下げ一覧」と「期間限定価格一覧」の両方に
同時に載っていることもあり、この場合はそれぞれの一覧が示す価格が実際に異
なることがあります(例: 値下げ一覧では¥1,290、期間限定一覧では¥1,990)。

これらの重複を素通しして両方記録してしまうと、同じ商品の価格が実行ごとの
発見順序次第で行ったり来たりして見え、見かけ上の「値上げ」として誤判定さ
れてしまいます。そのためスクレイパーは実行全体を通して `product_id` ごと
に**その実行内で見つかった最安値**を記憶しておき(`scripts/scrape.mjs` の
`productRunState`)、同じ商品を後から別のURL/ソースで発見しても、価格がそ
れ以上(同額含む)であれば記録をスキップします。より安い価格が見つかった
場合は、その実行内で直前に記録した行を上書きします。「過去に記録したこと
があるか」(`isNewProduct`)や前回価格の判定は、この実行が始まる前の
Supabase 上の状態を最初に発見した時点で確定させ、それを使い回します(実
行中に自分自身が書き込んだ行を「既存の記録」と誤認しないようにするため)。

`category` は商品名からのキーワード一致による推定です
(`scripts/scrape.mjs` の `CATEGORY_KEYWORDS`)。UNIQLO/GU の正式なカテゴリ
データを取得しているわけではないため、精度は完璧ではありません。一致しな
かった商品は UNIQLO なら「その他」、GU なら「グッズ・その他」に入ります。
分類がずれる場合は `CATEGORY_KEYWORDS` のキーワードを編集して調整してくだ
さい。

なお、`0002` のマイグレーション適用前に記録された古い行には
`category`/`gender`/`event_type` が入っていません。次回以降のスクレイプで
上書きされる(同じ product_id で新しい行が追加される)まで、そうした古い
商品はダッシュボードのどのタブにも表示されません。

### 同日の重複行について

同じ商品・同じ日に何度スクレイパーを実行しても(手動での動作確認など)、
`price_events` には1商品につき1日1行しか残りません。同じ日(UTC基準)に
既存の行があれば新規追加(INSERT)ではなく上書き(UPDATE)します。動作確
認のために何度手動実行しても、価格推移グラフに不自然な点が増えることはあ
りません。
