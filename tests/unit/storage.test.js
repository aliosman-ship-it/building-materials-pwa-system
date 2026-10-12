/**
 * Data migration and IndexedDB storage integrity (via fake-indexeddb).
 */

import 'fake-indexeddb/auto';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, STANDARD_MATERIALS, createTrip, hiddenCatalogEntry, normalizeDataset } from '../../src/core/domain.js';
import { createPinRecord } from '../../src/core/security.js';
import { Database, LEGACY_KEYS, StorageError, migrateFromLegacy, readLegacySnapshot } from '../../src/js/storage-adapter.js';

let dbCounter = 0;
const openDb = () => Database.open({ name: `dad_test_${process.pid}_${dbCounter++}` });

/** Minimal Web Storage stand-in. */
class MemoryStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
}

const LEGACY = {
  trips: [
    { id: 'trip_1759300000000_a', date: '2026-10-01', client: 'الريان', material: 'رمل احمر', count: '2', price: '400', total: '800' },
    { id: 'trip_1759300000000_a', date: '2026-10-01', client: 'الريان', material: 'بحص', count: 1, price: 600, total: 600 },
    { id: 'pay_old', type: 'payment', client: 'الريان', amount: 300, date: '2026-10-02' },
    { client: '', material: 'بحص' },
    'garbage',
    { id: 'trip_1759400000000_b', client: 'النخبة', material: 'دفان', count: 1, total: 250 }
  ],
  payments: [{ id: 'p1', client: 'النخبة', amount: '100', date: '2026-10-03', notes: 'سند 7' }, { client: 'x', amount: -5 }],
  clients: ['الريان'],
  materials: [{ name: 'رمل احمر', unit: 'تريلا 20م', defaultPrice: 400 }, { name: '', defaultPrice: 1 }],
  clientCatalogs: { 'الريان': [{ name: 'رمل احمر', unit: 'تريلا 20م', defaultPrice: 380 }] },
  accounts: [{ id: 'acc1', client: 'الريان', total: 1000, paid: 250, createdAt: '2026-09-01T10:00:00.000Z' }],
  trucks: ['1234 أ ب ج']
};

describe('normalizeDataset (legacy migration)', () => {
  const { dataset, report } = normalizeDataset(LEGACY, { now: new Date('2026-10-11T00:00:00Z') });

  test('detects the legacy format and counts dropped records', () => {
    assert.equal(report.format, 'legacy');
    assert.deepEqual(report.dropped, { trips: 2, payments: 1, materials: 1, catalogs: 0, accounts: 0, transactions: 0 });
  });
  test('legacy totals stay authoritative and duplicate ids are re-keyed', () => {
    assert.equal(dataset.trips.length, 3);
    assert.equal(new Set(dataset.trips.map(t => t.id)).size, 3);
    const first = dataset.trips.find(t => t.material === 'رمل احمر');
    assert.deepEqual([first.count, first.price, first.total, first.subtotal], [2, 400, 800, 800]);
  });
  test('missing dates fall back to the id timestamp with a warning', () => {
    const undated = dataset.trips.find(t => t.client === 'النخبة');
    assert.match(undated.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(report.warnings.length, 1);
  });
  test('payments embedded in the trips array are extracted', () => {
    assert.deepEqual(dataset.payments.map(p => [p.client, p.amount]).sort(), [['الريان', 300], ['النخبة', 100]]);
    assert.equal(dataset.payments.find(p => p.id === 'p1').note, 'سند 7');
  });
  test('legacy account totals become opening transactions', () => {
    const [account] = dataset.accounts;
    assert.deepEqual(account.transactions.map(tx => [tx.type, tx.amount]), [['debt', 1000], ['payment', 250]]);
  });
  test('client catalogs map to flat catalog entries and every referenced client exists', () => {
    assert.deepEqual(dataset.catalogs.map(c => [c.client, c.name, c.defaultPrice]), [['الريان', 'رمل احمر', 380]]);
    assert.deepEqual([...dataset.clients.map(c => c.name)].sort(), ['الريان', 'النخبة']);
    assert.deepEqual(dataset.trucks, [{ plate: '1234 أ ب ج' }]);
  });
  test('rejects payloads that are not backups', () => {
    assert.throws(() => normalizeDataset(null), DomainError);
    assert.throws(() => normalizeDataset({ foo: 1 }), DomainError);
  });
  test('current backups keep hidden catalog flags and never import private settings', () => {
    const backup = {
      app: 'dad-transport',
      data: {
        trips: [], payments: [], clients: [{ name: 'أ' }], materials: [...STANDARD_MATERIALS],
        catalogs: [hiddenCatalogEntry('أ', STANDARD_MATERIALS[0])],
        settings: [{ key: 'vatEnabled', value: true }, { key: 'pin', value: { hash: 'x' } }, { key: 'pinAttempts', value: { count: 3 } }]
      }
    };
    const { dataset: restored, report: info } = normalizeDataset(backup);
    assert.equal(info.format, 'current');
    assert.equal(restored.catalogs[0].hidden, true);
    assert.equal(restored.settings.vatEnabled, true);
    assert.equal('pin' in restored.settings, false);
    assert.equal('pinAttempts' in restored.settings, false);
  });
});

describe('IndexedDB storage', () => {
  test('migrateFromLegacy is non-destructive, idempotent and moves the PIN', async () => {
    const db = await openDb();
    const pin = await createPinRecord('2468');
    const storage = new MemoryStorage(Object.fromEntries([
      ...Object.entries(LEGACY).map(([key, value]) => [LEGACY_KEYS[key], JSON.stringify(value)]),
      [LEGACY_KEYS.pin, JSON.stringify(pin)]
    ]));
    const before = JSON.stringify([...storage.map]);

    const first = await migrateFromLegacy(db, { storage });
    assert.equal(first.status, 'migrated');
    assert.equal(first.pinMigrated, true);
    assert.equal(first.written.trips, 3);
    assert.equal(JSON.stringify([...storage.map]), before, 'legacy keys must stay untouched');

    assert.equal((await migrateFromLegacy(db, { storage })).status, 'skipped');
    const forced = await migrateFromLegacy(db, { storage, force: true });
    assert.equal(forced.status, 'migrated');
    assert.equal(forced.pinMigrated, false);

    const snapshot = await db.loadAll();
    assert.equal(snapshot.trips.length, 3, 'trips with missing or duplicate legacy ids must not duplicate on re-run');
    assert.equal(snapshot.payments.length, 2, 'payments must not duplicate on re-run');
    assert.equal(snapshot.accounts.length, 1);
    assert.equal(snapshot.accounts[0].transactions.length, 2, 'account transactions must not duplicate');
    assert.deepEqual((await db.getSetting('pin')).hash, pin.hash);
    db.close();
  });

  test('readLegacySnapshot reports unreadable keys instead of throwing', t => {
    const logged = t.mock.method(console, 'error', () => undefined);
    const snapshot = readLegacySnapshot(new MemoryStorage({ [LEGACY_KEYS.trips]: '{not json' }));
    assert.deepEqual(snapshot.errors, [LEGACY_KEYS.trips]);
    assert.equal(snapshot.found, false);
    assert.equal(logged.mock.callCount(), 1);
  });

  test('seeding only happens on an empty catalog', async () => {
    const db = await openDb();
    assert.equal(await db.seedMaterials(STANDARD_MATERIALS), true);
    assert.equal(await db.seedMaterials(STANDARD_MATERIALS), false);
    assert.equal((await db.loadAll()).materials.length, STANDARD_MATERIALS.length);
    db.close();
  });

  test('a failing transaction rolls back every write', async () => {
    const db = await openDb();
    const trip = createTrip({ client: 'أ', material: 'رمل', date: '2026-10-01', price: 10 });
    await assert.rejects(db.run(['trips', 'trucks'], 'readwrite', stores => {
      stores.trips.put(trip);
      stores.trucks.put({ plate: 'X' });
      throw new Error('boom');
    }), StorageError);
    const snapshot = await db.loadAll();
    assert.equal(snapshot.trips.length, 0);
    assert.equal(snapshot.trucks.length, 0);
    db.close();
  });

  test('duplicate client names are rejected by the store', async () => {
    const db = await openDb();
    await db.clients.add({ name: 'أ', createdAt: '' });
    await assert.rejects(db.clients.add({ name: 'أ', createdAt: '' }), err => err instanceof StorageError && /مكرر/.test(err.userMessage));
    db.close();
  });

  test('backup excludes the PIN and restores losslessly, including hidden price-list entries', async () => {
    const db = await openDb();
    await db.seedMaterials(STANDARD_MATERIALS);
    await db.addClient('أ', { id: 'account_1', client: 'أ', transactions: [], createdAt: '', updatedAt: '' });
    await db.catalogs.put(hiddenCatalogEntry('أ', STANDARD_MATERIALS[1]));
    await db.saveTrip(createTrip({ client: 'أ', material: 'بحص', date: '2026-10-01', price: 600, truck: '55 ب' }));
    await db.setSettings({ pin: await createPinRecord('1234'), pinAttempts: { count: 2 }, vatEnabled: true, _internal: 1 });

    const backup = await db.exportBackup();
    const keys = backup.data.settings.map(row => row.key);
    assert.ok(!keys.includes('pin') && !keys.includes('pinAttempts') && !keys.includes('_internal'));

    const target = await openDb();
    const { dataset } = normalizeDataset(JSON.parse(JSON.stringify(backup)));
    await target.replaceAll(dataset);
    const [a, b] = await Promise.all([db.loadAll(), target.loadAll()]);
    assert.deepEqual(b.trips, a.trips);
    assert.deepEqual(b.catalogs, a.catalogs);
    assert.deepEqual(b.trucks, ['55 ب']);
    assert.equal((await target.getSettings()).vatEnabled, true);
    assert.equal(await target.getSetting('pin'), undefined);
    db.close();
    target.close();
  });

  test('deleteClient removes the client price list and empty account atomically', async () => {
    const db = await openDb();
    await db.addClient('أ', { id: 'account_2', client: 'أ', transactions: [], createdAt: '', updatedAt: '' });
    await db.catalogs.put(hiddenCatalogEntry('أ', STANDARD_MATERIALS[0]));
    await db.deleteClient('أ');
    const snapshot = await db.loadAll();
    assert.deepEqual([snapshot.clients.length, snapshot.catalogs.length, snapshot.accounts.length], [0, 0, 0]);
    db.close();
  });
});
