import test from 'node:test';
import assert from 'node:assert/strict';
import { lineTagsFrom, productLineRows } from './product-lines.mjs';

test('lineTagsFrom: ライン用のグループだけを取り出す', () => {
  const tags = [
    { groupName: 'category', values: [{ name: 'tops', localizationName: 'トップス' }] },
    { groupName: 'special-collection', values: [{ name: 'uniqlo-c', localizationName: 'UNIQLO : C' }, { name: 'uniqlo-u', localizationName: 'Uniqlo U' }] },
    { groupName: 'ut', values: [{ name: 'yoasobi-26ss', localizationName: 'YOASOBI（UT）' }] },
  ];
  assert.deepEqual(lineTagsFrom(tags), [
    { group: 'special-collection', value: 'uniqlo-c', label: 'UNIQLO : C' },
    { group: 'special-collection', value: 'uniqlo-u', label: 'Uniqlo U' },
    { group: 'ut', value: 'yoasobi-26ss', label: 'YOASOBI（UT）' },
  ]);
});

test('lineTagsFrom: タグが無くても空を返す', () => {
  assert.deepEqual(lineTagsFrom(undefined), []);
});

test('productLineRows: price_events と同じ product_id で、重複を除く', () => {
  const tag = { group: 'special-collection', value: 'uniqlo-c', label: 'UNIQLO : C' };
  const items = [
    { productId: 'E487258-000', priceGroup: '00' },
    { productId: 'E487258-000', priceGroup: '00' },
    { productId: 'E492123-000', priceGroup: '00' },
    {},
  ];
  const rows = productLineRows({ brand: 'uniqlo', items, tag, nowIso: '2026-11-05T00:00:00Z' });
  assert.deepEqual(rows.map((r) => r.product_id), ['uniqlo-E487258-000-00', 'uniqlo-E492123-000-00']);
  assert.equal(rows[0].line_key, 'special-collection:uniqlo-c');
  assert.equal(rows[0].line_label, 'UNIQLO : C');
});
