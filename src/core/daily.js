/**
 * @module core/daily
 * Daily work & petty-cash sheet ("حركة العمل اليومية"): pure, storage-agnostic
 * rules for one paper-style day sheet — sales, itemized purchases and expenses,
 * net, opening/closing petty cash and the owner's drawings.
 *
 * Deliberately independent of the transport/accounts domain: nothing here reads
 * or writes trips, payments or client balances.
 *
 * All money arithmetic is done in integer halalas (×100) so sums never drift.
 */

import { DomainError } from './domain.js';
import { formatDate, isISODate, isISOMonth, parseAmount, parseLocalDate, toISODate, toNumber } from './format.js';
import { generateId } from './id.js';

/** The person whose personal drawings are recorded on the sheet. */
export const WITHDRAWER_NAME = 'سعد';

/** Sections holding itemized lines. */
export const LINE_SECTIONS = Object.freeze(['purchases', 'expenses']);

export const SECTION_LABEL = Object.freeze({ purchases: 'المشتريات', expenses: 'المصروفات' });

/** Arabic weekday names indexed by Date#getDay(). */
export const WEEKDAYS = Object.freeze(['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']);

/** Starter suggestions for the type column; the form also learns from past sheets. */
export const DEFAULT_TYPES = Object.freeze({
  purchases: ['بضاعة', 'مواد خام', 'خضار وفواكه', 'لحوم ودواجن', 'مواد تعبئة وتغليف'],
  expenses: ['أجور عمال', 'كهرباء', 'مياه', 'غاز', 'نقل وترحيل', 'صيانة', 'إيجار', 'نثريات']
});

export const MAX_LINES = 200;
const MAX_AMOUNT = 1e10;
const TEXT_LIMITS = Object.freeze({ type: 60, name: 120, notes: 2000 });

/**
 * @typedef {Object} DailyLine
 * @property {string} id
 * @property {string} type    نوع المصروف / المادة
 * @property {string} name    الاسم / البيان
 * @property {number|null} count  العدد (optional)
 * @property {number} amount  الإجمالي
 */

/**
 * @typedef {Object} DailySheet
 * @property {string} id
 * @property {string} date YYYY-MM-DD (one sheet per date)
 * @property {number} daySales
 * @property {number} nightSales
 * @property {DailyLine[]} purchases
 * @property {DailyLine[]} expenses
 * @property {number} openingCash
 * @property {number} withdrawals
 * @property {string} notes
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} DailyTotals
 * @property {number} totalSales
 * @property {number} totalPurchases
 * @property {number} totalExpenses
 * @property {number} net
 * @property {number} openingCash
 * @property {number} withdrawals
 * @property {number} closingCash
 */

/* ───────────────────────── money helpers ───────────────────────── */

/** @param {unknown} value @returns {number} integer halalas */
const toCents = value => Math.round(toNumber(value) * 100);
/** @param {number} cents @returns {number} */
const fromCents = cents => cents / 100;

/**
 * Sums amounts exactly (to the halala).
 * @param {Iterable<unknown>} values
 * @returns {number}
 */
export function sumMoney(values) {
  let cents = 0;
  for (const value of values) cents += toCents(value);
  return fromCents(cents);
}

/* ───────────────────────── dates ───────────────────────── */

/*
 * Sheet dates are calendar days stored as YYYY-MM-DD strings. Every
 * conversion to a Date goes through parseLocalDate (split + local
 * constructor), never `new Date("YYYY-MM-DD")`, which would be read as UTC
 * midnight and show the previous day west of UTC.
 */

/**
 * Splits a YYYY-MM-DD string into numbers (year, month 1–12, day).
 * @param {string} date
 * @returns {{ y: number, m: number, d: number }|null} null for invalid dates.
 */
export function dateParts(date) {
  const local = parseLocalDate(date);
  return local ? { y: local.getFullYear(), m: local.getMonth() + 1, d: local.getDate() } : null;
}

/**
 * Arabic weekday name for a date.
 * @param {string} date YYYY-MM-DD
 * @returns {string} e.g. "الاثنين" for 2026-10-12; '' when invalid.
 */
export function weekdayName(date) {
  const local = parseLocalDate(date);
  return local ? WEEKDAYS[local.getDay()] : '';
}

/**
 * Moves a date by whole calendar days (month and year boundaries included).
 * @param {string} date YYYY-MM-DD
 * @param {number} delta
 * @returns {string} YYYY-MM-DD, or '' when `date` is invalid.
 */
export function shiftISODate(date, delta) {
  const local = parseLocalDate(date);
  if (!local) return '';
  // Local constructor again: day overflow rolls into the next month/year correctly.
  return toISODate(new Date(local.getFullYear(), local.getMonth(), local.getDate() + delta));
}

/**
 * Unambiguous Arabic label: weekday + day + month name + year.
 * @param {string} date YYYY-MM-DD
 * @returns {string} e.g. "الاثنين 12 أكتوبر 2026"
 */
export function formatDayLabel(date) {
  return dateParts(date) ? `${weekdayName(date)} ${formatDate(date, { style: 'long' })}` : '—';
}

/* ───────────────────────── calculations ───────────────────────── */

/**
 * Derives every computed figure of a sheet. Works on raw form values too
 * (strings, blanks), so the form can preview totals while typing.
 * @param {Partial<DailySheet> & Record<string, any>} sheet
 * @returns {DailyTotals}
 */
export function computeDailyTotals(sheet) {
  const amount = value => {
    const parsed = parseAmount(value);
    return parsed === null || Number.isNaN(parsed) ? 0 : parsed;
  };
  const sales = toCents(amount(sheet.daySales)) + toCents(amount(sheet.nightSales));
  const purchases = (sheet.purchases || []).reduce((sum, line) => sum + toCents(amount(line?.amount)), 0);
  const expenses = (sheet.expenses || []).reduce((sum, line) => sum + toCents(amount(line?.amount)), 0);
  const opening = toCents(amount(sheet.openingCash));
  const withdrawals = toCents(amount(sheet.withdrawals));
  const net = sales - (purchases + expenses);
  return {
    totalSales: fromCents(sales),
    totalPurchases: fromCents(purchases),
    totalExpenses: fromCents(expenses),
    net: fromCents(net),
    openingCash: fromCents(opening),
    withdrawals: fromCents(withdrawals),
    closingCash: fromCents(opening + net - withdrawals)
  };
}

/**
 * Aggregates a set of sheets (e.g. a month). Opening cash is the earliest
 * sheet's opening and closing cash the latest sheet's closing.
 * @param {DailySheet[]} sheets
 * @returns {DailyTotals & { days: number }}
 */
export function summarizeSheets(sheets) {
  const ordered = sortSheets(sheets);
  const totals = ordered.map(computeDailyTotals);
  const sum = key => sumMoney(totals.map(item => item[key]));
  return {
    days: ordered.length,
    totalSales: sum('totalSales'),
    totalPurchases: sum('totalPurchases'),
    totalExpenses: sum('totalExpenses'),
    net: sum('net'),
    withdrawals: sum('withdrawals'),
    openingCash: totals[0]?.openingCash ?? 0,
    closingCash: totals.at(-1)?.closingCash ?? 0
  };
}

/* ───────────────────────── validation ───────────────────────── */

/**
 * @param {unknown} value
 * @param {string} label
 * @param {string} field
 * @param {{ required?: boolean, allowNegative?: boolean }} [options]
 * @returns {number}
 */
function validAmount(value, label, field, { required = false, allowNegative = false } = {}) {
  const parsed = parseAmount(value);
  if (parsed === null) {
    if (required) throw new DomainError(`أدخل ${label}.`, { field });
    return 0;
  }
  if (Number.isNaN(parsed)) throw new DomainError(`قيمة ${label} غير صحيحة. استخدم أرقاماً فقط.`, { field });
  if (parsed < 0 && !allowNegative) throw new DomainError(`${label} لا يمكن أن يكون بالسالب.`, { field });
  if (Math.abs(parsed) > MAX_AMOUNT) throw new DomainError(`قيمة ${label} كبيرة جداً.`, { field });
  return fromCents(toCents(parsed));
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
const cleanText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * True when a raw line has nothing typed in it (it is then simply dropped).
 * @param {Record<string, unknown>} line
 * @returns {boolean}
 */
export function isBlankLine(line) {
  return !['type', 'name', 'count', 'amount'].some(key => String(line?.[key] ?? '').trim() !== '');
}

/**
 * Validates and normalizes one itemized line.
 * @param {Record<string, unknown>} raw
 * @param {'purchases'|'expenses'} section
 * @param {number} index 0-based
 * @returns {DailyLine}
 */
function normalizeLine(raw, section, index) {
  const where = `${SECTION_LABEL[section]} — السطر ${index + 1}`;
  const type = cleanText(raw.type, TEXT_LIMITS.type);
  const name = cleanText(raw.name, TEXT_LIMITS.name);
  if (!type && !name) throw new DomainError(`${where}: اكتب النوع أو البيان.`, { field: `${section}.${index}.name` });
  const amount = validAmount(raw.amount, `الإجمالي (${where})`, `${section}.${index}.amount`, { required: true });
  const countRaw = parseAmount(raw.count);
  if (countRaw !== null && (Number.isNaN(countRaw) || countRaw < 0 || countRaw > 1e7)) {
    throw new DomainError(`${where}: العدد غير صحيح.`, { field: `${section}.${index}.count` });
  }
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : generateId('line'),
    type,
    name,
    count: countRaw === null ? null : Math.round(countRaw * 1000) / 1000,
    amount
  };
}

/**
 * Validates raw form input and returns a clean sheet ready to persist.
 * Throws DomainError (with a `field` path) on the first problem.
 * @param {Record<string, any>} input
 * @param {{ existing?: DailySheet|null, now?: Date }} [options]
 * @returns {DailySheet}
 */
export function createDailySheet(input, { existing = null, now = new Date() } = {}) {
  if (!isISODate(input.date)) throw new DomainError('اختر تاريخ اليومية.', { field: 'date' });
  const lines = {};
  for (const section of LINE_SECTIONS) {
    const raw = Array.isArray(input[section]) ? input[section] : [];
    const kept = raw.map((line, index) => ({ line, index })).filter(({ line }) => !isBlankLine(line));
    if (kept.length > MAX_LINES) throw new DomainError(`عدد أسطر ${SECTION_LABEL[section]} أكبر من المسموح (${MAX_LINES}).`);
    lines[section] = kept.map(({ line, index }) => normalizeLine(line, section, index));
  }
  const stamp = now.toISOString();
  return {
    id: existing?.id || (typeof input.id === 'string' && input.id) || generateId('day'),
    date: input.date,
    daySales: validAmount(input.daySales, 'مبيعات النهار', 'daySales'),
    nightSales: validAmount(input.nightSales, 'مبيعات الليل', 'nightSales'),
    purchases: lines.purchases,
    expenses: lines.expenses,
    // A deficit carried from the previous day is legitimate, so only opening cash may be negative.
    openingCash: validAmount(input.openingCash, 'عهدة بداية اليوم', 'openingCash', { allowNegative: true }),
    withdrawals: validAmount(input.withdrawals, `مسحوبات ${WITHDRAWER_NAME}`, 'withdrawals'),
    notes: cleanText(input.notes, TEXT_LIMITS.notes),
    createdAt: existing?.createdAt || (typeof input.createdAt === 'string' && input.createdAt) || stamp,
    updatedAt: stamp
  };
}

/**
 * Lenient normalization for stored/imported records: returns null for records
 * that cannot be salvaged instead of throwing.
 * @param {unknown} raw
 * @returns {DailySheet|null}
 */
export function reviveDailySheet(raw) {
  if (!raw || typeof raw !== 'object') return null;
  try {
    const sheet = createDailySheet(/** @type {any} */ (raw), { now: new Date() });
    const record = /** @type {any} */ (raw);
    if (typeof record.updatedAt === 'string' && record.updatedAt) sheet.updatedAt = record.updatedAt;
    return sheet;
  } catch {
    return null;
  }
}

/* ───────────────────────── collections ───────────────────────── */

/**
 * Sorts sheets oldest → newest.
 * @param {DailySheet[]} sheets
 * @returns {DailySheet[]}
 */
export function sortSheets(sheets) {
  return [...sheets].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Latest sheet strictly before `date`.
 * @param {DailySheet[]} sheets
 * @param {string} date
 * @returns {DailySheet|null}
 */
export function previousSheet(sheets, date) {
  let best = null;
  for (const sheet of sheets) {
    if (sheet.date < date && (!best || sheet.date > best.date)) best = sheet;
  }
  return best;
}

/**
 * Opening cash suggested for a new sheet: the previous day's closing cash.
 * @param {DailySheet[]} sheets
 * @param {string} date
 * @returns {{ amount: number, from: string }|null}
 */
export function carriedOpeningCash(sheets, date) {
  const prev = previousSheet(sheets, date);
  return prev ? { amount: computeDailyTotals(prev).closingCash, from: prev.date } : null;
}

/**
 * Months (YYYY-MM) that contain sheets, newest first.
 * @param {DailySheet[]} sheets
 * @returns {string[]}
 */
export function sheetMonths(sheets) {
  return [...new Set(sheets.map(sheet => sheet.date.slice(0, 7)))].sort().reverse();
}

/**
 * Filters sheets for the history list.
 * @param {DailySheet[]} sheets
 * @param {{ month?: string, date?: string, search?: string }} filters
 * @returns {DailySheet[]} oldest → newest
 */
export function filterSheets(sheets, { month = '', date = '', search = '' } = {}) {
  const needle = search.trim().toLowerCase();
  return sortSheets(sheets).filter(sheet => {
    if (isISODate(date)) { if (sheet.date !== date) return false; }
    else if (isISOMonth(month) && !sheet.date.startsWith(month)) return false;
    if (!needle) return true;
    const haystack = [sheet.notes, ...[...sheet.purchases, ...sheet.expenses].flatMap(line => [line.type, line.name])].join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}

/**
 * Days whose opening cash does not match the previous sheet's closing cash
 * (a gap in the petty-cash chain worth reviewing).
 * @param {DailySheet[]} sheets
 * @returns {Map<string, { expected: number, from: string }>} keyed by date
 */
export function findCashBreaks(sheets) {
  const breaks = new Map();
  const ordered = sortSheets(sheets);
  for (let index = 1; index < ordered.length; index += 1) {
    const expected = computeDailyTotals(ordered[index - 1]).closingCash;
    if (toCents(ordered[index].openingCash) !== toCents(expected)) {
      breaks.set(ordered[index].date, { expected, from: ordered[index - 1].date });
    }
  }
  return breaks;
}

/**
 * Distinct type values used in a section, most frequent first, plus defaults.
 * @param {DailySheet[]} sheets
 * @param {'purchases'|'expenses'} section
 * @returns {string[]}
 */
export function typeSuggestions(sheets, section) {
  const counts = new Map();
  for (const sheet of sheets) {
    for (const line of sheet[section] || []) if (line.type) counts.set(line.type, (counts.get(line.type) || 0) + 1);
  }
  const learned = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type);
  return [...new Set([...learned, ...DEFAULT_TYPES[section]])];
}
