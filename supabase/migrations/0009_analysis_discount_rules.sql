-- 値引きルールの検証。既知のルールをロジックとして持ち、実測と突き合わせて
-- 「ルールから外れた例外」だけを自動で拾い出す。
--
-- 検証したい既知のルール:
--   (A) 2,990円以上の商品は基本1,000円引き
--   (B) 20,000円超は3,000円引きの傾向 — ただし今年の値上げの影響で未確定
-- (B) を established ではなく provisional として持つのは、そもそも
-- 「未確定だと分かっている」ことを、確定しているルールと同じ顔で
-- 出さないため。画面側でもこの区別を出す。
--
-- 突き合わせの材料は自分の履歴しかない。このトラッカーが巡回するのは
-- 値下げ一覧・期間限定価格一覧だけなので「定価がいくらだったか」は
-- 一般には取れない(list_price は会員価格が別建てのときしか通常価格を
-- 示さない — README 参照)。代わりに使えるのは **観測した価格が動いた瞬間**:
--   - 値下げが段階を進んだとき (¥1,990 → ¥990)
--   - 期間限定価格が始まったとき (通常 → 期間限定)
-- どちらも「直前に観測していた価格」から「今日の価格」への差分として現れる。
-- これが analysis_price_drops。

-- --------------------------------------------------------------------------
-- 1. 値下がりの観測
-- --------------------------------------------------------------------------
-- 商品ごとに日本時間の1日1行へ畳んでから、隣り合う2日を比べる。
-- (スクレイパーは同じ日の行を上書きするので基本1日1行だが、同日判定が
--  UTC だった頃(〜2026-08)の行だけは日本時間で見ると1日2行あることがある。
--  その日の最後の記録を採る — docs/app.js の rowsByJstDay と同じ扱い。)
create or replace view public.analysis_price_drops as
with daily as (
  select distinct on (e.product_id, (e.scraped_at at time zone 'Asia/Tokyo')::date)
    e.product_id,
    (e.scraped_at at time zone 'Asia/Tokyo')::date as jst_day,
    e.price,
    e.currency,
    e.price_type,
    e.event_type,
    e.limited_price_end_date
  from public.price_events e
  order by
    e.product_id,
    (e.scraped_at at time zone 'Asia/Tokyo')::date,
    e.scraped_at desc
),
sequenced as (
  select
    d.*,
    lag(d.price)      over w as prev_price,
    lag(d.jst_day)    over w as prev_day,
    lag(d.price_type) over w as prev_price_type,
    lag(d.event_type) over w as prev_event_type
  from daily d
  window w as (partition by d.product_id order by d.jst_day)
)
select
  s.product_id,
  g.brand,
  g.gender,
  g.category,
  g.group_key,
  g.display_name,
  g.url,
  s.prev_day as from_day,
  s.jst_day as to_day,
  -- 何日ぶりの観測か。1 なら前日と比べている。2以上は間に巡回できていない
  -- 日があるということで、その間に値下げが2段進んでいた可能性を否定できない。
  (s.jst_day - s.prev_day)::int as gap_days,
  s.prev_price as from_price,
  s.price as to_price,
  (s.prev_price - s.price)::int as drop_amount,
  round((s.prev_price - s.price)::numeric / nullif(s.prev_price, 0), 4) as drop_ratio,
  s.prev_price_type as from_price_type,
  s.price_type as to_price_type,
  s.prev_event_type as from_event_type,
  s.event_type as to_event_type,
  s.currency,
  s.limited_price_end_date
from sequenced s
join public.analysis_product_groups g on g.product_id = s.product_id
where s.prev_price is not null
  and s.price < s.prev_price;

grant select on public.analysis_price_drops to anon, authenticated;

-- --------------------------------------------------------------------------
-- 2. ルールとの突き合わせ
-- --------------------------------------------------------------------------
-- verdict の意味:
--   'match'                 ルール通りの引き幅だった
--   'multiple'              ルールの引き幅のちょうど整数倍 (2,000円 = 1,000円×2)。
--                           間の巡回が空いていなくてもこれは起こりうる
--                           (同じ日に2段進む)ので、外れ値とは別扱いにする。
--   'exception'             ルールから外れた。これが自動ハイライトの対象。
--   'unjudgeable_gap'       前の観測から2日以上空いている。その間に何段
--                           進んだか決められないので、外れたとは言えない。
--   'unjudgeable_mechanism' 会員価格(GUのアプリ会員特別価格)を挟んでいる。
--                           値下げの段階ではなく別の価格体系への切り替えなので、
--                           値引き幅のルールの対象外。
--   'no_rule'               2,990円未満。既知のルールが無い帯。
--
-- 「判定できない」を 'match' や 'exception' に混ぜないのが要点。混ぜると
-- 巡回が失敗した日のぶんだけルールが破れて見える(あるいは守られて見える)。
create or replace view public.analysis_discount_rule_checks as
select
  d.*,
  r.rule_band,
  r.expected_drop,
  r.rule_confidence,
  case
    when r.expected_drop is null then 'no_rule'
    when d.gap_days > 1 then 'unjudgeable_gap'
    when coalesce(d.from_price_type, '') = 'member' or coalesce(d.to_price_type, '') = 'member'
      then 'unjudgeable_mechanism'
    when d.drop_amount = r.expected_drop then 'match'
    when d.drop_amount % r.expected_drop = 0 then 'multiple'
    else 'exception'
  end as verdict
from public.analysis_price_drops d
cross join lateral (
  select
    case
      when d.from_price > 20000 then 'over_20000'
      when d.from_price >= 2990 then 'from_2990'
      else 'under_2990'
    end as rule_band,
    case
      when d.from_price > 20000 then 3000
      when d.from_price >= 2990 then 1000
      else null
    end as expected_drop,
    case
      -- 20,000円超の3,000円引きは「傾向」であって確定していない
      -- (今年の値上げの影響がまだ読めていない)。
      when d.from_price > 20000 then 'provisional'
      when d.from_price >= 2990 then 'established'
      else null
    end as rule_confidence
) r;

grant select on public.analysis_discount_rule_checks to anon, authenticated;

-- --------------------------------------------------------------------------
-- 3. 集計
-- --------------------------------------------------------------------------
-- 帯 × 判定の件数。「ルールがどれくらい当たっているか」を1画面で出すため。
create or replace view public.analysis_discount_rule_summary as
select
  brand,
  gender,
  rule_band,
  rule_confidence,
  expected_drop,
  verdict,
  count(*)::int as drops,
  min(to_day) as first_day,
  max(to_day) as last_day,
  round(avg(drop_amount))::int as avg_drop
from public.analysis_discount_rule_checks
group by brand, gender, rule_band, rule_confidence, expected_drop, verdict;

grant select on public.analysis_discount_rule_summary to anon, authenticated;

-- 実際の引き幅の分布。ルールが当たっているかどうかは件数の比だけでなく
-- 「では実測は何円引きなのか」で見たほうが早い。20,000円超の帯が今年
-- 3,000円引きのままなのか変わったのかは、ここを年ごとに見れば分かる。
create or replace view public.analysis_drop_amount_distribution as
select
  brand,
  gender,
  rule_band,
  extract(year from to_day)::int as year,
  drop_amount,
  count(*)::int as drops,
  count(distinct group_key)::int as groups,
  min(to_day) as first_day,
  max(to_day) as last_day
from public.analysis_discount_rule_checks
-- 判定できないものは分布からも外す。間に巡回の抜けがある値下がりは
-- 「2段まとめて」かもしれず、1回の引き幅として数えられない。
where verdict <> 'unjudgeable_gap'
  and verdict <> 'unjudgeable_mechanism'
group by brand, gender, rule_band, extract(year from to_day), drop_amount;

grant select on public.analysis_drop_amount_distribution to anon, authenticated;

do $$
declare
  view_name text;
begin
  if current_setting('server_version_num')::int >= 150000 then
    foreach view_name in array array[
      'analysis_price_drops',
      'analysis_discount_rule_checks',
      'analysis_discount_rule_summary',
      'analysis_drop_amount_distribution'
    ] loop
      execute format('alter view public.%I set (security_invoker = on)', view_name);
    end loop;
  end if;
end
$$;
