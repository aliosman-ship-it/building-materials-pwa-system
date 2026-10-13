/**
 * @module core/domain
 * Pure business rules for transport trips, cash receipts, client balances,
 * monthly settlements, the manual debt ledger, and period-lock immutability.
 *
 * Every function here is deterministic given its inputs (time is injectable via
 * `now`), performs no I/O, and returns frozen records so callers cannot mutate
 * persisted state by accident.
 */

import { extractTimestamp, generateId } from './id.js';
import { DEFAULT_UNIT, isISODate, isISOMonth, monthRange, parseDate, toISODate } from './format.js';

export { DEFAULT_UNIT };

/** Materials seeded on first run (prices are configured by the user). */
export const STANDARD_MATERIALS = Object.freeze([
  Object.freeze({ name: 'رمل ابيض بناء', unit: 'تريلا 20م', defaultPrice: 0 }),
  Object.freeze({ name: 'رمل احمر', unit: 'تريلا 20م', defaultPrice: 0 }),
  Object.freeze({ name: 'بحص', unit: 'تريلا 20م', defaultPrice: 0 }),
  Object.freeze({ name: 'دفان', unit: 'تريلا 20م', defaultPrice: 0 }),
  Object.freeze({ name: 'مخلفات', unit: 'رد', defaultPrice: 0 })
]);

/** Manual-ledger transaction types. */
export const ACCOUNT_TX = Object.freeze({ DEBT: 'debt', PAYMENT: 'payment' });

/** Generic placeholder shown until the user enters their own company name. */
export const DEFAULT_COMPANY_NAME = 'اسم الشركة';

/** The original owner's company; existing (grandfathered) installs keep it. */
export const OWNER_COMPANY_NAME = 'شركة علي عثمان لتوريد مواد البناء والنقليات';

/** Default application settings. */
export const DEFAULT_SETTINGS = Object.freeze({
  companyName: DEFAULT_COMPANY_NAME,
  companyPhone: '',
  companyLogo: '',
  taxNumber: '',
  vatEnabled: false,
  vatRate: 15,
  lockedThrough: '',
  showHijri: true,
  backupReminderDays: 7
});

/** Former names of the owner's company; settings holding one are renamed to OWNER_COMPANY_NAME. */
const LEGACY_COMPANY_NAMES = Object.freeze(['شركة سعد فيصل القحطاني لتوريد مواد البناء', 'شركة سعد القحطاني']);

/** Longest accepted company logo (a data URL); a 200×200 compressed image is far smaller. */
export const MAX_LOGO_LENGTH = 200_000;

/** A base64 raster-image data URL — the only form a stored company logo may take. */
const LOGO_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * True for a value that is safe to store and render as the company logo.
 * @param {unknown} value
 * @returns {value is string}
 */
export const isLogoDataUrl = value => typeof value === 'string' && value.length <= MAX_LOGO_LENGTH && LOGO_DATA_URL.test(value);

/** Keys that must never leave the device in a backup. */
export const PRIVATE_SETTING_KEYS = Object.freeze(['pin', 'pinAttempts']);

export const BALANCE_STATUS = Object.freeze({ DUE: 'due', CREDIT: 'credit', SETTLED: 'settled' });
export const BALANCE_STATUS_LABEL = Object.freeze({ due: 'عليه متبقي', credit: 'له رصيد', settled: 'خالص' });

const MONEY_EPSILON = 0.005;
const MAX_TEXT = 500;
const MAX_NAME = 80;
const MAX_COUNT = 100000;
const MAX_AMOUNT = 1e10;

/** Error raised when input violates a business rule. Safe to show to users. */
export class DomainError extends Error {
  /**
   * @param {string} message Arabic, user-facing.
   * @param {{ field?: string, code?: string }} [details]
   */
  constructor(message, { field, code = 'invalid' } = {}) {
    super(message);
    this.name = 'DomainError';
    this.field = field;
    this.code = code;
  }
}

/* ───────────────────────── primitives ───────────────────────── */

/**
 * Rounds to 2 decimals (halalas) with correct half-up behaviour for floats.
 * @param {unknown} value
 * @returns {number}
 */
export function roundMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const rounded = Math.sign(number) * Math.round((Math.abs(number) + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Recursively freezes an object graph.
 * @template T
 * @param {T} value
 * @returns {Readonly<T>}
 */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Trims, collapses whitespace and caps length.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function cleanText(value, max = MAX_TEXT) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Locale-aware equality for names (case-insensitive, whitespace-normalized).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameName(a, b) {
  return cleanText(a).toLocaleLowerCase('ar') === cleanText(b).toLocaleLowerCase('ar');
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {string} label
 * @param {{ allowZero?: boolean }} [options]
 * @returns {number}
 */
function requireAmount(value, field, label, { allowZero = false } = {}) {
  const raw = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  const number = raw === '' || raw === null || raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0) || number > MAX_AMOUNT) {
    throw new DomainError(`${label} يجب أن يكون رقماً ${allowZero ? 'صفراً أو أكبر' : 'أكبر من صفر'}.`, { field });
  }
  return roundMoney(number);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {string} label
 * @returns {string}
 */
function requireDate(value, field = 'date', label = 'التاريخ') {
  if (!isISODate(value)) throw new DomainError(`${label} غير صالح.`, { field });
  return String(value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {string} label
 * @returns {string}
 */
function requireName(value, field, label) {
  const name = cleanText(value, MAX_NAME);
  if (!name) throw new DomainError(`يرجى إدخال ${label}.`, { field });
  return name;
}

/**
 * @param {{ now?: Date }} [ctx]
 * @returns {string}
 */
const stamp = ctx => (ctx?.now instanceof Date ? ctx.now : new Date()).toISOString();

/**
 * True when the material is a waste-removal service.
 * @param {string} material
 * @returns {boolean}
 */
export const isWasteMaterial = material => String(material || '').includes('مخلفات');

/* ───────────────────────── period lock (immutability) ───────────────────────── */

/**
 * A period is locked when its month is on or before `lockedThrough` (YYYY-MM).
 * Records in locked periods are immutable: no edits, no deletions, no back-dated inserts.
 * @param {unknown} date YYYY-MM-DD or ISO timestamp.
 * @param {string} [lockedThrough]
 * @returns {boolean}
 */
export function isPeriodLocked(date, lockedThrough) {
  if (!isISOMonth(lockedThrough)) return false;
  const parsed = parseDate(date);
  if (!parsed) return false;
  return toISODate(parsed).slice(0, 7) <= lockedThrough;
}

/**
 * Throws when a date falls inside a locked period.
 * @param {unknown} date
 * @param {string} [lockedThrough]
 * @param {string} [action]
 */
export function assertPeriodOpen(date, lockedThrough, action = 'تعديل') {
  if (isPeriodLocked(date, lockedThrough)) {
    throw new DomainError(`لا يمكن ${action} حركة ضمن فترة مقفلة (حتى ${lockedThrough}). افتح الفترة من الإعدادات أولاً.`, { field: 'date', code: 'locked' });
  }
}

/* ───────────────────────── catalog & pricing ───────────────────────── */

/**
 * The global catalog is only the default template. Each client owns a price list
 * built from catalog entries that add items, override default prices, or hide
 * default items (`hidden: true`) from that client's list.
 * @typedef {{ name: string, unit: string, defaultPrice: number }} Material
 * @typedef {{ client: string, name: string, unit: string, defaultPrice: number, hidden?: boolean }} CatalogEntry
 */

/**
 * Validates a global material definition.
 * @param {Partial<Material>} input
 * @returns {Readonly<Material>}
 */
export function normalizeMaterial(input) {
  return deepFreeze({
    name: requireName(input?.name, 'name', 'اسم المادة'),
    unit: cleanText(input?.unit, 40) || DEFAULT_UNIT,
    defaultPrice: requireAmount(input?.defaultPrice ?? 0, 'defaultPrice', 'السعر الافتراضي', { allowZero: true })
  });
}

/**
 * Validates a client-specific price entry.
 * @param {Partial<CatalogEntry>} input
 * @returns {Readonly<CatalogEntry>}
 */
export function normalizeCatalogEntry(input) {
  const material = normalizeMaterial(input);
  const entry = { client: requireName(input?.client, 'client', 'اسم العميل'), ...material };
  if (input?.hidden === true) entry.hidden = true;
  return deepFreeze(entry);
}

/**
 * Catalog entry that removes a default material from one client's list.
 * @param {string} client
 * @param {Material} material
 * @returns {Readonly<CatalogEntry>}
 */
export function hiddenCatalogEntry(client, material) {
  return normalizeCatalogEntry({ client, name: material.name, unit: material.unit, defaultPrice: material.defaultPrice, hidden: true });
}

/**
 * Materials available to a client: client-specific prices override global ones by
 * name, client-only items are added, and hidden defaults are left out.
 * @param {string} client
 * @param {{ catalogs: CatalogEntry[], materials: Material[] }} sources
 * @returns {Array<Material & { source: 'client'|'global' }>}
 */
export function getClientMaterials(client, sources) {
  return getClientPriceList(client, sources)
    .filter(item => item.status !== 'hidden')
    .map(({ name, unit, defaultPrice, status }) => ({ name, unit, defaultPrice, source: status === 'default' ? /** @type {const} */ ('global') : /** @type {const} */ ('client') }));
}

/**
 * @typedef {Material & { status: 'default'|'override'|'custom'|'hidden', globalPrice: number|null }} PriceListItem
 */

/**
 * A client's full price list for management screens, including hidden defaults.
 * `override` = default item with a client price, `custom` = client-only item.
 * @param {string} client
 * @param {{ catalogs: CatalogEntry[], materials: Material[] }} sources
 * @returns {PriceListItem[]} Sorted by name.
 */
export function getClientPriceList(client, { catalogs, materials }) {
  const globals = new Map(materials.map(material => [material.name, material]));
  const entries = catalogs.filter(entry => entry.client === client);
  const seen = new Set();
  /** @type {PriceListItem[]} */
  const list = [];
  for (const entry of entries) {
    const global = globals.get(entry.name);
    seen.add(entry.name);
    const status = entry.hidden ? 'hidden' : global ? 'override' : 'custom';
    // A hidden client-only item has nothing to fall back to; drop it.
    if (status === 'hidden' && !global) continue;
    const source = status === 'hidden' ? global : entry;
    list.push({ name: entry.name, unit: source.unit, defaultPrice: source.defaultPrice, status, globalPrice: global ? global.defaultPrice : null });
  }
  for (const material of materials) {
    if (!seen.has(material.name)) list.push({ ...material, status: 'default', globalPrice: material.defaultPrice });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

/**
 * Resolves the price and unit for a client/material pair.
 * @param {string} client
 * @param {string} material
 * @param {{ catalogs: CatalogEntry[], materials: Material[] }} sources
 * @returns {{ price: number, unit: string, source: 'client'|'global'|'none' }}
 */
export function resolvePricing(client, material, { catalogs, materials }) {
  const custom = catalogs.find(entry => entry.client === client && entry.name === material && !entry.hidden);
  if (custom) return { price: custom.defaultPrice, unit: custom.unit, source: 'client' };
  const global = materials.find(entry => entry.name === material);
  if (global) return { price: global.defaultPrice, unit: global.unit, source: 'global' };
  return { price: 0, unit: DEFAULT_UNIT, source: 'none' };
}

/* ───────────────────────── trips ───────────────────────── */

/**
 * @typedef {Object} Trip
 * @property {string} id
 * @property {string} date YYYY-MM-DD
 * @property {string} client
 * @property {string} material
 * @property {string} unit
 * @property {string} truck
 * @property {number} count
 * @property {number} price Unit price before VAT.
 * @property {number} subtotal count × price
 * @property {number} vatRate Percentage snapshot at creation time.
 * @property {number} vatAmount
 * @property {number} total subtotal + vatAmount
 * @property {string} notes
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} MutationContext
 * @property {string} [lockedThrough]
 * @property {string[]} [clients] Known clients; when given, the client must exist.
 * @property {number} [vatRate] Percentage applied to new trips.
 * @property {Date} [now]
 */

/**
 * Calculates trip money fields.
 * @param {number} count
 * @param {number} price
 * @param {number} [vatRate=0]
 * @returns {{ subtotal: number, vatAmount: number, total: number }}
 */
export function computeTripAmounts(count, price, vatRate = 0) {
  const subtotal = roundMoney(count * price);
  const vatAmount = roundMoney(subtotal * (vatRate / 100));
  return { subtotal, vatAmount, total: roundMoney(subtotal + vatAmount) };
}

/**
 * Normalizes a VAT percentage.
 * @param {unknown} rate
 * @returns {number}
 */
export function normalizeVatRate(rate) {
  const number = Number(rate);
  if (!Number.isFinite(number) || number < 0 || number > 100) throw new DomainError('نسبة الضريبة يجب أن تكون بين 0 و 100.', { field: 'vatRate' });
  return roundMoney(number);
}

/** Saudi standard VAT rate, used when no explicit rate is configured. */
export const STANDARD_VAT_RATE = 15;

/**
 * Splits a VAT-inclusive amount into net and VAT. The VAT is derived as
 * gross − net so the two parts always add back up to the gross exactly.
 * @param {unknown} gross Amount including VAT.
 * @param {unknown} [rate=15] VAT percentage (0–100).
 * @returns {{ gross: number, net: number, vat: number, rate: number }}
 */
export function splitVatInclusive(gross, rate = STANDARD_VAT_RATE) {
  const vatRate = normalizeVatRate(rate);
  const total = requireAmount(gross, 'gross', 'المبلغ شامل الضريبة', { allowZero: true });
  const net = roundMoney(total / (1 + vatRate / 100));
  return { gross: total, net, vat: roundMoney(total - net), rate: vatRate };
}

/**
 * Net amount (excluding VAT) of a VAT-inclusive amount.
 * @param {unknown} gross
 * @param {unknown} [rate=15]
 * @returns {number}
 */
export const netFromGross = (gross, rate = STANDARD_VAT_RATE) => splitVatInclusive(gross, rate).net;

/**
 * Validates trip input shared by create and update.
 * @param {Record<string, unknown>} input
 * @param {MutationContext} ctx
 */
function validateTripInput(input, ctx) {
  const client = requireName(input.client, 'client', 'اسم العميل');
  if (Array.isArray(ctx.clients) && !ctx.clients.includes(client)) {
    throw new DomainError('العميل غير مسجل. أضفه من صفحة الحسابات أولاً.', { field: 'client' });
  }
  const material = requireName(input.material, 'material', 'المادة');
  const date = requireDate(input.date);
  const countRaw = Number(input.count ?? 1);
  if (!Number.isInteger(countRaw) || countRaw < 1 || countRaw > MAX_COUNT) {
    throw new DomainError('العدد يجب أن يكون رقماً صحيحاً موجباً.', { field: 'count' });
  }
  const price = requireAmount(input.price ?? 0, 'price', 'سعر الوحدة', { allowZero: true });
  return {
    client,
    material,
    date,
    count: countRaw,
    price,
    unit: cleanText(input.unit, 40) || DEFAULT_UNIT,
    truck: cleanText(input.truck, 40),
    notes: cleanText(input.notes)
  };
}

/**
 * Creates a new trip record.
 * @param {Record<string, unknown>} input
 * @param {MutationContext} [ctx]
 * @returns {Readonly<Trip>}
 */
export function createTrip(input, ctx = {}) {
  const data = validateTripInput(input, ctx);
  assertPeriodOpen(data.date, ctx.lockedThrough, 'إضافة');
  const vatRate = normalizeVatRate(ctx.vatRate ?? 0);
  const timestamp = stamp(ctx);
  return deepFreeze({
    id: generateId('trip'),
    ...data,
    ...computeTripAmounts(data.count, data.price, vatRate),
    vatRate,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

/**
 * Applies changes to an existing trip. The VAT rate snapshot is preserved so
 * changing tax settings never rewrites historical invoices.
 * @param {Trip} existing
 * @param {Record<string, unknown>} changes
 * @param {MutationContext} [ctx]
 * @returns {Readonly<Trip>}
 */
export function updateTrip(existing, changes, ctx = {}) {
  assertPeriodOpen(existing.date, ctx.lockedThrough, 'تعديل');
  const data = validateTripInput({ ...existing, ...changes }, ctx);
  assertPeriodOpen(data.date, ctx.lockedThrough, 'نقل');
  const vatRate = normalizeVatRate(existing.vatRate ?? 0);
  return deepFreeze({
    ...existing,
    ...data,
    ...computeTripAmounts(data.count, data.price, vatRate),
    vatRate,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: stamp(ctx)
  });
}

/**
 * Throws if a dated record may not be deleted.
 * @param {{ date: string }} record
 * @param {string} [lockedThrough]
 */
export function assertDeletable(record, lockedThrough) {
  assertPeriodOpen(record.date, lockedThrough, 'حذف');
}

/* ───────────────────────── cash receipts (payments) ───────────────────────── */

/**
 * @typedef {Object} Payment
 * @property {string} id
 * @property {string} client
 * @property {number} amount
 * @property {string} date
 * @property {string} note
 * @property {string} createdAt
 */

/**
 * Creates a cash receipt against a client's transport balance.
 * @param {Record<string, unknown>} input
 * @param {MutationContext} [ctx]
 * @returns {Readonly<Payment>}
 */
export function createPayment(input, ctx = {}) {
  const client = requireName(input.client, 'client', 'اسم العميل');
  if (Array.isArray(ctx.clients) && !ctx.clients.includes(client)) {
    throw new DomainError('العميل غير مسجل.', { field: 'client' });
  }
  const date = requireDate(input.date);
  assertPeriodOpen(date, ctx.lockedThrough, 'إضافة');
  return deepFreeze({
    id: generateId('payment'),
    client,
    amount: requireAmount(input.amount, 'amount', 'المبلغ'),
    date,
    note: cleanText(input.note),
    createdAt: stamp(ctx)
  });
}

/* ───────────────────────── timeline & ledger ───────────────────────── */

/**
 * @typedef {Object} TimelineEntry
 * @property {'trip'|'payment'} kind
 * @property {Trip|Payment} record
 * @property {string} date
 * @property {string} client
 * @property {number} debit
 * @property {number} credit
 * @property {number} [balance] Running balance (after `withRunningBalance`).
 */

/**
 * Entry-order key for records on the same day: the moment the user created the
 * record (createdAt, else the timestamp embedded in its id, as in legacy payments).
 * Editing a record never changes it, so edits keep their original position.
 * @param {{ createdAt?: string, id?: string }} record
 * @returns {number}
 */
export function creationOrder(record) {
  const created = Date.parse(record.createdAt || '');
  if (Number.isFinite(created)) return created;
  return extractTimestamp(record.id) ?? 0;
}

/**
 * Comparator: transaction date, then the order the user entered the records
 * (creation time, then the id's embedded timestamp), then the id as a
 * deterministic last resort. Trips and payments are interleaved by entry order.
 * @param {{ date: string, record: any }} a
 * @param {{ date: string, record: any }} b
 * @returns {number}
 */
export function compareChronological(a, b) {
  const byDate = String(a.date || '').localeCompare(String(b.date || ''));
  if (byDate) return byDate;
  const byCreation = creationOrder(a.record) - creationOrder(b.record);
  if (byCreation) return byCreation;
  const byIdTime = (extractTimestamp(a.record.id) ?? 0) - (extractTimestamp(b.record.id) ?? 0);
  if (byIdTime) return byIdTime;
  return String(a.record.id || '').localeCompare(String(b.record.id || ''), 'en', { numeric: true });
}

/**
 * Distinct YYYY-MM months that have at least one trip or payment, newest first.
 * @param {{ trips: Array<{ date: string }>, payments: Array<{ date: string }> }} data
 * @returns {string[]}
 */
export function activeMonths({ trips, payments }) {
  const months = new Set();
  for (const record of [...trips, ...payments]) {
    const month = String(record.date || '').slice(0, 7);
    if (isISOMonth(month)) months.add(month);
  }
  return [...months].sort().reverse();
}

/**
 * Merges trips and payments into one chronological ledger (oldest first).
 * @param {Trip[]} trips
 * @param {Payment[]} payments
 * @returns {TimelineEntry[]}
 */
export function buildTimeline(trips, payments) {
  const entries = [
    ...trips.map(trip => ({ kind: /** @type {const} */ ('trip'), record: trip, date: trip.date, client: trip.client, debit: roundMoney(trip.total), credit: 0 })),
    ...payments.map(payment => ({ kind: /** @type {const} */ ('payment'), record: payment, date: payment.date, client: payment.client, debit: 0, credit: roundMoney(payment.amount) }))
  ];
  return entries.sort(compareChronological);
}

/**
 * @typedef {Object} LedgerFilters
 * @property {string} [client]
 * @property {string} [material]
 * @property {string} [month] YYYY-MM
 * @property {string} [search]
 * @property {'all'|'trip'|'payment'} [kind]
 */

/**
 * Filters timeline entries.
 * @param {TimelineEntry[]} entries
 * @param {LedgerFilters} filters
 * @returns {TimelineEntry[]}
 */
export function filterTimeline(entries, filters = {}) {
  const query = cleanText(filters.search).toLocaleLowerCase('ar');
  return entries.filter(entry => {
    if (filters.client && entry.client !== filters.client) return false;
    if (filters.kind && filters.kind !== 'all' && entry.kind !== filters.kind) return false;
    if (filters.material && (entry.kind !== 'trip' || entry.record.material !== filters.material)) return false;
    if (filters.month && !String(entry.date || '').startsWith(filters.month)) return false;
    if (query) {
      const record = /** @type {any} */ (entry.record);
      const haystack = entry.kind === 'trip'
        ? [record.client, record.material, record.truck, record.notes, record.date]
        : [record.client, 'دفعة نقدية سند قبض', record.note, record.date];
      if (!haystack.join(' ').toLocaleLowerCase('ar').includes(query)) return false;
    }
    return true;
  });
}

/**
 * Adds a running balance (debit − credit) to chronologically sorted entries.
 * @param {TimelineEntry[]} entries
 * @param {number} [opening=0]
 * @returns {TimelineEntry[]}
 */
export function withRunningBalance(entries, opening = 0) {
  let balance = roundMoney(opening);
  return entries.map(entry => {
    balance = roundMoney(balance + entry.debit - entry.credit);
    return { ...entry, balance };
  });
}

/**
 * Totals for a set of timeline entries.
 * @param {TimelineEntry[]} entries
 * @returns {{ deliveries: number, payments: number, balance: number, tripCount: number, paymentCount: number }}
 */
export function summarizeLedger(entries) {
  let deliveries = 0;
  let payments = 0;
  let tripCount = 0;
  let paymentCount = 0;
  for (const entry of entries) {
    deliveries += entry.debit;
    payments += entry.credit;
    if (entry.kind === 'trip') tripCount += 1;
    else paymentCount += 1;
  }
  return { deliveries: roundMoney(deliveries), payments: roundMoney(payments), balance: roundMoney(deliveries - payments), tripCount, paymentCount };
}

/**
 * Classifies a balance.
 * @param {number} balance Positive means the client owes the company.
 * @returns {'due'|'credit'|'settled'}
 */
export function balanceStatus(balance) {
  if (balance > MONEY_EPSILON) return BALANCE_STATUS.DUE;
  if (balance < -MONEY_EPSILON) return BALANCE_STATUS.CREDIT;
  return BALANCE_STATUS.SETTLED;
}

/* ───────────────────────── manual debt ledger (accounts) ───────────────────────── */

/**
 * @typedef {{ id: string, type: 'debt'|'payment', amount: number, date: string, note: string, createdAt: string }} AccountTransaction
 * @typedef {{ id: string, client: string, transactions: AccountTransaction[], createdAt: string, updatedAt: string }} Account
 */

/**
 * Creates an empty manual account for a client.
 * @param {string} client
 * @param {{ now?: Date }} [ctx]
 * @returns {Readonly<Account>}
 */
export function createAccount(client, ctx = {}) {
  const timestamp = stamp(ctx);
  return deepFreeze({ id: generateId('account'), client: requireName(client, 'client', 'اسم العميل'), transactions: [], createdAt: timestamp, updatedAt: timestamp });
}

/**
 * Adds a debt or payment to a manual account.
 * @param {Account} account
 * @param {{ type: unknown, amount: unknown, date?: unknown, note?: unknown }} input
 * @param {MutationContext} [ctx]
 * @returns {Readonly<Account>}
 */
export function addAccountTransaction(account, input, ctx = {}) {
  if (input.type !== ACCOUNT_TX.DEBT && input.type !== ACCOUNT_TX.PAYMENT) {
    throw new DomainError('نوع المعاملة غير صالح.', { field: 'type' });
  }
  const date = requireDate(input.date ?? toISODate(ctx.now || new Date()));
  assertPeriodOpen(date, ctx.lockedThrough, 'إضافة');
  const transaction = {
    id: generateId('transaction'),
    type: input.type,
    amount: requireAmount(input.amount, 'amount', 'المبلغ'),
    date,
    note: cleanText(input.note),
    createdAt: stamp(ctx)
  };
  return deepFreeze({ ...account, transactions: [...account.transactions, transaction], updatedAt: stamp(ctx) });
}

/**
 * Removes a transaction from a manual account.
 * @param {Account} account
 * @param {string} transactionId
 * @param {MutationContext} [ctx]
 * @returns {Readonly<Account>}
 */
export function removeAccountTransaction(account, transactionId, ctx = {}) {
  const transaction = account.transactions.find(item => item.id === transactionId);
  if (!transaction) throw new DomainError('المعاملة غير موجودة.', { code: 'not_found' });
  assertPeriodOpen(transaction.date, ctx.lockedThrough, 'حذف');
  return deepFreeze({ ...account, transactions: account.transactions.filter(item => item.id !== transactionId), updatedAt: stamp(ctx) });
}

/**
 * Totals of a manual account.
 * @param {Account|undefined} account
 * @returns {{ debt: number, paid: number, balance: number }}
 */
export function accountTotals(account) {
  let debt = 0;
  let paid = 0;
  for (const transaction of account?.transactions || []) {
    if (transaction.type === ACCOUNT_TX.DEBT) debt += transaction.amount;
    else paid += transaction.amount;
  }
  return { debt: roundMoney(debt), paid: roundMoney(paid), balance: roundMoney(debt - paid) };
}

/* ───────────────────────── clients ───────────────────────── */

/**
 * Validates a new client name against existing ones.
 * @param {unknown} name
 * @param {string[]} existing
 * @returns {string}
 */
export function validateNewClient(name, existing) {
  const clean = requireName(name, 'name', 'اسم العميل');
  if (existing.some(item => sameName(item, clean))) throw new DomainError('هذا العميل مسجل بالفعل.', { field: 'name', code: 'duplicate' });
  return clean;
}

/**
 * Checks whether a client can be deleted without orphaning financial records.
 * @param {string} client
 * @param {{ trips: Trip[], payments: Payment[], accounts: Account[] }} data
 * @returns {{ ok: boolean, reason?: string }}
 */
export function canDeleteClient(client, { trips, payments, accounts }) {
  const tripCount = trips.filter(trip => trip.client === client).length;
  const paymentCount = payments.filter(payment => payment.client === client).length;
  const account = accounts.find(item => item.client === client);
  if (tripCount || paymentCount) {
    return { ok: false, reason: `لا يمكن حذف العميل لوجود ${tripCount} نقلة و${paymentCount} دفعة مرتبطة به.` };
  }
  if (account && account.transactions.length) {
    return { ok: false, reason: 'لا يمكن حذف عميل لديه معاملات في الحساب اليدوي. احذف المعاملات أولاً.' };
  }
  return { ok: true };
}

/**
 * @typedef {Object} ClientBalance
 * @property {string} client
 * @property {number} tripCount
 * @property {number} deliveries
 * @property {number} payments
 * @property {number} transportBalance
 * @property {number} manualDebt
 * @property {number} manualPaid
 * @property {number} manualBalance
 * @property {number} totalBalance
 * @property {string} lastActivity
 */

/**
 * Per-client balances. Transport charges and the manual debt ledger are kept as
 * separate balances (matching the business's bookkeeping) and also combined.
 * @param {{ clients: string[], trips: Trip[], payments: Payment[], accounts: Account[] }} data
 * @returns {ClientBalance[]}
 */
export function computeClientBalances({ clients, trips, payments, accounts }) {
  /** @type {Map<string, ClientBalance>} */
  const map = new Map();
  const ensure = client => {
    if (!map.has(client)) {
      map.set(client, { client, tripCount: 0, deliveries: 0, payments: 0, transportBalance: 0, manualDebt: 0, manualPaid: 0, manualBalance: 0, totalBalance: 0, lastActivity: '' });
    }
    return map.get(client);
  };
  clients.forEach(ensure);
  const touch = (row, date) => { if (date && date > row.lastActivity) row.lastActivity = date; };
  for (const trip of trips) {
    const row = ensure(trip.client);
    row.tripCount += 1;
    row.deliveries += trip.total;
    touch(row, trip.date);
  }
  for (const payment of payments) {
    const row = ensure(payment.client);
    row.payments += payment.amount;
    touch(row, payment.date);
  }
  for (const account of accounts) {
    const row = ensure(account.client);
    const totals = accountTotals(account);
    row.manualDebt = totals.debt;
    row.manualPaid = totals.paid;
    for (const transaction of account.transactions) touch(row, String(transaction.date).slice(0, 10));
  }
  return [...map.values()].map(row => {
    const deliveries = roundMoney(row.deliveries);
    const paid = roundMoney(row.payments);
    const transportBalance = roundMoney(deliveries - paid);
    const manualBalance = roundMoney(row.manualDebt - row.manualPaid);
    return { ...row, deliveries, payments: paid, transportBalance, manualBalance, totalBalance: roundMoney(transportBalance + manualBalance) };
  });
}

/**
 * Builds the cash receipt that brings a client's transport balance to zero.
 * @param {string} client
 * @param {number} balance
 * @param {MutationContext & { date?: string }} [ctx]
 * @returns {Readonly<Payment>}
 */
export function createSettlementPayment(client, balance, ctx = {}) {
  if (balanceStatus(balance) !== BALANCE_STATUS.DUE) throw new DomainError('لا يوجد رصيد مستحق لتسويته.', { code: 'nothing_due' });
  return createPayment({ client, amount: roundMoney(balance), date: ctx.date || toISODate(ctx.now || new Date()), note: 'تسوية كامل الرصيد المستحق' }, ctx);
}

/* ───────────────────────── statements & settlements ───────────────────────── */

/**
 * 32-bit string hash (stable statement references).
 * @param {string} text
 * @returns {number}
 */
export function hashString(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

/**
 * Stable reference for a client's monthly statement, e.g. "INV-202610-417".
 * @param {string} client
 * @param {string} month YYYY-MM
 * @returns {string}
 */
export function statementReference(client, month) {
  return `INV-${String(month || '').replace('-', '')}-${String(Math.abs(hashString(client || '')) % 1000).padStart(3, '0')}`;
}

/**
 * @typedef {Object} MaterialSummary
 * @property {string} material
 * @property {string} unit
 * @property {number} count
 * @property {number} tripCount
 * @property {number} subtotal
 * @property {number} vatAmount
 * @property {number} total
 * @property {number} averagePrice
 * @property {number} share Percentage of the period total (0–100).
 */

/**
 * Groups trips by material + unit.
 * @param {Trip[]} trips
 * @returns {MaterialSummary[]} Sorted by total, descending.
 */
export function summarizeByMaterial(trips) {
  const groups = new Map();
  let grand = 0;
  for (const trip of trips) {
    const key = `${trip.material}\u0000${trip.unit}`;
    if (!groups.has(key)) groups.set(key, { material: trip.material, unit: trip.unit, count: 0, tripCount: 0, subtotal: 0, vatAmount: 0, total: 0 });
    const group = groups.get(key);
    group.count += trip.count;
    group.tripCount += 1;
    group.subtotal += trip.subtotal;
    group.vatAmount += trip.vatAmount;
    group.total += trip.total;
    grand += trip.total;
  }
  return [...groups.values()].map(group => ({
    ...group,
    subtotal: roundMoney(group.subtotal),
    vatAmount: roundMoney(group.vatAmount),
    total: roundMoney(group.total),
    averagePrice: group.count ? roundMoney(group.subtotal / group.count) : 0,
    share: grand > 0 ? Math.round((group.total / grand) * 1000) / 10 : 0
  })).sort((a, b) => b.total - a.total);
}

/**
 * @typedef {Object} Statement
 * @property {string} client
 * @property {string} month
 * @property {string} from
 * @property {string} to
 * @property {string} reference
 * @property {number} openingBalance Balance carried from before the period.
 * @property {Trip[]} trips
 * @property {Payment[]} payments
 * @property {TimelineEntry[]} entries Period entries with running balance.
 * @property {MaterialSummary[]} breakdown
 * @property {number} subtotal
 * @property {number} vatAmount
 * @property {number} deliveries
 * @property {number} paymentsTotal
 * @property {number} closingBalance
 */

/**
 * Monthly settlement for one client: opening balance, period activity and closing balance.
 * Pass `month = ''` for an all-time statement.
 * @param {{ client: string, month: string, trips: Trip[], payments: Payment[] }} input
 * @returns {Statement}
 */
export function computeStatement({ client, month, trips, payments }) {
  const allTime = !isISOMonth(month);
  const range = allTime ? { from: '', to: '' } : monthRange(month);
  const clientTrips = trips.filter(trip => trip.client === client);
  const clientPayments = payments.filter(payment => payment.client === client);
  const before = record => !allTime && record.date < range.from;
  const inside = record => allTime || (record.date >= range.from && record.date <= range.to);

  const opening = summarizeLedger(buildTimeline(clientTrips.filter(before), clientPayments.filter(before))).balance;
  const periodTrips = clientTrips.filter(inside);
  const periodPayments = clientPayments.filter(inside);
  const entries = withRunningBalance(buildTimeline(periodTrips, periodPayments), opening);
  const totals = summarizeLedger(entries);
  const subtotal = roundMoney(periodTrips.reduce((sum, trip) => sum + trip.subtotal, 0));
  const vatAmount = roundMoney(periodTrips.reduce((sum, trip) => sum + trip.vatAmount, 0));

  return {
    client,
    month: allTime ? '' : month,
    from: range.from,
    to: range.to,
    reference: statementReference(client, allTime ? 'ALL' : month),
    openingBalance: opening,
    trips: entries.filter(entry => entry.kind === 'trip').map(entry => /** @type {Trip} */ (entry.record)),
    payments: entries.filter(entry => entry.kind === 'payment').map(entry => /** @type {Payment} */ (entry.record)),
    entries,
    breakdown: summarizeByMaterial(periodTrips),
    subtotal,
    vatAmount,
    deliveries: totals.deliveries,
    paymentsTotal: totals.payments,
    closingBalance: roundMoney(opening + totals.balance)
  };
}

/* ───────────────────────── dashboard analytics ───────────────────────── */

/**
 * KPI snapshot for a month plus all-time outstanding balances.
 * @param {{ clients: string[], trips: Trip[], payments: Payment[], accounts: Account[], month: string }} input
 */
export function computeDashboard({ clients, trips, payments, accounts, month }) {
  const monthTrips = trips.filter(trip => String(trip.date).startsWith(month));
  const monthPayments = payments.filter(payment => String(payment.date).startsWith(month));
  const balances = computeClientBalances({ clients, trips, payments, accounts });
  const perClient = new Map();
  for (const trip of monthTrips) {
    const row = perClient.get(trip.client) || { client: trip.client, trips: 0, value: 0 };
    row.trips += 1;
    row.value += trip.total;
    perClient.set(trip.client, row);
  }
  const activeDays = new Set(monthTrips.map(trip => trip.date)).size;
  const deliveries = roundMoney(monthTrips.reduce((sum, trip) => sum + trip.total, 0));
  const collected = roundMoney(monthPayments.reduce((sum, payment) => sum + payment.amount, 0));

  return {
    month,
    tripCount: monthTrips.length,
    wasteTrips: monthTrips.filter(trip => isWasteMaterial(trip.material)).length,
    deliveries,
    collected,
    collectionRate: deliveries > 0 ? Math.round((collected / deliveries) * 1000) / 10 : 0,
    activeDays,
    averagePerDay: activeDays ? Math.round((monthTrips.length / activeDays) * 10) / 10 : 0,
    activeClients: perClient.size,
    monthTrips,
    transportOutstanding: roundMoney(balances.reduce((sum, row) => sum + Math.max(0, row.transportBalance), 0)),
    manualOutstanding: roundMoney(balances.reduce((sum, row) => sum + Math.max(0, row.manualBalance), 0)),
    clientsWithDues: balances.filter(row => balanceStatus(row.totalBalance) === BALANCE_STATUS.DUE).length,
    perClient: [...perClient.values()].map(row => ({ ...row, value: roundMoney(row.value) })).sort((a, b) => b.value - a.value),
    topDebtors: balances.filter(row => row.totalBalance > MONEY_EPSILON).sort((a, b) => b.totalBalance - a.totalBalance).slice(0, 5),
    breakdown: summarizeByMaterial(monthTrips),
    recent: buildTimeline(trips, payments).slice(-8).reverse()
  };
}

/* ───────────────────────── settings ───────────────────────── */

/**
 * Validates and merges settings with defaults.
 * @param {Record<string, unknown>} raw
 * @returns {typeof DEFAULT_SETTINGS & Record<string, unknown>}
 */
export function normalizeSettings(raw = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  return {
    ...merged,
    companyName: (() => {
      const name = cleanText(merged.companyName, 120);
      if (LEGACY_COMPANY_NAMES.includes(name)) return OWNER_COMPANY_NAME;
      return name || DEFAULT_COMPANY_NAME;
    })(),
    companyPhone: cleanText(merged.companyPhone, 40),
    companyLogo: isLogoDataUrl(merged.companyLogo) ? merged.companyLogo : '',
    taxNumber: cleanText(merged.taxNumber, 20).replace(/[^\d]/g, ''),
    vatEnabled: Boolean(merged.vatEnabled),
    vatRate: (() => { try { return normalizeVatRate(merged.vatRate); } catch { return DEFAULT_SETTINGS.vatRate; } })(),
    lockedThrough: isISOMonth(merged.lockedThrough) ? String(merged.lockedThrough) : '',
    showHijri: merged.showHijri !== false,
    backupReminderDays: Math.min(90, Math.max(0, Number.parseInt(String(merged.backupReminderDays), 10) || 0))
  };
}

/**
 * True while the company name is still the generic placeholder.
 * @param {unknown} name
 * @returns {boolean}
 */
export const isDefaultCompanyName = name => !cleanText(name) || cleanText(name) === DEFAULT_COMPANY_NAME;

/**
 * Company details for printed documents; the placeholder is left out rather
 * than printed on a client's statement.
 * @param {{ companyName?: string, taxNumber?: string, companyPhone?: string, companyLogo?: string }} settings
 * @returns {{ name: string, taxNumber: string, phone: string, logo: string }}
 */
export const companyForPrint = settings => ({
  name: isDefaultCompanyName(settings.companyName) ? '' : String(settings.companyName),
  taxNumber: settings.taxNumber || '',
  phone: settings.companyPhone || '',
  logo: isLogoDataUrl(settings.companyLogo) ? settings.companyLogo : ''
});

/**
 * VAT percentage to apply to new trips under the given settings.
 * @param {{ vatEnabled?: boolean, vatRate?: number }} settings
 * @returns {number}
 */
export const effectiveVatRate = settings => (settings.vatEnabled ? Number(settings.vatRate) || 0 : 0);

/* ───────────────────────── dataset normalization (import / migration) ───────────────────────── */

/**
 * @typedef {Object} Dataset
 * @property {Array<{ name: string, createdAt: string }>} clients
 * @property {Material[]} materials
 * @property {CatalogEntry[]} catalogs
 * @property {Array<{ plate: string }>} trucks
 * @property {Trip[]} trips
 * @property {Payment[]} payments
 * @property {Account[]} accounts
 * @property {Record<string, unknown>} settings
 */

/**
 * @param {unknown} value
 * @returns {any[]}
 */
const asArray = value => (Array.isArray(value) ? value : []);

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Best-effort creation timestamp for imported records.
 * @param {Record<string, any>} record
 * @param {string} fallback
 * @returns {string}
 */
function importedTimestamp(record, fallback) {
  if (typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt))) return new Date(record.createdAt).toISOString();
  const embedded = extractTimestamp(record.id);
  if (embedded) return new Date(embedded).toISOString();
  return fallback;
}

/**
 * Converts any supported backup/legacy payload into a clean dataset.
 * Accepts: (1) current backups `{ app: 'dad-transport', data: {...} }`,
 * (2) legacy JSON backups `{ version: '1.0', trips, payments, ... }`,
 * (3) a legacy localStorage snapshot in the same shape as (2).
 * Invalid records are dropped and counted, never silently "fixed" into wrong money values.
 * @param {unknown} raw
 * @param {{ now?: Date }} [ctx]
 * @returns {{ dataset: Dataset, report: { format: string, dropped: Record<string, number>, warnings: string[] } }}
 */
export function normalizeDataset(raw, ctx = {}) {
  if (!isPlainObject(raw)) throw new DomainError('صيغة الملف غير متوافقة.', { code: 'format' });
  const isCurrent = raw.app === 'dad-transport' && isPlainObject(raw.data);
  const source = isCurrent ? raw.data : raw;
  if (!isCurrent && !Array.isArray(source.trips)) throw new DomainError('صيغة الملف غير متوافقة: لا توجد قائمة نقلات.', { code: 'format' });

  const fallbackStamp = stamp(ctx);
  const dropped = { trips: 0, payments: 0, materials: 0, catalogs: 0, accounts: 0, transactions: 0 };
  const warnings = [];
  // Fallback ids are derived from the record content (never random) so that
  // re-running a migration or re-importing a file upserts instead of duplicating.
  const seenIds = new Set();
  const uniqueId = (id, prefix, record) => {
    const base = typeof id === 'string' && id.trim()
      ? id.trim()
      : `${prefix}_legacy_${(hashString(JSON.stringify(record) ?? '') >>> 0).toString(36)}`;
    let value = base;
    for (let n = 2; seenIds.has(value); n += 1) value = `${base}_${n}`;
    seenIds.add(value);
    return value;
  };

  // Materials
  const materials = [];
  for (const item of asArray(source.materials)) {
    try {
      const material = normalizeMaterial(item);
      if (!materials.some(existing => existing.name === material.name)) materials.push(material);
    } catch { dropped.materials += 1; }
  }
  if (!materials.length) materials.push(...STANDARD_MATERIALS);

  // Client catalogs: legacy object map or current flat array
  const catalogs = [];
  const rawCatalogs = isCurrent ? asArray(source.catalogs) : isPlainObject(source.clientCatalogs)
    ? Object.entries(source.clientCatalogs).flatMap(([client, entries]) => asArray(entries).map(entry => ({ ...entry, client })))
    : [];
  for (const item of rawCatalogs) {
    try {
      const entry = normalizeCatalogEntry(item);
      if (!catalogs.some(existing => existing.client === entry.client && existing.name === entry.name)) catalogs.push(entry);
    } catch { dropped.catalogs += 1; }
  }

  const pricingSources = { catalogs, materials };
  const trips = [];
  const payments = [];

  // Legacy builds once stored cash receipts inside the trips array.
  const rawTrips = asArray(source.trips);
  const embeddedPayments = rawTrips.filter(item => isPlainObject(item) && item.type === 'payment');
  const rawPayments = [...asArray(source.payments), ...embeddedPayments];

  for (const item of rawTrips) {
    if (!isPlainObject(item) || item.type === 'payment') { if (!isPlainObject(item)) dropped.trips += 1; continue; }
    const client = cleanText(item.client, MAX_NAME);
    const material = cleanText(item.material, MAX_NAME);
    if (!client || !material) { dropped.trips += 1; continue; }
    const pricing = resolvePricing(client, material, pricingSources);
    const count = Number.parseInt(item.count, 10) > 0 ? Number.parseInt(item.count, 10) : 1;
    const price = item.price !== null && item.price !== '' && Number.isFinite(Number(item.price)) && Number(item.price) >= 0 ? roundMoney(item.price) : pricing.price;
    const vatRate = Number.isFinite(Number(item.vatRate)) && Number(item.vatRate) >= 0 && Number(item.vatRate) <= 100 ? roundMoney(item.vatRate) : 0;
    const computed = computeTripAmounts(count, price, vatRate);
    // Legacy totals are authoritative (they are what the client was billed).
    const legacyTotal = item.total !== null && item.total !== '' && Number.isFinite(Number(item.total)) ? roundMoney(item.total) : null;
    const total = legacyTotal ?? computed.total;
    const vatAmount = Number.isFinite(Number(item.vatAmount)) ? roundMoney(item.vatAmount) : computed.vatAmount;
    const createdAt = importedTimestamp(item, fallbackStamp);
    let date = isISODate(item.date) ? item.date : '';
    if (!date) {
      date = toISODate(new Date(createdAt));
      warnings.push(`نقلة للعميل "${client}" بلا تاريخ صالح؛ استُخدم تاريخ إنشائها ${date}.`);
    }
    trips.push(deepFreeze({
      id: uniqueId(item.id, 'trip', item),
      date,
      client,
      material,
      unit: cleanText(item.unit, 40) || pricing.unit || DEFAULT_UNIT,
      truck: cleanText(item.truck, 40),
      count,
      price,
      subtotal: roundMoney(total - vatAmount),
      vatRate,
      vatAmount,
      total,
      notes: cleanText(item.notes),
      createdAt,
      updatedAt: typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt)) ? new Date(item.updatedAt).toISOString() : createdAt
    }));
  }

  for (const item of rawPayments) {
    const client = isPlainObject(item) ? cleanText(item.client, MAX_NAME) : '';
    const amount = isPlainObject(item) ? Number(item.amount) : NaN;
    if (!client || !Number.isFinite(amount) || amount <= 0) { dropped.payments += 1; continue; }
    const createdAt = importedTimestamp(item, fallbackStamp);
    payments.push(deepFreeze({
      id: uniqueId(item.id, 'payment', item),
      client,
      amount: roundMoney(amount),
      date: isISODate(item.date) ? item.date : toISODate(new Date(createdAt)),
      note: cleanText(item.note ?? item.notes),
      createdAt
    }));
  }

  // Manual accounts (legacy accounts may predate transactions and only carry total/paid)
  const accounts = [];
  for (const item of asArray(source.accounts)) {
    const client = isPlainObject(item) ? cleanText(item.client, MAX_NAME) : '';
    if (!client) { dropped.accounts += 1; continue; }
    const accountId = uniqueId(item.id, 'account', item);
    const createdAt = importedTimestamp(item, fallbackStamp);
    let transactions = [];
    if (Array.isArray(item.transactions)) {
      for (const tx of item.transactions) {
        const amount = isPlainObject(tx) ? Number(tx.amount) : NaN;
        if (!isPlainObject(tx) || (tx.type !== ACCOUNT_TX.DEBT && tx.type !== ACCOUNT_TX.PAYMENT) || !Number.isFinite(amount) || amount <= 0) {
          dropped.transactions += 1;
          continue;
        }
        const txCreated = importedTimestamp(tx, createdAt);
        const parsed = parseDate(tx.date);
        transactions.push({
          id: uniqueId(tx.id, 'transaction', { account: accountId, ...tx }),
          type: tx.type,
          amount: roundMoney(amount),
          date: parsed ? toISODate(parsed) : toISODate(new Date(txCreated)),
          note: cleanText(tx.note),
          createdAt: parsed && !isISODate(tx.date) ? parsed.toISOString() : txCreated
        });
      }
    } else {
      const total = Number(item.total);
      const paid = Number(item.paid);
      const date = toISODate(new Date(createdAt));
      if (Number.isFinite(total) && total > 0) transactions.push({ id: `${accountId}_opening_debt`, type: ACCOUNT_TX.DEBT, amount: roundMoney(total), date, note: 'رصيد افتتاحي', createdAt });
      if (Number.isFinite(paid) && paid > 0) transactions.push({ id: `${accountId}_opening_payment`, type: ACCOUNT_TX.PAYMENT, amount: roundMoney(paid), date, note: 'رصيد افتتاحي', createdAt });
    }
    transactions = transactions.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    const existing = accounts.find(account => account.client === client);
    if (existing) {
      existing.transactions.push(...transactions);
      warnings.push(`تم دمج حسابين مكررين للعميل "${client}".`);
    } else {
      accounts.push({ id: accountId, client, transactions, createdAt, updatedAt: createdAt });
    }
  }

  // Clients: declared list plus every name referenced by records (referential integrity)
  const clientNames = [];
  const addClient = name => {
    const clean = cleanText(typeof name === 'string' ? name : name?.name, MAX_NAME);
    if (clean && !clientNames.includes(clean)) clientNames.push(clean);
  };
  asArray(source.clients).forEach(addClient);
  [...trips, ...payments, ...accounts, ...catalogs].forEach(record => addClient(record.client));

  const truckPlates = [];
  const addTruck = value => {
    const plate = cleanText(typeof value === 'string' ? value : value?.plate, 40);
    if (plate && !truckPlates.includes(plate)) truckPlates.push(plate);
  };
  asArray(source.trucks).forEach(addTruck);
  trips.forEach(trip => addTruck(trip.truck));

  // Settings (current format only; private keys are never imported)
  const settings = {};
  if (isCurrent) {
    const rawSettings = Array.isArray(source.settings)
      ? Object.fromEntries(source.settings.filter(isPlainObject).map(entry => [entry.key, entry.value]))
      : isPlainObject(source.settings) ? source.settings : {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in rawSettings) settings[key] = rawSettings[key];
    }
  }

  return {
    dataset: deepFreeze({
      clients: clientNames.map(name => ({ name, createdAt: fallbackStamp })),
      materials,
      catalogs,
      trucks: truckPlates.map(plate => ({ plate })),
      trips,
      payments,
      accounts,
      settings: Object.keys(settings).length ? normalizeSettings(settings) : {}
    }),
    report: { format: isCurrent ? 'current' : 'legacy', dropped, warnings }
  };
}
