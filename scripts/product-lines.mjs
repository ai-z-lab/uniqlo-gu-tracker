// コラボ・特別ラインの記録のための、DBにもネットワークにも触れない部分。
// 本体(scrape.mjs)から使い、ここだけ単体でテストできるようにしている。
import { productIdOfItem } from './regular-prices.mjs';

// 一覧APIの aggregations.tags の中で、ラインを表すグループ。
// special-collection = UNIQLO : C / UNIQLO U / JW ANDERSON など、ut = UTのコラボ。
export const LINE_TAG_GROUPS = ['special-collection', 'ut', 'collaboration'];

// aggregations.tags から、ラインごとの {group, value, label} を取り出す。
export function lineTagsFrom(tags) {
  const out = [];
  for (const g of tags ?? []) {
    if (!LINE_TAG_GROUPS.includes(g?.groupName)) continue;
    for (const v of g.values ?? []) {
      if (!v?.name) continue;
      out.push({ group: g.groupName, value: v.name, label: v.localizationName || v.name });
    }
  }
  return out;
}

// ラインで絞り込んだ商品一覧(items)から、書き込む行を作る。
export function productLineRows({ brand, items, tag, nowIso }) {
  const rows = [];
  const seen = new Set();
  for (const item of items) {
    const productId = productIdOfItem(brand, item);
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    rows.push({
      product_id: productId,
      brand,
      line_key: `${tag.group}:${tag.value}`,
      line_label: tag.label,
      recorded_at: nowIso,
    });
  }
  return rows;
}

// 「一部店舗商品」(一部店舗のみの取り扱い)。一覧APIの representative.flags.productFlags に
// サイト自身の表示名として入っている。product_lines に、ラインとは別のキーで記録する。
export const PARTIAL_STORE_FLAG_NAME = '一部店舗商品';
export const PARTIAL_STORE_LINE_KEY = 'flag:partial-store';
export const PARTIAL_STORE_LABEL = '一部店舗';

export function isPartialStoreItem(item) {
  const flags = item?.representative?.flags?.productFlags ?? item?.flags?.productFlags ?? [];
  return flags.some((f) => f?.name === PARTIAL_STORE_FLAG_NAME);
}

export function partialStoreRows({ brand, items, nowIso }) {
  const rows = [];
  const seen = new Set();
  for (const item of items) {
    if (!isPartialStoreItem(item)) continue;
    const productId = productIdOfItem(brand, item);
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    rows.push({
      product_id: productId,
      brand,
      line_key: PARTIAL_STORE_LINE_KEY,
      line_label: PARTIAL_STORE_LABEL,
      recorded_at: nowIso,
    });
  }
  return rows;
}
