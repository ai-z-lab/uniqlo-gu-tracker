-- キッズ・ベビーの一覧も巡回するため、gender に 'kids' と 'baby' を許す。
-- 0002 で列に付けた check 制約(自動名 price_events_gender_check)を張り直す。
alter table public.price_events drop constraint if exists price_events_gender_check;
alter table public.price_events
  add constraint price_events_gender_check check (gender in ('men', 'women', 'kids', 'baby'));
