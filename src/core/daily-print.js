/**
 * @module core/daily-print
 * Printable A4 document for one daily sheet, laid out like the traditional
 * paper ledger: sales box, purchases and expenses side by side with ruled
 * blank lines, the closing account, notes and signature lines.
 */

import { escapeHtml } from './dom.js';
import { COMPANY_BLOCK_CSS, PRINT_CSP, companyBlockHtml } from './export.js';
import { WITHDRAWER_NAME, computeDailyTotals, weekdayName } from './daily.js';
import { formatDate, formatDateTime, formatHijri, formatMoney, formatNumber } from './format.js';

/** Ruled rows printed per itemized table so late items can be written by hand. */
const MIN_PRINT_ROWS = 8;

const DAILY_PRINT_CSS = `
@page { size: A4; margin: 12mm 11mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Cairo", "Segoe UI", Tahoma, "Noto Naskh Arabic", Arial, sans-serif; color: #0f172a; font-size: 11px; line-height: 1.5; direction: rtl; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
header.doc { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; border-bottom: 3px double #1e3a8a; padding-bottom: 8px; margin-bottom: 10px; }
.company { font-size: 15px; font-weight: 800; color: #1e3a8a; }
.company small { display: block; font-size: 10px; font-weight: 500; color: #475569; }
.doc-title { text-align: left; }
.doc-title h1 { margin: 0; font-size: 19px; letter-spacing: 0.01em; }
.doc-title p { margin: 0; color: #475569; font-size: 10.5px; }
.date-strip { display: grid; grid-template-columns: 1fr 1fr 1.4fr; border: 1.5px solid #0f172a; margin-bottom: 10px; }
.date-strip div { padding: 5px 10px; border-inline-start: 1px solid #94a3b8; }
.date-strip div:first-child { border-inline-start: 0; }
.date-strip span { display: block; font-size: 9.5px; color: #475569; }
.date-strip strong { font-size: 13px; }
h2 { font-size: 12px; margin: 0 0 4px; padding: 3px 8px; background: #e2e8f0; border: 1px solid #0f172a; border-bottom: 0; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 1px solid #0f172a; padding: 4px 6px; vertical-align: middle; }
th { background: #f1f5f9; font-size: 10px; font-weight: 700; }
td { height: 22px; }
tfoot td { background: #f1f5f9; font-weight: 800; }
.c { text-align: center; } .e { text-align: left; }
.sales { margin-bottom: 10px; }
.sales td { font-size: 13px; text-align: center; height: 28px; }
.sales td.total { font-weight: 800; background: #f1f5f9; }
.lines { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; align-items: start; }
.lines th:nth-child(1), .lines td:nth-child(1) { width: 22px; text-align: center; color: #475569; }
.lines th:nth-child(4), .lines td:nth-child(4) { width: 40px; text-align: center; }
.lines th:nth-child(5), .lines td:nth-child(5) { width: 78px; text-align: left; }
.lines td { font-size: 10.5px; }
.bottom { display: grid; grid-template-columns: 1.1fr 1fr; gap: 10px; align-items: start; }
.account td { height: 24px; font-size: 11.5px; }
.account td:last-child { width: 120px; text-align: left; }
.account .op { width: 22px; text-align: center; font-weight: 800; color: #475569; }
.account .strong td { font-weight: 800; background: #f1f5f9; }
.account .final td { font-weight: 800; font-size: 13px; background: #dbeafe; border-width: 2px; }
.neg { color: #b91c1c; }
.notes { border: 1px solid #0f172a; min-height: 118px; padding: 6px 8px; white-space: pre-wrap; }
.notes-title { font-weight: 700; font-size: 10px; color: #475569; display: block; margin-bottom: 2px; }
.signatures { display: flex; justify-content: space-between; gap: 40px; margin-top: 34px; }
.signatures div { flex: 1; border-top: 1px dashed #475569; padding-top: 6px; text-align: center; color: #334155; font-size: 10.5px; }
footer.doc { margin-top: 14px; font-size: 9px; color: #94a3b8; text-align: center; }
`;

/**
 * @param {import('./daily.js').DailyLine[]} lines
 * @param {string} title
 * @param {number} total
 * @param {number} rowCount
 * @returns {string}
 */
function linesTable(lines, title, total, rowCount) {
  const rows = [];
  for (let index = 0; index < rowCount; index += 1) {
    const line = lines[index];
    rows.push(line
      ? `<tr><td>${index + 1}</td><td>${escapeHtml(line.type)}</td><td>${escapeHtml(line.name)}</td><td class="num">${line.count === null ? '' : escapeHtml(formatNumber(line.count, { maxFraction: 3 }))}</td><td class="num">${escapeHtml(formatMoney(line.amount, { currency: false }))}</td></tr>`
      : `<tr><td>${index + 1}</td><td></td><td></td><td></td><td></td></tr>`);
  }
  return `<section><h2>${escapeHtml(title)}</h2><table>
<thead><tr><th>م</th><th>النوع / المادة</th><th>الاسم / البيان</th><th>العدد</th><th>الإجمالي</th></tr></thead>
<tbody>${rows.join('')}</tbody>
<tfoot><tr><td colspan="4">إجمالي ${escapeHtml(title)}</td><td class="num">${escapeHtml(formatMoney(total, { currency: false }))}</td></tr></tfoot>
</table></section>`;
}

/**
 * Builds the printable HTML for one daily sheet. All dynamic text is escaped.
 * @param {import('./daily.js').DailySheet} sheet
 * @param {{ company: import('./export.js').PrintCompany, showHijri?: boolean }} options
 * @returns {string}
 */
export function buildDailySheetHtml(sheet, { company, showHijri = true }) {
  const t = computeDailyTotals(sheet);
  const money = value => escapeHtml(formatMoney(value));
  const signed = value => `<span class="${value < 0 ? 'neg' : ''}">${money(value)}</span>`;
  const rowCount = Math.max(MIN_PRINT_ROWS, sheet.purchases.length, sheet.expenses.length);
  const hijri = showHijri ? formatHijri(sheet.date) : '';
  const title = `يومية حركة العمل — ${formatDate(sheet.date)}`;

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}"><title>${escapeHtml(title)}</title><style>${DAILY_PRINT_CSS}${COMPANY_BLOCK_CSS}</style></head><body>
<header class="doc">${companyBlockHtml(company)}
<div class="doc-title"><h1>يومية حركة العمل</h1><p>المبيعات والمشتريات والمصروفات والعهدة</p></div></header>
<section class="date-strip">
<div><span>اليوم</span><strong>${escapeHtml(weekdayName(sheet.date))}</strong></div>
<div><span>التاريخ</span><strong>${escapeHtml(formatDate(sheet.date, { style: 'long' }))}</strong></div>
<div><span>${hijri ? 'الموافق' : 'التاريخ (ميلادي)'}</span><strong>${escapeHtml(hijri || sheet.date)}</strong></div>
</section>
<section class="sales"><h2>المبيعات</h2><table>
<thead><tr><th>مبيعات النهار</th><th>مبيعات الليل</th><th>إجمالي المبيعات</th></tr></thead>
<tbody><tr><td class="num">${money(sheet.daySales)}</td><td class="num">${money(sheet.nightSales)}</td><td class="num total">${money(t.totalSales)}</td></tr></tbody>
</table></section>
<div class="lines">
${linesTable(sheet.purchases, 'المشتريات', t.totalPurchases, rowCount)}
${linesTable(sheet.expenses, 'المصروفات', t.totalExpenses, rowCount)}
</div>
<div class="bottom">
<section><h2>الحساب الختامي لليوم</h2><table class="account"><tbody>
<tr><td class="op"></td><td>إجمالي المبيعات</td><td class="num">${money(t.totalSales)}</td></tr>
<tr><td class="op">−</td><td>إجمالي المشتريات</td><td class="num">${money(t.totalPurchases)}</td></tr>
<tr><td class="op">−</td><td>إجمالي المصروفات</td><td class="num">${money(t.totalExpenses)}</td></tr>
<tr class="strong"><td class="op">=</td><td>الصافي</td><td class="num">${signed(t.net)}</td></tr>
<tr><td class="op"></td><td>عهدة بداية اليوم</td><td class="num">${money(t.openingCash)}</td></tr>
<tr><td class="op">${t.net < 0 ? '−' : '+'}</td><td>الصافي</td><td class="num">${money(Math.abs(t.net))}</td></tr>
<tr><td class="op">−</td><td>مسحوبات ${escapeHtml(WITHDRAWER_NAME)}</td><td class="num">${money(t.withdrawals)}</td></tr>
<tr class="final"><td class="op">=</td><td>عهدة نهاية اليوم (المتبقي)</td><td class="num">${signed(t.closingCash)}</td></tr>
</tbody></table></section>
<section><h2>ملاحظات</h2><div class="notes">${escapeHtml(sheet.notes)}</div></section>
</div>
<div class="signatures"><div>توقيع المحاسب / المسؤول</div><div>اعتماد صاحب العمل</div></div>
<footer class="doc">طُبعت بتاريخ ${escapeHtml(formatDateTime(new Date()))}${company.name ? ` — ${escapeHtml(company.name)}` : ''}</footer>
</body></html>`;
}
