import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogSourcesFrom, productIdOfItem, currentPriceOfItem, regularPriceRows } from './regular-prices.mjs';

const item = (productId, promo, priceGroup = '00', base = promo) => ({
  productId,
  priceGroup,
  prices: { base: { value: base }, promo: { value: promo }, isDualPrice: false },
});

test('catalogSourcesFrom: 値下げソースだけから、flagCodes を空にした全商品ソースを作る', () => {
  const sources = [
    { id: 'uniqlo-sale-women', brand: 'uniqlo', gender: 'women', listingType: 'sale', api: { genderIds: [1071], flagCodes: ['discount'] } },
    { id: 'uniqlo-limited-women', brand: 'uniqlo', gender: 'women', listingType: 'limited', api: { genderIds: [1071], flagCodes: ['limitedOffer'] } },
    { id: 'gu-appmember-women', brand: 'gu', gender: 'women', listingType: 'limited', api: { genderIds: [2256], flagCodes: ['appmemberLimited'] } },
    { id: 'gu-sale-women', brand: 'gu', gender: 'women', listingType: 'sale', api: { genderIds: [2256], flagCodes: ['discount'] } },
  ];
  const out = catalogSourcesFrom(sources);
  assert.deepEqual(out.map((s) => s.id), ['uniqlo-sale-women-catalog', 'gu-sale-women-catalog']);
  assert.deepEqual(out[0].api, { genderIds: [1071], flagCodes: [] });
  assert.equal(out[0].saleSourceId, 'uniqlo-sale-women');
  assert.equal(out[0].pageSize, 100);
});

test('catalogSourcesFrom: 同じブランド・同じ条件は1つにまとめる', () => {
  const s = { brand: 'uniqlo', listingType: 'sale', api: { genderIds: [1071], flagCodes: ['discount'] } };
  assert.equal(catalogSourcesFrom([{ ...s, id: 'a' }, { ...s, id: 'b' }]).length, 1);
});

test('productIdOfItem: price_events.product_id と同じ形', () => {
  assert.equal(productIdOfItem('uniqlo', { productId: 'E489091-000', priceGroup: '00' }), 'uniqlo-E489091-000-00');
  assert.equal(productIdOfItem('gu', { productId: 'E360542-000', priceGroup: '01' }), 'gu-E360542-000-01');
  assert.equal(productIdOfItem('gu', { productId: 'E360542-000' }), 'gu-E360542-000');
  assert.equal(productIdOfItem('gu', {}), null);
});

test('currentPriceOfItem: promo を優先し、読めない・異常値は null', () => {
  assert.equal(currentPriceOfItem(item('E1-000', 2990)), 2990);
  assert.equal(currentPriceOfItem({ prices: { base: { value: 3990 } } }), 3990);
  assert.equal(currentPriceOfItem({ prices: { promo: { value: '1990' } } }), 1990);
  assert.equal(currentPriceOfItem({}), null);
  assert.equal(currentPriceOfItem(item('E1-000', 0)), null);
  assert.equal(currentPriceOfItem(item('E1-000', 5_000_000)), null);
});

test('regularPriceRows: 値下げ中の商品は書かない(値下げ前の通常価格を壊さない)', () => {
  const items = [item('E1-000', 3990), item('E2-000', 2990)];
  const rows = regularPriceRows({
    brand: 'uniqlo',
    items,
    discountedIds: new Set(['uniqlo-E2-000-00']),
    known: new Map(),
    nowIso: '2026-10-29T00:00:00Z',
  });
  assert.deepEqual(rows.map((r) => [r.product_id, r.regular_price]), [['uniqlo-E1-000-00', 3990]]);
});

test('regularPriceRows: 同じ価格は書き直さない・変わった価格は書く・重複は1つ', () => {
  const items = [item('E1-000', 3990), item('E2-000', 4990), item('E2-000', 4990)];
  const rows = regularPriceRows({
    brand: 'uniqlo',
    items,
    discountedIds: new Set(),
    known: new Map([['uniqlo-E1-000-00', 3990], ['uniqlo-E2-000-00', 3990]]),
    nowIso: '2026-10-29T00:00:00Z',
  });
  assert.deepEqual(rows.map((r) => [r.product_id, r.regular_price]), [['uniqlo-E2-000-00', 4990]]);
});
