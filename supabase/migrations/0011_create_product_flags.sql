-- product_flags: 「一部店舗のみ」「オンライン限定」など、販売場所に制限がある商品の印。
--
-- 公式の商品データのフラグ(limitedStore=一部店舗商品 / onlineOnly=オンライン商品)を
-- スクレイパーが毎朝フラグで絞り込んで記録する。画面のカードに「一部店舗」などと出し、
-- 店に行ったら無かった、を避けるために使う。
-- checked_at は最後にフラグが確認できた時刻。画面は古い行(フラグが外れた商品)を無視する。

create table if not exists public.product_flags (
  product_id text not null,
  brand text not null check (brand in ('uniqlo', 'gu')),
  flag_key text not null check (flag_key in ('limitedStore', 'onlineOnly')),
  checked_at timestamptz not null default now(),
  primary key (product_id, flag_key)
);

alter table public.product_flags enable row level security;

drop policy if exists "Public read access" on public.product_flags;
create policy "Public read access"
  on public.product_flags
  for select
  to anon
  using (true);
