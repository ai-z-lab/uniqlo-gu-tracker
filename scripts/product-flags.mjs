// 販売場所の制限フラグ(一部店舗・オンライン限定)の記録用。DBにもネットワークにも触れない。
import { productIdOfItem } from './regular-prices.mjs';

// 公式APIのフラグ名。
export const STORE_FLAGS = ['limitedStore', 'onlineOnly'];

// フラグで絞り込んだ商品一覧(items)から、書き込む行を作る。重複は除く。
export function productFlagRows({ brand, items, flagKey, nowIso }) {
  const rows = [];
  const seen = new Set();
  for (const item of items ?? []) {
    const productId = productIdOfItem(brand, item);
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    rows.push({ product_id: productId, brand, flag_key: flagKey, checked_at: nowIso });
  }
  return rows;
}
