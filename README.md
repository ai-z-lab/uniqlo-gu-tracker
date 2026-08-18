# uniqlo-gu-tracker

UNIQLO / GU の「セール一覧」「期間限定価格一覧」などのカテゴリ・一覧ページを
毎日自動巡回し、掲載されている商品を自動的に発見して価格をチェック、変わって
いたら Supabase の `price_events` テーブルに記録、GitHub Pages 上の静的サイト
でグラフ表示する価格トラッカーです。個々の商品URLを事前登録する必要はなく、
一覧ページに載っている商品を都度拾い直すので、値下げ・期間限定価格の対象
商品を網羅的に追跡できます。

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
  埋め込みデータ、(2) ページ自身が呼んでいる価格API(下記)、(3) どちらでも
  取れなければ、URL に商品コードを含む JSON レスポンスから価格らしき値を
  総当たりで探す、というベストエフォート実装です。サイト構造の変更で取れなく
  なることがあります。
  - **アプリ会員特別価格・期間限定価格は JSON-LD には入っていません。**
    UNIQLO/GU 両方が、商品ページ読み込み後に
    `/api/commerce/v5/ja/products/<商品コード>/price-groups/00/l2s?withPrices=true&withMemberPricing=true`
    を呼んでおり、そのレスポンスだけが会員価格を持っています:

    ```
    result.l2s:    [{ l2Id, color: { displayCode }, size: { displayCode }, … }]
    result.prices: { <l2Id>: { guest:  { base: { value }, promo: { … } },
                               member: { base: { value }, promo: { … } } } }
    ```

    JSON-LD 側は常に `guest`(通常価格)しか持たないため、以前は
    「期間限定価格一覧から発見した商品なのに通常価格が記録される」状態でした
    (例: GU サテンキャミソール E361445-000 は画面表示が「¥1,490 / アプリ会員
    特別価格 ¥990」なのに ¥1,490 を記録)。現在はこの API を構造を理解した上で
    読み、JSON-LD の価格より安ければそちらを採用します
    (`extractPriceFromPriceApiBody()`)。会員価格が設定されていない商品には
    `member` ブロック自体が無いため、通常商品の挙動は変わりません。
  - `result.prices` は**全色・全サイズ分**を含み、色によって価格が違うことが
    普通にあるため、そのまま最安値を取ると別の色の価格を拾ってしまいます。
    そこで (a) URL の `colorDisplayCode`/`sizeDisplayCode` に一致する l2s
    エントリ、(b) それでも絞り切れない場合は JSON-LD で特定したバリエーション
    と同じ通常価格帯のエントリ、の順に絞り込んでから最安値を採ります。
  - 同じ価格APIのレスポンスから、価格以外に次の3つも記録します。いずれも
    以前から手元には来ていたのに保存せず捨てていた情報で、**過去に遡って
    埋めることはできません**(記録開始が遅れたぶんの履歴は失われます)。
    - `list_price`: 通常価格。選択中の色のSKUのうち最も高い `guest.base` を
      採ります(割引を過大に見せないため)。実売価格より高い場合のみ入ります。
    - `price_type`: 採用した価格の種類。`member`(アプリ会員特別価格を採用)/
      `limited`(終了日のある期間限定価格)/ `markdown`(それ以外)。
      `member` は**価格APIの会員価格が実際に採用された場合のみ**付きます
      (会員価格が通常価格と同額なら、会員割引は存在しないため)。
    - `stock_status` / `in_stock_size_count`: 同じレスポンスに同梱されている
      `result.stocks` から、選択中の色のSKUで在庫があるサイズ数と、1つ以上
      あるかどうか。`statusCode` が読めないSKUは「在庫なし」ではなく
      「不明」として数えません。
  - 価格APIのレスポンスは `domcontentloaded` の**後**に飛ぶため、レンダリング
    後に最大 `PRICE_API_WAIT_MS`(既定4秒)だけこのレスポンスを待ちます
    (到着した時点で待機は終了するので、通常は待ち時間はほとんど増えません)。
    以前の固定1秒待ちでは、会員価格が届く前に DOM を読んで通常価格を記録して
    しまうことがありました。
  - 色・サイズ違いのバリエーションを1つのページ(schema.org の
    ProductGroup/hasVariant)にまとめて掲載している商品は、URL(色・サイズ
    のクエリパラメータ等)と一致する `hasVariant` エントリをまず探し、
    見つかった場合はその価格・商品名を使います(`findMatchingVariant()`)。
    一致するエントリが見つからない場合のみ、配列の先頭から価格が取れる
    最初のバリエーションにフォールバックします(この場合、実際に見ている
    色・サイズと異なる価格になっている可能性があります)。
  - 1つの商品(またはバリエーション)に対して JSON-LD の `offers` が複数
    存在する場合、配列内で先に出てきた方ではなく、その中で最も安い価格を
    採用します(`extractPriceFromOffers()`)。以前は配列の並び順によっては
    通常価格(高い方)を拾ってしまうことがありました。
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
- 通常価格が別途取れている商品には、実売価格の横に元値(取り消し線)と割引率を
  表示します(`list_price` 列)。ただし**値下げされただけの商品では出ません** —
  価格APIは `includePreviousPrice=false` で呼ばれており「値下げ前の価格」は
  取得できないためです。通常価格と実売価格が同時に提示されるのは、GUの
  アプリ会員特別価格のようなケースに限られます(例: ワイドカーゴパンツ UL の
  ¥3,990 → ¥2,990 で 25%OFF)。UNIQLOの期間限定価格は通常価格＝実売価格として
  提示されるため、割引率は表示されません。
- 商品カードには、商品ページ自身のデータから読み取った事実をチップで表示します。
  「アプリ会員価格」(`price_type` が `'member'`)と、在庫の状況
  (`stock_status` / `in_stock_size_count`)です。セクション分けに使う
  `event_type` が「どの一覧ページで発見したか」に由来する推定なのに対し、
  こちらは商品ページのデータそのものなので、別系統の情報として扱っています。
- 期間限定価格の商品には、可能な場合「◯月◯日まで」を表示します。取得元は
  商品ページの schema.org JSON-LD にある `Offer.priceValidUntil`(price_events
  の `limited_price_end_date` 列)で、見つからない場合はページ内の
  「◯月◯日まで」というテキストからの推測にフォールバックします。

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
5. [`supabase/migrations/0005_add_list_price_price_type_stock.sql`](./supabase/migrations/0005_add_list_price_price_type_stock.sql)
   — 通常価格(`list_price`)・価格の種類(`price_type`)・在庫
   (`stock_status` / `in_stock_size_count`)の各列を追加

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

## 価格が合わない時のデバッグ方法

Actions タブから `Scrape prices` を手動実行 (workflow_dispatch) する際に
`debug_url` を指定すると、通常のスクレイプの代わりにそのページだけを描画し、
`debug-output` アーティファクトを残します(商品ごとに `page.html` /
`screenshot.png` / `responses.json` / `extraction-trace.txt`、全体の
`summary.txt`)。

- `debug_url` は**カンマ/空白区切りで複数指定できます**。
- 各URLは商品ページでも**一覧ページ**でも構いません。一覧ページを指定すると、
  そこからリンクされている商品の先頭N件を自動で辿ります。件数は `sample=N`
  というトークンを `debug_url` の中に混ぜて指定します(既定3件)。
  「期間限定価格一覧から発見した商品の価格がおかしい」類の問題は、実際の
  スクレイパーと同じ起点から辿らないと再現しないため、この指定が有効です。

例:

```
sample=5 https://www.gu-global.com/jp/ja/feature/limited-offers/women https://www.uniqlo.com/jp/ja/products/E361445-000/00?colorDisplayCode=09
```

`extraction-trace.txt` には、抽出の判断過程の**前に**根拠となる生データが
出力されます: レンダリング後のDOMに見えている「¥1,234」表記(前後の文言つき
なので「期間限定価格」なのか「通常価格」なのかが読めます)、JSON-LD の
offers/hasVariant、商品コードを含む各 JSON レスポンスの構造と価格らしき
フィールド。そのうえで、実際のスクレイパーと**同じ関数**
(`extractPriceAndName()`)を通した結果が `RESULT:` 行に出ます。

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
れ以上であれば記録をスキップします。より安い価格が見つかった場合は、その
実行内で直前に記録した行を上書きします。

ただし**同額の場合だけは例外**で、後から「期間限定価格一覧」側で発見した
occurrence が、まだ期間限定として記録されていない行を上書きします。値下げ
一覧と期間限定価格一覧は同じ商品ページにリンクしているため両者の価格は同額
になり、「同額ならスキップ」だと事実上「`config/sources.json` で先に書いた
ソースが勝つ」= 値下げ側が常に勝つ、という挙動でした。ダッシュボードのセク
ションは `event_type` で決まるので、その結果こうした商品が一つも「期間限定」
セクションに出てこない状態になっていました。逆方向(期間限定→値下げ)の上書
きは起きないため、実行順で行ったり来たりすることはありません。「過去に記録したこと
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
