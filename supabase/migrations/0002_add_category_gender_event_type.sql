-- Adds the columns the dashboard needs to group products by brand / gender /
-- event type / category, without which every row would fall into an
-- "unclassified" bucket.
--
-- event_type is computed by the scraper (scripts/scrape.mjs) on every scrape,
-- not just when the price changes, so the *latest* row per product_id always
-- reflects its current section. The original 'new' value (and the check
-- constraint below) was replaced by migration 0004 with 'first_markdown'/
-- 'first_limited' — see that file for why.
--
-- category is a best-effort keyword classification of product_name (see
-- scripts/scrape.mjs categorizeProduct) — inherently approximate, unmatched
-- items fall back to 'その他'/'グッズ・その他' as described in the README.

alter table public.price_events
  add column if not exists category text,
  add column if not exists gender text check (gender in ('men', 'women')),
  add column if not exists event_type text check (event_type in ('new', 'markdown', 'limited', 'price_up'));

create index if not exists price_events_brand_gender_event_type_idx
  on public.price_events (brand, gender, event_type, scraped_at desc);
