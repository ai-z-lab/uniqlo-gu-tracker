-- 1日2回の巡回で消えていた 初値下げ / 初期間限定 を戻す。
--
-- スクレイパーは同じ日(日本時間)の2回目の巡回で、1回目の行を上書きする。
-- その際、比較の相手を「前日以前の最新行」ではなく「1回目が書いたばかりの
-- 今日の行」にしていたため、1回目が付けた first_markdown / first_limited が
-- 「既に見たことのある商品」扱いの markdown / limited に書き換わっていた。
-- 2026-09-02 以降に初めて記録された商品は、すべてこの状態になっている
-- (scripts/scrape.mjs の recordExtractedProduct で修正済み)。
--
-- 商品の最初の行は、定義上かならず初値下げか初期間限定になる
-- (classifyEventType は新規の商品にそれ以外を返さない)。そこで、その期間に
-- 作られた「その商品の最初の行」のうち markdown / limited のものだけを戻す。
-- それより前の行は対象にしない。product_id の付け直し(0006)や event_type
-- 列が無かった頃の行があり、最初の行が first_* でない理由がこのバグとは限らない。
--
-- 同じ原因で price_up も markdown / limited に書き換わっていた可能性があるが、
-- こちらは戻さない。値下げの段階数の数え方(price_up の行は段階に数えない)が
-- 過去に遡って変わり、利用者に見えている数字が動くため。

update public.price_events as e
set event_type = case e.event_type
  when 'markdown' then 'first_markdown'
  when 'limited' then 'first_limited'
end
where e.event_type in ('markdown', 'limited')
  and e.scraped_at >= timestamptz '2026-09-02 00:00:00+09'
  and not exists (
    select 1
    from public.price_events as earlier
    where earlier.product_id = e.product_id
      and earlier.scraped_at < e.scraped_at
  );
