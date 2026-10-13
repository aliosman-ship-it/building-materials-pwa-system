/**
 * @module core/format
 * Currency, number, quantity and date formatting (Gregorian + Hijri Umm al-Qura).
 * Western (Latin) digits are used everywhere for consistency with printed invoices.
 */

export const CURRENCY_LABEL = 'ر.س';
export const DEFAULT_UNIT = 'رد';

/** Gregorian month names as used in Saudi business documents. */
export const GREGORIAN_MONTHS = Object.freeze([
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
]);

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH_RE = /^(\d{4})-(\d{2})$/;

const numberFormatters = new Map();

/**
 * Cached Intl.NumberFormat accessor.
 * @param {number} minFraction
 * @param {number} maxFraction
 * @returns {Intl.NumberFormat}
 */
function numberFormatter(minFraction, maxFraction) {
  const key = `${minFraction}:${maxFraction}`;
  if (!numberFormatters.has(key)) {
    numberFormatters.set(key, new Intl.NumberFormat('en-US', {
      minimumFractionDigits: minFraction,
      maximumFractionDigits: maxFraction
    }));
  }
  return numberFormatters.get(key);
}

/**
 * Coerces any value to a finite number (0 when not finite).
 * @param {unknown} value
 * @returns {number}
 */
export function toNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Converts Arabic-Indic (٠-٩) and Persian (۰-۹) digits to Western digits and the
 * Arabic decimal mark (٫) to ".". Other characters are left as they are.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDigits(value) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.');
}

/**
 * Parses a user-entered amount. Accepts Arabic-Indic digits and the Arabic
 * decimal/thousands separators; blank → null.
 * @param {unknown} value
 * @returns {number|null} NaN when the text is not a number.
 */
export function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  const text = normalizeDigits(value).trim().replace(/[٬,\s]/g, '');
  if (!text) return null;
  return /^-?\d*\.?\d+$/.test(text) ? Number(text) : Number.NaN;
}

/**
 * Formats a plain number with grouping.
 * @param {unknown} value
 * @param {{ maxFraction?: number, minFraction?: number }} [options]
 * @returns {string}
 */
export function formatNumber(value, { maxFraction = 2, minFraction = 0 } = {}) {
  return numberFormatter(minFraction, maxFraction).format(toNumber(value));
}

/**
 * Formats a monetary amount. Whole amounts drop the decimals; fractional ones show two.
 * @param {unknown} amount
 * @param {{ currency?: boolean, signed?: boolean }} [options]
 * @returns {string} e.g. "1,250 ر.س" or "1,250.50 ر.س" (number wrapped in bidi isolates)
 */
export function formatMoney(amount, { currency = true, signed = false } = {}) {
  const value = toNumber(amount);
  const abs = Math.abs(value);
  const fixed = Math.round(abs * 100) / 100;
  const text = Number.isInteger(fixed) ? formatNumber(fixed, { maxFraction: 0 }) : formatNumber(fixed, { minFraction: 2, maxFraction: 2 });
  const sign = value < 0 ? '−' : signed && value > 0 ? '+' : '';
  // LRI…PDI isolates the signed number so it renders "−30" (not "30−") inside RTL text,
  // while the currency label still follows the number in Arabic reading order.
  const number = `\u2066${sign}${text}\u2069`;
  return currency ? `${number} ${CURRENCY_LABEL}` : number;
}

/**
 * Formats a percentage (input as 0–100).
 * @param {unknown} value
 * @param {number} [digits=1]
 * @returns {string}
 */
export function formatPercent(value, digits = 1) {
  return `${formatNumber(value, { minFraction: digits, maxFraction: digits })}%`;
}

/**
 * Formats a quantity with its unit.
 * @param {unknown} count
 * @param {string} [unit]
 * @returns {string}
 */
export function formatQuantity(count, unit = DEFAULT_UNIT) {
  return `${formatNumber(count)} ${unit || DEFAULT_UNIT}`;
}

/**
 * Sums quantities per unit and formats them as "12 رد · 4 تريلا 20م".
 * @param {Array<{count?: number, unit?: string}>} items
 * @returns {string}
 */
export function formatQuantityByUnit(items) {
  const totals = new Map();
  for (const item of items) {
    const unit = item.unit || DEFAULT_UNIT;
    totals.set(unit, (totals.get(unit) || 0) + toNumber(item.count ?? 1));
  }
  if (!totals.size) return formatQuantity(0);
  return [...totals.entries()].map(([unit, count]) => formatQuantity(count, unit)).join(' · ');
}

/**
 * Zero-pads a number to two digits.
 * @param {number} value
 * @returns {string}
 */
const pad2 = value => String(value).padStart(2, '0');

/**
 * Serializes a Date as a local YYYY-MM-DD string.
 * @param {Date} [date]
 * @returns {string}
 */
export function toISODate(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** @returns {string} Today's local date as YYYY-MM-DD. */
export const todayISO = () => toISODate(new Date());

/** @returns {string} The current local month as YYYY-MM. */
export const currentMonthISO = () => todayISO().slice(0, 7);

/**
 * Parses a YYYY-MM-DD calendar date as a LOCAL date (00:00 local time).
 *
 * Never use `new Date("YYYY-MM-DD")` for date-only strings: JavaScript reads
 * that form as UTC midnight, which lands on the previous day in any timezone
 * west of UTC. Splitting the string and using the (year, monthIndex, day)
 * constructor keeps the calendar day exactly as typed.
 * @param {unknown} value
 * @returns {Date|null} null unless `value` is a real calendar date (rejects 2026-02-30).
 */
export function parseLocalDate(value) {
  const text = String(value ?? '');
  if (!ISO_DATE_RE.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/**
 * True for a real calendar date in YYYY-MM-DD form.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isISODate(value) {
  return parseLocalDate(value) !== null;
}

/**
 * True for a YYYY-MM month string.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isISOMonth(value) {
  const match = ISO_MONTH_RE.exec(String(value ?? ''));
  return Boolean(match) && Number(match[2]) >= 1 && Number(match[2]) <= 12;
}

/**
 * Parses a YYYY-MM-DD string or a full ISO timestamp into a Date.
 * Date-only strings go through parseLocalDate (local calendar day, no UTC shift);
 * only timestamps that carry their own time/offset use the native parser.
 * @param {unknown} value
 * @returns {Date|null}
 */
export function parseDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !value) return null;
  if (ISO_DATE_RE.test(value)) return parseLocalDate(value);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Shifts a YYYY-MM month by `delta` months.
 * @param {string} month
 * @param {number} delta
 * @returns {string}
 */
export function shiftMonth(month, delta) {
  if (!isISOMonth(month)) return currentMonthISO();
  const [y, m] = month.split('-').map(Number);
  const date = new Date(y, m - 1 + delta, 1);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

/**
 * First and last day (inclusive) of a YYYY-MM month.
 * @param {string} month
 * @returns {{ from: string, to: string }}
 */
export function monthRange(month) {
  const safe = isISOMonth(month) ? month : currentMonthISO();
  const [y, m] = safe.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { from: `${safe}-01`, to: `${safe}-${pad2(lastDay)}` };
}

/**
 * Arabic label for a YYYY-MM month, e.g. "أكتوبر 2026".
 * @param {string} month
 * @returns {string}
 */
export function formatMonthLabel(month) {
  if (!isISOMonth(month)) return 'جميع الفترات';
  const [y, m] = month.split('-').map(Number);
  return `${GREGORIAN_MONTHS[m - 1]} ${y}`;
}

let hijriFormatter = null;
let hijriSupported = null;

/**
 * Lazily builds the Umm al-Qura formatter; returns null when the runtime lacks the calendar.
 * @returns {Intl.DateTimeFormat|null}
 */
function getHijriFormatter() {
  if (hijriSupported === false) return null;
  if (hijriFormatter) return hijriFormatter;
  try {
    // Pinned to UTC: calendar dates are fed in as UTC noon (see formatHijri), so the
    // result never depends on the device timezone, even if it changes mid-session.
    const formatter = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
    });
    hijriSupported = formatter.resolvedOptions().calendar.startsWith('islamic');
    hijriFormatter = hijriSupported ? formatter : null;
  } catch {
    hijriSupported = false;
  }
  return hijriFormatter;
}

/**
 * Formats a date in the Gregorian calendar.
 * @param {unknown} value YYYY-MM-DD, ISO timestamp, or Date.
 * @param {{ style?: 'iso'|'long'|'short' }} [options]
 * @returns {string} "—" when the value is not a valid date.
 */
export function formatDate(value, { style = 'iso' } = {}) {
  const date = parseDate(value);
  if (!date) return '—';
  if (style === 'iso') return toISODate(date);
  if (style === 'short') return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
  return `${date.getDate()} ${GREGORIAN_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * Formats a date in the Hijri (Umm al-Qura) calendar.
 * @param {unknown} value
 * @returns {string} e.g. "29 ربيع الآخر 1448 هـ", or "" when unsupported/invalid.
 */
export function formatHijri(value) {
  const date = parseDate(value);
  const formatter = getHijriFormatter();
  if (!date || !formatter) return '';
  // The formatter is pinned to UTC (it is cached, and the device timezone can change
  // while the app is open), so hand it the same local calendar day as UTC noon.
  const text = formatter.format(new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12)));
  return /هـ/.test(text) ? text : `${text} هـ`;
}

/**
 * Gregorian date with the Hijri equivalent appended.
 * @param {unknown} value
 * @param {{ style?: 'iso'|'long'|'short' }} [options]
 * @returns {string}
 */
export function formatDateDual(value, options = {}) {
  const gregorian = formatDate(value, options);
  const hijri = formatHijri(value);
  return hijri && gregorian !== '—' ? `${gregorian} · ${hijri}` : gregorian;
}

/**
 * Date + 24h time for timestamps.
 * @param {unknown} value
 * @returns {string}
 */
export function formatDateTime(value) {
  const date = parseDate(value);
  if (!date) return '—';
  return `${toISODate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * Formats a byte count for storage displays.
 * @param {unknown} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  let value = toNumber(bytes);
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${formatNumber(value, { maxFraction: index ? 1 : 0 })} ${units[index]}`;
}
