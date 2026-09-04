-- 商品カテゴリ別 周期表と、値引きルールの検証のための集計層。
--
-- すべて自前のスクレイプデータ(price_events / scrape_runs)だけから作る。
-- 外部の分析サイトを見に行ったり、その内容を取り込んだりはしない。
--
-- なぜテーブルではなくビューなのか:
--   周期表は「何年も前と今年を並べる」ものなので、ダッシュボードが読んでいる
--   直近35日の窓では作れない。かといって数十万行を丸ごとブラウザへ送るのも
--   無理がある(PostgREST は1リクエスト1,000行で切れる)。集計をDB側に置けば
--   ブラウザが受け取るのは商品グループ×年の数行で済む。
--   さらにビューであれば、分類ロジックを直した時に過去の履歴へ自動的に
--   遡って効く。派生テーブルに焼き込むと、直すたびに再計算の段取りが要る。
--
--   代償は、ページを開くたびに price_events を全走査すること。1日あたり
--   約900行、1年で約33万行なので現状は問題にならない。重くなってきたら
--   analysis_group_year_cycles をマテリアライズドビューに変え、巡回の
--   最後に refresh する(そのときも定義はこのファイルの流用でよい)。

-- --------------------------------------------------------------------------
-- 1. 商品名の正規化
-- --------------------------------------------------------------------------
-- 商品コード(E484457-000)は季節ごとに振り直されるため、年をまたいで同じ商品を
-- 追うには商品名を手がかりにするしかない。ただし商品名は表記ゆれを起こす。
--
-- ここでやるのは「機械的に確実に同じと言い切れる差」だけを潰すこと:
--   - 全角/半角、半角カナ、丸数字などの表記差 (Unicode NFKC)
--   - 大文字/小文字
--   - 区切り・装飾記号(空白、中点、括弧、スラッシュ、ハイフン等)
--
-- 意味を持つ語は落とさない。特に「半袖/長袖」「◯分丈」は落とすと
-- 夏物と冬物が同じグループに潰れる — 周期表は「いつ値下げされるか」を
-- 見るための表なので、季節が違う商品を混ぜたら表そのものが無意味になる。
-- 長音符(ー)も落とさない(「シャツ」と「シャ」が別語であるように、語の一部)。
--
-- 「エクストラファインメリノ」→「エクストラファインメリノウール」のような
-- 改名や、機械的には潰せない表記ゆれは、下の analysis_product_group_aliases
-- で人手で対応付ける。自動で寄せられる範囲を意図的に狭く取り、意味的な
-- 統合はすべて明示・レビュー可能な形(gitに残るマイグレーション)にしている。
create or replace function public.analysis_normalize_product_name(name text)
returns text
language sql
immutable
strict
parallel safe
as $fn$
  select nullif(
    regexp_replace(
      lower(normalize(name, NFKC)),
      $re$[]\[(){}<>「」『』【】〈〉《》〔〕[:space:]・･/\\|,、。.:;!?"'`~^*&@#%_+＋−–—―‐-]+$re$,
      '',
      'g'
    ),
    ''
  );
$fn$;

comment on function public.analysis_normalize_product_name(text) is
  '商品名から表記ゆれ(全角半角・記号・空白)だけを落とした正規化キー。意味を持つ語(半袖/長袖/丈など)は残す。';

-- product_id (例: uniqlo-E484457-000-01) から商品コード部分だけを取り出す。
-- 末尾の価格グループ(定価ライン/処分ライン)は落とす — 同じ商品の別の値付け
-- なので、周期表の上では1つの商品として扱う。
-- 商品コードは「英数字 + '-' + 3桁」の形をしているので、その形にだけ当てる。
-- 単純に「末尾の -数字 を落とす」とすると、価格グループの無いIDから
-- 商品コードの一部(-000)を削ってしまう。
create or replace function public.analysis_item_code(product_id text)
returns text
language sql
immutable
strict
parallel safe
as $fn$
  select coalesce(
    substring(product_id from '^(?:uniqlo|gu)-([A-Za-z0-9]+-[0-9]{3})(?:-[0-9]{1,3})?$'),
    regexp_replace(product_id, '^(?:uniqlo|gu)-', '')
  );
$fn$;

-- --------------------------------------------------------------------------
-- 2. 手動エイリアス(改名・正規化で寄り切らない表記ゆれ)
-- --------------------------------------------------------------------------
-- from_key(正規化済みキー) を to_key へ寄せる。1段だけ解決する
-- (エイリアスの連鎖は追わない — 循環と「どっちが正か」の曖昧さを持ち込まない
-- ため。A→B→C にしたい場合は A→C と B→C の2行を書く)。
--
-- 行の追加・修正は新しい番号のマイグレーションで行う。DBを直接いじらないのは、
-- 「なぜこの2つを同じ商品とみなしたのか」がgitのレビュー履歴に残るようにする
-- ため。判断の根拠は note に書く。
create table if not exists public.analysis_product_group_aliases (
  brand text not null check (brand in ('uniqlo', 'gu')),
  from_key text not null,
  to_key text not null,
  note text,
  created_at timestamptz not null default now(),
  primary key (brand, from_key),
  -- 自分自身へのエイリアスは無意味で、書けてしまうと「1段だけ解決」の
  -- 前提が読みにくくなるだけなので弾く。
  constraint analysis_product_group_aliases_not_self check (from_key <> to_key)
);

alter table public.analysis_product_group_aliases enable row level security;

drop policy if exists "Public read access" on public.analysis_product_group_aliases;
create policy "Public read access"
  on public.analysis_product_group_aliases
  for select
  to anon
  using (true);

grant select on public.analysis_product_group_aliases to anon, authenticated;

-- --------------------------------------------------------------------------
-- 3. 商品グループ
-- --------------------------------------------------------------------------
-- product_id 1つは必ずグループ1つに属する。所属は「その商品の最新の記録」の
-- 商品名・カテゴリで決める。1つの商品の名前が途中で変わることは実際上ほぼ
-- 無いが、仮に変わっても商品が2つのグループに跨がらないようにするため、
-- 最新の1行だけを見る。
--
-- グループの単位は ブランド × 性別 × 正規化キー。性別を含めるのは、同名の
-- メンズ商品とレディース商品が別商品だからで、ダッシュボードのタブとも揃う。
-- カテゴリはグループの属性(表示上の見出し)であって、グループを分ける鍵には
-- 使わない — カテゴリ判定は商品名からの推定なので、キーワード表を直した
-- 瞬間に同じ商品が別グループへ飛ぶのを避ける。
create or replace view public.analysis_product_groups as
with latest as (
  select distinct on (product_id)
    product_id,
    brand,
    gender,
    category,
    product_name,
    url,
    scraped_at
  from public.price_events
  order by product_id, scraped_at desc
)
select
  l.product_id,
  l.brand,
  coalesce(l.gender, 'unknown') as gender,
  coalesce(l.category, case when l.brand = 'gu' then 'グッズ・その他' else 'その他' end) as category,
  l.product_name as display_name,
  l.url,
  public.analysis_item_code(l.product_id) as item_code,
  k.normalized_key,
  coalesce(a.to_key, k.normalized_key) as group_key,
  a.to_key is not null as alias_applied
from latest l
cross join lateral (
  select coalesce(
    public.analysis_normalize_product_name(l.product_name),
    -- 商品名が読めなかった行(0002適用前の古い行など)は、商品コードを
    -- そのままキーにする。名前の無いもの同士を1つのグループに
    -- まとめてしまわないため。
    public.analysis_item_code(l.product_id)
  ) as normalized_key
) k
left join public.analysis_product_group_aliases a
  on a.brand = l.brand and a.from_key = k.normalized_key;

grant select on public.analysis_product_groups to anon, authenticated;

-- グループの代表名。同じグループに属する商品のうち、いちばん最近確認できた
-- ものの商品名を使う(正規化キーは記号を落としているので、そのままでは
-- 画面に出せない)。
create or replace view public.analysis_product_group_names as
select distinct on (brand, gender, group_key)
  g.brand,
  g.gender,
  g.group_key,
  g.display_name,
  g.category,
  g.url
from public.analysis_product_groups g
join public.price_events e on e.product_id = g.product_id
order by g.brand, g.gender, g.group_key, e.scraped_at desc;

grant select on public.analysis_product_group_names to anon, authenticated;

-- --------------------------------------------------------------------------
-- 4. 巡回カバレッジ(どの日を実際に見に行けたか)
-- --------------------------------------------------------------------------
-- scrape_runs が入る前の履歴には実行ログが無いので、その期間は
-- 「price_events にそのブランド/性別の行がある日 = 巡回できた日」で代用する。
-- 代用であることは source 列で区別できるようにしておく(実行ログのある日は
-- 'run_log'、遡って推定した日は 'inferred')。
create or replace view public.analysis_coverage_days as
select distinct on (brand, gender, day)
  brand,
  gender,
  day,
  source
from (
  select
    r.brand,
    coalesce(r.gender, 'unknown') as gender,
    (r.started_at at time zone 'Asia/Tokyo')::date as day,
    'run_log' as source
  from public.scrape_runs r
  where r.ok
  union all
  select
    e.brand,
    coalesce(e.gender, 'unknown') as gender,
    (e.scraped_at at time zone 'Asia/Tokyo')::date as day,
    'inferred' as source
  from public.price_events e
) d
-- 同じ日に両方あれば実行ログ側を採る('inferred' < 'run_log' なので降順)。
order by brand, gender, day, source desc;

grant select on public.analysis_coverage_days to anon, authenticated;

create or replace view public.analysis_coverage_years as
select
  c.brand,
  c.gender,
  extract(year from c.day)::int as year,
  count(*)::int as covered_days,
  count(*) filter (where c.source = 'run_log')::int as run_log_days,
  min(c.day) as first_covered_day,
  max(c.day) as last_covered_day,
  y.days_elapsed,
  -- 1年のうち何割を実際に見に行けたか。0.08 なら「その年の8%しか見ていない」。
  round(count(*)::numeric / nullif(y.days_elapsed, 0), 4) as coverage_ratio
from public.analysis_coverage_days c
cross join lateral (
  select (
    least(
      make_date(extract(year from c.day)::int, 12, 31),
      (now() at time zone 'Asia/Tokyo')::date
    )
    - make_date(extract(year from c.day)::int, 1, 1)
    + 1
  )::int as days_elapsed
) y
group by c.brand, c.gender, extract(year from c.day), y.days_elapsed;

grant select on public.analysis_coverage_years to anon, authenticated;

-- --------------------------------------------------------------------------
-- 5. 周期表(商品グループ × 年)
-- --------------------------------------------------------------------------
-- 「その商品グループが、その年の何月何日に初めて値下げ/期間限定として
-- 観測されたか」。
--
-- ここで言う初動値下げ日は、あくまで **このトラッカーが値下げ一覧で最初に
-- 見つけた日** であって、店頭で値札が書き換わった日ではない。両者がずれる
-- 要因は2つある:
--   (a) 巡回していない日に始まっていた場合
--   (b) 記録開始前から既に値下げされていた場合
-- (a)(b) はどちらも「その年の最初の巡回日以前に初観測がある」という形で
-- 現れるので、first_markdown_censored / first_limited_censored として持ち出す。
-- これが真の日付は「その日以前のどこか」までしか言えない。
--
-- 逆に「その年に値下げが無かった」も、巡回できていない期間があれば
-- 「無かった」とは言えない。判断材料として covered_days / coverage_ratio を
-- 同じ行に載せ、画面側で「該当なし」と「未確認」を出し分けられるようにする。
create or replace view public.analysis_group_year_cycles as
with observations as (
  select
    g.brand,
    g.gender,
    g.category,
    g.group_key,
    e.product_id,
    (e.scraped_at at time zone 'Asia/Tokyo')::date as jst_day,
    e.event_type,
    e.price,
    e.limited_price_end_date
  from public.price_events e
  join public.analysis_product_groups g on g.product_id = e.product_id
),
per_year as (
  select
    o.brand,
    o.gender,
    o.category,
    o.group_key,
    extract(year from o.jst_day)::int as year,
    count(distinct o.product_id)::int as product_count,
    count(distinct o.jst_day)::int as observed_days,
    min(o.jst_day) as first_seen_day,
    max(o.jst_day) as last_seen_day,
    min(o.jst_day) filter (where o.event_type in ('first_markdown', 'markdown')) as first_markdown_day,
    max(o.jst_day) filter (where o.event_type in ('first_markdown', 'markdown')) as last_markdown_day,
    count(distinct o.jst_day) filter (where o.event_type in ('first_markdown', 'markdown'))::int as markdown_days,
    min(o.jst_day) filter (where o.event_type in ('first_limited', 'limited')) as first_limited_day,
    max(o.jst_day) filter (where o.event_type in ('first_limited', 'limited')) as last_limited_day,
    count(distinct o.jst_day) filter (where o.event_type in ('first_limited', 'limited'))::int as limited_days,
    min(o.price)::int as min_price,
    max(o.price)::int as max_price
  from observations o
  group by o.brand, o.gender, o.category, o.group_key, extract(year from o.jst_day)
)
select
  p.*,
  n.display_name,
  n.url,
  cy.covered_days,
  cy.run_log_days,
  cy.first_covered_day,
  cy.last_covered_day,
  cy.days_elapsed,
  cy.coverage_ratio,
  -- 「その年の最初に見に行けた日」以前にもう値下げされていた
  -- = 本当の初動はそれより前かもしれない。
  (p.first_markdown_day is not null and cy.first_covered_day is not null
     and p.first_markdown_day <= cy.first_covered_day) as first_markdown_censored,
  (p.first_limited_day is not null and cy.first_covered_day is not null
     and p.first_limited_day <= cy.first_covered_day) as first_limited_censored
from per_year p
left join public.analysis_product_group_names n
  on n.brand = p.brand and n.gender = p.gender and n.group_key = p.group_key
left join public.analysis_coverage_years cy
  on cy.brand = p.brand and cy.gender = p.gender and cy.year = p.year;

grant select on public.analysis_group_year_cycles to anon, authenticated;

-- --------------------------------------------------------------------------
-- 6. エイリアス候補(改名の見つけ方)
-- --------------------------------------------------------------------------
-- 改名は「旧名が一覧から消えた後に、よく似た新名が現れる」という形で出る。
-- その形をした2つのグループを候補として並べる。人が見て判断し、正しければ
-- analysis_product_group_aliases に1行足す。自動では何も統合しない。
--
-- 似ているの判定は2通り(reason 列でどちらか分かる):
--   'prefix'   … 先頭6文字が一致し、共通接頭辞が短い方の半分以上を占める。
--                「エクストラファインメリノ(ウール)クルーネックセーター」の
--                ように語が途中へ挿入される改名はこちらで捕まる。
--   'contains' … 片方がもう片方をそのまま含んでいる。語の追加・削除による
--                改名(末尾にラインの名前が付く等)はこちらで捕まる。
--
-- どちらも「観測期間が重なっていないこと」を条件にする。同じ時期に併存して
-- いる2つは、名前が似ていても別々に売られている別商品である可能性が高い。
--
-- 注意: グループ同士の突き合わせなので、必ず brand と gender で絞って使う
-- こと(PostgREST なら ?brand=eq.uniqlo&gender=eq.men)。絞らずに全件走らせると
-- 'contains' 側がグループ数の二乗の比較になる。
create or replace function public.analysis_common_prefix_length(a text, b text)
returns int
language plpgsql
immutable
strict
parallel safe
as $fn$
declare
  n int := 0;
  m int := least(length(a), length(b));
begin
  while n < m and substr(a, n + 1, 1) = substr(b, n + 1, 1) loop
    n := n + 1;
  end loop;
  return n;
end;
$fn$;

-- 列の並びを変えると create or replace が通らないので、作り直す。
-- このビューに依存しているものは無い。
drop view if exists public.analysis_group_alias_candidates;
create view public.analysis_group_alias_candidates as
with spans as (
  select
    g.brand,
    g.gender,
    g.group_key,
    min(n.display_name) as display_name,
    min((e.scraped_at at time zone 'Asia/Tokyo')::date) as first_day,
    max((e.scraped_at at time zone 'Asia/Tokyo')::date) as last_day,
    count(*)::int as observations
  from public.analysis_product_groups g
  join public.price_events e on e.product_id = g.product_id
  left join public.analysis_product_group_names n
    on n.brand = g.brand and n.gender = g.gender and n.group_key = g.group_key
  group by g.brand, g.gender, g.group_key
),
pairs as (
  -- 先頭が揃っている組。等値なのでハッシュ結合になり、総当たりにならない。
  select a, b, 'prefix' as reason
  from spans a
  join spans b
    on b.brand = a.brand
   and b.gender = a.gender
   and left(b.group_key, 6) = left(a.group_key, 6)
   and b.group_key <> a.group_key
   and b.first_day > a.last_day
  where length(a.group_key) >= 8
    and public.analysis_common_prefix_length(a.group_key, b.group_key)
        >= greatest(6, least(length(a.group_key), length(b.group_key)) / 2)

  union all

  -- 片方がもう片方を丸ごと含んでいる組。
  select a, b, 'contains' as reason
  from spans a
  join spans b
    on b.brand = a.brand
   and b.gender = a.gender
   and b.group_key <> a.group_key
   and b.first_day > a.last_day
   and (position(a.group_key in b.group_key) > 0 or position(b.group_key in a.group_key) > 0)
   -- 短いキーは無関係な商品同士でも含有関係になりやすい。
  where length(a.group_key) >= 8
    -- 上の 'prefix' 側と重複する組は出さない。
    and left(b.group_key, 6) <> left(a.group_key, 6)
)
select distinct
  (p.a).brand,
  (p.a).gender,
  p.reason,
  (p.a).group_key as old_key,
  (p.a).display_name as old_name,
  (p.a).first_day as old_first_day,
  (p.a).last_day as old_last_day,
  (p.a).observations as old_observations,
  (p.b).group_key as new_key,
  (p.b).display_name as new_name,
  (p.b).first_day as new_first_day,
  (p.b).last_day as new_last_day,
  (p.b).observations as new_observations,
  ((p.b).first_day - (p.a).last_day)::int as gap_days
from pairs p
-- 既に対応付け済みのものは候補から外す。
where not exists (
  select 1 from public.analysis_product_group_aliases al
  where al.brand = (p.a).brand and al.from_key = (p.a).group_key
);

grant select on public.analysis_group_alias_candidates to anon, authenticated;

-- --------------------------------------------------------------------------
-- security_invoker
-- --------------------------------------------------------------------------
-- ビューは既定では作成者(postgres)の権限で走るため、下敷きのテーブルの RLS を
-- すり抜ける。price_events / scrape_runs はどちらも anon に SELECT を許して
-- いるので結果は変わらないが、権限の出所を1か所(テーブルのポリシー)に
-- 揃えておく。PostgreSQL 15 以降のオプションなので、それ未満では飛ばす。
do $$
declare
  view_name text;
begin
  if current_setting('server_version_num')::int >= 150000 then
    foreach view_name in array array[
      'analysis_product_groups',
      'analysis_product_group_names',
      'analysis_coverage_days',
      'analysis_coverage_years',
      'analysis_group_year_cycles',
      'analysis_group_alias_candidates'
    ] loop
      execute format('alter view public.%I set (security_invoker = on)', view_name);
    end loop;
  else
    raise notice 'security_invoker は PostgreSQL 15 以降のみ。このサーバーでは設定しない。';
  end if;
end
$$;
