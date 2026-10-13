/**
 * @module views/ledger
 * Transport log: a keyboard-friendly fast entry form and a filterable
 * chronological ledger of trips and cash receipts with running balances.
 */

import { View } from '../core/view.js';
import { debounce, field, h, readForm, render, select } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { confirmDialog, emptyState, toast, withBusy } from '../core/ui.js';
import {
  activeMonths, assertDeletable, buildTimeline, computeTripAmounts, createTrip, effectiveVatRate, filterTimeline,
  isPeriodLocked, resolvePricing, summarizeLedger, withRunningBalance
} from '../core/domain.js';
import {
  formatMoney, formatMonthLabel, formatNumber, formatQuantityByUnit, isISODate, isISOMonth, todayISO
} from '../core/format.js';
import { exportCSV, exportName, exportXlsx } from '../core/export.js';
import {
  balanceClass, button, dateCell, handleFormError, iconButton, lockBadge, materialBadge, materialOptions,
  openPaymentDialog, openTripEditor, pageHeader, vatAmountField, vatDeductionRate
} from './shared.js';

const PAGE_SIZE = 200;

export default class LedgerView extends View {
  get title() { return 'سجل النقليات'; }

  constructor(ctx, route) {
    super(ctx, route);
    const query = route.query || new URLSearchParams();
    this.state.filters = {
      client: query.get('client') || '',
      material: query.get('material') || '',
      month: isISOMonth(query.get('month')) ? query.get('month') : '',
      search: query.get('q') || '',
      kind: ['trip', 'payment'].includes(query.get('kind') || '') ? query.get('kind') : 'all'
    };
    this.state.limit = PAGE_SIZE;
    this.state.form = { client: query.get('client') || '', material: '', date: todayISO(), truck: '', count: '1', price: '', notes: '', priceTouched: false };
    /** @type {Record<string, any>} */
    this.refs = {};
    this.repaintRecordsDebounced = debounce(() => this.repaintRecords(), 180);
  }

  async load() {
    this.state.data = await this.ctx.db.loadAll();
    const { form, data } = this.state;
    if (form.client && !data.clients.includes(form.client)) form.client = '';
    if (!form.client && data.clients.length === 1) form.client = data.clients[0];
  }

  afterMount() {
    this.on('submit', '#trip-form', event => this.handleSave(event));
    this.on('change', '#trip-form [name="material"]', (_e, target) => this.pickMaterial(/** @type {HTMLSelectElement} */ (target).value));
    this.on('click', '[data-action="count-step"]', (_e, target) => this.stepCount(Number(target.dataset.step)));
    this.on('click', '[data-action="reset-form"]', () => this.resetForm());
    this.on('change', '#trip-form [name="client"]', (_e, target) => this.changeClient(/** @type {HTMLSelectElement} */ (target).value));
    this.on('input', '#trip-form [name="price"]', () => { this.state.form.priceTouched = true; this.updatePriceHint(); this.updatePreview(); });
    this.on('input', '#trip-form [name="count"]', () => this.updatePreview());
    this.on('input', '#trip-form', (_e, form) => Object.assign(this.state.form, readForm(/** @type {HTMLFormElement} */ (form))));
    this.on('change', '#trip-form', (_e, form) => Object.assign(this.state.form, readForm(/** @type {HTMLFormElement} */ (form))));

    this.on('input', '[data-filter]', (_e, target) => this.setFilter(target.dataset.filter, /** @type {HTMLInputElement} */ (target).value, target.dataset.filter === 'search'));
    this.on('click', '[data-action="clear-filters"]', () => this.clearFilters());
    this.on('click', '[data-action="load-more"]', () => { this.state.limit += PAGE_SIZE; this.repaintRecords(); });
    this.on('click', '[data-action="edit-trip"]', (_e, target) => this.editTrip(target.dataset.id || ''));
    this.on('click', '[data-action="delete-trip"]', (_e, target) => this.deleteRecord('trip', target.dataset.id || ''));
    this.on('click', '[data-action="delete-payment"]', (_e, target) => this.deleteRecord('payment', target.dataset.id || ''));
    this.on('click', '[data-action="new-payment"]', () => this.addPayment());
    this.on('click', '[data-action="export-xlsx"]', () => this.exportRecords('xlsx'));
    this.on('click', '[data-action="export-csv"]', () => this.exportRecords('csv'));
    this.addCleanup(() => this.repaintRecordsDebounced.cancel());
  }

  afterRender() {
    this.updatePreview();
    if (this.state.focusTruck) {
      this.state.focusTruck = false;
      this.refs.truck?.focus();
    }
  }

  /* ───────────── rendering ───────────── */

  render() {
    const { data } = this.state;
    return h('div', {},
      pageHeader('سجل النقليات', 'إدخال سريع للنقلات ومتابعة الحركات والأرصدة',
        button('تسجيل دفعة نقدية', { icon: 'banknote', action: 'new-payment' })
      ),
      h('div', { class: 'grid grid-side-main' },
        data.clients.length ? this.renderForm() : this.renderNoClients(),
        this.renderRecordsCard()
      )
    );
  }

  renderNoClients() {
    return h('section', { class: 'card' },
      h('div', { class: 'card-body' },
        emptyState('لا يوجد عملاء بعد. أضف أول عميل لبدء تسجيل النقلات.', 'users'),
        h('div', { class: 'row', style: { justifyContent: 'center' } },
          h('a', { class: 'btn btn-primary', href: '#/accounts?new=1' }, icon('plus'), 'إضافة عميل'))
      )
    );
  }

  renderForm() {
    const { form, data } = this.state;
    const vatRate = effectiveVatRate(this.ctx.settings);
    const clientSelect = select({ name: 'client', value: form.client, required: true, placeholder: 'اختر العميل', options: data.clients, ariaLabel: 'العميل' });
    const truck = h('input', { class: 'input', type: 'text', name: 'truck', value: form.truck, list: 'truck-list', maxLength: 40, placeholder: 'مثال: 1234 أ ب ج', autocomplete: 'off' });
    const count = h('input', { class: 'input num', type: 'text', name: 'count', value: form.count, min: '1', step: '1', inputMode: 'numeric', required: true });
    const price = h('input', { class: 'input num', type: 'text', name: 'price', value: form.price, min: '0', step: '0.01', inputMode: 'decimal', required: true });
    const materialSelect = h('select', { class: 'input', name: 'material', required: true, ariaLabel: 'المادة / الخدمة' });
    const priceHint = h('small', { class: 'field-hint' });
    const totalValue = h('strong', { class: 'num' }, formatMoney(0));
    const totalNote = h('small', {}, vatRate ? `شامل ضريبة ${vatRate}%` : 'بدون ضريبة');
    Object.assign(this.refs, { clientSelect, truck, count, price, materialSelect, priceHint, totalValue, totalNote });
    const priceField = vatAmountField('سعر الوحدة (ر.س)', /** @type {HTMLInputElement} */ (price), vatDeductionRate(this.ctx.settings));
    priceField.appendChild(priceHint);

    const formEl = h('form', { id: 'trip-form', novalidate: true, autocomplete: 'off' },
      h('div', { class: 'form-grid' },
        field('العميل', clientSelect, { class: 'span-2' }),
        field('المادة / الخدمة', materialSelect, { class: 'span-2', hint: 'قائمة المواد وأسعارها خاصة بالعميل المختار' }),
        field('التاريخ', h('input', { class: 'input', type: 'date', name: 'date', value: form.date, required: true })),
        field('رقم الشاحنة', truck),
        h('div', { class: 'field' },
          h('label', { class: 'field-label', htmlFor: 'trip-count' }, 'العدد'),
          h('div', { class: 'input-group' },
            h('button', { type: 'button', class: 'btn btn-secondary', dataset: { action: 'count-step', step: '-1' }, ariaLabel: 'إنقاص العدد' }, icon('minus', { size: 16 })),
            Object.assign(count, { id: 'trip-count' }),
            h('button', { type: 'button', class: 'btn btn-secondary', dataset: { action: 'count-step', step: '1' }, ariaLabel: 'زيادة العدد' }, icon('plus', { size: 16 }))
          )
        ),
        h('div', { class: 'span-2' }, priceField),
        field('ملاحظات', h('input', { class: 'input', type: 'text', name: 'notes', value: form.notes, maxLength: 500 }), { class: 'span-2' }),
        h('div', { class: 'total-preview span-2', ariaLive: 'polite' }, h('span', {}, 'إجمالي النقلة', totalNote), totalValue)
      ),
      h('datalist', { id: 'truck-list' }, data.trucks.map(plate => h('option', { value: plate }))),
      h('div', { class: 'form-actions' },
        button('حفظ النقلة', { icon: 'check', variant: 'primary', type: 'submit', size: 'lg' }),
        button('تفريغ', { icon: 'refresh', variant: 'ghost', action: 'reset-form' })
      )
    );

    this.renderMaterials();
    return h('section', { class: 'card' },
      h('header', { class: 'card-header' }, h('h2', {}, icon('plus'), 'نقلة جديدة'),
        this.ctx.settings.lockedThrough ? h('span', { class: 'badge badge-lock' }, icon('lock', { size: 12 }), `مقفل حتى ${this.ctx.settings.lockedThrough}`) : null),
      h('div', { class: 'card-body' }, formEl)
    );
  }

  /** Rebuilds the material dropdown from the selected client's own price list. */
  renderMaterials() {
    const { form, data } = this.state;
    const { materialSelect } = this.refs;
    if (!materialSelect) return;
    const options = form.client ? materialOptions(form.client, data) : [];
    if (!options.some(option => option.value === form.material)) form.material = options[0]?.value || '';
    const placeholder = !form.client ? 'اختر العميل أولاً' : options.length ? '' : 'لا توجد مواد لهذا العميل — أضفها من الحسابات';
    materialSelect.replaceChildren(
      ...(placeholder ? [h('option', { value: '' }, placeholder)] : []),
      ...options.map(option => h('option', { value: option.value }, option.label))
    );
    materialSelect.value = form.material;
    materialSelect.disabled = !options.length;
    if (!form.priceTouched || form.price === '') this.applyPricing();
    else this.updatePriceHint();
  }

  /** Writes the client's price for the current material into the form. */
  applyPricing() {
    const { form, data } = this.state;
    if (!form.material) {
      this.updatePriceHint();
      return;
    }
    const pricing = resolvePricing(form.client, form.material, data);
    form.price = String(pricing.price);
    form.priceTouched = false;
    if (this.refs.price) this.refs.price.value = form.price;
    this.updatePriceHint();
    this.updatePreview();
  }

  /** Explains where the unit price came from. */
  updatePriceHint() {
    const { form, data } = this.state;
    const hint = this.refs.priceHint;
    if (!hint) return;
    if (!form.client || !form.material) {
      hint.textContent = 'يُعبّأ تلقائياً من تسعيرة العميل';
      return;
    }
    const pricing = resolvePricing(form.client, form.material, data);
    const origin = pricing.source === 'client' ? 'سعر خاص بالعميل' : 'السعر الافتراضي';
    hint.textContent = form.priceTouched
      ? `معدّل يدوياً — ${origin}: ${formatMoney(pricing.price)} / ${pricing.unit}`
      : `${origin} لكل ${pricing.unit}`;
  }

  updatePreview() {
    const { count, price, totalValue } = this.refs;
    if (!totalValue) return;
    const amounts = computeTripAmounts(Math.max(0, Number.parseInt(count.value, 10) || 0), Math.max(0, Number(price.value) || 0), effectiveVatRate(this.ctx.settings));
    totalValue.textContent = formatMoney(amounts.total);
  }

  renderRecordsCard() {
    const { filters, data } = this.state;
    // Only months that actually contain movements, newest first.
    const months = activeMonths(data);
    if (filters.month && !months.includes(filters.month)) months.unshift(filters.month);
    const monthInput = select({
      value: filters.month,
      placeholder: 'جميع الأشهر',
      options: months.map(month => ({ value: month, label: formatMonthLabel(month) })),
      ariaLabel: 'تصفية حسب الشهر',
      dataset: { filter: 'month' }
    });
    const searchInput = h('input', { class: 'input', type: 'search', value: filters.search, placeholder: 'عميل، مادة، شاحنة، ملاحظة…', dataset: { filter: 'search' } });
    this.refs.recordsHost = h('div');
    this.repaintRecords();
    return h('section', { class: 'card' },
      h('header', { class: 'card-header' },
        h('h2', {}, icon('history'), 'سجل الحركات'),
        h('div', { class: 'row' },
          button('Excel', { icon: 'spreadsheet', size: 'sm', action: 'export-xlsx' }),
          button('CSV', { icon: 'download', size: 'sm', variant: 'ghost', action: 'export-csv' })
        )
      ),
      h('div', { class: 'toolbar', role: 'search' },
        field('بحث', h('div', { class: 'search-input' }, icon('search', { size: 16 }), searchInput), { class: 'grow' }),
        field('العميل', select({ value: filters.client, placeholder: 'جميع العملاء', options: data.clients, ariaLabel: 'تصفية حسب العميل', dataset: { filter: 'client' } })),
        field('المادة', select({ value: filters.material, placeholder: 'جميع المواد', options: [...new Set([...data.materials.map(item => item.name), ...data.trips.map(trip => trip.material)])], dataset: { filter: 'material' } })),
        field('الشهر', monthInput),
        field('النوع', select({ value: filters.kind, options: [{ value: 'all', label: 'الكل' }, { value: 'trip', label: 'نقلات' }, { value: 'payment', label: 'دفعات' }], dataset: { filter: 'kind' } })),
        h('div', { class: 'field', style: { flex: '0 0 auto' } }, h('span', { class: 'field-label' }, ' '), button('مسح', { icon: 'close', variant: 'ghost', action: 'clear-filters' }))
      ),
      this.refs.recordsHost
    );
  }

  /** Re-renders only the summary + table (keeps toolbar focus while typing). */
  repaintRecords() {
    const host = this.refs.recordsHost;
    if (!host) return;
    const { data, filters, limit } = this.state;
    const timeline = buildTimeline(data.trips, data.payments);
    const filtered = filterTimeline(timeline, filters);
    // Running balances are only meaningful per client; compute them over that client's full history.
    const balances = new Map();
    if (filters.client) {
      for (const entry of withRunningBalance(filterTimeline(timeline, { client: filters.client }))) balances.set(entry.record.id, entry.balance);
    }
    const totals = summarizeLedger(filtered);
    const clientTotals = filters.client ? summarizeLedger(filterTimeline(timeline, { client: filters.client })) : null;
    const visible = filtered.slice(-limit);
    const hidden = filtered.length - visible.length;
    const offset = hidden;

    const summary = h('div', { class: 'summary-bar' },
      h('div', {}, h('span', {}, 'الحركات المعروضة'), h('strong', { class: 'num' }, `${formatNumber(totals.tripCount)} نقلة · ${formatNumber(totals.paymentCount)} دفعة`)),
      h('div', {}, h('span', {}, 'الكميات'), h('strong', {}, formatQuantityByUnit(filtered.filter(entry => entry.kind === 'trip').map(entry => entry.record)))),
      h('div', {}, h('span', {}, 'قيمة النقلات'), h('strong', { class: 'num' }, formatMoney(totals.deliveries))),
      h('div', {}, h('span', {}, 'الدفعات'), h('strong', { class: 'num text-ok' }, formatMoney(totals.payments))),
      clientTotals
        ? h('div', {}, h('span', {}, `الرصيد الكلي — ${filters.client}`), h('strong', { class: ['num', balanceClass(clientTotals.balance)] }, formatMoney(clientTotals.balance)))
        : h('div', {}, h('span', {}, filters.month ? `صافي ${formatMonthLabel(filters.month)}` : 'الصافي'), h('strong', { class: ['num', balanceClass(totals.balance)] }, formatMoney(totals.balance)))
    );

    if (!filtered.length) {
      host.replaceChildren(summary, emptyState(timeline.length ? 'لا توجد حركات مطابقة للتصفية الحالية.' : 'لا توجد حركات مسجلة بعد. استخدم النموذج لإضافة أول نقلة.', 'truck'));
      return;
    }

    const lockedThrough = this.ctx.settings.lockedThrough;
    const showHijri = this.ctx.settings.showHijri !== false;
    const rows = visible.map((entry, index) => {
      const record = /** @type {any} */ (entry.record);
      const locked = isPeriodLocked(entry.date, lockedThrough);
      const balance = balances.get(record.id);
      const common = [
        h('td', { class: 'index num' }, formatNumber(offset + index + 1)),
        dateCell(entry.date, showHijri),
        h('td', { class: 'nowrap' }, h('strong', {}, record.client))
      ];
      if (entry.kind === 'payment') {
        return h('tr', { class: ['row-payment', locked && 'row-locked'] },
          common,
          h('td', {}, h('span', { class: 'badge badge-payment' }, icon('banknote', { size: 13 }), 'دفعة نقدية (سند قبض)')),
          h('td', { class: 'muted center' }, '—'),
          h('td', { class: 'muted center' }, '—'),
          h('td', { class: 'muted center' }, '—'),
          h('td', { class: 'num text-ok' }, formatMoney(-record.amount)),
          filters.client ? h('td', { class: ['num', balanceClass(balance)] }, formatMoney(balance)) : null,
          h('td', { class: 'truncate', title: record.note || '' }, record.note || '—'),
          h('td', { class: 'nowrap' }, locked ? lockBadge() : h('div', { class: 'actions' },
            iconButton('trash', 'حذف الدفعة', { action: 'delete-payment', id: record.id, danger: true })))
        );
      }
      return h('tr', { class: [locked && 'row-locked'] },
        common,
        h('td', {}, materialBadge(record.material)),
        h('td', {}, record.truck ? h('span', { class: 'plate' }, record.truck) : h('span', { class: 'muted small' }, 'غير محدد')),
        h('td', { class: 'num' }, `${formatNumber(record.count)} ${record.unit}`),
        h('td', { class: 'num' }, formatMoney(record.price)),
        h('td', { class: 'num', title: record.vatAmount ? `منها ضريبة ${formatMoney(record.vatAmount)}` : undefined }, h('strong', {}, formatMoney(record.total))),
        filters.client ? h('td', { class: ['num', balanceClass(balance)] }, formatMoney(balance)) : null,
        h('td', { class: 'truncate', title: record.notes || '' }, record.notes || '—'),
        h('td', { class: 'nowrap' }, locked ? lockBadge() : h('div', { class: 'actions' },
          iconButton('edit', 'تعديل النقلة', { action: 'edit-trip', id: record.id }),
          iconButton('trash', 'حذف النقلة', { action: 'delete-trip', id: record.id, danger: true })))
      );
    });

    render(host,
      summary,
      hidden > 0 ? h('div', { class: 'load-more' }, button(`عرض ${formatNumber(Math.min(hidden, PAGE_SIZE))} حركة أقدم (المخفي ${formatNumber(hidden)})`, { icon: 'history', size: 'sm', action: 'load-more' })) : null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('caption', { class: 'sr-only' }, 'سجل النقلات والدفعات مرتب زمنياً'),
        h('thead', {}, h('tr', {},
          h('th', { class: 'center' }, '#'), h('th', {}, 'التاريخ'), h('th', {}, 'العميل'), h('th', {}, 'البيان'),
          h('th', {}, 'الشاحنة'), h('th', { class: 'num' }, 'الكمية'), h('th', { class: 'num' }, 'السعر'), h('th', { class: 'num' }, 'المبلغ'),
          filters.client ? h('th', { class: 'num' }, 'الرصيد') : null,
          h('th', {}, 'ملاحظات'), h('th', {}, h('span', { class: 'sr-only' }, 'إجراءات'))
        )),
        h('tbody', {}, rows)
      ))
    );
  }

  /* ───────────── form behaviour ───────────── */

  /** @param {string} client */
  changeClient(client) {
    this.state.form.client = client;
    this.state.form.priceTouched = false;
    this.renderMaterials();
  }

  /** @param {string} material */
  pickMaterial(material) {
    this.state.form.material = material;
    this.state.form.priceTouched = false;
    this.applyPricing();
  }

  /** @param {number} step */
  stepCount(step) {
    const input = this.refs.count;
    const next = Math.max(1, (Number.parseInt(input.value, 10) || 1) + step);
    input.value = String(next);
    this.state.form.count = input.value;
    this.updatePreview();
  }

  resetForm() {
    const { form } = this.state;
    Object.assign(form, { truck: '', count: '1', notes: '', date: todayISO(), priceTouched: false });
    this.update();
  }

  /** @param {SubmitEvent} event */
  async handleSave(event) {
    event.preventDefault();
    const formEl = /** @type {HTMLFormElement} */ (event.target);
    const submit = /** @type {HTMLButtonElement} */ (formEl.querySelector('[type="submit"]'));
    const values = readForm(formEl);
    if (!values.client) { toast('يرجى اختيار العميل.', 'error'); this.refs.clientSelect.focus(); return; }
    if (!values.material) { toast('يرجى اختيار المادة.', 'error'); return; }
    if (!isISODate(values.date)) { toast('يرجى إدخال تاريخ صحيح.', 'error'); return; }

    await withBusy(submit, async () => {
      try {
        const { data } = this.state;
        const pricing = resolvePricing(values.client, values.material, data);
        const trip = createTrip({ ...values, unit: pricing.unit }, this.ctx.mutationContext(data));
        await this.ctx.db.saveTrip(trip);
        toast(`تم حفظ نقلة ${trip.material} بقيمة ${formatMoney(trip.total)}.`, 'success');
        // Keep client, material and date for rapid repeated entry.
        Object.assign(this.state.form, { client: trip.client, material: trip.material, date: trip.date, truck: '', count: '1', notes: '', priceTouched: false });
        this.state.focusTruck = true;
        this.ctx.notifyDataChanged({ source: 'LedgerView' });
        await this.refresh();
      } catch (error) {
        handleFormError(formEl, error);
      }
    });
  }

  /* ───────────── filters ───────────── */

  /**
   * @param {string|undefined} key
   * @param {string} value
   * @param {boolean} debounced
   */
  setFilter(key, value, debounced) {
    if (!key) return;
    this.state.filters[key] = value;
    this.state.limit = PAGE_SIZE;
    const { filters } = this.state;
    this.ctx.router.setQuery({ client: filters.client, material: filters.material, month: filters.month, q: filters.search, kind: filters.kind === 'all' ? '' : filters.kind });
    if (debounced) this.repaintRecordsDebounced();
    else this.repaintRecords();
  }

  clearFilters() {
    this.state.filters = { client: '', material: '', month: '', search: '', kind: 'all' };
    this.state.limit = PAGE_SIZE;
    this.ctx.router.setQuery({ client: null, material: null, month: null, q: null, kind: null });
    this.update();
  }

  /* ───────────── record actions ───────────── */

  /** @param {string} id */
  async editTrip(id) {
    const trip = this.state.data.trips.find(item => item.id === id);
    if (!trip) return;
    if (await openTripEditor(this.ctx, this.state.data, trip, { source: 'LedgerView' })) await this.refresh();
  }

  /**
   * @param {'trip'|'payment'} kind
   * @param {string} id
   */
  async deleteRecord(kind, id) {
    const { data } = this.state;
    const record = /** @type {any} */ (kind === 'trip' ? data.trips.find(item => item.id === id) : data.payments.find(item => item.id === id));
    if (!record) return;
    assertDeletable(record, this.ctx.settings.lockedThrough);
    const message = kind === 'trip'
      ? `حذف نقلة "${record.material}" للعميل "${record.client}" بتاريخ ${record.date} بقيمة ${formatMoney(record.total)}؟`
      : `حذف دفعة ${formatMoney(record.amount)} للعميل "${record.client}" بتاريخ ${record.date}؟`;
    if (!(await confirmDialog({ title: kind === 'trip' ? 'حذف نقلة' : 'حذف دفعة', message: `${message}\nلا يمكن التراجع عن هذه العملية.`, confirmText: 'حذف', danger: true }))) return;
    await this.ctx.db.deleteTransactions(kind === 'trip' ? { trips: [id] } : { payments: [id] });
    toast(kind === 'trip' ? 'تم حذف النقلة.' : 'تم حذف الدفعة.', 'info');
    this.ctx.notifyDataChanged({ source: 'LedgerView' });
    await this.refresh();
  }

  async addPayment() {
    if (await openPaymentDialog(this.ctx, this.state.data, { client: this.state.filters.client || this.state.form.client, source: 'LedgerView' })) await this.refresh();
  }

  /** @param {'xlsx'|'csv'} format */
  exportRecords(format) {
    const { data, filters } = this.state;
    const entries = filterTimeline(buildTimeline(data.trips, data.payments), filters);
    if (!entries.length) {
      toast('لا توجد حركات مطابقة للتصدير.', 'warning');
      return;
    }
    const withBalance = filters.client ? withRunningBalance(entries) : entries;
    /** @type {import('../core/export.js').ExportColumn[]} */
    const columns = [
      { header: '#', value: (_row, index) => index + 1, type: 'number', width: 6 },
      { header: 'التاريخ', value: row => row.date, type: 'date' },
      { header: 'العميل', value: row => row.client, width: 24 },
      { header: 'النوع', value: row => (row.kind === 'trip' ? 'نقلة' : 'دفعة نقدية'), width: 12 },
      { header: 'المادة', value: row => (row.kind === 'trip' ? row.record.material : ''), width: 18 },
      { header: 'الشاحنة', value: row => row.record.truck || '', width: 14 },
      { header: 'العدد', value: row => (row.kind === 'trip' ? row.record.count : ''), type: 'number', width: 8 },
      { header: 'الوحدة', value: row => (row.kind === 'trip' ? row.record.unit : ''), width: 12 },
      { header: 'سعر الوحدة', value: row => (row.kind === 'trip' ? row.record.price : ''), type: 'money' },
      { header: 'الضريبة', value: row => (row.kind === 'trip' ? row.record.vatAmount : ''), type: 'money' },
      { header: 'مدين', value: row => row.debit || '', type: 'money' },
      { header: 'دائن', value: row => row.credit || '', type: 'money' },
      ...(filters.client ? [{ header: 'الرصيد', value: row => row.balance, type: /** @type {const} */ ('money') }] : []),
      { header: 'ملاحظات', value: row => row.record.notes || row.record.note || '', width: 30 }
    ];
    const totals = summarizeLedger(entries);
    const footer = [columns.map(column => (column.header === '#' ? '' : column.header === 'التاريخ' ? 'الإجمالي' : column.header === 'مدين' ? totals.deliveries : column.header === 'دائن' ? totals.payments : column.header === 'الرصيد' ? totals.balance : ''))];
    const name = exportName('سجل_النقليات', filters.client, filters.month);
    if (format === 'csv') exportCSV(name, columns, withBalance, footer);
    else exportXlsx(name, [{ name: 'سجل الحركات', columns, rows: withBalance, footer }]);
    toast(`تم تصدير ${formatNumber(entries.length)} حركة.`, 'success');
  }
}
