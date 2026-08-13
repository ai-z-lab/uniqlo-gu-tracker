-- price_events: one row per observed price for a tracked Uniqlo/GU product.
-- A new row is inserted only when the price actually changes (see scripts/scrape.mjs),
-- so this table doubles as the full price-change history for each product.

create table if not exists public.price_events (
  id bigint generated always as identity primary key,
  product_id text not null,
  product_name text,
  brand text not null check (brand in ('uniqlo', 'gu')),
  url text not null,
  price integer not null check (price >= 0),
  currency text not null default 'JPY',
  scraped_at timestamptz not null default now()
);

create index if not exists price_events_product_id_scraped_at_idx
  on public.price_events (product_id, scraped_at desc);

alter table public.price_events enable row level security;

-- Public (anon/publishable key) can read all price history for the frontend.
drop policy if exists "Public read access" on public.price_events;
create policy "Public read access"
  on public.price_events
  for select
  to anon
  using (true);

-- Inserts are only performed by the scraper using the service_role key,
-- which bypasses RLS entirely, so no insert policy is defined here on purpose.
