/**
 * Financial calculations: rounding, trip amounts, VAT-inclusive net conversion,
 * running balances, statements and period locking.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DomainError, OWNER_COMPANY_NAME, STANDARD_VAT_RATE, accountTotals, activeMonths, companyForPrint, isDefaultCompanyName, addAccountTransaction, balanceStatus, buildTimeline,
  computeClientBalances, computeStatement, computeTripAmounts, createAccount, createPayment,
  createSettlementPayment, createTrip, effectiveVatRate, netFromGross, normalizeSettings, roundMoney,
  splitVatInclusive, summarizeLedger, updateTrip, withRunningBalance
} from '../../src/core/domain.js';

const NOW = new Date('2026-10-11T09:00:00Z');

describe('roundMoney', () => {
  test('rounds half-up to halalas despite binary float error', () => {
    assert.equal(roundMoney(1.005), 1.01);
    assert.equal(roundMoney(2.675), 2.68);
    assert.equal(roundMoney(0.1 + 0.2), 0.3);
  });
  test('is symmetric for negatives and never returns -0', () => {
    assert.equal(roundMoney(-1.005), -1.01);
    assert.ok(Object.is(roundMoney(-0.001), 0));
  });
  test('maps non-finite input to 0', () => {
    assert.equal(roundMoney('abc'), 0);
    assert.equal(roundMoney(Infinity), 0);
  });
});

describe('computeTripAmounts', () => {
  test('applies VAT on the subtotal', () => {
    assert.deepEqual(computeTripAmounts(3, 100, 15), { subtotal: 300, vatAmount: 45, total: 345 });
  });
  test('without VAT total equals subtotal', () => {
    assert.deepEqual(computeTripAmounts(7, 0.1, 0), { subtotal: 0.7, vatAmount: 0, total: 0.7 });
  });
});

describe('VAT-inclusive net conversion', () => {
  test('1,150 at 15% splits into 1,000 net + 150 VAT', () => {
    assert.deepEqual(splitVatInclusive(1150, 15), { gross: 1150, net: 1000, vat: 150, rate: 15 });
  });
  test('defaults to the 15% standard rate', () => {
    assert.equal(STANDARD_VAT_RATE, 15);
    assert.equal(netFromGross(115), 100);
  });
  test('accepts formatted strings with thousands separators', () => {
    assert.equal(netFromGross('1,150'), 1000);
    assert.equal(netFromGross(' 2300 ', '15'), 2000);
  });
  test('net + VAT always reconstructs the gross exactly', () => {
    for (let cents = 0; cents <= 500_000; cents += 137) {
      const gross = cents / 100;
      for (const rate of [5, 15, 12.5]) {
        const { net, vat } = splitVatInclusive(gross, rate);
        assert.equal(roundMoney(net + vat), gross, `gross ${gross} @ ${rate}%`);
        // Re-applying VAT to the net lands within one halala of the original gross.
        assert.ok(Math.abs(roundMoney(net * (1 + rate / 100)) - gross) <= 0.011, `round-trip ${gross} @ ${rate}%`);
      }
    }
  });
  test('rate 0 leaves the amount unchanged', () => {
    assert.deepEqual(splitVatInclusive(99.99, 0), { gross: 99.99, net: 99.99, vat: 0, rate: 0 });
  });
  test('rejects invalid amounts and rates', () => {
    assert.throws(() => splitVatInclusive(-1, 15), DomainError);
    assert.throws(() => splitVatInclusive('abc', 15), DomainError);
    assert.throws(() => splitVatInclusive(100, 101), DomainError);
    assert.throws(() => splitVatInclusive(100, -5), DomainError);
  });
  test('deducted net price round-trips through a VAT-enabled trip', () => {
    const net = netFromGross(575, 15);
    const trip = createTrip({ client: 'أ', material: 'رمل', date: '2026-10-11', count: 1, price: net }, { vatRate: 15, now: NOW });
    assert.equal(trip.price, 500);
    assert.equal(trip.total, 575);
  });
});

describe('trips', () => {
  const base = { client: 'مؤسسة الريان', material: 'رمل احمر', date: '2026-10-05', count: 2, price: 250 };

  test('createTrip snapshots the VAT rate and computes totals', () => {
    const trip = createTrip(base, { vatRate: 15, now: NOW });
    assert.equal(trip.subtotal, 500);
    assert.equal(trip.vatAmount, 75);
    assert.equal(trip.total, 575);
    assert.equal(trip.vatRate, 15);
    assert.ok(Object.isFrozen(trip));
  });
  test('updateTrip keeps the original VAT snapshot', () => {
    const trip = createTrip(base, { vatRate: 15, now: NOW });
    const updated = updateTrip(trip, { count: 4 }, { vatRate: 0, now: NOW });
    assert.equal(updated.vatRate, 15);
    assert.equal(updated.total, 1150);
    assert.equal(updated.id, trip.id);
  });
  test('validates client registration, count and price', () => {
    assert.throws(() => createTrip(base, { clients: ['غيره'] }), /العميل غير مسجل/);
    assert.throws(() => createTrip({ ...base, count: 1.5 }), DomainError);
    assert.throws(() => createTrip({ ...base, price: -1 }), DomainError);
    assert.throws(() => createTrip({ ...base, date: '2026-02-30' }), DomainError);
  });
  test('locked periods reject inserts, edits and moves', () => {
    assert.throws(() => createTrip(base, { lockedThrough: '2026-10' }), err => err.code === 'locked');
    const trip = createTrip(base, { now: NOW });
    assert.throws(() => updateTrip(trip, { date: '2026-09-30' }, { lockedThrough: '2026-09' }), err => err.code === 'locked');
  });
});

describe('ledger and balances', () => {
  const trips = [
    createTrip({ client: 'أ', material: 'رمل', date: '2026-09-20', count: 1, price: 1000 }, { now: new Date('2026-09-20T08:00:00Z') }),
    createTrip({ client: 'أ', material: 'رمل', date: '2026-10-02', count: 2, price: 500 }, { now: new Date('2026-10-02T08:00:00Z') }),
    createTrip({ client: 'ب', material: 'بحص', date: '2026-10-03', count: 1, price: 300 }, { now: new Date('2026-10-03T08:00:00Z') })
  ];
  const payments = [
    createPayment({ client: 'أ', amount: 400, date: '2026-09-25' }, { now: new Date('2026-09-25T08:00:00Z') }),
    createPayment({ client: 'أ', amount: 1000, date: '2026-10-02' }, { now: new Date('2026-10-02T09:00:00Z') })
  ];

  test('timeline is chronological with same-day creation order', () => {
    const timeline = buildTimeline(trips, payments);
    assert.deepEqual(timeline.map(entry => [entry.date, entry.kind]), [
      ['2026-09-20', 'trip'], ['2026-09-25', 'payment'], ['2026-10-02', 'trip'], ['2026-10-02', 'payment'], ['2026-10-03', 'trip']
    ]);
  });
  test('running balance and summary agree', () => {
    const forA = buildTimeline(trips.filter(t => t.client === 'أ'), payments);
    assert.deepEqual(withRunningBalance(forA).map(entry => entry.balance), [1000, 600, 1600, 600]);
    assert.deepEqual(summarizeLedger(forA), { deliveries: 2000, payments: 1400, balance: 600, tripCount: 2, paymentCount: 2 });
  });
  test('monthly statement carries the opening balance forward', () => {
    const statement = computeStatement({ client: 'أ', month: '2026-10', trips, payments });
    assert.equal(statement.openingBalance, 600);
    assert.equal(statement.deliveries, 1000);
    assert.equal(statement.paymentsTotal, 1000);
    assert.equal(statement.closingBalance, 600);
    assert.match(statement.reference, /^INV-202610-\d{3}$/);
  });
  test('client balances combine transport and manual ledgers', () => {
    let account = createAccount('أ', { now: NOW });
    account = addAccountTransaction(account, { type: 'debt', amount: 250, date: '2026-10-01' }, { now: NOW });
    account = addAccountTransaction(account, { type: 'payment', amount: 50, date: '2026-10-04' }, { now: NOW });
    assert.deepEqual(accountTotals(account), { debt: 250, paid: 50, balance: 200 });
    const rows = computeClientBalances({ clients: ['أ', 'ب'], trips, payments, accounts: [account] });
    const a = rows.find(row => row.client === 'أ');
    assert.equal(a.transportBalance, 600);
    assert.equal(a.manualBalance, 200);
    assert.equal(a.totalBalance, 800);
    assert.equal(balanceStatus(a.totalBalance), 'due');
    assert.equal(balanceStatus(-0.001), 'settled');
  });
  test('settlement payment zeroes a due balance and refuses otherwise', () => {
    const settlement = createSettlementPayment('أ', 600, { now: NOW, date: '2026-10-11' });
    assert.equal(settlement.amount, 600);
    assert.throws(() => createSettlementPayment('أ', 0), err => err.code === 'nothing_due');
  });
});

describe('entry order within a day', () => {
  const at = time => ({ now: new Date(`2026-10-05T${time}:00Z`) });
  const trip = (time, client = 'أ') => createTrip({ client, material: 'رمل', date: '2026-10-05', price: 100 }, at(time));
  const payment = (time, amount = 50) => createPayment({ client: 'أ', amount, date: '2026-10-05' }, at(time));
  const order = timeline => timeline.map(entry => `${entry.kind}@${entry.record.createdAt.slice(11, 16)}`);

  test('a trip followed by a payment keeps that sequence, and vice versa', () => {
    assert.deepEqual(order(buildTimeline([trip('09:00')], [payment('09:05')])), ['trip@09:00', 'payment@09:05']);
    assert.deepEqual(order(buildTimeline([trip('09:05')], [payment('09:00')])), ['payment@09:00', 'trip@09:05']);
  });
  test('interleaved same-day entries come out exactly as entered, whatever the input order', () => {
    const trips = [trip('08:00'), trip('10:00'), trip('12:00')];
    const payments = [payment('09:00'), payment('11:00')];
    const expected = ['trip@08:00', 'payment@09:00', 'trip@10:00', 'payment@11:00', 'trip@12:00'];
    assert.deepEqual(order(buildTimeline(trips, payments)), expected);
    assert.deepEqual(order(buildTimeline([...trips].reverse(), [...payments].reverse())), expected);
  });
  test('the transaction date still wins over entry time (back-dated entries)', () => {
    const backdated = createPayment({ client: 'أ', amount: 10, date: '2026-10-04' }, at('23:00'));
    assert.equal(buildTimeline([trip('08:00')], [backdated])[0].kind, 'payment');
  });
  test('editing a trip keeps its original position', () => {
    const first = trip('08:00');
    const later = payment('09:00');
    const edited = updateTrip(first, { count: 3 }, at('17:00'));
    assert.deepEqual(buildTimeline([edited], [later]).map(entry => entry.kind), ['trip', 'payment']);
  });
  test('legacy records without createdAt fall back to the timestamp in their id', () => {
    const legacyPayment = { id: 'payment_1759654800000_ab12cd', client: 'أ', amount: 5, date: '2026-10-05' }; // 09:00Z
    const legacyTrip = { id: 'trip_1759651200000_zz', client: 'أ', total: 5, date: '2026-10-05' }; // 08:00Z
    assert.deepEqual(buildTimeline([legacyTrip], [legacyPayment]).map(entry => entry.kind), ['trip', 'payment']);
  });
  test('ties on createdAt fall back to the id timestamp, not alphabetical prefix', () => {
    const stamp = '2026-10-05T09:00:00.000Z';
    const t = { id: 'trip_1759654800001_a', createdAt: stamp, client: 'أ', total: 1, date: '2026-10-05' };
    const p = { id: 'payment_1759654800002_b', createdAt: stamp, client: 'أ', amount: 1, date: '2026-10-05' };
    assert.deepEqual(buildTimeline([t], [p]).map(entry => entry.kind), ['trip', 'payment']);
  });
  test('activeMonths lists distinct months with data, newest first', () => {
    const months = activeMonths({ trips: [{ date: '2026-09-30' }, { date: '2026-10-01' }, { date: 'bad' }], payments: [{ date: '2025-12-31' }, { date: '2026-10-09' }] });
    assert.deepEqual(months, ['2026-10', '2026-09', '2025-12']);
  });
});

describe('settings', () => {
  test('normalizeSettings clamps and sanitizes', () => {
    const settings = normalizeSettings({ vatRate: 250, taxNumber: '30-0123 4567', backupReminderDays: 999, lockedThrough: 'bad' });
    assert.equal(settings.vatRate, 15);
    assert.equal(settings.taxNumber, '3001234567');
    assert.equal(settings.backupReminderDays, 90);
    assert.equal(settings.lockedThrough, '');
  });
  test('new installs get a generic company name; saved names are kept', () => {
    assert.equal(normalizeSettings({}).companyName, 'اسم الشركة');
    assert.equal(normalizeSettings({ companyName: '   ' }).companyName, 'اسم الشركة');
    assert.equal(normalizeSettings({ companyName: '  مؤسسة أخرى ' }).companyName, 'مؤسسة أخرى');
    assert.ok(isDefaultCompanyName('اسم الشركة') && isDefaultCompanyName('') && !isDefaultCompanyName('مؤسسة أخرى'));
  });
  test("the owner's former company names map to the owner's current name", () => {
    assert.equal(normalizeSettings({ companyName: 'شركة سعد فيصل القحطاني لتوريد مواد البناء' }).companyName, OWNER_COMPANY_NAME);
    assert.equal(normalizeSettings({ companyName: 'شركة سعد القحطاني' }).companyName, OWNER_COMPANY_NAME);
  });
  test('printed documents leave out the placeholder name', () => {
    assert.deepEqual(companyForPrint({ companyName: 'اسم الشركة', taxNumber: '3001' }), { name: '', taxNumber: '3001', phone: '' });
    assert.equal(companyForPrint({ companyName: 'مؤسسة أخرى' }).name, 'مؤسسة أخرى');
  });
  test('effectiveVatRate is 0 unless VAT is enabled', () => {
    assert.equal(effectiveVatRate({ vatEnabled: false, vatRate: 15 }), 0);
    assert.equal(effectiveVatRate({ vatEnabled: true, vatRate: 15 }), 15);
  });
});
