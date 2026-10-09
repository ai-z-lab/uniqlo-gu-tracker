-- メンズ・レディース両方の一覧に載る商品を 'unisex'(男女兼用)として記録するため、
-- gender の check 制約に 'unisex' を加える。
alter table public.price_events drop constraint if exists price_events_gender_check;
alter table public.price_events
  add constraint price_events_gender_check check (gender in ('men', 'women', 'unisex', 'kids', 'baby'));
