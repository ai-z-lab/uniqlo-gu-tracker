// 値下げされる前の「通常価格」を記録するための、DBにもネットワークにも触れない部分。
// 本体(scrape.mjs)から使い、ここだけ単体でテストできるようにしている。

// 値下げ・期間限定の各ソースから、同じ区分(ブランド・性別)の「全商品」を引く
// ソースを作る。flagCodes を空にすると、値引き中かどうかに関係なく全商品が返る。
export function catalogSourcesFrom(sources, { maxProducts = 3000, pageSize = 100 } = {}) {
  const seen = new Set();
  const out = [];
  for (const source of sources) {
    if (source.listingType !== 'sale') continue;
    const api = { ...source.api, flagCodes: [] };
    const key = `${source.brand}:${JSON.stringify(api)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `${source.id}-catalog`,
      saleSourceId: source.id,
      brand: source.brand,
      gender: source.gender,
      listingType: 'catalog',
      api,
      maxProducts,
      pageSize,
    });
  }
  return out;
}

// price_events.product_id と同じ形(scrape.mjs の productIdFromUrl と揃える)。
export function productIdOfItem(brand, item) {
  if (!item?.productId) return null;
  return item.priceGroup ? `${brand}-${item.productId}-${item.priceGroup}` : `${brand}-${item.productId}`;
}

// 一覧の1件が、いま実際に買える価格(ゲスト価格)。読めなければ null。
export function currentPriceOfItem(item) {
  const raw = item?.prices?.promo?.value ?? item?.prices?.base?.value;
  const price = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(price) || price <= 0 || price >= 1_000_000) return null;
  return Math.round(price);
}

// 書き込むべき行だけを返す。
// - 今日の巡回で値下げ・期間限定の一覧に載っていた商品(discountedIds)は飛ばす。
//   いまの価格は値下げ後なので、通常価格として書くと「元の価格」を壊してしまう。
// - すでに同じ価格が記録されている商品も飛ばす(毎日の書き込みを増やさない)。
export function regularPriceRows({ brand, items, discountedIds, known, nowIso }) {
  const rows = [];
  const seen = new Set();
  for (const item of items) {
    const productId = productIdOfItem(brand, item);
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    if (discountedIds.has(productId)) continue;
    const price = currentPriceOfItem(item);
    if (price == null) continue;
    if (known.get(productId) === price) continue;
    rows.push({ product_id: productId, brand, regular_price: price, recorded_at: nowIso });
  }
  return rows;
}
