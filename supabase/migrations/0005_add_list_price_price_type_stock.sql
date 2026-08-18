-- 通常価格・値下げの種類・在庫ステータスを記録できるようにする。
--
-- いずれもスクレイパーが商品ページから既に読み取っていながら、保存せずに
-- 捨てていた情報です。過去の行に遡って埋めることはできないため、記録開始が
-- 遅れるほど取り返せない履歴が積み上がります。
--
-- list_price: その商品の通常価格(アプリ会員特別価格などが適用される前の
--   価格)。price より高い場合のみ入り、割引が無い場合は NULL です。
--   価格APIは includePreviousPrice=false で呼ばれているため、これは
--   「値下げ前の価格」ではありません。単に値下げされただけの商品
--   (UNIQLOの期間限定価格を含む)では通常価格と実売価格が一致するため NULL に
--   なります。GUのアプリ会員特別価格のように、通常価格と会員価格が同時に
--   提示されているケースで値が入ります。
--
-- price_type: 記録した価格が「どういう価格なのか」。従来の event_type は
--   「どの一覧ページで発見したか」に由来する推定でしたが、こちらは商品
--   ページ自身のデータから決まります。
--     'member'   … アプリ会員特別価格を採用した
--     'limited'  … 期間限定価格(終了日あり)
--     'markdown' … 上記以外
--
-- stock_status / in_stock_size_count: URLが示す色のSKUのうち在庫がある数と、
--   1つ以上あるかどうか。通常値下げは「売り切れるまで」続く性質があるため、
--   残サイズ数は次の値下げの予兆になり得ます。まずは「安いが在庫切れ」の
--   商品を出さないためだけでも有用です。
alter table public.price_events
  add column if not exists list_price integer check (list_price is null or list_price >= 0),
  add column if not exists price_type text check (price_type is null or price_type in ('member', 'limited', 'markdown')),
  add column if not exists stock_status text check (stock_status is null or stock_status in ('in_stock', 'stock_out')),
  add column if not exists in_stock_size_count integer check (in_stock_size_count is null or in_stock_size_count >= 0);
