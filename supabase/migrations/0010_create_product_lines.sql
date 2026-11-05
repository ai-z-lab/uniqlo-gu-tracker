-- product_lines: 商品がどのコラボ・特別ライン(UNIQLO : C / UNIQLO U / UNIQLO and
-- JW ANDERSON / UT のコラボ など)に属するかを持つ表。
--
-- 同じ商品名(例: イージーワイドパンツ)がラインごとに別商品として並ぶため、
-- 画面のカードにライン名を出して区別できるようにする。ライン名は商品の一覧APIの
-- 返答に入っておらず、「特別コレクション」「UT」のタグで絞り込んだ商品一覧からだけ
-- 分かる。スクレイパーが毎朝ラインごとに絞り込んで、商品コードとの対応をここへ記録する。
--
-- ラインの特集ページから商品が消えた後(終了・復刻待ち)も行は消さない。
-- 1つの商品が複数のラインに属することもあるため、主キーは (product_id, line_key)。

create table if not exists public.product_lines (
  -- price_events.product_id と同じ形(例: uniqlo-E487258-000-00)
  product_id text not null,
  brand text not null check (brand in ('uniqlo', 'gu')),
  -- タグのグループと値(例: special-collection:uniqlo-c)
  line_key text not null,
  -- 画面に出す名前(例: UNIQLO : C)
  line_label text not null,
  recorded_at timestamptz not null default now(),
  primary key (product_id, line_key)
);

alter table public.product_lines enable row level security;

-- 公開サイト(publishable key)は読むだけ。書き込みは service_role のスクレイパーだけ。
drop policy if exists "Public read access" on public.product_lines;
create policy "Public read access"
  on public.product_lines
  for select
  to anon
  using (true);
