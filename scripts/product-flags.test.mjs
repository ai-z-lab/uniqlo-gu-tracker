import test from 'node:test';
import assert from 'node:assert/strict';
import { productFlagRows } from './product-flags.mjs';

test('productFlagRows: price_events と同じ product_id で、重複を除く', () => {
  const items = [
    { productId: 'E1-000', priceGroup: '00' },
    { productId: 'E1-000', priceGroup: '00' },
    { productId: 'E2-000', priceGroup: '00' },
    {},
  ];
  const rows = productFlagRows({ brand: 'gu', items, flagKey: 'limitedStore', nowIso: '2026-11-17T00:00:00Z' });
  assert.deepEqual(rows, [
    { product_id: 'gu-E1-000-00', brand: 'gu', flag_key: 'limitedStore', checked_at: '2026-11-17T00:00:00Z' },
    { product_id: 'gu-E2-000-00', brand: 'gu', flag_key: 'limitedStore', checked_at: '2026-11-17T00:00:00Z' },
  ]);
});

test('productFlagRows: 空でも落ちない', () => {
  assert.deepEqual(productFlagRows({ brand: 'uniqlo', items: undefined, flagKey: 'onlineOnly', nowIso: 'x' }), []);
});
