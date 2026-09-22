-- gender に 'unisex'(男女兼用)を足す。
--
-- UNIQLO/GU の男女兼用の商品は、MEN一覧とWOMEN一覧の両方に同じ商品として
-- 載っている。スクレイパーは同じ商品を1回の巡回で1行しか書かないため、先に
-- 巡回するWOMEN一覧で見つけた性別がそのまま残り、男女兼用の商品はすべて
-- gender = 'women' になってMENのタブから消えていた(2026-09 時点で、GUメンズ
-- 値下げ一覧の約5割、UNIQLOメンズ値下げ一覧の約6割が男女兼用)。
--
-- 行は1商品につき1本のまま、商品自身の区分として 'unisex' を持たせる。
-- ダッシュボードは 'unisex' の商品をMEN・WOMENの両方のタブに「ユニセックス」
-- のバッジ付きで出す。判定はスクレイパーが一覧APIの genderCategory を見て行う。
--
-- 過去の行は書き換えない。どの商品が男女兼用だったかは行には残っておらず、
-- ダッシュボードは商品ごとの最新行の gender で振り分けるので、次の巡回で
-- 最新行が 'unisex' になれば表示は直る。

-- 0002 で列定義に付けた CHECK は名前を指定していない。自動で付いた名前に
-- 頼らず、gender を見ている CHECK 制約をすべて外してから付け直す。
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.price_events'::regclass
      and con.contype = 'c'
      and att.attname = 'gender'
  loop
    execute format('alter table public.price_events drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.price_events
  add constraint price_events_gender_check
  check (gender in ('men', 'women', 'unisex'));
