/**
 * Daily work & petty-cash sheet: calculations, validation and the isolated
 * localStorage adapter.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  carriedOpeningCash, computeDailyTotals, createDailySheet, dateParts, filterSheets, findCashBreaks, formatDayLabel,
  sheetMonths, shiftISODate, summarizeSheets, typeSuggestions, weekdayName
} from '../../src/core/daily.js';
import { formatHijri, normalizeDigits, parseAmount, parseDate, parseLocalDate } from '../../src/core/format.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DAILY_BACKUP_KIND, DAILY_STORAGE_KEY, DailyStore } from '../../src/js/daily-storage.js';
import { LEGACY_KEYS } from '../../src/js/storage-adapter.js';

/** Minimal Web Storage stand-in. */
class MemoryStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
}

const line = (amount, extra = {}) => ({ type: 'بضاعة', name: 'صنف', count: '', amount, ...extra });

const sheet = (date, overrides = {}) => createDailySheet({
  date, daySales: '1000', nightSales: '500', purchases: [line('300')], expenses: [line('120.5', { type: 'كهرباء' })],
  openingCash: '200', withdrawals: '100', notes: '', ...overrides
});

describe('computeDailyTotals', () => {
  test('follows the paper-sheet formulas', () => {
    const t = computeDailyTotals(sheet('2026-10-12'));
    assert.equal(t.totalSales, 1500);
    assert.equal(t.totalPurchases, 300);
    assert.equal(t.totalExpenses, 120.5);
    assert.equal(t.net, 1079.5); // 1500 − (300 + 120.5)
    assert.equal(t.closingCash, 1179.5); // 200 + 1079.5 − 100
  });

  test('sums exactly to the halala (no float drift)', () => {
    const t = computeDailyTotals({ daySales: '0.1', nightSales: '0.2', purchases: Array.from({ length: 10 }, () => ({ amount: '0.1' })), expenses: [] });
    assert.equal(t.totalSales, 0.3);
    assert.equal(t.totalPurchases, 1);
    assert.equal(t.net, -0.7);
  });

  test('treats blank and malformed live input as zero', () => {
    const t = computeDailyTotals({ daySales: '', nightSales: 'abc', purchases: [{ amount: '' }], expenses: [], openingCash: '٥٠', withdrawals: null });
    assert.equal(t.totalSales, 0);
    assert.equal(t.closingCash, 50);
  });

  test('can go negative when spending exceeds sales', () => {
    const t = computeDailyTotals({ daySales: '100', purchases: [{ amount: '250' }], expenses: [], openingCash: '50', withdrawals: '20' });
    assert.equal(t.net, -150);
    assert.equal(t.closingCash, -120);
  });
});

describe('normalizeDigits (shared by every numeric field)', () => {
  test('converts Arabic-Indic and Persian digits and the Arabic decimal mark only', () => {
    assert.equal(normalizeDigits('٤٥٠٫٥'), '450.5');
    assert.equal(normalizeDigits('۱۲۳'), '123');
    assert.equal(normalizeDigits('12 أ'), '12 أ');
    assert.equal(normalizeDigits(null), '');
  });
});

describe('parseAmount', () => {
  test('accepts Western, Arabic-Indic and Persian digits with separators', () => {
    assert.equal(parseAmount('1,250.5'), 1250.5);
    assert.equal(parseAmount('١٬٢٥٠٫٥'), 1250.5);
    assert.equal(parseAmount('۱۲'), 12);
    assert.equal(parseAmount('  '), null);
    assert.ok(Number.isNaN(parseAmount('12a')));
  });
});

describe('createDailySheet validation', () => {
  test('drops untouched lines and keeps original line numbers in errors', () => {
    const result = sheet('2026-10-12', { purchases: [{ type: '', name: '', count: '', amount: '' }, line('40')] });
    assert.equal(result.purchases.length, 1);
    assert.throws(() => sheet('2026-10-12', { expenses: [{ type: '', name: '', count: '', amount: '' }, line('')] }),
      error => error.name === 'DomainError' && error.field === 'expenses.1.amount' && /السطر 2/.test(error.message));
  });

  test('requires a date and rejects negative or non-numeric amounts', () => {
    assert.throws(() => sheet('2026-02-30'), /تاريخ/);
    assert.throws(() => sheet('2026-10-12', { daySales: '-5' }), error => error.field === 'daySales');
    assert.throws(() => sheet('2026-10-12', { withdrawals: 'خمسون' }), error => error.field === 'withdrawals');
    assert.throws(() => sheet('2026-10-12', { purchases: [line('10', { type: '', name: '' })] }), error => error.field === 'purchases.0.name');
  });

  test('allows a negative opening cash carried from a deficit day', () => {
    assert.equal(sheet('2026-10-12', { openingCash: '-120' }).openingCash, -120);
  });

  test('keeps id and createdAt when editing an existing sheet', () => {
    const original = sheet('2026-10-12');
    const edited = createDailySheet({ ...original, daySales: '2000' }, { existing: original });
    assert.equal(edited.id, original.id);
    assert.equal(edited.createdAt, original.createdAt);
    assert.equal(edited.daySales, 2000);
  });
});

describe('collections', () => {
  const sheets = [
    sheet('2026-09-30', { notes: 'جرد آخر الشهر' }),
    sheet('2026-10-01'),
    sheet('2026-10-02', { openingCash: '0' }) // should be 1179.5 carried from 10-01
  ];

  test('carries the previous day closing cash forward', () => {
    assert.deepEqual(carriedOpeningCash(sheets, '2026-10-05'), { amount: 979.5, from: '2026-10-02' });
    assert.equal(carriedOpeningCash(sheets, '2026-09-01'), null);
  });

  test('flags days whose opening cash breaks the chain', () => {
    const breaks = findCashBreaks(sheets);
    assert.deepEqual([...breaks.keys()], ['2026-10-01', '2026-10-02']);
    assert.equal(breaks.get('2026-10-02').expected, 1179.5);
  });

  test('filters by month, exact day and text', () => {
    assert.equal(filterSheets(sheets, { month: '2026-10' }).length, 2);
    assert.equal(filterSheets(sheets, { month: '2026-10', date: '2026-09-30' }).length, 1);
    assert.equal(filterSheets(sheets, { search: 'كهرباء' }).length, 3);
    assert.equal(filterSheets(sheets, { search: 'جرد' }).length, 1);
    assert.deepEqual(sheetMonths(sheets), ['2026-10', '2026-09']);
  });

  test('summarizes a period with first opening and last closing', () => {
    const s = summarizeSheets(filterSheets(sheets, { month: '2026-10' }));
    assert.equal(s.days, 2);
    assert.equal(s.totalSales, 3000);
    assert.equal(s.withdrawals, 200);
    assert.equal(s.openingCash, 200);
    assert.equal(s.closingCash, 979.5);
  });

  test('learns type suggestions from past sheets', () => {
    assert.equal(typeSuggestions(sheets, 'expenses')[0], 'كهرباء');
    assert.equal(weekdayName('2026-10-12'), 'الاثنين');
  });
});

describe('DailyStore (isolated localStorage)', () => {
  test('round-trips sheets under its own key only', () => {
    const storage = new MemoryStorage({ [LEGACY_KEYS.trips]: '[]' });
    const store = new DailyStore({ storage });
    store.save(sheet('2026-10-02'));
    store.save(sheet('2026-10-01'));
    assert.deepEqual(store.list().map(item => item.date), ['2026-10-01', '2026-10-02']);
    assert.deepEqual([...storage.map.keys()].sort(), [DAILY_STORAGE_KEY, LEGACY_KEYS.trips].sort());
    assert.equal(storage.getItem(LEGACY_KEYS.trips), '[]');
  });

  test('refuses a second sheet for the same date and updates in place', () => {
    const store = new DailyStore({ storage: new MemoryStorage() });
    const first = store.save(sheet('2026-10-01'));
    assert.throws(() => store.save(sheet('2026-10-01')), error => error.name === 'StorageError' && /توجد يومية/.test(error.userMessage));
    store.save(createDailySheet({ ...first, nightSales: '0' }, { existing: first }));
    assert.equal(store.list().length, 1);
    assert.equal(store.getByDate('2026-10-01').nightSales, 0);
    assert.equal(store.delete(first.id), true);
    assert.equal(store.list().length, 0);
  });

  test('never overwrites a corrupt envelope', () => {
    const storage = new MemoryStorage({ [DAILY_STORAGE_KEY]: '{not json' });
    const store = new DailyStore({ storage });
    assert.throws(() => store.list(), error => error.name === 'StorageError');
    assert.throws(() => store.save(sheet('2026-10-01')));
    assert.equal(storage.getItem(DAILY_STORAGE_KEY), '{not json');
  });

  test('reports a full quota with an actionable message', () => {
    const storage = new MemoryStorage();
    storage.setItem = () => { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); };
    assert.throws(() => new DailyStore({ storage }).save(sheet('2026-10-01')), error => /ممتلئة/.test(error.userMessage));
  });

  test('backup restore merges by date and skips damaged records', () => {
    const source = new DailyStore({ storage: new MemoryStorage() });
    source.save(sheet('2026-10-01', { daySales: '9999' }));
    source.save(sheet('2026-10-03'));
    const backup = JSON.parse(JSON.stringify(source.exportBackup()));
    backup.sheets.push({ date: 'bad' }, 'junk');

    const target = new DailyStore({ storage: new MemoryStorage() });
    target.save(sheet('2026-10-01'));
    target.save(sheet('2026-10-02'));
    assert.deepEqual(target.previewImport(backup).replacing, 1);
    const result = target.importBackup(backup);
    assert.deepEqual(result, { imported: 2, skipped: 2, replaced: 1 });
    assert.deepEqual(target.list().map(item => item.date), ['2026-10-01', '2026-10-02', '2026-10-03']);
    assert.equal(target.getByDate('2026-10-01').daySales, 9999);
    assert.throws(() => target.previewImport({ kind: 'other', sheets: [] }), error => /ليس نسخة/.test(error.userMessage));
    assert.equal(backup.kind, DAILY_BACKUP_KIND);
  });
});

describe('sheet dates (ISO, timezone-independent)', () => {
  // Far-east/far-west zones and DST zones: a local-midnight bug would show up here.
  // Santiago, Havana and Cairo switch to DST at local midnight, so 00:00 does not exist on those days.
  const ZONES = ['UTC', 'Asia/Riyadh', 'Africa/Khartoum', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Europe/London', 'America/Santiago', 'America/Havana', 'Africa/Cairo'];
  const original = process.env.TZ;

  test('October 12 is never confused with December 10, in any timezone', () => {
    try {
      for (const zone of ZONES) {
        process.env.TZ = zone;
        assert.deepEqual(dateParts('2026-10-12'), { y: 2026, m: 10, d: 12 }, zone);
        assert.equal(weekdayName('2026-10-12'), 'الاثنين', zone);
        assert.equal(formatDayLabel('2026-10-12'), 'الاثنين 12 أكتوبر 2026', zone);
        assert.equal(weekdayName('2026-12-10'), 'الخميس', zone);
        assert.equal(formatDayLabel('2026-12-10'), 'الخميس 10 ديسمبر 2026', zone);
        assert.match(formatHijri('2026-10-12'), /^1 جمادى الأولى 1448/, zone);
        assert.match(formatHijri('2026-12-10'), /^1 رجب 1448/, zone);
        // DST change days in Europe/US.
        assert.equal(weekdayName('2026-03-29'), 'الأحد', zone);
        assert.equal(weekdayName('2026-11-01'), 'الأحد', zone);
      }
    } finally {
      process.env.TZ = original;
      if (original === undefined) delete process.env.TZ;
    }
  });

  test('day stepping crosses months, years and leap days without drifting', () => {
    try {
      for (const zone of ZONES) {
        process.env.TZ = zone;
        assert.equal(shiftISODate('2026-10-12', 1), '2026-10-13', zone);
        assert.equal(shiftISODate('2026-10-31', 1), '2026-11-01', zone);
        assert.equal(shiftISODate('2026-03-29', -1), '2026-03-28', zone);
        assert.equal(shiftISODate('2027-01-01', -1), '2026-12-31', zone);
        assert.equal(shiftISODate('2028-02-28', 1), '2028-02-29', zone);
      }
    } finally {
      process.env.TZ = original;
      if (original === undefined) delete process.env.TZ;
    }
  });

  test('rejects non-ISO and impossible dates', () => {
    for (const bad of ['12/10/2026', '10-12-2026', '2026-13-01', '2026-02-30', '2026-1-5', '']) {
      assert.equal(dateParts(bad), null, bad);
      assert.equal(weekdayName(bad), '');
      assert.equal(shiftISODate(bad, 1), '');
    }
    assert.throws(() => sheet('12/10/2026'), error => error.field === 'date');
  });

  test('parseLocalDate builds the local calendar day, unlike new Date("YYYY-MM-DD")', () => {
    try {
      process.env.TZ = 'America/Los_Angeles';
      // The classic bug this guards against: UTC midnight is still Sunday Oct 11 in Los Angeles.
      assert.equal(new Date('2026-10-12').getDate(), 11);
      const local = parseLocalDate('2026-10-12');
      assert.deepEqual([local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getDay()], [2026, 10, 12, 1]);
      assert.equal(parseDate('2026-10-12').getDate(), 12);
      assert.equal(parseLocalDate('2026-02-30'), null);
      assert.equal(parseLocalDate('12/10/2026'), null);
      for (const zone of ZONES) {
        process.env.TZ = zone;
        // Every day of a full year round-trips to the same weekday the UTC calendar gives.
        for (let day = 0; day < 366; day += 1) {
          const iso = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
          assert.equal(weekdayName(iso), ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'][new Date(Date.UTC(2026, 0, 1 + day)).getUTCDay()], `${zone} ${iso}`);
          assert.equal(shiftISODate(iso, 1), new Date(Date.UTC(2026, 0, 2 + day)).toISOString().slice(0, 10), `${zone} ${iso}+1`);
        }
      }
    } finally {
      process.env.TZ = original;
      if (original === undefined) delete process.env.TZ;
    }
  });

  test('no source file parses a date-only string with new Date()', () => {
    const files = [];
    const walk = dir => readdirSync(dir, { withFileTypes: true }).forEach(entry => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.js') && files.push(join(dir, entry.name))));
    walk(new URL('../../src', import.meta.url).pathname);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /new Date\(\s*['"`]\d{4}-\d{2}-\d{2}['"`]\s*\)/, file);
      assert.doesNotMatch(source, /new Date\(\s*(?:date|dateStr|iso|sheet\.date|form\.date)\s*\)/, file);
    }
  });
});


describe('DailyStore never loses stored records', () => {
  test('records that fail validation are kept aside through later saves and backups', () => {
    const good = sheet('2026-10-01');
    const broken = { id: 'day_x', date: '2026-10-02', daySales: 'abc' };
    const older = { ...sheet('2026-10-01'), id: 'day_dup', updatedAt: '2000-01-01T00:00:00.000Z' };
    const storage = new MemoryStorage({ [DAILY_STORAGE_KEY]: JSON.stringify({ version: 1, sheets: [good, broken, older] }) });
    const store = new DailyStore({ storage });
    assert.deepEqual(store.list().map(item => item.id), [good.id]);
    assert.equal(store.quarantinedCount(), 2);

    store.save(sheet('2026-10-03'));
    store.delete(good.id);
    const stored = JSON.parse(storage.getItem(DAILY_STORAGE_KEY));
    assert.deepEqual(stored.quarantine.map(item => item.id).sort(), ['day_dup', 'day_x']);
    assert.deepEqual(stored.quarantine.find(item => item.id === 'day_x'), broken, 'kept byte-for-byte');
    assert.equal(store.exportBackup().quarantine.length, 2);
  });
});
