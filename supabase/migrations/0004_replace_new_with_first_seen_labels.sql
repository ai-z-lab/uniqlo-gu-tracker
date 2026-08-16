-- Replaces the misleading 'new' event_type. This tracker only crawls the
-- 値下げ一覧 ("sale") and 期間限定価格一覧 ("limited") listing pages — it never
-- visits an official new-arrivals page — so 'new' never meant "genuinely just
-- released"; it only meant "the first time this tracker happened to see the
-- product". Split it into two listing-specific labels that say that honestly:
--   'first_markdown' - first time seen, discovered via a 'sale'-type listing
--   'first_limited'  - first time seen, discovered via a 'limited'-type listing
-- scripts/scrape.mjs's classifyEventType() now returns one of these instead
-- of 'new' whenever isNewProduct is true.

alter table public.price_events
  drop constraint if exists price_events_event_type_check;

alter table public.price_events
  add constraint price_events_event_type_check
  check (event_type in ('first_markdown', 'first_limited', 'markdown', 'limited', 'price_up'));

-- Best-effort backfill for any rows still tagged 'new'. This only affects
-- products whose *next* scrape hasn't run yet (event_type is recomputed on
-- every scrape, so 'new' is inherently a one-day-only value). There's no
-- stored record of which listing page first discovered a given row, so this
-- guesses from limited_price_end_date: only 期間限定 listing pages populate
-- that column.
update public.price_events
  set event_type = case when limited_price_end_date is not null then 'first_limited' else 'first_markdown' end
  where event_type = 'new';
