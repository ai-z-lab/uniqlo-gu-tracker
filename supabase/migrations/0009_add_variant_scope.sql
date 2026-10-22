-- 値引きが一部の色・サイズだけに付いているときの対象範囲。全色・全サイズが
-- 対象なら NULL。形は scripts/scrape.mjs の variantScopeFromL2s() を参照:
--   { "colors": ["09 BLACK", …] | null,      -- 対象の色(null = 全色)
--     "sizes":  ["XXL", "3XL"] | null,       -- 対象のサイズ(null = 全サイズ)
--     "detail": [{ "color": "…", "sizes": [...] | null }] | null,  -- 色ごとにサイズが違うとき
--     "total_colors": 5, "total_sizes": 8 }
alter table public.price_events add column if not exists variant_scope jsonb;
