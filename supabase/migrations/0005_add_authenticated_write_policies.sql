-- Allows manual corrections/additions from the hidden admin UI
-- (docs/manage-7q2k9x4d/), which authenticates via Supabase Auth. The
-- scraper keeps using the service_role key (which bypasses RLS entirely),
-- so this only needs to cover the "authenticated" role.
--
-- Anonymous visitors still cannot write anything -- only a signed-in
-- Supabase Auth user can. Create that user via Supabase Dashboard ->
-- Authentication -> Users (see README "隠し管理UI" section).

drop policy if exists "Authenticated insert access" on public.price_events;
create policy "Authenticated insert access"
  on public.price_events
  for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated update access" on public.price_events;
create policy "Authenticated update access"
  on public.price_events
  for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated delete access" on public.price_events;
create policy "Authenticated delete access"
  on public.price_events
  for delete
  to authenticated
  using (true);
