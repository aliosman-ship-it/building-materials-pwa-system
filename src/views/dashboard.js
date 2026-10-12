/**
 * @module views/dashboard
 * KPI analytics for a selected month plus all-time receivables.
 */

import { View } from '../core/view.js';
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { emptyState } from '../core/ui.js';
import { computeDashboard } from '../core/domain.js';
import {
  currentMonthISO, formatDate, formatMonthLabel, formatMoney, formatNumber, formatPercent,
  formatQuantityByUnit, isISOMonth, shiftMonth
} from '../core/format.js';
import { balanceClass, button, kpi, materialBadge, openPaymentDialog, pageHeader } from './shared.js';

export default class DashboardView extends View {
  get title() { return 'لوحة المعلومات'; }

  async load() {
    const month = this.route.query?.get('month');
    this.state.month = this.state.month || (isISOMonth(month) ? month : currentMonthISO());
    this.state.data = await this.ctx.db.loadAll();
  }

  afterMount() {
    this.on('click', '[data-action="prev-month"]', () => this.setMonth(shiftMonth(this.state.month, -1)));
    this.on('click', '[data-action="next-month"]', () => this.setMonth(shiftMonth(this.state.month, 1)));
    this.on('click', '[data-action="this-month"]', () => this.setMonth(currentMonthISO()));
    this.on('click', '[data-action="new-trip"]', () => this.ctx.router.navigate('/ledger'));
    this.on('click', '[data-action="new-payment"]', async () => {
      if (await openPaymentDialog(this.ctx, this.state.data, { source: 'DashboardView' })) await this.refresh();
    });
  }

  /**
   * @param {string} month
   */
  setMonth(month) {
    this.ctx.router.setQuery({ month: month === currentMonthISO() ? null : month });
    this.update({ month });
  }

  render() {
    const { data, month } = this.state;
    const stats = computeDashboard({ ...data, month });
    const isCurrent = month === currentMonthISO();

    return h('div', {},
      pageHeader('لوحة المعلومات', `ملخص أداء ${formatMonthLabel(month)} والأرصدة المستحقة`,
        button('نقلة جديدة', { icon: 'plus', variant: 'primary', action: 'new-trip' }),
        button('تسجيل دفعة', { icon: 'banknote', action: 'new-payment' })
      ),

      h('div', { class: 'row', style: { marginBottom: '16px' } },
        h('div', { class: 'segmented', role: 'group', ariaLabel: 'اختيار الشهر' },
          h('button', { type: 'button', dataset: { action: 'prev-month' }, ariaLabel: 'الشهر السابق' }, icon('chevronRight', { size: 16 })),
          h('button', { type: 'button', ariaPressed: 'true', ariaLive: 'polite' }, icon('calendar', { size: 16 }), formatMonthLabel(month)),
          h('button', { type: 'button', dataset: { action: 'next-month' }, ariaLabel: 'الشهر التالي', disabled: isCurrent }, icon('chevronLeft', { size: 16 }))
        ),
        isCurrent ? null : button('الشهر الحالي', { size: 'sm', variant: 'ghost', action: 'this-month' })
      ),

      h('section', { class: 'kpi-grid', ariaLabel: 'مؤشرات الشهر' },
        kpi({ label: 'نقلات الشهر', value: formatNumber(stats.tripCount), caption: formatQuantityByUnit(stats.monthTrips), icon: 'truck' }),
        kpi({ label: 'قيمة التوريدات', value: formatMoney(stats.deliveries), caption: `${formatNumber(stats.activeClients)} عميل نشط`, icon: 'trendingUp' }),
        kpi({ label: 'المحصّل نقداً', value: formatMoney(stats.collected), caption: `نسبة التحصيل ${formatPercent(stats.collectionRate)}`, icon: 'banknote', tone: 'info' }),
        kpi({ label: 'نقلات المخلفات', value: formatNumber(stats.wasteTrips), caption: `متوسط ${formatNumber(stats.averagePerDay)} نقلة / يوم عمل`, icon: 'recycle', tone: 'credit' }),
        kpi({ label: 'مستحقات النقليات', value: formatMoney(stats.transportOutstanding), caption: 'إجمالي الأرصدة المدينة', icon: 'receipt', tone: stats.transportOutstanding > 0 ? 'due' : '' }),
        kpi({ label: 'ديون الحسابات اليدوية', value: formatMoney(stats.manualOutstanding), caption: `${formatNumber(stats.clientsWithDues)} عميل عليه مستحقات`, icon: 'wallet', tone: stats.manualOutstanding > 0 ? 'due' : '' })
      ),

      h('div', { class: 'grid grid-2' },
        this.renderClients(stats),
        this.renderMaterials(stats)
      ),
      h('div', { class: 'grid grid-2', style: { marginTop: '20px' } },
        this.renderDebtors(stats),
        this.renderRecent(stats)
      )
    );
  }

  /** @param {ReturnType<typeof computeDashboard>} stats */
  renderClients(stats) {
    return h('section', { class: 'card' },
      h('header', { class: 'card-header' }, h('h2', {}, icon('building'), 'نشاط العملاء هذا الشهر')),
      stats.perClient.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
          h('thead', {}, h('tr', {}, h('th', {}, 'العميل'), h('th', { class: 'num' }, 'النقلات'), h('th', { class: 'num' }, 'القيمة'))),
          h('tbody', {}, stats.perClient.map(row => h('tr', {},
            h('td', {}, h('a', { href: `#/ledger?client=${encodeURIComponent(row.client)}` }, row.client)),
            h('td', { class: 'num' }, formatNumber(row.trips)),
            h('td', { class: 'num' }, formatMoney(row.value))
          )))
        ))
        : emptyState('لا توجد نقلات مسجلة في هذا الشهر.', 'truck')
    );
  }

  /** @param {ReturnType<typeof computeDashboard>} stats */
  renderMaterials(stats) {
    return h('section', { class: 'card' },
      h('header', { class: 'card-header' }, h('h2', {}, icon('layers'), 'التوزيع حسب المادة')),
      stats.breakdown.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
          h('thead', {}, h('tr', {}, h('th', {}, 'المادة'), h('th', { class: 'num' }, 'الكمية'), h('th', { class: 'num' }, 'القيمة'), h('th', { class: 'num' }, 'النسبة'))),
          h('tbody', {}, stats.breakdown.map(row => h('tr', {},
            h('td', {}, materialBadge(row.material)),
            h('td', { class: 'num' }, `${formatNumber(row.count)} ${row.unit}`),
            h('td', { class: 'num' }, formatMoney(row.total)),
            h('td', { class: 'num' }, formatPercent(row.share))
          )))
        ))
        : emptyState('لا توجد بيانات مواد لهذا الشهر.', 'package')
    );
  }

  /** @param {ReturnType<typeof computeDashboard>} stats */
  renderDebtors(stats) {
    return h('section', { class: 'card' },
      h('header', { class: 'card-header' },
        h('h2', {}, icon('alert'), 'أعلى الأرصدة المستحقة'),
        h('a', { href: '#/accounts', class: 'small' }, 'كل الحسابات')
      ),
      stats.topDebtors.length
        ? h('ul', { class: 'list' }, stats.topDebtors.map(row => h('li', { class: 'list-item' },
          h('div', { class: 'list-item-main' },
            h('div', { class: 'list-item-title' }, row.client),
            h('div', { class: 'list-item-sub' }, `نقليات ${formatMoney(row.transportBalance)} · يدوي ${formatMoney(row.manualBalance)}`)
          ),
          h('div', { class: ['list-item-value', balanceClass(row.totalBalance)] }, formatMoney(row.totalBalance))
        )))
        : emptyState('لا توجد أرصدة مستحقة. جميع الحسابات خالصة.', 'checkCircle')
    );
  }

  /** @param {ReturnType<typeof computeDashboard>} stats */
  renderRecent(stats) {
    return h('section', { class: 'card' },
      h('header', { class: 'card-header' },
        h('h2', {}, icon('history'), 'آخر الحركات'),
        h('a', { href: '#/ledger', class: 'small' }, 'السجل الكامل')
      ),
      stats.recent.length
        ? h('ul', { class: 'list' }, stats.recent.map(entry => {
          const record = /** @type {any} */ (entry.record);
          const isTrip = entry.kind === 'trip';
          return h('li', { class: 'list-item' },
            h('span', { class: ['kpi-icon'], style: { width: '36px', height: '36px' } }, icon(isTrip ? 'truck' : 'banknote', { size: 18 })),
            h('div', { class: 'list-item-main' },
              h('div', { class: 'list-item-title' }, record.client),
              h('div', { class: 'list-item-sub' }, `${formatDate(entry.date)} · ${isTrip ? `${record.material} × ${formatNumber(record.count)} ${record.unit}` : 'دفعة نقدية'}`)
            ),
            h('div', { class: ['list-item-value', isTrip ? '' : 'text-ok'] }, isTrip ? formatMoney(entry.debit) : formatMoney(-entry.credit))
          );
        }))
        : emptyState('لم تُسجّل أي حركات بعد. ابدأ من سجل النقليات.', 'history')
    );
  }
}
