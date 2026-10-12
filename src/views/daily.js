/**
 * @module views/daily
 * Daily work & petty-cash sheet ("حركة العمل اليومية"): a paper-style entry
 * form (sales, itemized purchases and expenses, petty cash, owner's drawings)
 * and a filterable history of past sheets with print, export and backup.
 *
 * Self-contained: sheets live under their own localStorage key
 * (js/daily-storage.js) and never touch trips, payments or customer accounts.
 */

import { View } from '../core/view.js';
import { debounce, field, h, select } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { confirmDialog, emptyState, toast, withBusy } from '../core/ui.js';
import { companyForPrint } from '../core/domain.js';
import {
  LINE_SECTIONS, SECTION_LABEL, WITHDRAWER_NAME, carriedOpeningCash, computeDailyTotals, createDailySheet, filterSheets,
  findCashBreaks, formatDayLabel, isBlankLine, sheetMonths, shiftISODate, summarizeSheets, typeSuggestions, weekdayName
} from '../core/daily.js';
import { buildDailySheetHtml } from '../core/daily-print.js';
import { generateId } from '../core/id.js';
import { formatDate, formatHijri, formatMoney, formatMonthLabel, formatNumber, isISODate, isISOMonth, parseAmount, todayISO } from '../core/format.js';
import { exportCSV, exportJSON, exportName, exportXlsx, printHtml, printReport, readFileAsText } from '../core/export.js';
import { DAILY_STORAGE_KEY, DailyStore } from '../js/daily-storage.js';
import { button, dateCell, handleFormError, iconButton, pageHeader } from './shared.js';

const TABS = Object.freeze([
  { id: 'sheet', label: 'اليومية', icon: 'clipboardList' },
  { id: 'history', label: 'سجل اليوميات', icon: 'history' }
]);
const SECTION_ICON = Object.freeze({ purchases: 'cart', expenses: 'receipt' });
const LINE_FIELDS = Object.freeze(['type', 'name', 'count', 'amount']);
const BLANK_LINES_NEW = 3;
const PRINT_SIGNATURES = ['توقيع المحاسب / المسؤول', 'اعتماد صاحب العمل'];

/** @returns {{ id: string, type: string, name: string, count: string, amount: string }} */
const blankLine = () => ({ id: generateId('line'), type: '', name: '', count: '', amount: '' });

/** Amount → input text ('' for zero so the placeholder shows). */
const amountText = value => (value ? String(value) : '');

/**
 * Comparable form content, used to detect unsaved changes. Blank lines and
 * formatting differences ("100" vs "100.00") do not count as changes.
 * @param {Record<string, any>} form
 * @returns {string}
 */
function fingerprint(form) {
  const amount = value => {
    const parsed = parseAmount(value);
    return parsed === null ? 0 : Number.isNaN(parsed) ? String(value).trim() : Math.round(parsed * 100);
  };
  const lines = list => list.filter(line => !isBlankLine(line)).map(line => [line.type.trim(), line.name.trim(), amount(line.count), amount(line.amount)]);
  return JSON.stringify([
    form.date, amount(form.daySales), amount(form.nightSales), lines(form.purchases), lines(form.expenses),
    amount(form.openingCash), amount(form.withdrawals), form.notes.trim()
  ]);
}

/**
 * Editable (string) form state for a saved sheet, with one spare line per section.
 * @param {import('../core/daily.js').DailySheet} sheet
 */
function formFromSheet(sheet) {
  const lines = list => [
    ...list.map(line => ({ id: line.id, type: line.type, name: line.name, count: line.count === null ? '' : String(line.count), amount: String(line.amount) })),
    blankLine()
  ];
  return {
    id: sheet.id,
    createdAt: sheet.createdAt,
    date: sheet.date,
    daySales: amountText(sheet.daySales),
    nightSales: amountText(sheet.nightSales),
    purchases: lines(sheet.purchases),
    expenses: lines(sheet.expenses),
    openingCash: String(sheet.openingCash),
    withdrawals: amountText(sheet.withdrawals),
    notes: sheet.notes,
    openingTouched: true
  };
}

/**
 * Text input for money (text + decimal keypad so Arabic-Indic digits work too).
 * @param {string} name
 * @param {string} value
 * @param {{ allowNegative?: boolean }} [options]
 * @returns {HTMLInputElement}
 */
function moneyInput(name, value, { allowNegative = false } = {}) {
  return /** @type {HTMLInputElement} */ (h('input', {
    class: 'input amount', type: 'text', inputMode: 'decimal', name, value, placeholder: '0', autocomplete: 'off', maxLength: 16,
    dataset: { field: name, money: allowNegative ? 'signed' : 'plain' }
  }));
}

/**
 * Flags a money/count input whose text is not a valid amount.
 * @param {HTMLInputElement} input
 */
function markAmountValidity(input) {
  const parsed = parseAmount(input.value);
  const invalid = parsed !== null && (Number.isNaN(parsed) || (parsed < 0 && input.dataset.money !== 'signed'));
  if (invalid) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

export default class DailyView extends View {
  get title() { return 'حركة العمل اليومية'; }

  constructor(ctx, route) {
    super(ctx, route);
    const query = route.query || new URLSearchParams();
    const month = query.get('month');
    this.store = new DailyStore();
    this.state.tab = query.get('tab') === 'history' ? 'history' : 'sheet';
    this.state.requestedDate = isISODate(query.get('date')) ? query.get('date') : todayISO();
    // null = not chosen yet: defaults to the newest month that has sheets.
    this.state.filters = { month: month === 'all' ? '' : isISOMonth(month) ? month : null, date: '', search: query.get('q') || '' };
    this.state.sheets = [];
    /** @type {Record<string, any>|null} */
    this.state.form = null;
    this.state.snapshot = '';
    /** @type {{ amount: number, from: string }|null} */
    this.state.carried = null;
    /** @type {Record<string, any>} */
    this.refs = {};
    this.repaintHistoryDebounced = debounce(() => this.repaintHistory(), 180);
  }

  async load() {
    try {
      const envelope = this.store.read();
      this.state.sheets = envelope.sheets;
      this.state.quarantined = envelope.quarantine.length;
    } catch (error) {
      throw new Error(/** @type {any} */ (error)?.userMessage || 'تعذر قراءة اليوميات المحفوظة.');
    }
    // Keep whatever is being typed across background refreshes.
    if (!this.state.form) this.openDate(this.state.requestedDate);
    if (this.state.filters.month === null) this.state.filters.month = sheetMonths(this.state.sheets)[0] || '';
  }

  /** True when the form differs from the saved (or freshly opened) sheet. */
  get dirty() {
    return Boolean(this.state.form) && fingerprint(this.state.form) !== this.state.snapshot;
  }

  afterMount() {
    this.on('click', '[data-tab]', (_e, target) => this.switchTab(target.dataset.tab || 'sheet'));
    this.on('click', '[data-action="new-sheet"]', () => this.newSheet());

    this.on('input', '#daily-form [data-field]', (_e, target) => this.onFieldInput(/** @type {HTMLInputElement} */ (target)));
    this.on('input', '#daily-form [data-line]', (_e, target) => this.onLineInput(/** @type {HTMLInputElement} */ (target)));
    this.on('keydown', '#daily-form [data-line]', (event, target) => this.onLineKeydown(/** @type {KeyboardEvent} */ (event), target));
    this.on('change', '#daily-form [name="date"]', (_e, target) => this.changeDate(/** @type {HTMLInputElement} */ (target).value));
    this.on('click', '[data-action="day-step"]', (_e, target) => this.changeDate(shiftISODate(this.state.form.date, Number(target.dataset.step))));
    this.on('click', '[data-action="today"]', () => this.changeDate(todayISO()));
    this.on('click', '[data-action="add-line"]', (_e, target) => this.addLine(target.dataset.section || ''));
    this.on('click', '[data-action="remove-line"]', (_e, target) => this.removeLine(target.dataset.section || '', Number(target.dataset.index)));
    this.on('submit', '#daily-form', event => this.handleSave(event));
    this.on('click', '[data-action="print-sheet"]', () => this.printCurrent());
    this.on('click', '[data-action="delete-sheet"]', () => this.deleteSheet(this.state.form.id));

    this.on('input', '[data-filter]', (_e, target) => this.setFilter(target.dataset.filter || '', /** @type {HTMLInputElement} */ (target).value));
    this.on('click', '[data-action="clear-filters"]', () => this.clearFilters());
    this.on('click', '[data-action="open-sheet"]', (_e, target) => this.openFromHistory(target.dataset.date || ''));
    this.on('click', '[data-action="print-row"]', (_e, target) => this.printSaved(target.dataset.date || ''));
    this.on('click', '[data-action="delete-row"]', (_e, target) => this.deleteSheet(target.dataset.id || ''));
    this.on('click', '[data-action="print-month"]', () => this.printPeriod());
    this.on('click', '[data-action="export-xlsx"]', () => this.exportPeriod('xlsx'));
    this.on('click', '[data-action="export-csv"]', () => this.exportPeriod('csv'));
    this.on('click', '[data-action="backup"]', () => this.downloadBackup());
    this.on('click', '[data-action="restore-pick"]', () => this.refs.restoreInput?.click());
    this.on('change', '[data-action="restore"]', (_e, target) => this.restoreBackup(/** @type {HTMLInputElement} */ (target)));
    this.addCleanup(() => this.repaintHistoryDebounced.cancel());

    const onKeydown = event => {
      // Ignored behind the PIN lock: saving would show the day's cash in a toast over the lock screen.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && this.state.tab === 'sheet' && !this.ctx.locked) {
        event.preventDefault();
        this.refs.form?.requestSubmit();
      }
    };
    const onBeforeUnload = event => {
      if (!this.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const onStorage = event => {
      if (event.key === DAILY_STORAGE_KEY || event.key === null) this.syncFromOtherTab();
    };
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('storage', onStorage);
    this.addCleanup(() => document.removeEventListener('keydown', onKeydown));
    this.addCleanup(() => window.removeEventListener('beforeunload', onBeforeUnload));
    this.addCleanup(() => window.removeEventListener('storage', onStorage));
    // Leaving the page with unsaved changes asks first.
    this.addCleanup(this.ctx.router.beforeEach(async to => to.path === '/daily' || !this.dirty || this.confirmDiscard()));
  }

  afterRender() {
    for (const input of this.root?.querySelectorAll('#daily-form .amount') || []) markAmountValidity(/** @type {HTMLInputElement} */ (input));
    this.updateLive();
    if (this.state.focusName) {
      /** @type {HTMLElement|null|undefined} */ (this.root?.querySelector(`[name="${CSS.escape(this.state.focusName)}"]`))?.focus();
      this.state.focusName = '';
    }
  }

  /* ───────────── rendering ───────────── */

  render() {
    const { tab } = this.state;
    this.refs = {};
    return h('div', { class: 'daily-view' },
      pageHeader('حركة العمل اليومية', 'يومية المبيعات والمشتريات والمصروفات وعهدة الصندوق — مستقلة تماماً عن حسابات العملاء',
        button('يومية جديدة', { icon: 'plus', action: 'new-sheet' }),
        tab === 'sheet'
          ? button('طباعة اليومية', { icon: 'printer', variant: 'primary', action: 'print-sheet' })
          : button('طباعة الكشف', { icon: 'printer', variant: 'primary', action: 'print-month' })
      ),
      h('div', { class: 'segmented daily-tabs', role: 'tablist', ariaLabel: 'أقسام حركة العمل اليومية' },
        TABS.map(item => h('button', { type: 'button', role: 'tab', ariaSelected: String(item.id === tab), dataset: { tab: item.id } }, icon(item.icon, { size: 16 }), item.label))
      ),
      this.state.quarantined
        ? h('div', { class: 'callout warn daily-quarantine', role: 'status' }, icon('alert'),
          h('p', {}, `يوجد ${formatNumber(this.state.quarantined)} سجل يومية محفوظ لا يمكن عرضه (بيانات غير مكتملة أو مكررة). تم الاحتفاظ به كما هو دون حذف، ويُضمَّن في النسخ الاحتياطية. تواصل مع الدعم لمراجعته.`))
        : null,
      tab === 'sheet' ? this.renderSheet() : this.renderHistory()
    );
  }

  renderSheet() {
    const form = /** @type {HTMLFormElement} */ (h('form', { id: 'daily-form', class: 'grid grid-main-side daily-form', novalidate: true, autocomplete: 'off' },
      h('div', { class: 'stack' },
        this.renderDayCard(),
        this.renderSalesCard(),
        LINE_SECTIONS.map(section => this.renderLinesCard(section)),
        this.renderNotesCard()
      ),
      this.renderSummaryCard()
    ));
    this.refs.form = form;
    return form;
  }

  renderDayCard() {
    const { form } = this.state;
    const showHijri = this.ctx.settings.showHijri !== false;
    const hijri = showHijri ? formatHijri(form.date) : '';
    this.refs.status = h('span', { class: 'badge' });
    return h('section', { class: 'card' },
      h('header', { class: 'card-header' }, h('h2', {}, icon('calendar'), 'بيانات اليوم'), this.refs.status),
      h('div', { class: 'card-body' },
        h('div', { class: 'daily-date-bar' },
          field('التاريخ', h('input', { class: 'input', type: 'date', name: 'date', value: form.date, required: true })),
          // The native picker shows the date in the browser's own format (often month/day),
          // so the chosen day is always spelled out here to remove any doubt.
          h('div', { class: 'field' },
            h('span', { class: 'field-label' }, 'اليوم'),
            h('div', { class: 'day-name', dataset: { date: form.date } },
              h('strong', { class: 'day-label' }, formatDayLabel(form.date)),
              hijri ? h('small', { class: 'day-hijri' }, `الموافق ${hijri}`) : null)
          ),
          h('div', { class: 'date-nav' },
            iconButton('chevronRight', 'اليوم السابق', { action: 'day-step', dataset: { step: '-1' } }),
            button('اليوم', { size: 'sm', variant: 'ghost', action: 'today' }),
            iconButton('chevronLeft', 'اليوم التالي', { action: 'day-step', dataset: { step: '1' } })
          )
        )
      )
    );
  }

  renderSalesCard() {
    const { form } = this.state;
    this.refs.salesTotal = h('strong', { class: 'num' });
    return h('section', { class: 'card' },
      h('header', { class: 'card-header' }, h('h2', {}, icon('trendingUp'), 'المبيعات')),
      h('div', { class: 'card-body' },
        h('div', { class: 'sales-grid' },
          field('مبيعات النهار', moneyInput('daySales', form.daySales)),
          field('مبيعات الليل', moneyInput('nightSales', form.nightSales)),
          h('div', { class: 'total-preview', ariaLive: 'polite' }, h('span', {}, 'إجمالي المبيعات'), this.refs.salesTotal)
        )
      )
    );
  }

  /** @param {'purchases'|'expenses'} section */
  renderLinesCard(section) {
    const { form, sheets } = this.state;
    const label = SECTION_LABEL[section];
    const listId = `daily-types-${section}`;
    this.refs[`${section}Total`] = h('strong', { class: 'num' });
    this.refs[`${section}Count`] = h('span', { class: 'badge badge-neutral' });
    return h('section', { class: 'card', ariaLabel: label },
      h('header', { class: 'card-header' },
        h('h2', {}, icon(SECTION_ICON[section]), label, this.refs[`${section}Count`]),
        button('إضافة سطر', { icon: 'plus', size: 'sm', action: 'add-line', dataset: { section } })
      ),
      h('div', { class: 'line-grid' },
        h('div', { class: 'line-head', ariaHidden: 'true' },
          h('span', { class: 'line-index' }, '#'), h('span', {}, 'النوع / المادة'), h('span', {}, 'الاسم / البيان'),
          h('span', {}, 'العدد'), h('span', {}, 'الإجمالي'), h('span', {})
        ),
        form[section].map((line, index) => this.renderLine(section, line, index, listId))
      ),
      h('datalist', { id: listId }, typeSuggestions(sheets, section).map(value => h('option', { value }))),
      h('footer', { class: 'line-foot' }, h('span', {}, `إجمالي ${label}`), this.refs[`${section}Total`])
    );
  }

  /**
   * @param {'purchases'|'expenses'} section
   * @param {Record<string, string>} line
   * @param {number} index
   * @param {string} listId
   */
  renderLine(section, line, index, listId) {
    const n = formatNumber(index + 1);
    const input = (key, props) => h('input', {
      class: ['input', `line-${key}`], type: 'text', name: `${section}.${index}.${key}`, value: line[key], autocomplete: 'off',
      dataset: { line: key, section, index: String(index) }, ...props
    });
    return h('div', { class: 'line-row' },
      h('span', { class: 'line-index num' }, n),
      input('type', { list: listId, maxLength: 60, placeholder: 'النوع / المادة', ariaLabel: `النوع أو المادة — السطر ${n}` }),
      input('name', { maxLength: 120, placeholder: 'الاسم / البيان', ariaLabel: `الاسم أو البيان — السطر ${n}` }),
      input('count', { class: ['input', 'amount', 'line-count'], inputMode: 'decimal', maxLength: 10, placeholder: 'العدد', ariaLabel: `العدد — السطر ${n}` }),
      input('amount', { class: ['input', 'amount', 'line-amount'], inputMode: 'decimal', maxLength: 16, placeholder: 'الإجمالي', ariaLabel: `الإجمالي — السطر ${n}` }),
      h('span', { class: 'line-remove' }, iconButton('trash', `حذف السطر ${n}`, { action: 'remove-line', danger: true, dataset: { section, index: String(index) } }))
    );
  }

  renderNotesCard() {
    return h('section', { class: 'card' },
      h('header', { class: 'card-header' }, h('h2', {}, icon('edit'), 'ملاحظات')),
      h('div', { class: 'card-body' },
        h('textarea', { class: 'input', name: 'notes', rows: 3, maxLength: 2000, value: this.state.form.notes, placeholder: 'أي ملاحظة عن حركة اليوم…', ariaLabel: 'ملاحظات', dataset: { field: 'notes' } })
      )
    );
  }

  renderSummaryCard() {
    const { form } = this.state;
    const r = this.refs;
    const item = (op, label, key, className) => {
      r[key] = h('strong', { class: 'num' });
      return h('li', { class: className }, h('span', {}, h('span', { class: 'summary-op', ariaHidden: 'true' }, op), label), r[key]);
    };
    r.closing = h('strong', { class: 'num' });
    r.closingBox = h('div', { class: 'closing-box', ariaLive: 'polite' }, h('span', {}, 'عهدة نهاية اليوم', h('small', {}, 'المتبقي في الصندوق')), r.closing);
    r.carriedHint = h('small', { class: 'field-hint' });
    const openingField = field('عهدة بداية اليوم', moneyInput('openingCash', form.openingCash, { allowNegative: true }));
    openingField.appendChild(r.carriedHint);

    return h('aside', { class: 'card daily-summary', ariaLabel: 'ملخص اليوم' },
      h('header', { class: 'card-header' }, h('h2', {}, icon('scale'), 'ملخص اليوم')),
      h('div', { class: 'card-body' },
        h('ul', { class: 'summary-list' },
          item('', 'إجمالي المبيعات', 'sumSales'),
          item('−', 'إجمالي المشتريات', 'sumPurchases'),
          item('−', 'إجمالي المصروفات', 'sumExpenses'),
          item('=', 'الصافي', 'sumNet', 'is-total')
        ),
        h('div', { class: 'cash-fields' },
          openingField,
          field(`مسحوبات ${WITHDRAWER_NAME}`, moneyInput('withdrawals', form.withdrawals), { hint: 'المسحوبات الشخصية من الصندوق' })
        ),
        r.closingBox,
        h('p', { class: 'field-hint closing-formula' }, 'عهدة نهاية اليوم = عهدة البداية + الصافي − المسحوبات'),
        h('div', { class: 'daily-actions' },
          button(form.id ? 'حفظ التعديلات' : 'حفظ اليومية', { icon: 'check', variant: 'primary', type: 'submit', size: 'lg' }),
          button('طباعة اليومية', { icon: 'printer', action: 'print-sheet' }),
          form.id ? button('حذف اليومية', { icon: 'trash', variant: 'danger-soft', action: 'delete-sheet' }) : null
        ),
        h('p', { class: 'field-hint shortcut-hint' }, 'للحفظ السريع: Ctrl + S')
      )
    );
  }

  /** Refreshes every computed figure in place (no re-render, keeps focus). */
  updateLive() {
    const r = this.refs;
    const { form, carried } = this.state;
    if (!form || !r.closing) return;
    const t = computeDailyTotals(form);
    const show = (el, value) => { if (el) el.textContent = formatMoney(value); };
    show(r.salesTotal, t.totalSales);
    show(r.purchasesTotal, t.totalPurchases);
    show(r.expensesTotal, t.totalExpenses);
    show(r.sumSales, t.totalSales);
    show(r.sumPurchases, t.totalPurchases);
    show(r.sumExpenses, t.totalExpenses);
    show(r.sumNet, t.net);
    show(r.closing, t.closingCash);
    r.sumNet.classList.toggle('text-due', t.net < 0);
    r.closingBox.classList.toggle('is-negative', t.closingCash < 0);
    for (const section of LINE_SECTIONS) {
      const count = form[section].filter(line => !isBlankLine(line)).length;
      if (r[`${section}Count`]) r[`${section}Count`].textContent = `${formatNumber(count)} بند`;
    }

    if (carried) {
      const typed = parseAmount(form.openingCash);
      const matches = typed !== null && !Number.isNaN(typed) && Math.round(typed * 100) === Math.round(carried.amount * 100);
      r.carriedHint.textContent = matches
        ? `مُرحّلة من عهدة نهاية يوم ${formatDate(carried.from)}`
        : `لا تطابق عهدة نهاية يوم ${formatDate(carried.from)}: ${formatMoney(carried.amount)}`;
      r.carriedHint.classList.toggle('text-credit', !matches);
    } else {
      r.carriedHint.textContent = 'لا توجد يومية سابقة — أدخل العهدة الموجودة في الصندوق';
      r.carriedHint.classList.remove('text-credit');
    }

    const dirty = this.dirty;
    r.status.className = ['badge', !form.id ? 'badge-neutral' : dirty ? 'badge-credit' : 'badge-settled'].join(' ');
    r.status.textContent = !form.id ? (dirty ? 'يومية جديدة — لم تُحفظ بعد' : 'يومية جديدة') : dirty ? 'تعديلات غير محفوظة' : 'محفوظة';
  }

  renderHistory() {
    const { filters, sheets } = this.state;
    const months = sheetMonths(sheets);
    if (filters.month && !months.includes(filters.month)) months.unshift(filters.month);
    this.refs.restoreInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, dataset: { action: 'restore' } });
    this.refs.historyHost = h('div');
    this.repaintHistory();
    return h('section', { class: 'card' },
      h('header', { class: 'card-header' },
        h('h2', {}, icon('history'), 'سجل اليوميات'),
        h('div', { class: 'row' },
          button('Excel', { icon: 'spreadsheet', size: 'sm', action: 'export-xlsx' }),
          button('CSV', { icon: 'download', size: 'sm', variant: 'ghost', action: 'export-csv' }),
          button('نسخة احتياطية', { icon: 'database', size: 'sm', variant: 'ghost', action: 'backup', title: 'تنزيل كل اليوميات في ملف' }),
          button('استعادة', { icon: 'upload', size: 'sm', variant: 'ghost', action: 'restore-pick', title: 'استعادة اليوميات من ملف نسخة احتياطية' }),
          this.refs.restoreInput
        )
      ),
      h('div', { class: 'toolbar', role: 'search' },
        field('الشهر', select({
          value: filters.month,
          placeholder: 'جميع الأشهر',
          options: months.map(month => ({ value: month, label: formatMonthLabel(month) })),
          ariaLabel: 'تصفية حسب الشهر',
          dataset: { filter: 'month' }
        })),
        field('يوم محدد', h('input', { class: 'input', type: 'date', value: filters.date, dataset: { filter: 'date' } })),
        field('بحث في البنود والملاحظات', h('div', { class: 'search-input' }, icon('search', { size: 16 }),
          h('input', { class: 'input', type: 'search', value: filters.search, placeholder: 'مثال: كهرباء، خضار…', dataset: { filter: 'search' } })), { class: 'grow' }),
        h('div', { class: 'field', style: { flex: '0 0 auto' } }, h('span', { class: 'field-label' }, ' '), button('مسح', { icon: 'close', variant: 'ghost', action: 'clear-filters' }))
      ),
      this.refs.historyHost
    );
  }

  /** Re-renders only the summary + table (keeps toolbar focus while typing). */
  repaintHistory() {
    const host = this.refs.historyHost;
    if (!host) return;
    const { sheets, filters, form } = this.state;
    const list = filterSheets(sheets, filters);
    const totals = summarizeSheets(list);
    const breaks = findCashBreaks(sheets);
    const stat = (label, value, className) => h('div', {}, h('span', {}, label), h('strong', { class: ['num', className] }, value));
    const summary = h('div', { class: 'summary-bar' },
      stat('عدد الأيام', formatNumber(totals.days)),
      stat('إجمالي المبيعات', formatMoney(totals.totalSales)),
      stat('المشتريات', formatMoney(totals.totalPurchases)),
      stat('المصروفات', formatMoney(totals.totalExpenses)),
      stat('الصافي', formatMoney(totals.net), totals.net < 0 ? 'text-due' : 'text-ok'),
      stat(`مسحوبات ${WITHDRAWER_NAME}`, formatMoney(totals.withdrawals)),
      stat('عهدة نهاية آخر يوم', formatMoney(totals.closingCash), totals.closingCash < 0 ? 'text-due' : '')
    );

    if (!list.length) {
      host.replaceChildren(summary, emptyState(sheets.length ? 'لا توجد يوميات مطابقة للتصفية الحالية.' : 'لا توجد يوميات محفوظة بعد. ابدأ بتعبئة يومية اليوم.', 'clipboardList'));
      return;
    }

    const showHijri = this.ctx.settings.showHijri !== false;
    const money = (value, className) => h('td', { class: ['num', className] }, formatMoney(value));
    const listedBreaks = list.filter(sheet => breaks.has(sheet.date)).length;
    const rows = list.map((sheet, index) => {
      const t = computeDailyTotals(sheet);
      const gap = breaks.get(sheet.date);
      return h('tr', { class: [form?.id === sheet.id && 'row-editing'] },
        h('td', { class: 'index num' }, formatNumber(index + 1)),
        dateCell(sheet.date, showHijri),
        h('td', { class: 'nowrap' }, weekdayName(sheet.date)),
        money(t.totalSales),
        money(t.totalPurchases),
        money(t.totalExpenses),
        h('td', { class: ['num', t.net < 0 ? 'text-due' : ''] }, h('strong', {}, formatMoney(t.net))),
        money(t.withdrawals),
        h('td', { class: 'num' }, gap
          ? h('span', { class: 'cash-break', title: `لا تطابق عهدة نهاية يوم ${formatDate(gap.from)}: ${formatMoney(gap.expected)}` }, icon('alert', { size: 14, label: 'فرق في العهدة' }), formatMoney(t.openingCash))
          : formatMoney(t.openingCash)),
        h('td', { class: ['num', t.closingCash < 0 ? 'text-due' : ''] }, h('strong', {}, formatMoney(t.closingCash))),
        h('td', { class: 'nowrap' }, h('div', { class: 'actions' },
          iconButton('edit', `فتح يومية ${sheet.date}`, { action: 'open-sheet', dataset: { date: sheet.date } }),
          iconButton('printer', `طباعة يومية ${sheet.date}`, { action: 'print-row', dataset: { date: sheet.date } }),
          iconButton('trash', `حذف يومية ${sheet.date}`, { action: 'delete-row', id: sheet.id, danger: true })))
      );
    });

    host.replaceChildren(
      summary,
      listedBreaks ? h('div', { class: 'callout warn daily-callout' }, icon('alert'),
        h('p', {}, `يوجد ${formatNumber(listedBreaks)} يوم لا تطابق فيه عهدة بداية اليوم عهدةَ نهاية اليوم السابق. راجع الأيام المعلّمة.`)) : null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'table daily-table' },
        h('caption', { class: 'sr-only' }, 'سجل اليوميات مرتب من الأقدم إلى الأحدث'),
        h('thead', {}, h('tr', {},
          h('th', { class: 'center' }, '#'), h('th', {}, 'التاريخ'), h('th', {}, 'اليوم'),
          h('th', { class: 'num' }, 'المبيعات'), h('th', { class: 'num' }, 'المشتريات'), h('th', { class: 'num' }, 'المصروفات'),
          h('th', { class: 'num' }, 'الصافي'), h('th', { class: 'num' }, `مسحوبات ${WITHDRAWER_NAME}`),
          h('th', { class: 'num' }, 'عهدة البداية'), h('th', { class: 'num' }, 'عهدة النهاية'),
          h('th', {}, h('span', { class: 'sr-only' }, 'إجراءات'))
        )),
        h('tbody', {}, rows),
        h('tfoot', {}, h('tr', {},
          h('td', { colSpan: 3 }, `الإجمالي (${formatNumber(totals.days)} يوم)`),
          money(totals.totalSales), money(totals.totalPurchases), money(totals.totalExpenses),
          money(totals.net, totals.net < 0 ? 'text-due' : ''), money(totals.withdrawals),
          money(totals.openingCash), money(totals.closingCash, totals.closingCash < 0 ? 'text-due' : ''),
          h('td', {})
        ))
      ))
    );
  }

  /* ───────────── sheet state ───────────── */

  /**
   * Loads the sheet for `date` into the form (or a blank one with the
   * previous day's closing cash carried forward).
   * @param {string} date
   */
  openDate(date) {
    const { sheets } = this.state;
    const sheet = sheets.find(item => item.date === date) || null;
    const carried = carriedOpeningCash(sheets, date);
    this.state.carried = carried;
    this.state.form = sheet ? formFromSheet(sheet) : {
      id: '',
      createdAt: '',
      date,
      daySales: '',
      nightSales: '',
      purchases: Array.from({ length: BLANK_LINES_NEW }, blankLine),
      expenses: Array.from({ length: BLANK_LINES_NEW }, blankLine),
      openingCash: carried ? String(carried.amount) : '',
      withdrawals: '',
      notes: '',
      openingTouched: false
    };
    this.state.snapshot = fingerprint(this.state.form);
  }

  /** @returns {Promise<boolean>} */
  confirmDiscard() {
    return confirmDialog({
      title: 'تعديلات غير محفوظة',
      message: `لم تُحفظ التعديلات على يومية ${formatDate(this.state.form.date)}. هل تريد تجاهلها؟`,
      confirmText: 'تجاهل التعديلات',
      cancelText: 'الرجوع للحفظ',
      danger: true
    });
  }

  /** @param {string} tab */
  switchTab(tab) {
    if (tab === this.state.tab) return;
    this.state.tab = tab === 'history' ? 'history' : 'sheet';
    this.ctx.router.setQuery({ tab: this.state.tab === 'history' ? 'history' : null });
    this.update();
  }

  /** @param {HTMLInputElement} input */
  onFieldInput(input) {
    const key = input.dataset.field;
    if (!key) return;
    this.state.form[key] = input.value;
    if (key === 'openingCash') this.state.form.openingTouched = true;
    if (input.dataset.money) markAmountValidity(input);
    this.updateLive();
  }

  /** @param {HTMLInputElement} input */
  onLineInput(input) {
    const { line: key, section, index } = input.dataset;
    const line = this.state.form[section || '']?.[Number(index)];
    if (!line || !key) return;
    line[key] = input.value;
    if (key === 'count' || key === 'amount') markAmountValidity(input);
    this.updateLive();
  }

  /**
   * Enter moves through the row like a paper form; on the last field it
   * jumps to the next line, adding one when needed.
   * @param {KeyboardEvent} event
   * @param {HTMLElement} target
   */
  onLineKeydown(event, target) {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    const { line: key, section = '', index } = target.dataset;
    const row = Number(index);
    const next = LINE_FIELDS.indexOf(key || '') + 1;
    if (next > 0 && next < LINE_FIELDS.length) {
      /** @type {HTMLElement|null|undefined} */ (this.root?.querySelector(`[name="${section}.${row}.${LINE_FIELDS[next]}"]`))?.focus();
      return;
    }
    if (row >= this.state.form[section].length - 1) this.addLine(section);
    else /** @type {HTMLElement|null|undefined} */ (this.root?.querySelector(`[name="${section}.${row + 1}.type"]`))?.focus();
  }

  /** @param {string} section */
  addLine(section) {
    const lines = this.state.form[section];
    if (!lines) return;
    lines.push(blankLine());
    this.state.focusName = `${section}.${lines.length - 1}.type`;
    this.update();
  }

  /**
   * @param {string} section
   * @param {number} index
   */
  removeLine(section, index) {
    const lines = this.state.form[section];
    if (!lines?.[index]) return;
    if (lines.length === 1) lines[0] = blankLine();
    else lines.splice(index, 1);
    this.update();
  }

  /** @param {string} date */
  async changeDate(date) {
    const { form, sheets } = this.state;
    if (!isISODate(date)) {
      toast('اختر تاريخاً صحيحاً.', 'error');
      this.update();
      return;
    }
    if (date === form.date) return;
    if (!this.dirty) {
      this.openDate(date);
    } else if (!form.id && !sheets.some(sheet => sheet.date === date)) {
      // An unsaved new sheet simply moves to the chosen day, keeping what was typed.
      form.date = date;
      this.state.carried = carriedOpeningCash(sheets, date);
      if (!form.openingTouched) form.openingCash = this.state.carried ? String(this.state.carried.amount) : '';
    } else if (await this.confirmDiscard()) {
      this.openDate(date);
    } else {
      this.update(); // put the date picker back
      return;
    }
    this.state.focusName = 'date';
    this.ctx.router.setQuery({ date });
    this.update();
  }

  async newSheet() {
    const today = todayISO();
    if (this.state.form.date !== today) {
      if (this.dirty && !(await this.confirmDiscard())) return;
      this.openDate(today);
    }
    this.state.tab = 'sheet';
    this.ctx.router.setQuery({ tab: null, date: today });
    this.update();
    if (this.state.form.id) toast('يومية اليوم محفوظة مسبقاً، وتم فتحها للتعديل.', 'info');
  }

  /** @param {string} date */
  async openFromHistory(date) {
    if (!isISODate(date)) return;
    if (date !== this.state.form.date) {
      if (this.dirty && !(await this.confirmDiscard())) return;
      this.openDate(date);
    }
    this.state.tab = 'sheet';
    this.ctx.router.setQuery({ tab: null, date });
    this.update();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  /** Re-reads storage after another tab changed it. */
  syncFromOtherTab() {
    try {
      this.state.sheets = this.store.list();
    } catch (error) {
      toast(/** @type {any} */ (error)?.userMessage || 'تعذر قراءة اليوميات.', 'error');
      return;
    }
    if (!this.dirty) this.openDate(this.state.form.date);
    this.update();
  }

  /* ───────────── save / delete ───────────── */

  /**
   * Validates and stores the form; throws DomainError/StorageError.
   * @returns {import('../core/daily.js').DailySheet}
   */
  persist() {
    const { form, sheets } = this.state;
    const existing = form.id ? sheets.find(sheet => sheet.id === form.id) || null : null;
    const sheet = this.store.save(createDailySheet(form, { existing }));
    this.state.sheets = this.store.list();
    this.openDate(sheet.date);
    this.ctx.router.setQuery({ date: sheet.date });
    this.update();
    return sheet;
  }

  /** @param {Event} event */
  async handleSave(event) {
    event.preventDefault();
    const formEl = /** @type {HTMLFormElement} */ (event.target);
    const submit = /** @type {HTMLButtonElement|null} */ (formEl.querySelector('[type="submit"]'));
    await withBusy(submit, async () => {
      try {
        const sheet = this.persist();
        const t = computeDailyTotals(sheet);
        toast(`تم حفظ يومية ${weekdayName(sheet.date)} ${formatDate(sheet.date)} — المتبقي في العهدة ${formatMoney(t.closingCash)}.`, 'success');
      } catch (error) {
        handleFormError(formEl, error);
      }
    });
  }

  /** @param {string} id */
  async deleteSheet(id) {
    const sheet = this.state.sheets.find(item => item.id === id);
    if (!sheet) return;
    const t = computeDailyTotals(sheet);
    const confirmed = await confirmDialog({
      title: 'حذف يومية',
      message: `حذف يومية ${weekdayName(sheet.date)} ${formatDate(sheet.date)} (مبيعات ${formatMoney(t.totalSales)}، عهدة نهاية اليوم ${formatMoney(t.closingCash)})؟\nلا يمكن التراجع عن هذه العملية.`,
      confirmText: 'حذف',
      danger: true
    });
    if (!confirmed) return;
    try {
      this.store.delete(id);
      this.state.sheets = this.store.list();
    } catch (error) {
      toast(/** @type {any} */ (error)?.userMessage || 'تعذر حذف اليومية.', 'error');
      return;
    }
    if (this.state.form.id === id) this.openDate(sheet.date);
    toast('تم حذف اليومية.', 'info');
    this.update();
  }

  /* ───────────── history filters ───────────── */

  /**
   * @param {string} key
   * @param {string} value
   */
  setFilter(key, value) {
    if (!(key in this.state.filters)) return;
    this.state.filters[key] = value;
    const { filters } = this.state;
    this.ctx.router.setQuery({ month: filters.month || 'all', q: filters.search });
    if (key === 'search') this.repaintHistoryDebounced();
    else this.repaintHistory();
  }

  clearFilters() {
    this.state.filters = { month: '', date: '', search: '' };
    this.ctx.router.setQuery({ month: 'all', q: null });
    this.update();
  }

  /** Human label for the active history filter. */
  periodLabel() {
    const { date, month } = this.state.filters;
    if (isISODate(date)) return `يوم ${weekdayName(date)} ${formatDate(date)}`;
    return formatMonthLabel(month);
  }

  /* ───────────── print / export ───────────── */

  async printCurrent() {
    const { form } = this.state;
    if (!form.id && !this.dirty) {
      toast('اليومية فارغة. أدخل بياناتها أولاً ثم اطبعها.', 'warning');
      return;
    }
    if (this.dirty) {
      const confirmed = await confirmDialog({
        title: 'الحفظ قبل الطباعة',
        message: 'تُطبع اليومية كما هي محفوظة. هل تريد حفظ التعديلات الحالية ثم الطباعة؟',
        confirmText: 'حفظ وطباعة'
      });
      if (!confirmed) return;
      try {
        this.persist();
      } catch (error) {
        if (this.refs.form) handleFormError(this.refs.form, error);
        return;
      }
      toast('تم حفظ اليومية.', 'success');
    }
    await this.printSaved(this.state.form.date);
  }

  /** @param {string} date */
  async printSaved(date) {
    const sheet = this.state.sheets.find(item => item.date === date);
    if (!sheet) return;
    try {
      await printHtml(buildDailySheetHtml(sheet, { company: companyForPrint(this.ctx.settings), showHijri: this.ctx.settings.showHijri !== false }));
    } catch (error) {
      console.error(error);
      toast('تعذر فتح نافذة الطباعة.', 'error');
    }
  }

  /** @returns {import('../core/daily.js').DailySheet[]|null} */
  filteredOrWarn() {
    const list = filterSheets(this.state.sheets, this.state.filters);
    if (!list.length) {
      toast('لا توجد يوميات مطابقة للتصفية الحالية.', 'warning');
      return null;
    }
    return list;
  }

  async printPeriod() {
    const list = this.filteredOrWarn();
    if (!list) return;
    const s = summarizeSheets(list);
    const money = value => formatMoney(value);
    try {
      await printReport({
        title: 'كشف حركة العمل اليومية',
        subtitle: this.periodLabel(),
        company: companyForPrint(this.ctx.settings),
        meta: [
          { label: 'الفترة', value: this.periodLabel() },
          { label: 'عدد الأيام', value: formatNumber(s.days) },
          { label: 'من', value: formatDate(list[0].date) },
          { label: 'إلى', value: formatDate(list.at(-1).date) }
        ],
        summary: [
          { label: 'إجمالي المبيعات', value: money(s.totalSales) },
          { label: 'إجمالي المشتريات', value: money(s.totalPurchases) },
          { label: 'إجمالي المصروفات', value: money(s.totalExpenses) },
          { label: 'الصافي', value: money(s.net), tone: s.net < 0 ? 'due' : 'settled' },
          { label: `مسحوبات ${WITHDRAWER_NAME}`, value: money(s.withdrawals), tone: 'credit' },
          { label: 'عهدة نهاية الفترة', value: money(s.closingCash), tone: s.closingCash < 0 ? 'due' : 'neutral' }
        ],
        sections: [{
          columns: [
            { header: 'التاريخ', align: 'center' }, { header: 'اليوم' }, { header: 'المبيعات', align: 'end' }, { header: 'المشتريات', align: 'end' },
            { header: 'المصروفات', align: 'end' }, { header: 'الصافي', align: 'end' }, { header: `مسحوبات ${WITHDRAWER_NAME}`, align: 'end' },
            { header: 'عهدة البداية', align: 'end' }, { header: 'عهدة النهاية', align: 'end' }
          ],
          rows: list.map(sheet => {
            const t = computeDailyTotals(sheet);
            return [formatDate(sheet.date), weekdayName(sheet.date), money(t.totalSales), money(t.totalPurchases), money(t.totalExpenses), money(t.net), money(t.withdrawals), money(t.openingCash), money(t.closingCash)];
          }),
          footer: [['الإجمالي', '', money(s.totalSales), money(s.totalPurchases), money(s.totalExpenses), money(s.net), money(s.withdrawals), money(s.openingCash), money(s.closingCash)]]
        }],
        signatures: PRINT_SIGNATURES
      });
    } catch (error) {
      console.error(error);
      toast('تعذر فتح نافذة الطباعة.', 'error');
    }
  }

  /** @param {'xlsx'|'csv'} format */
  exportPeriod(format) {
    const list = this.filteredOrWarn();
    if (!list) return;
    const rows = list.map(sheet => ({ sheet, t: computeDailyTotals(sheet) }));
    /** @type {import('../core/export.js').ExportColumn[]} */
    const columns = [
      { header: 'التاريخ', value: row => row.sheet.date, type: 'date' },
      { header: 'اليوم', value: row => weekdayName(row.sheet.date), width: 10 },
      { header: 'مبيعات النهار', value: row => row.sheet.daySales, type: 'money' },
      { header: 'مبيعات الليل', value: row => row.sheet.nightSales, type: 'money' },
      { header: 'إجمالي المبيعات', value: row => row.t.totalSales, type: 'money' },
      { header: 'إجمالي المشتريات', value: row => row.t.totalPurchases, type: 'money' },
      { header: 'إجمالي المصروفات', value: row => row.t.totalExpenses, type: 'money' },
      { header: 'الصافي', value: row => row.t.net, type: 'money' },
      { header: 'عهدة بداية اليوم', value: row => row.t.openingCash, type: 'money' },
      { header: `مسحوبات ${WITHDRAWER_NAME}`, value: row => row.t.withdrawals, type: 'money' },
      { header: 'عهدة نهاية اليوم', value: row => row.t.closingCash, type: 'money' },
      { header: 'ملاحظات', value: row => row.sheet.notes, width: 40 }
    ];
    const s = summarizeSheets(list);
    const sum = key => rows.reduce((total, row) => total + Math.round(row.sheet[key] * 100), 0) / 100;
    const footer = [['الإجمالي', '', sum('daySales'), sum('nightSales'), s.totalSales, s.totalPurchases, s.totalExpenses, s.net, '', s.withdrawals, s.closingCash, '']];
    const name = exportName('حركة_العمل_اليومية', this.state.filters.date || this.state.filters.month);
    if (format === 'csv') {
      exportCSV(name, columns, rows, footer);
    } else {
      const lines = list.flatMap(sheet => LINE_SECTIONS.flatMap(section => sheet[section].map(line => ({ date: sheet.date, section, ...line }))));
      exportXlsx(name, [
        { name: 'ملخص الأيام', columns, rows, footer },
        {
          name: 'تفاصيل البنود',
          columns: [
            { header: 'التاريخ', value: row => row.date, type: 'date' },
            { header: 'القسم', value: row => SECTION_LABEL[row.section], width: 12 },
            { header: 'النوع / المادة', value: row => row.type, width: 20 },
            { header: 'الاسم / البيان', value: row => row.name, width: 30 },
            { header: 'العدد', value: row => row.count ?? '', type: 'number', width: 8 },
            { header: 'الإجمالي', value: row => row.amount, type: 'money' }
          ],
          rows: lines
        }
      ]);
    }
    toast(`تم تصدير ${formatNumber(list.length)} يومية.`, 'success');
  }

  /* ───────────── backup / restore ───────────── */

  downloadBackup() {
    try {
      const backup = this.store.exportBackup();
      if (!backup.sheets.length) {
        toast('لا توجد يوميات لحفظ نسخة منها.', 'warning');
        return;
      }
      exportJSON(exportName('نسخة_احتياطية_حركة_العمل_اليومية'), backup);
      toast(`تم تنزيل نسخة احتياطية تضم ${formatNumber(backup.sheets.length)} يومية.`, 'success');
    } catch (error) {
      toast(/** @type {any} */ (error)?.userMessage || 'تعذر تجهيز النسخة الاحتياطية.', 'error');
    }
  }

  /** @param {HTMLInputElement} input */
  async restoreBackup(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    let payload;
    try {
      payload = JSON.parse(await readFileAsText(file, 20 * 1024 * 1024));
    } catch {
      toast('تعذر قراءة الملف. تأكد أنه ملف نسخة احتياطية بصيغة JSON.', 'error');
      return;
    }
    try {
      const preview = this.store.previewImport(payload);
      if (!preview.sheets.length) {
        toast('الملف لا يحتوي على يوميات صالحة.', 'warning');
        return;
      }
      const details = [
        `سيتم استيراد ${formatNumber(preview.sheets.length)} يومية من الملف.`,
        preview.replacing ? `${formatNumber(preview.replacing)} منها بتواريخ موجودة حالياً وستحل محلها نسخة الملف — سيتم تنزيل نسخة من يومياتك الحالية تلقائياً قبل الاستعادة.` : '',
        preview.skipped ? `سيتم تجاهل ${formatNumber(preview.skipped)} سجل تالف.` : '',
        'بقية اليوميات الحالية تبقى كما هي.'
      ].filter(Boolean).join('\n');
      if (!(await confirmDialog({ title: 'استعادة اليوميات', message: details, confirmText: 'استعادة' }))) return;
      // Safety copy first, so replaced days can always be recovered.
      if (preview.replacing) exportJSON(exportName('نسخة_قبل_استعادة_اليوميات'), this.store.exportBackup());
      const result = this.store.importBackup(payload);
      this.state.sheets = this.store.list();
      if (!this.dirty) this.openDate(this.state.form.date);
      this.state.filters.month = sheetMonths(this.state.sheets)[0] || '';
      this.update();
      toast(`تمت استعادة ${formatNumber(result.imported)} يومية.`, 'success');
    } catch (error) {
      toast(/** @type {any} */ (error)?.userMessage || 'تعذرت استعادة النسخة الاحتياطية.', 'error');
    }
  }
}
