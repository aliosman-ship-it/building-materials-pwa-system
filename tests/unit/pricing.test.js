/**
 * Client-specific material price lists built on top of the default catalog.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getClientMaterials, getClientPriceList, hiddenCatalogEntry, normalizeCatalogEntry, resolvePricing
} from '../../src/core/domain.js';

const materials = [
  { name: 'رمل احمر', unit: 'تريلا 20م', defaultPrice: 400 },
  { name: 'بحص', unit: 'تريلا 20م', defaultPrice: 600 },
  { name: 'دفان', unit: 'تريلا 20م', defaultPrice: 250 }
];
const catalogs = [
  normalizeCatalogEntry({ client: 'الريان', name: 'رمل احمر', unit: 'تريلا 20م', defaultPrice: 380 }),
  normalizeCatalogEntry({ client: 'الريان', name: 'حجر جبلي', unit: 'رد', defaultPrice: 900 }),
  hiddenCatalogEntry('الريان', materials[2]),
  normalizeCatalogEntry({ client: 'النخبة', name: 'بحص', unit: 'رد', defaultPrice: 550 })
];
const data = { catalogs, materials };

describe('client price lists', () => {
  test('a client sees overrides, own items and remaining defaults, but not hidden ones', () => {
    const list = getClientMaterials('الريان', data);
    assert.deepEqual(list.map(item => [item.name, item.defaultPrice, item.source]), [
      ['بحص', 600, 'global'],
      ['حجر جبلي', 900, 'client'],
      ['رمل احمر', 380, 'client']
    ]);
  });
  test('clients without entries get the full default list', () => {
    assert.deepEqual(getClientMaterials('عميل جديد', data).map(item => item.name).sort(), materials.map(m => m.name).sort());
  });
  test('price lists are isolated per client', () => {
    assert.equal(resolvePricing('النخبة', 'بحص', data).price, 550);
    assert.equal(resolvePricing('النخبة', 'بحص', data).unit, 'رد');
    assert.equal(resolvePricing('الريان', 'بحص', data).price, 600);
    assert.equal(resolvePricing('النخبة', 'رمل احمر', data).price, 400);
  });
  test('resolvePricing ignores hidden entries and falls back to the default', () => {
    assert.deepEqual(resolvePricing('الريان', 'دفان', data), { price: 250, unit: 'تريلا 20م', source: 'global' });
    assert.deepEqual(resolvePricing('الريان', 'مجهول', data), { price: 0, unit: 'رد', source: 'none' });
  });
  test('management list labels every item with its status', () => {
    const list = getClientPriceList('الريان', data);
    assert.deepEqual(Object.fromEntries(list.map(item => [item.name, [item.status, item.globalPrice]])), {
      'بحص': ['default', 600],
      'حجر جبلي': ['custom', null],
      'رمل احمر': ['override', 400],
      'دفان': ['hidden', 250]
    });
  });
  test('removing a default material keeps client overrides as client-only items', () => {
    const remaining = materials.filter(m => m.name !== 'رمل احمر');
    const list = getClientPriceList('الريان', { catalogs, materials: remaining });
    assert.equal(list.find(item => item.name === 'رمل احمر').status, 'custom');
  });
  test('hidden entries whose default no longer exists disappear', () => {
    const list = getClientPriceList('الريان', { catalogs, materials: materials.slice(0, 2) });
    assert.equal(list.some(item => item.name === 'دفان'), false);
  });
  test('catalog entries are validated and only carry hidden when true', () => {
    assert.equal('hidden' in normalizeCatalogEntry({ client: 'أ', name: 'ب', defaultPrice: 1, hidden: 'yes' }), false);
    assert.equal(hiddenCatalogEntry('أ', materials[0]).hidden, true);
    assert.throws(() => normalizeCatalogEntry({ name: 'ب', defaultPrice: 1 }), /العميل/);
    assert.throws(() => normalizeCatalogEntry({ client: 'أ', name: 'ب', defaultPrice: -3 }));
  });
});
