-- regular_prices: 値下げされる前の「通常価格」を商品ごとに1行だけ持つ表。
--
-- UNIQLO は値下げした日から、サイトの定価欄もAPIも値下げ後の価格に書き換えて
-- しまい、元の価格をどこにも出さない。だから「初値下げ」の商品は、値下げされる
-- 前に価格を記録しておかない限り、元の価格を後から知る手段が無い。
-- スクレイパーは毎朝、値下げ・期間限定の一覧に載っていない商品(=通常価格で売って
-- いる商品)の価格をここへ記録する。値下げ中の商品は上書きしないので、値下げ前の
-- 最後の通常価格がそのまま残る。画面はこの値を「通常 ¥X」として添える。
--
-- price_events とは別の表にしている。price_events は「いまどの一覧に載っているか」
-- を最新行で判断するため、通常価格の行を混ぜると一覧の区分が崩れる。

create table if not exists public.regular_prices (
  -- price_events.product_id と同じ形(例: uniqlo-E489091-000-00)
  product_id text primary key,
  brand text not null check (brand in ('uniqlo', 'gu')),
  regular_price integer not null check (regular_price > 0),
  -- この価格を最後に書き込んだ(=価格が変わった)日時
  recorded_at timestamptz not null default now()
);

alter table public.regular_prices enable row level security;

-- 公開サイト(publishable key)は読むだけ。書き込みは service_role のスクレイパーだけで、
-- RLS を素通りするため insert/update のポリシーは意図的に定義しない。
drop policy if exists "Public read access" on public.regular_prices;
create policy "Public read access"
  on public.regular_prices
  for select
  to anon
  using (true);
