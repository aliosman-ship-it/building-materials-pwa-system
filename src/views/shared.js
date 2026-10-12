/**
 * @module views/shared
 * Presentational helpers and cross-screen dialogs (payment entry, trip editor)
 * shared by the ledger, accounts and dashboard views.
 */

import { field, h, readForm, select } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { openModal, toast } from '../core/ui.js';
import {
  BALANCE_STATUS_LABEL, STANDARD_VAT_RATE, balanceStatus, computeTripAmounts, createPayment, getClientMaterials,
  isPeriodLocked, isWasteMaterial, resolvePricing, splitVatInclusive, updateTrip
} from '../core/domain.js';
import { formatDate, formatHijri, formatMoney, formatNumber, todayISO } from '../core/format.js';

/**
 * Page header with optional action buttons.
 * @param {string} title
 * @param {string} [subtitle]
 * @param {...Node} actions
 * @returns {HTMLElement}
 */
export function pageHeader(title, subtitle, ...actions) {
  return h('div', { class: 'page-header' },
    h('div', {}, h('h1', {}, title), subtitle ? h('p', {}, subtitle) : null),
    actions.length ? h('div', { class: 'row no-print' }, actions) : null
  );
}

/**
 * Button factory.
 * @param {string} label
 * @param {{ icon?: string, variant?: string, size?: 'sm'|'lg', action?: string, type?: string, dataset?: Record<string, string>, title?: string, disabled?: boolean, form?: string }} [options]
 * @returns {HTMLButtonElement}
 */
export function button(label, { icon: iconName, variant = 'secondary', size, action, type = 'button', dataset = {}, title, disabled, form } = {}) {
  return /** @type {HTMLButtonElement} */ (h('button', {
    type,
    class: ['btn', `btn-${variant}`, size && `btn-${size}`],
    dataset: { ...(action ? { action } : {}), ...dataset },
    title,
    disabled,
    attrs: form ? { form } : undefined
  }, iconName ? icon(iconName, { size: size === 'sm' ? 15 : 18 }) : null, label));
}

/**
 * Icon-only action button (accessible label required).
 * @param {string} iconName
 * @param {string} label
 * @param {{ action: string, id?: string, danger?: boolean, disabled?: boolean, dataset?: Record<string, string> }} options
 * @returns {HTMLButtonElement}
 */
export function iconButton(iconName, label, { action, id, danger = false, disabled = false, dataset = {} }) {
  return /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    class: ['icon-btn', danger && 'danger'],
    title: label,
    ariaLabel: label,
    disabled,
    dataset: { action, ...(id ? { id } : {}), ...dataset }
  }, icon(iconName, { size: 17 })));
}

/**
 * KPI tile.
 * @param {{ label: string, value: string, caption?: string, icon: string, tone?: 'due'|'credit'|'info'|'' }} props
 * @returns {HTMLElement}
 */
export function kpi({ label, value, caption, icon: iconName, tone = '' }) {
  return h('article', { class: ['kpi', tone && `tone-${tone}`] },
    h('div', { class: 'kpi-icon' }, icon(iconName, { size: 22 })),
    h('div', {},
      h('div', { class: 'kpi-label' }, label),
      h('div', { class: 'kpi-value num' }, value),
      caption ? h('div', { class: 'kpi-caption' }, caption) : null
    )
  );
}

/**
 * Material pill (waste services are highlighted differently).
 * @param {string} material
 * @returns {HTMLElement}
 */
export function materialBadge(material) {
  const waste = isWasteMaterial(material);
  return h('span', { class: ['badge', waste ? 'badge-waste' : 'badge-material'] }, icon(waste ? 'recycle' : 'package', { size: 13 }), material || '—');
}

/**
 * Balance status pill.
 * @param {number} balance
 * @returns {HTMLElement}
 */
export function balanceBadge(balance) {
  const status = balanceStatus(balance);
  return h('span', { class: ['badge', `badge-${status === 'due' ? 'due' : status === 'credit' ? 'credit' : 'settled'}`] }, BALANCE_STATUS_LABEL[status]);
}

/**
 * CSS class for a balance amount.
 * @param {number} balance
 * @returns {string}
 */
export function balanceClass(balance) {
  const status = balanceStatus(balance);
  return status === 'due' ? 'text-due' : status === 'credit' ? 'text-credit' : 'text-ok';
}

/**
 * Money table cell.
 * @param {number} amount
 * @param {{ class?: string, signed?: boolean }} [options]
 * @returns {HTMLTableCellElement}
 */
export function moneyCell(amount, { class: className, signed = false } = {}) {
  return /** @type {HTMLTableCellElement} */ (h('td', { class: ['num', className] }, formatMoney(amount, { signed })));
}

/**
 * Date cell with the Hijri date as a tooltip / secondary line.
 * @param {string} date
 * @param {boolean} [showHijri=true]
 * @returns {HTMLTableCellElement}
 */
export function dateCell(date, showHijri = true) {
  const hijri = showHijri ? formatHijri(date) : '';
  return /** @type {HTMLTableCellElement} */ (h('td', { class: 'nowrap', title: hijri || undefined },
    h('span', { class: 'num' }, formatDate(date)),
    hijri ? h('div', { class: 'small muted' }, hijri) : null
  ));
}

/**
 * Small lock badge for immutable records.
 * @returns {HTMLElement}
 */
export function lockBadge() {
  return h('span', { class: 'badge badge-lock', title: 'ضمن فترة مقفلة — لا يمكن التعديل أو الحذف' }, icon('lock', { size: 12 }), 'مقفلة');
}

/**
 * Builds <option> data for a client's materials.
 * @param {string} client
 * @param {{ catalogs: any[], materials: any[] }} data
 * @returns {Array<{ value: string, label: string }>}
 */
export function materialOptions(client, data) {
  return getClientMaterials(client, data).map(item => ({
    value: item.name,
    label: `${item.name} — ${formatMoney(item.defaultPrice)}${item.source === 'client' ? ' (سعر خاص)' : ''}`
  }));
}

/**
 * VAT rate used by the "deduct VAT" converters: the configured rate, else 15%.
 * @param {{ vatRate?: unknown }} settings
 * @returns {number}
 */
export function vatDeductionRate(settings) {
  const rate = Number(settings?.vatRate);
  return Number.isFinite(rate) && rate > 0 && rate <= 100 ? rate : STANDARD_VAT_RATE;
}

/**
 * Inline converter: replaces a VAT-inclusive amount in `input` with its net value
 * and fires an `input` event so dependent previews and form state update.
 * @param {HTMLInputElement} input
 * @param {number} rate
 * @returns {HTMLButtonElement}
 */
export function vatDeductButton(input, rate) {
  const deduct = () => {
    try {
      const { net, vat } = splitVatInclusive(input.value, rate);
      if (!net) {
        toast('أدخل المبلغ شاملاً الضريبة أولاً ثم اضغط خصم الضريبة.', 'warning');
        input.focus();
        return;
      }
      input.value = String(net);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      toast(`تم خصم ضريبة ${formatMoney(vat)} — الصافي ${formatMoney(net)}.`, 'info');
    } catch (error) {
      toast(/** @type {any} */ (error)?.message || 'المبلغ غير صالح.', 'error');
      input.focus();
    }
  };
  return /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    class: 'btn btn-secondary btn-vat',
    title: `اعتبر المبلغ شاملاً الضريبة واحسب الصافي (÷ ${formatNumber(1 + rate / 100, { maxFraction: 4 })})`,
    dataset: { role: 'vat-deduct' },
    on: { click: deduct }
  }, icon('percent', { size: 15 }), `خصم ${formatNumber(rate)}%`));
}

/**
 * Labeled amount field with the inline "deduct VAT" converter beside the input.
 * @param {string} label
 * @param {HTMLInputElement} input
 * @param {number} rate
 * @param {{ hint?: string, class?: string }} [options]
 * @returns {HTMLElement}
 */
export function vatAmountField(label, input, rate, { hint, class: className } = {}) {
  if (!input.id) input.id = `f_${Math.random().toString(36).slice(2, 9)}`;
  return h('div', { class: ['field', className] },
    h('label', { htmlFor: input.id, class: 'field-label' }, label),
    h('div', { class: 'input-group' }, input, vatDeductButton(input, rate)),
    hint ? h('small', { class: 'field-hint' }, hint) : null
  );
}

/**
 * Opens the cash receipt dialog.
 * @param {any} ctx App context.
 * @param {import('../js/storage-adapter.js').Snapshot} data
 * @param {{ client?: string, amount?: number, source?: string }} [defaults]
 * @returns {Promise<boolean>} true when a payment was saved.
 */
export function openPaymentDialog(ctx, data, { client = '', amount, source = '' } = {}) {
  if (!data.clients.length) {
    toast('أضف عميلاً أولاً من صفحة الحسابات.', 'warning');
    return Promise.resolve(false);
  }
  let saved = false;
  const formId = `payment-form-${Date.now()}`;
  const form = h('form', { id: formId, class: 'form-grid', novalidate: true },
    field('العميل', select({ name: 'client', value: client, required: true, placeholder: 'اختر العميل', options: data.clients })),
    field('التاريخ', h('input', { class: 'input', type: 'date', name: 'date', value: todayISO(), required: true })),
    vatAmountField('المبلغ (ر.س)', /** @type {HTMLInputElement} */ (h('input', { class: 'input num', type: 'number', name: 'amount', min: '0.01', step: '0.01', inputMode: 'decimal', required: true, value: amount ? String(amount) : '', autofocus: true })), vatDeductionRate(ctx.settings), { hint: 'إن كان المبلغ شاملاً الضريبة اضغط "خصم" لحفظ الصافي' }),
    field('ملاحظة / رقم السند', h('input', { class: 'input', type: 'text', name: 'note', maxLength: 500 }), { class: 'span-2' })
  );
  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const values = readForm(form);
      const payment = createPayment(values, ctx.mutationContext(data));
      await ctx.db.payments.add(payment);
      saved = true;
      modal.close('saved');
      toast(`تم تسجيل دفعة ${formatMoney(payment.amount)} للعميل ${payment.client}.`, 'success');
      ctx.notifyDataChanged({ source });
    } catch (error) {
      handleFormError(form, error);
    }
  });
  const modal = openModal({
    title: 'تسجيل دفعة نقدية (سند قبض)',
    icon: 'banknote',
    content: form,
    actions: [
      { label: 'إلغاء', variant: 'ghost', onClick: () => undefined },
      { label: 'حفظ الدفعة', variant: 'primary', icon: 'check', type: 'submit', form: formId }
    ]
  });
  return modal.closed.then(() => saved);
}

/**
 * Opens the trip editor.
 * @param {any} ctx
 * @param {import('../js/storage-adapter.js').Snapshot} data
 * @param {import('../core/domain.js').Trip} trip
 * @param {{ source?: string }} [options]
 * @returns {Promise<boolean>} true when saved.
 */
export function openTripEditor(ctx, data, trip, { source = '' } = {}) {
  if (isPeriodLocked(trip.date, ctx.settings.lockedThrough)) {
    toast('هذه النقلة ضمن فترة مقفلة ولا يمكن تعديلها.', 'warning');
    return Promise.resolve(false);
  }
  let saved = false;
  const formId = `trip-edit-${trip.id}`;
  const clientSelect = select({ name: 'client', value: trip.client, required: true, options: data.clients.includes(trip.client) ? data.clients : [trip.client, ...data.clients] });
  const materialSelect = select({ name: 'material', value: trip.material, required: true, options: [] });
  const countInput = h('input', { class: 'input num', type: 'number', name: 'count', min: '1', step: '1', required: true, value: String(trip.count) });
  const priceInput = h('input', { class: 'input num', type: 'number', name: 'price', min: '0', step: '0.01', required: true, value: String(trip.price) });
  const totalEl = h('strong', { class: 'num' });
  const vatNote = h('small');

  const fillMaterials = (keep) => {
    const options = materialOptions(clientSelect.value, data);
    if (keep && !options.some(option => option.value === keep)) options.unshift({ value: keep, label: keep });
    materialSelect.replaceChildren(...options.map(option => h('option', { value: option.value }, option.label)));
    materialSelect.value = keep || options[0]?.value || '';
  };
  const updateTotal = () => {
    const amounts = computeTripAmounts(Number(countInput.value) || 0, Number(priceInput.value) || 0, trip.vatRate || 0);
    totalEl.textContent = formatMoney(amounts.total);
    vatNote.textContent = trip.vatRate ? `شامل ضريبة ${trip.vatRate}%: ${formatMoney(amounts.vatAmount)}` : 'بدون ضريبة';
  };
  const applyPricing = () => {
    const pricing = resolvePricing(clientSelect.value, materialSelect.value, data);
    priceInput.value = String(pricing.price);
    updateTotal();
  };
  fillMaterials(trip.material);
  clientSelect.addEventListener('change', () => { fillMaterials(''); applyPricing(); });
  materialSelect.addEventListener('change', applyPricing);
  countInput.addEventListener('input', updateTotal);
  priceInput.addEventListener('input', updateTotal);

  const form = h('form', { id: formId, class: 'form-grid', novalidate: true },
    field('العميل', clientSelect),
    field('المادة / الخدمة', materialSelect),
    field('التاريخ', h('input', { class: 'input', type: 'date', name: 'date', value: trip.date, required: true })),
    field('رقم الشاحنة', h('input', { class: 'input', type: 'text', name: 'truck', value: trip.truck, list: 'truck-list-edit', maxLength: 40 })),
    h('datalist', { id: 'truck-list-edit' }, data.trucks.map(plate => h('option', { value: plate }))),
    field('العدد', countInput),
    vatAmountField('سعر الوحدة (ر.س)', /** @type {HTMLInputElement} */ (priceInput), vatDeductionRate(ctx.settings)),
    field('ملاحظات', h('textarea', { class: 'input', name: 'notes', maxLength: 500 }, trip.notes), { class: 'span-2' }),
    h('div', { class: 'total-preview span-2' }, h('span', {}, 'الإجمالي', vatNote), totalEl)
  );
  updateTotal();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const values = readForm(form);
      const pricing = resolvePricing(values.client, values.material, data);
      const keepUnit = values.client === trip.client && values.material === trip.material;
      const updated = updateTrip(trip, { ...values, unit: keepUnit ? trip.unit : pricing.unit }, ctx.mutationContext(data));
      await ctx.db.saveTrip(updated);
      saved = true;
      modal.close('saved');
      toast('تم تحديث بيانات النقلة.', 'success');
      ctx.notifyDataChanged({ source });
    } catch (error) {
      handleFormError(form, error);
    }
  });

  const modal = openModal({
    title: 'تعديل نقلة',
    icon: 'edit',
    size: 'lg',
    content: form,
    actions: [
      { label: 'إلغاء', variant: 'ghost', onClick: () => undefined },
      { label: 'حفظ التعديلات', variant: 'primary', icon: 'check', type: 'submit', form: formId }
    ]
  });
  return modal.closed.then(() => saved);
}

/**
 * Shows a validation/storage error and highlights the offending field.
 * @param {HTMLFormElement} form
 * @param {unknown} error
 */
export function handleFormError(form, error) {
  const err = /** @type {any} */ (error);
  for (const el of form.querySelectorAll('[aria-invalid="true"]')) el.removeAttribute('aria-invalid');
  if (err?.name === 'DomainError') {
    const target = err.field ? form.querySelector(`[name="${CSS.escape(String(err.field))}"]`) : null;
    if (target) {
      target.setAttribute('aria-invalid', 'true');
      /** @type {HTMLElement} */ (target).focus();
      target.addEventListener('input', () => target.removeAttribute('aria-invalid'), { once: true });
    }
    toast(err.message, 'error');
    return;
  }
  console.error(error);
  toast(err?.userMessage || 'تعذر حفظ البيانات. لم يتم تغيير أي شيء.', 'error');
}
