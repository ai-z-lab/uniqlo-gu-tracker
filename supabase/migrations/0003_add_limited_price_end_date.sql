-- Stores when a "period-limited price" (期間限定価格) is scheduled to end,
-- so the dashboard can show "◯月◯日まで" on 期間限定 cards. Populated by
-- scripts/scrape.mjs from the product page's schema.org JSON-LD
-- (Offer.priceValidUntil) when present, with a best-effort text-pattern
-- fallback — see extractLimitedPriceEndDate() there. Not every product will
-- have this (only ones the site itself marks with an end date), so it's
-- nullable.

alter table public.price_events
  add column if not exists limited_price_end_date date;
