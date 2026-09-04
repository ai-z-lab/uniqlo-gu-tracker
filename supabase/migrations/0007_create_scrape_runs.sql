-- 巡回そのものの記録。「その日そのソースを実際に見に行けたのか」を残す。
--
-- これが無いと、price_events の行が無い日を「値下げが無かった日」と
-- 「そもそも見に行けていない日」のどちらとも区別できない。周期表は
-- 「今年いつ初動値下げが来たか」を年ごとに並べるものなので、この区別が
-- 付かないまま集計すると、巡回が止まっていた期間がそのまま
-- 「値下げが無かった期間」として出てしまう。実測ではないものを実測の
-- 顔で出さないために、先にこの表を用意する。
--
-- 粒度は「1実行 × 1ソース」。ソース単位にするのは、失敗が全体で起きるとは
-- 限らないため — 実際に 2026-08-20 には GU レディースの一覧だけが2回連続で
-- 0件を返し、他のソースは正常だった。実行単位でしか残さないと、この日は
-- 「成功した日」として記録され、GUレディースの欠測が見えなくなる。
--
-- ok の定義は「1件以上発見でき、その全部が失敗したわけではない」。
-- discovered = 0 は scripts/scrape.mjs 側でも既にジョブ失敗の扱いにしている
-- (そのブランド/性別がまるごと更新されないため)。
create table if not exists public.scrape_runs (
  id bigint generated always as identity primary key,
  -- 同じ実行に属する行をまとめるためのID。実行ごとにスクレイパーが採番する。
  run_id uuid not null,
  source_id text not null,
  brand text not null check (brand in ('uniqlo', 'gu')),
  gender text check (gender is null or gender in ('men', 'women')),
  listing_type text,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  discovered integer not null default 0 check (discovered >= 0),
  recorded integer not null default 0 check (recorded >= 0),
  price_changed integer not null default 0 check (price_changed >= 0),
  skipped integer not null default 0 check (skipped >= 0),
  failed integer not null default 0 check (failed >= 0),
  ok boolean not null,
  note text
);

create index if not exists scrape_runs_brand_gender_started_idx
  on public.scrape_runs (brand, gender, started_at desc);

create index if not exists scrape_runs_run_id_idx
  on public.scrape_runs (run_id);

alter table public.scrape_runs enable row level security;

-- price_events と同じ方針。公開サイトが「未確認」を出すために読む必要が
-- あるので anon に SELECT だけ許す。書き込みは service_role
-- (RLSをバイパスする)を使うスクレイパーだけなので INSERT ポリシーは置かない。
drop policy if exists "Public read access" on public.scrape_runs;
create policy "Public read access"
  on public.scrape_runs
  for select
  to anon
  using (true);

grant select on public.scrape_runs to anon, authenticated;
