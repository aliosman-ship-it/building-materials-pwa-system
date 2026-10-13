/**
 * @module views/reports
 * Reporting: monthly client statements (invoice-style settlement with opening/closing
 * balance and VAT), receivables summary, and period trip reports — each with a live
 * preview, printable PDF output and Excel/CSV export.
 */

import { View } from '../core/view.js';
import { field, h, select } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { emptyState, toast } from '../core/ui.js';
import { balanceStatus, buildTimeline, companyForPrint, computeClientBalances, computeStatement, roundMoney, summarizeByMaterial, summarizeLedger } from '../core/domain.js';
import {
  currentMonthISO, formatDate, formatDateDual, formatMoney, formatMonthLabel, formatNumber, formatPercent,
  formatQuantityByUnit, isISODate, isISOMonth, monthRange, todayISO
} from '../core/format.js';
import { exportCSV, exportName, exportXlsx, printReport } from '../core/export.js';
import { balanceBadge, balanceClass, button, materialBadge, pageHeader } from './shared.js';

const REPORTS = Object.freeze([
  { id: 'statement', label: 'كشف شهري / فاتورة', icon: 'receipt' },
  { id: 'balances', label: 'ملخص الأرصدة', icon: 'scale' },
  { id: 'period', label: 'تقرير النقلات لفترة', icon: 'calendar' }
]);

export default class ReportsView extends View {
  get title() { return 'التقارير والكشوف'; }

  constructor(ctx, route) {
    super(ctx, route);
    const query = route.query || new URLSearchParams();
    const type = query.get('type');
    const month = query.get('month');
    const range = monthRange(currentMonthISO());
    this.state.type = REPORTS.some(report => report.id === type) ? type : 'statement';
    this.state.client = query.get('client') || '';
    this.state.month = month === 'all' ? '' : isISOMonth(month) ? month : currentMonthISO();
    this.state.from = range.from;
    this.state.to = todayISO();
    this.state.periodClient = '';
  }

  async load() {
    this.state.data = await this.ctx.db.loadAll();
    if (!this.state.data.clients.includes(this.state.client)) this.state.client = this.state.data.clients[0] || '';
  }

  afterMount() {
    this.on('click', '[data-report]', (_e, target) => this.setState({ type: target.dataset.report }));
    this.on('change', '[data-param]', (_e, target) => {
      const input = /** @type {HTMLInputElement} */ (target);
      const key = input.dataset.param || '';
      if (key === 'allTime') this.setState({ month: input.checked ? '' : currentMonthISO() });
      else if ((key === 'from' || key === 'to') && !isISODate(input.value)) toast('تاريخ غير صالح.', 'warning');
      else this.setState({ [key]: input.value });
    });
    this.on('click', '[data-action="print"]', () => this.print());
    this.on('click', '[data-action="xlsx"]', () => this.exportXlsx());
    this.on('click', '[data-action="csv"]', () => this.exportCsv());
  }

  /** @param {Record<string, any>} patch */
  setState(patch) {
    Object.assign(this.state, patch);
    this.ctx.router.setQuery({ type: this.state.type, client: this.state.client, month: this.state.month || 'all' });
    this.update();
  }

  /** @returns {{ name: string, taxNumber?: string, phone?: string }} */
  company() {
    return companyForPrint(this.ctx.settings);
  }

  /* ───────────── rendering ───────────── */

  render() {
    const { type, data } = this.state;
    return h('div', {},
      pageHeader('التقارير والكشوف', 'معاينة وطباعة وتصدير الكشوف والتقارير',
        button('طباعة / PDF', { icon: 'printer', variant: 'primary', action: 'print' }),
        button('Excel', { icon: 'spreadsheet', action: 'xlsx' }),
        button('CSV', { icon: 'download', variant: 'ghost', action: 'csv' })
      ),
      h('div', { class: 'segmented', role: 'tablist', ariaLabel: 'نوع التقرير', style: { marginBottom: '16px' } },
        REPORTS.map(report => h('button', { type: 'button', role: 'tab', ariaSelected: String(report.id === type), dataset: { report: report.id } }, icon(report.icon, { size: 16 }), report.label))
      ),
      !data.clients.length && type !== 'balances'
        ? h('section', { class: 'card' }, emptyState('لا توجد بيانات بعد. أضف عملاء ونقلات أولاً.', 'report'))
        : type === 'statement' ? this.renderStatement()
          : type === 'balances' ? this.renderBalances()
            : this.renderPeriod()
    );
  }

  renderStatement() {
    const { data, client, month } = this.state;
    const statement = computeStatement({ client, month, trips: data.trips, payments: data.payments });
    const showHijri = this.ctx.settings.showHijri !== false;
    const hasVat = statement.vatAmount > 0;

    return h('section', { class: 'card statement' },
      h('div', { class: 'toolbar' },
        field('العميل', select({ value: client, options: data.clients, dataset: { param: 'client' } }), { class: 'grow' }),
        field('الشهر', h('input', { class: 'input', type: 'month', value: month, disabled: !month, dataset: { param: 'month' } })),
        h('label', { class: 'checkbox', style: { paddingBottom: '10px' } }, h('input', { type: 'checkbox', checked: !month, dataset: { param: 'allTime' } }), 'كل الفترات')
      ),
      h('div', { class: 'statement-head' },
        h('div', {}, this.company().name ? h('h2', {}, this.company().name) : null, this.ctx.settings.taxNumber ? h('p', { class: 'muted small' }, `الرقم الضريبي: ${this.ctx.settings.taxNumber}`) : null),
        h('div', { style: { textAlign: 'left' } }, h('h2', {}, 'كشف حساب وفاتورة'), h('p', { class: 'muted small num' }, statement.reference))
      ),
      h('div', { class: 'statement-meta' },
        h('div', {}, h('span', {}, 'العميل'), h('strong', {}, client || '—')),
        h('div', {}, h('span', {}, 'الفترة'), h('strong', {}, month ? formatMonthLabel(month) : 'جميع الفترات')),
        h('div', {}, h('span', {}, 'تاريخ الإصدار'), h('strong', {}, showHijri ? formatDateDual(todayISO()) : todayISO())),
        h('div', {}, h('span', {}, 'الرصيد الافتتاحي'), h('strong', { class: ['num', balanceClass(statement.openingBalance)] }, formatMoney(statement.openingBalance))),
        h('div', {}, h('span', {}, 'توريدات الفترة'), h('strong', { class: 'num' }, formatMoney(statement.deliveries))),
        h('div', {}, h('span', {}, 'مدفوعات الفترة'), h('strong', { class: 'num text-ok' }, formatMoney(statement.paymentsTotal))),
        h('div', {}, h('span', {}, 'الرصيد الختامي'), h('strong', { class: ['num', balanceClass(statement.closingBalance)] }, formatMoney(statement.closingBalance)))
      ),

      h('h3', { class: 'section-title' }, 'ملخص حسب المادة'),
      statement.breakdown.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
          h('thead', {}, h('tr', {}, h('th', {}, 'المادة / الخدمة'), h('th', { class: 'num' }, 'الكمية'), h('th', { class: 'num' }, 'متوسط السعر'), h('th', { class: 'num' }, 'قبل الضريبة'), hasVat ? h('th', { class: 'num' }, 'الضريبة') : null, h('th', { class: 'num' }, 'الإجمالي'), h('th', { class: 'num' }, 'النسبة'))),
          h('tbody', {}, statement.breakdown.map(row => h('tr', {},
            h('td', {}, materialBadge(row.material)),
            h('td', { class: 'num' }, `${formatNumber(row.count)} ${row.unit}`),
            h('td', { class: 'num' }, formatMoney(row.averagePrice)),
            h('td', { class: 'num' }, formatMoney(row.subtotal)),
            hasVat ? h('td', { class: 'num' }, formatMoney(row.vatAmount)) : null,
            h('td', { class: 'num' }, h('strong', {}, formatMoney(row.total))),
            h('td', { class: 'num' }, formatPercent(row.share))
          ))),
          h('tfoot', {}, h('tr', {},
            h('td', {}, 'الإجمالي'),
            h('td', { class: 'num' }, formatQuantityByUnit(statement.trips)),
            h('td', {}, ''),
            h('td', { class: 'num' }, formatMoney(statement.subtotal)),
            hasVat ? h('td', { class: 'num' }, formatMoney(statement.vatAmount)) : null,
            h('td', { class: 'num' }, formatMoney(statement.deliveries)),
            h('td', { class: 'num' }, statement.deliveries > 0 ? '100%' : '0%')
          ))
        ))
        : emptyState('لا توجد نقلات لهذا العميل في الفترة المحددة.', 'truck'),

      h('h3', { class: 'section-title' }, 'تفاصيل الحركات'),
      statement.entries.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
          h('thead', {}, h('tr', {}, h('th', { class: 'center' }, '#'), h('th', {}, 'التاريخ'), h('th', {}, 'البيان'), h('th', {}, 'الشاحنة'), h('th', { class: 'num' }, 'الكمية'), h('th', { class: 'num' }, 'السعر'), h('th', { class: 'num' }, 'مدين'), h('th', { class: 'num' }, 'دائن'), h('th', { class: 'num' }, 'الرصيد'))),
          h('tbody', {},
            h('tr', {}, h('td', {}, ''), h('td', { class: 'num' }, statement.from || '—'), h('td', { colSpan: 6 }, h('em', {}, 'رصيد افتتاحي منقول')), h('td', { class: ['num', balanceClass(statement.openingBalance)] }, formatMoney(statement.openingBalance))),
            statement.entries.map((entry, index) => {
              const record = /** @type {any} */ (entry.record);
              const isTrip = entry.kind === 'trip';
              return h('tr', { class: isTrip ? '' : 'row-payment' },
                h('td', { class: 'index num' }, formatNumber(index + 1)),
                h('td', { class: 'num nowrap' }, formatDate(entry.date)),
                h('td', {}, isTrip ? record.material : `دفعة نقدية${record.note ? ` — ${record.note}` : ''}`),
                h('td', {}, isTrip && record.truck ? h('span', { class: 'plate' }, record.truck) : '—'),
                h('td', { class: 'num' }, isTrip ? `${formatNumber(record.count)} ${record.unit}` : '—'),
                h('td', { class: 'num' }, isTrip ? formatMoney(record.price) : '—'),
                h('td', { class: 'num' }, entry.debit ? formatMoney(entry.debit) : '—'),
                h('td', { class: 'num text-ok' }, entry.credit ? formatMoney(entry.credit) : '—'),
                h('td', { class: ['num', balanceClass(entry.balance)] }, formatMoney(entry.balance))
              );
            })
          ),
          h('tfoot', {}, h('tr', {}, h('td', { colSpan: 6 }, 'الإجمالي'), h('td', { class: 'num' }, formatMoney(statement.deliveries)), h('td', { class: 'num' }, formatMoney(statement.paymentsTotal)), h('td', { class: ['num', balanceClass(statement.closingBalance)] }, formatMoney(statement.closingBalance))))
        ))
        : emptyState('لا توجد حركات في هذه الفترة.', 'history')
    );
  }

  balancesRows() {
    return computeClientBalances(this.state.data).sort((a, b) => b.totalBalance - a.totalBalance);
  }

  renderBalances() {
    const rows = this.balancesRows();
    const totals = rows.reduce((acc, row) => ({
      deliveries: acc.deliveries + row.deliveries, payments: acc.payments + row.payments,
      transport: acc.transport + row.transportBalance, manual: acc.manual + row.manualBalance, total: acc.total + row.totalBalance
    }), { deliveries: 0, payments: 0, transport: 0, manual: 0, total: 0 });
    return h('section', { class: 'card' },
      h('header', { class: 'card-header' }, h('h2', {}, icon('scale'), `ملخص أرصدة العملاء حتى ${formatDate(todayISO())}`)),
      rows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'العميل'), h('th', { class: 'num' }, 'النقلات'), h('th', { class: 'num' }, 'قيمة النقلات'), h('th', { class: 'num' }, 'المدفوع'), h('th', { class: 'num' }, 'رصيد النقليات'), h('th', { class: 'num' }, 'الحساب اليدوي'), h('th', { class: 'num' }, 'الإجمالي'), h('th', {}, 'الحالة'))),
          h('tbody', {}, rows.map(row => h('tr', {},
            h('td', {}, h('strong', {}, row.client)),
            h('td', { class: 'num' }, formatNumber(row.tripCount)),
            h('td', { class: 'num' }, formatMoney(row.deliveries)),
            h('td', { class: 'num text-ok' }, formatMoney(row.payments)),
            h('td', { class: ['num', balanceClass(row.transportBalance)] }, formatMoney(row.transportBalance)),
            h('td', { class: ['num', balanceClass(row.manualBalance)] }, formatMoney(row.manualBalance)),
            h('td', { class: ['num', balanceClass(row.totalBalance)] }, h('strong', {}, formatMoney(row.totalBalance))),
            h('td', {}, balanceBadge(row.totalBalance))
          ))),
          h('tfoot', {}, h('tr', {},
            h('td', {}, 'الإجمالي'), h('td', {}, ''),
            h('td', { class: 'num' }, formatMoney(totals.deliveries)), h('td', { class: 'num' }, formatMoney(totals.payments)),
            h('td', { class: 'num' }, formatMoney(totals.transport)), h('td', { class: 'num' }, formatMoney(totals.manual)),
            h('td', { class: ['num', balanceClass(totals.total)] }, formatMoney(totals.total)), h('td', {}, '')
          ))
        ))
        : emptyState('لا يوجد عملاء.', 'users')
    );
  }

  periodData() {
    const { data, from, to, periodClient } = this.state;
    const inRange = record => record.date >= from && record.date <= to && (!periodClient || record.client === periodClient);
    const trips = data.trips.filter(inRange);
    const payments = data.payments.filter(inRange);
    return { trips, payments, entries: buildTimeline(trips, payments), breakdown: summarizeByMaterial(trips), totals: summarizeLedger(buildTimeline(trips, payments)) };
  }

  renderPeriod() {
    const { from, to, periodClient, data } = this.state;
    const { trips, breakdown, totals } = this.periodData();
    const byClient = new Map();
    for (const trip of trips) {
      const row = byClient.get(trip.client) || { client: trip.client, trips: 0, total: 0 };
      row.trips += 1;
      row.total += trip.total;
      byClient.set(trip.client, row);
    }
    return h('section', { class: 'card' },
      h('div', { class: 'toolbar' },
        field('من تاريخ', h('input', { class: 'input', type: 'date', value: from, max: to, dataset: { param: 'from' } })),
        field('إلى تاريخ', h('input', { class: 'input', type: 'date', value: to, min: from, dataset: { param: 'to' } })),
        field('العميل', select({ value: periodClient, placeholder: 'جميع العملاء', options: data.clients, dataset: { param: 'periodClient' } }), { class: 'grow' })
      ),
      h('div', { class: 'summary-bar' },
        h('div', {}, h('span', {}, 'عدد النقلات'), h('strong', { class: 'num' }, formatNumber(totals.tripCount))),
        h('div', {}, h('span', {}, 'الكميات'), h('strong', {}, formatQuantityByUnit(trips))),
        h('div', {}, h('span', {}, 'قيمة النقلات'), h('strong', { class: 'num' }, formatMoney(totals.deliveries))),
        h('div', {}, h('span', {}, 'المحصّل'), h('strong', { class: 'num text-ok' }, formatMoney(totals.payments))),
        h('div', {}, h('span', {}, 'صافي الفترة'), h('strong', { class: ['num', balanceClass(totals.balance)] }, formatMoney(totals.balance)))
      ),
      h('div', { class: 'grid grid-2', style: { padding: '20px' } },
        h('div', {}, h('h3', { class: 'section-title', style: { padding: '0 0 8px' } }, 'حسب المادة'),
          breakdown.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
            h('thead', {}, h('tr', {}, h('th', {}, 'المادة'), h('th', { class: 'num' }, 'الكمية'), h('th', { class: 'num' }, 'القيمة'), h('th', { class: 'num' }, 'النسبة'))),
            h('tbody', {}, breakdown.map(row => h('tr', {}, h('td', {}, materialBadge(row.material)), h('td', { class: 'num' }, `${formatNumber(row.count)} ${row.unit}`), h('td', { class: 'num' }, formatMoney(row.total)), h('td', { class: 'num' }, formatPercent(row.share)))))
          )) : emptyState('لا توجد نقلات في الفترة.', 'package')),
        h('div', {}, h('h3', { class: 'section-title', style: { padding: '0 0 8px' } }, 'حسب العميل'),
          byClient.size ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
            h('thead', {}, h('tr', {}, h('th', {}, 'العميل'), h('th', { class: 'num' }, 'النقلات'), h('th', { class: 'num' }, 'القيمة'))),
            h('tbody', {}, [...byClient.values()].sort((a, b) => b.total - a.total).map(row => h('tr', {}, h('td', {}, row.client), h('td', { class: 'num' }, formatNumber(row.trips)), h('td', { class: 'num' }, formatMoney(roundMoney(row.total))))))
          )) : emptyState('لا توجد نقلات في الفترة.', 'users'))
      )
    );
  }

  /* ───────────── output ───────────── */

  async print() {
    try {
      const { type } = this.state;
      if (type === 'statement') await printReport(this.statementPrintSpec());
      else if (type === 'balances') await printReport(this.balancesPrintSpec());
      else await printReport(this.periodPrintSpec());
    } catch (error) {
      console.error(error);
      toast('تعذر فتح نافذة الطباعة.', 'error');
    }
  }

  statementPrintSpec() {
    const { data, client, month } = this.state;
    const s = computeStatement({ client, month, trips: data.trips, payments: data.payments });
    const hasVat = s.vatAmount > 0;
    return {
      title: 'كشف حساب وفاتورة',
      subtitle: `${s.reference} — ${month ? formatMonthLabel(month) : 'جميع الفترات'}`,
      company: this.company(),
      meta: [
        { label: 'العميل', value: client },
        { label: 'الفترة', value: month ? `${s.from} إلى ${s.to}` : 'جميع الفترات' },
        { label: 'تاريخ الإصدار', value: this.ctx.settings.showHijri !== false ? formatDateDual(todayISO()) : todayISO() },
        { label: 'رقم المرجع', value: s.reference }
      ],
      summary: [
        { label: 'الرصيد الافتتاحي', value: formatMoney(s.openingBalance), tone: balanceStatus(s.openingBalance) },
        { label: hasVat ? 'التوريدات (شامل الضريبة)' : 'التوريدات', value: formatMoney(s.deliveries) },
        ...(hasVat ? [{ label: 'ضريبة القيمة المضافة', value: formatMoney(s.vatAmount) }] : []),
        { label: 'المدفوعات', value: formatMoney(s.paymentsTotal) },
        { label: 'الرصيد الختامي المستحق', value: formatMoney(s.closingBalance), tone: balanceStatus(s.closingBalance) }
      ],
      sections: [
        {
          title: 'ملخص حسب المادة',
          columns: [{ header: '#', align: 'center' }, { header: 'المادة / الخدمة' }, { header: 'الكمية', align: 'center' }, { header: 'متوسط السعر', align: 'end' }, { header: 'قبل الضريبة', align: 'end' }, ...(hasVat ? [{ header: 'الضريبة', align: /** @type {const} */ ('end') }] : []), { header: 'الإجمالي', align: 'end' }, { header: 'النسبة', align: 'center' }],
          rows: s.breakdown.map((row, i) => [String(i + 1), row.material, `${formatNumber(row.count)} ${row.unit}`, formatMoney(row.averagePrice), formatMoney(row.subtotal), ...(hasVat ? [formatMoney(row.vatAmount)] : []), formatMoney(row.total), formatPercent(row.share)]),
          footer: [['', 'الإجمالي', formatQuantityByUnit(s.trips), '', formatMoney(s.subtotal), ...(hasVat ? [formatMoney(s.vatAmount)] : []), formatMoney(s.deliveries), s.deliveries > 0 ? '100%' : '0%']],
          empty: 'لا توجد نقلات في الفترة.'
        },
        {
          title: 'تفاصيل الحركات',
          columns: [{ header: '#', align: 'center' }, { header: 'التاريخ', align: 'center' }, { header: 'البيان' }, { header: 'الشاحنة', align: 'center' }, { header: 'الكمية', align: 'center' }, { header: 'السعر', align: 'end' }, { header: 'مدين', align: 'end' }, { header: 'دائن', align: 'end' }, { header: 'الرصيد', align: 'end' }],
          rows: [
            ['', s.from || '—', 'رصيد افتتاحي منقول', '', '', '', '', '', formatMoney(s.openingBalance)],
            ...s.entries.map((entry, i) => {
              const r = /** @type {any} */ (entry.record);
              const trip = entry.kind === 'trip';
              return [String(i + 1), entry.date, trip ? r.material : `دفعة نقدية${r.note ? ` — ${r.note}` : ''}`, trip ? r.truck || '—' : '—', trip ? `${formatNumber(r.count)} ${r.unit}` : '—', trip ? formatMoney(r.price) : '—', entry.debit ? formatMoney(entry.debit) : '—', entry.credit ? formatMoney(entry.credit) : '—', formatMoney(entry.balance)];
            })
          ],
          footer: [['', '', 'الإجمالي', '', '', '', formatMoney(s.deliveries), formatMoney(s.paymentsTotal), formatMoney(s.closingBalance)]]
        }
      ],
      notes: hasVat ? `الأسعار شاملة ضريبة القيمة المضافة حسب النسبة المسجلة لكل نقلة${this.ctx.settings.taxNumber ? ` — الرقم الضريبي ${this.ctx.settings.taxNumber}` : ''}.` : undefined,
      signatures: true
    };
  }

  balancesPrintSpec() {
    const rows = this.balancesRows();
    const total = roundMoney(rows.reduce((sum, row) => sum + row.totalBalance, 0));
    return {
      title: 'ملخص أرصدة العملاء',
      subtitle: `حتى ${formatDate(todayISO(), { style: 'long' })}`,
      company: this.company(),
      summary: [
        { label: 'عدد العملاء', value: formatNumber(rows.length) },
        { label: 'إجمالي المستحق', value: formatMoney(total), tone: balanceStatus(total) }
      ],
      sections: [{
        columns: [{ header: '#', align: 'center' }, { header: 'العميل' }, { header: 'النقلات', align: 'center' }, { header: 'قيمة النقلات', align: 'end' }, { header: 'المدفوع', align: 'end' }, { header: 'رصيد النقليات', align: 'end' }, { header: 'الحساب اليدوي', align: 'end' }, { header: 'الإجمالي', align: 'end' }],
        rows: rows.map((row, i) => [String(i + 1), row.client, formatNumber(row.tripCount), formatMoney(row.deliveries), formatMoney(row.payments), formatMoney(row.transportBalance), formatMoney(row.manualBalance), formatMoney(row.totalBalance)]),
        footer: [['', 'الإجمالي', '', formatMoney(rows.reduce((s, r) => s + r.deliveries, 0)), formatMoney(rows.reduce((s, r) => s + r.payments, 0)), formatMoney(rows.reduce((s, r) => s + r.transportBalance, 0)), formatMoney(rows.reduce((s, r) => s + r.manualBalance, 0)), formatMoney(total)]]
      }]
    };
  }

  periodPrintSpec() {
    const { from, to, periodClient } = this.state;
    const { entries, breakdown, totals, trips } = this.periodData();
    return {
      title: 'تقرير النقلات',
      subtitle: `${from} إلى ${to}${periodClient ? ` — ${periodClient}` : ''}`,
      company: this.company(),
      summary: [
        { label: 'عدد النقلات', value: formatNumber(totals.tripCount) },
        { label: 'الكميات', value: formatQuantityByUnit(trips) },
        { label: 'قيمة النقلات', value: formatMoney(totals.deliveries) },
        { label: 'المحصّل', value: formatMoney(totals.payments) }
      ],
      sections: [
        {
          title: 'حسب المادة',
          columns: [{ header: 'المادة' }, { header: 'الكمية', align: 'center' }, { header: 'القيمة', align: 'end' }, { header: 'النسبة', align: 'center' }],
          rows: breakdown.map(row => [row.material, `${formatNumber(row.count)} ${row.unit}`, formatMoney(row.total), formatPercent(row.share)])
        },
        {
          title: 'الحركات',
          columns: [{ header: '#', align: 'center' }, { header: 'التاريخ', align: 'center' }, { header: 'العميل' }, { header: 'البيان' }, { header: 'الكمية', align: 'center' }, { header: 'مدين', align: 'end' }, { header: 'دائن', align: 'end' }],
          rows: entries.map((entry, i) => {
            const r = /** @type {any} */ (entry.record);
            const trip = entry.kind === 'trip';
            return [String(i + 1), entry.date, r.client, trip ? r.material : 'دفعة نقدية', trip ? `${formatNumber(r.count)} ${r.unit}` : '—', entry.debit ? formatMoney(entry.debit) : '—', entry.credit ? formatMoney(entry.credit) : '—'];
          }),
          footer: [['', '', '', 'الإجمالي', '', formatMoney(totals.deliveries), formatMoney(totals.payments)]],
          empty: 'لا توجد حركات في الفترة.'
        }
      ]
    };
  }

  /** @returns {{ name: string, sheets: import('../core/export.js').SheetSpec[] }} */
  workbook() {
    const { type, data, client, month, from, to, periodClient } = this.state;
    if (type === 'statement') {
      const s = computeStatement({ client, month, trips: data.trips, payments: data.payments });
      const label = month ? formatMonthLabel(month) : 'جميع الفترات';
      return {
        name: exportName('كشف', client, month || 'كل_الفترات'),
        sheets: [
          {
            name: 'الملخص',
            preamble: [[`كشف حساب: ${client}`], [`الفترة: ${label}`, `المرجع: ${s.reference}`]],
            columns: [
              { header: 'المادة', value: r => r.material, width: 22 }, { header: 'الوحدة', value: r => r.unit, width: 12 },
              { header: 'الكمية', value: r => r.count, type: 'number' }, { header: 'متوسط السعر', value: r => r.averagePrice, type: 'money' },
              { header: 'قبل الضريبة', value: r => r.subtotal, type: 'money' }, { header: 'الضريبة', value: r => r.vatAmount, type: 'money' },
              { header: 'الإجمالي', value: r => r.total, type: 'money' }, { header: 'النسبة %', value: r => r.share, type: 'number' }
            ],
            rows: s.breakdown,
            footer: [['الإجمالي', '', '', '', s.subtotal, s.vatAmount, s.deliveries, ''], ['الرصيد الافتتاحي', '', '', '', '', '', s.openingBalance, ''], ['المدفوعات', '', '', '', '', '', s.paymentsTotal, ''], ['الرصيد الختامي', '', '', '', '', '', s.closingBalance, '']]
          },
          {
            name: 'التفاصيل',
            columns: [
              { header: 'التاريخ', value: e => e.date, type: 'date' },
              { header: 'النوع', value: e => (e.kind === 'trip' ? 'نقلة' : 'دفعة'), width: 10 },
              { header: 'المادة', value: e => (e.kind === 'trip' ? e.record.material : ''), width: 20 },
              { header: 'الشاحنة', value: e => e.record.truck || '', width: 14 },
              { header: 'العدد', value: e => (e.kind === 'trip' ? e.record.count : ''), type: 'number' },
              { header: 'الوحدة', value: e => (e.kind === 'trip' ? e.record.unit : ''), width: 12 },
              { header: 'السعر', value: e => (e.kind === 'trip' ? e.record.price : ''), type: 'money' },
              { header: 'مدين', value: e => e.debit || '', type: 'money' },
              { header: 'دائن', value: e => e.credit || '', type: 'money' },
              { header: 'الرصيد', value: e => e.balance, type: 'money' },
              { header: 'ملاحظات', value: e => e.record.notes || e.record.note || '', width: 30 }
            ],
            rows: s.entries,
            footer: [['الإجمالي', '', '', '', '', '', '', s.deliveries, s.paymentsTotal, s.closingBalance, '']]
          }
        ]
      };
    }
    if (type === 'balances') {
      const rows = this.balancesRows();
      return {
        name: exportName('ملخص_الأرصدة'),
        sheets: [{
          name: 'الأرصدة',
          columns: [
            { header: 'العميل', value: r => r.client, width: 26 }, { header: 'النقلات', value: r => r.tripCount, type: 'number' },
            { header: 'قيمة النقلات', value: r => r.deliveries, type: 'money' }, { header: 'المدفوع', value: r => r.payments, type: 'money' },
            { header: 'رصيد النقليات', value: r => r.transportBalance, type: 'money' }, { header: 'ديون يدوية', value: r => r.manualDebt, type: 'money' },
            { header: 'سداد يدوي', value: r => r.manualPaid, type: 'money' }, { header: 'الحساب اليدوي', value: r => r.manualBalance, type: 'money' },
            { header: 'الإجمالي', value: r => r.totalBalance, type: 'money' }, { header: 'آخر حركة', value: r => r.lastActivity, type: 'date' }
          ],
          rows,
          footer: [['الإجمالي', '', ...['deliveries', 'payments', 'transportBalance', 'manualDebt', 'manualPaid', 'manualBalance', 'totalBalance'].map(key => roundMoney(rows.reduce((sum, row) => sum + row[key], 0))), '']]
        }]
      };
    }
    const { trips, breakdown, totals } = this.periodData();
    return {
      name: exportName('تقرير_النقلات', from, to, periodClient),
      sheets: [
        {
          name: 'النقلات',
          columns: [
            { header: 'التاريخ', value: t => t.date, type: 'date' }, { header: 'العميل', value: t => t.client, width: 24 },
            { header: 'المادة', value: t => t.material, width: 18 }, { header: 'الشاحنة', value: t => t.truck, width: 14 },
            { header: 'العدد', value: t => t.count, type: 'number' }, { header: 'الوحدة', value: t => t.unit, width: 12 },
            { header: 'السعر', value: t => t.price, type: 'money' }, { header: 'قبل الضريبة', value: t => t.subtotal, type: 'money' },
            { header: 'الضريبة', value: t => t.vatAmount, type: 'money' }, { header: 'الإجمالي', value: t => t.total, type: 'money' },
            { header: 'ملاحظات', value: t => t.notes, width: 30 }
          ],
          rows: [...trips].sort((a, b) => a.date.localeCompare(b.date)),
          footer: [['الإجمالي', '', '', '', '', '', '', roundMoney(trips.reduce((s, t) => s + t.subtotal, 0)), roundMoney(trips.reduce((s, t) => s + t.vatAmount, 0)), totals.deliveries, '']]
        },
        {
          name: 'حسب المادة',
          columns: [
            { header: 'المادة', value: r => r.material, width: 22 }, { header: 'الوحدة', value: r => r.unit, width: 12 },
            { header: 'الكمية', value: r => r.count, type: 'number' }, { header: 'الإجمالي', value: r => r.total, type: 'money' },
            { header: 'النسبة %', value: r => r.share, type: 'number' }
          ],
          rows: breakdown
        }
      ]
    };
  }

  exportXlsx() {
    const { name, sheets } = this.workbook();
    if (!sheets.some(sheet => sheet.rows.length)) {
      toast('لا توجد بيانات للتصدير.', 'warning');
      return;
    }
    exportXlsx(name, sheets);
    toast('تم إنشاء ملف Excel.', 'success');
  }

  exportCsv() {
    const { name, sheets } = this.workbook();
    // Statements export their transaction details; other reports export their primary sheet.
    const sheet = this.state.type === 'statement' ? sheets[1] : sheets[0];
    if (!sheet.rows.length) {
      toast('لا توجد بيانات للتصدير.', 'warning');
      return;
    }
    exportCSV(name, sheet.columns, sheet.rows, sheet.footer);
    toast('تم إنشاء ملف CSV.', 'success');
  }
}
