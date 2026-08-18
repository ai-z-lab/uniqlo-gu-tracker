-- 通常価格・値下げの種類・在庫ステータスを記録できるようにする。
--
-- いずれもスクレイパーが商品ページから既に読み取っていながら、保存せずに
-- 捨てていた情報です。過去の行に遡って埋めることはできないため、記録開始が
-- 遅れるほど取り返せない履歴が積み上がります。
--
-- list_price: 会員価格などが適用される前の、guest(非会員)価格。読み取れた
--   場合は price と同額でも常に記録します(「今日は会員割引が無かった」ことも
--   事実として残すため。NULL は「guest価格が読めなかった」の意味に限定)。
--   割引があるかどうかは list_price > price で判定してください。
--   なお価格APIは includePreviousPrice=false で呼ばれているため、これは
--   「値下げ前の価格」ではありません。単に値下げされただけの商品
--   (UNIQLOの期間限定価格を含む)では list_price = price になります。
--   両者が実際に食い違うのは、GUのアプリ会員特別価格のように通常価格と
--   会員価格が同時に提示されているケースです。
--
-- price_type: 記録した価格が「どういう価格なのか」。従来の event_type は
--   「どの一覧ページで発見したか」に由来する推定でしたが、こちらは商品
--   ページ自身のデータから決まります。
--     'member'     … アプリ会員特別価格を採用した
--     'limited'    … 期間限定価格(終了日あり)
--     'remarkdown' … 再値下げ。通常値下げされていた商品に、さらに期間限定
--                    価格が乗った状態
--     'markdown'   … 上記以外(通常値下げ)
--   このうち 'remarkdown' だけは商品ページからは判別できません(ページは
--   「今日の価格」しか示さず、先週その商品が通常値下げ価格だったことは
--   こちらの履歴にしか無いため)。直前の記録との比較で決めています。
--
-- stock_status / in_stock_size_count: URLが示す色のSKUのうち在庫がある数と、
--   1つ以上あるかどうか。通常値下げは「売り切れるまで」続く性質があるため、
--   残サイズ数は次の値下げの予兆になり得ます。まずは「安いが在庫切れ」の
--   商品を出さないためだけでも有用です。
alter table public.price_events
  add column if not exists list_price integer check (list_price is null or list_price >= 0),
  add column if not exists price_type text check (price_type is null or price_type in ('member', 'limited', 'remarkdown', 'markdown')),
  add column if not exists stock_status text check (stock_status is null or stock_status in ('in_stock', 'stock_out')),
  add column if not exists in_stock_size_count integer check (in_stock_size_count is null or in_stock_size_count >= 0);
