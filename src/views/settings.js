/**
 * @module views/settings
 * System configuration: company profile, the VAT calculator (and VAT on new trips),
 * period locking (immutability), PIN security, the default materials list, trucks,
 * backup/restore, manual legacy migration, and a guarded danger zone.
 */

import { View } from '../core/view.js';
import { field, h, readForm } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { confirmDialog, emptyState, openModal, toast, withBusy } from '../core/ui.js';
import { DomainError, MAX_LOGO_LENGTH, isDefaultCompanyName, isLogoDataUrl, isPeriodLocked, normalizeDataset, normalizeMaterial, normalizeSettings, splitVatInclusive } from '../core/domain.js';
import { createPinRecord, isPinRecord, isValidPin, verifyPin } from '../core/security.js';
import { currentMonthISO, formatBytes, formatDateTime, formatMoney, formatMonthLabel, formatNumber, shiftMonth } from '../core/format.js';
import { LOGO_FILE_TYPES, exportJSON, exportName, readFileAsText, readImageAsLogo } from '../core/export.js';
import { migrateFromLegacy, readLegacySnapshot } from '../js/storage-adapter.js';
import { DailyStore } from '../js/daily-storage.js';
import { button, handleFormError, iconButton, pageHeader, vatDeductionRate } from './shared.js';
import { licensePanel } from './license.js';

const LEGACY_LABELS = { trips: 'نقلات', payments: 'دفعات', clients: 'عملاء', accounts: 'حسابات', materials: 'مواد', trucks: 'شاحنات', clientCatalogs: 'تسعيرات' };

export default class SettingsView extends View {
  get title() { return 'الإعدادات'; }

  async load() {
    const db = this.ctx.db;
    const [data, estimate, migration] = await Promise.all([db.loadAll(), db.estimate().catch(() => null), db.getSetting('_legacyMigration')]);
    this.state.data = data;
    this.state.estimate = estimate;
    this.state.migration = migration;
    this.state.legacy = readLegacySnapshot();
  }

  afterMount() {
    this.on('submit', '#company-form', e => this.saveSettings(e, 'تم حفظ بيانات المنشأة. يظهر الاسم الآن في أعلى التطبيق وفي التقارير.'));
    this.on('click', '[data-action="pick-logo"]', () => /** @type {HTMLInputElement} */ (this.root?.querySelector('#logo-input'))?.click());
    this.on('change', '#logo-input', e => this.uploadLogo(/** @type {HTMLInputElement} */ (e.target)));
    this.on('click', '[data-action="remove-logo"]', () => this.removeLogo());
    this.on('submit', '#tax-form', e => this.saveSettings(e, 'تم حفظ إعدادات الضريبة. تُطبّق على النقلات الجديدة فقط.'));
    this.on('submit', '#display-form', e => this.saveSettings(e, 'تم حفظ إعدادات العرض.'));
    this.on('click', '[data-action="lock-period"]', () => this.lockPeriod());
    this.on('click', '[data-action="unlock-period"]', () => this.unlockPeriod());
    this.on('submit', '#pin-form', e => this.savePin(e));
    this.on('click', '[data-action="remove-pin"]', () => this.removePin());
    this.on('click', '[data-action="lock-now"]', () => this.ctx.lock());
    this.on('submit', '#material-form', e => this.saveMaterial(e));
    this.on('click', '[data-action="edit-material"]', (_e, t) => this.editMaterial(t.dataset.id || ''));
    this.on('click', '[data-action="delete-material"]', (_e, t) => this.deleteMaterial(t.dataset.id || ''));
    this.on('click', '[data-action="delete-truck"]', (_e, t) => this.deleteTruck(t.dataset.id || ''));
    this.on('click', '[data-action="backup"]', (_e, t) => withBusy(/** @type {HTMLButtonElement} */ (t), () => this.backup()));
    this.on('change', '#restore-input', e => this.restore(/** @type {HTMLInputElement} */ (e.target)));
    this.on('click', '[data-action="pick-restore"]', () => /** @type {HTMLInputElement} */ (this.root?.querySelector('#restore-input'))?.click());
    this.on('click', '[data-action="migrate"]', (_e, t) => withBusy(/** @type {HTMLButtonElement} */ (t), () => this.migrate()));
    this.on('click', '[data-action="persist"]', () => this.persist());
    this.on('click', '[data-action="clear-transactions"]', () => this.clearTransactions());
  }

  /* ───────────── rendering ───────────── */

  render() {
    return h('div', {},
      pageHeader('الإعدادات', 'تهيئة النظام والضرائب والأمان والبيانات'),
      h('div', { class: 'grid grid-2' },
        h('div', { class: 'stack' }, this.renderCompany(), this.renderTax(), this.renderPeriodLock(), this.renderDisplay(), this.renderSecurity()),
        h('div', { class: 'stack' }, this.renderLicense(), this.renderMaterials(), this.renderData(), this.renderMigration(), this.renderTrucks(), this.renderDanger())
      )
    );
  }

  /**
   * @param {string} title
   * @param {string} iconName
   * @param {Node} body
   * @param {{ class?: string, flush?: boolean, extra?: Node }} [options]
   */
  card(title, iconName, body, { class: className, flush = false, extra } = {}) {
    return h('section', { class: ['card', className] },
      h('header', { class: 'card-header' }, h('h2', {}, icon(iconName), title), extra || null),
      h('div', { class: ['card-body', flush && 'flush'] }, body)
    );
  }

  renderCompany() {
    const s = this.ctx.settings;
    const unnamed = isDefaultCompanyName(s.companyName);
    return this.card('بيانات المنشأة', 'building', h('form', { id: 'company-form', class: 'form-grid', novalidate: true },
      unnamed ? h('div', { class: 'callout span-2' }, icon('info'), h('p', {}, 'أدخل اسم شركتك ليظهر في أعلى التطبيق وفي الكشوف والتقارير المطبوعة.')) : null,
      field('اسم المنشأة', h('input', { class: 'input', name: 'companyName', value: unnamed ? '' : s.companyName, maxLength: 120, required: true, placeholder: 'مثال: مؤسسة الريان لمواد البناء والنقليات' }), { class: 'span-2' }),
      field('الهاتف', h('input', { class: 'input num', name: 'companyPhone', value: s.companyPhone || '', maxLength: 40, inputMode: 'tel' })),
      field('الرقم الضريبي (15 رقماً)', h('input', { class: 'input num', name: 'taxNumber', value: s.taxNumber || '', maxLength: 15, inputMode: 'numeric', pattern: '\\d{15}' })),
      this.renderLogoField(s.companyLogo),
      h('div', { class: 'span-2' }, button('حفظ', { icon: 'check', variant: 'primary', type: 'submit' }))
    ), { extra: h('span', { class: 'muted small' }, 'تظهر في الكشوف المطبوعة') });
  }

  /**
   * Company logo picker with a live preview; changes are saved immediately.
   * @param {string} logo
   */
  renderLogoField(logo) {
    return h('div', { class: 'field span-2' },
      h('span', { class: 'field-label', id: 'logo-label' }, 'شعار المنشأة'),
      h('div', { class: 'logo-field' },
        h('div', { class: 'logo-preview', id: 'logo-preview', role: 'img', ariaLabelledby: 'logo-label' }, this.logoPreview(logo)),
        h('div', { class: 'stack' },
          h('div', { class: 'row' },
            button('رفع شعار', { icon: 'upload', action: 'pick-logo' }),
            h('span', { id: 'remove-logo-slot' }, logo ? this.removeLogoButton() : null)
          ),
          h('small', { class: 'field-hint' }, 'PNG أو JPG أو WebP بحجم 5 ميجابايت كحد أقصى. يُصغَّر تلقائياً إلى 200×200 بكسل ويظهر في القائمة الجانبية والكشوف المطبوعة.')
        ),
        h('input', { type: 'file', id: 'logo-input', accept: LOGO_FILE_TYPES.join(','), hidden: true })
      )
    );
  }

  /** @param {string} logo */
  logoPreview(logo) {
    return logo ? h('img', { src: logo, alt: '' }) : icon('truck', { size: 32 });
  }

  removeLogoButton() {
    return button('حذف الشعار', { icon: 'trash', variant: 'danger-soft', action: 'remove-logo' });
  }

  /** Standalone VAT calculator: VAT-inclusive total → VAT amount + net amount. */
  renderTax() {
    const s = this.ctx.settings;
    const gross = /** @type {HTMLInputElement} */ (h('input', { class: 'input num', type: 'text', id: 'calc-gross', min: '0', step: '0.01', inputMode: 'decimal', placeholder: '0.00', autocomplete: 'off' }));
    const rate = /** @type {HTMLInputElement} */ (h('input', { class: 'input num', type: 'text', id: 'calc-rate', value: String(vatDeductionRate(s)), min: '0', max: '100', step: '0.01', inputMode: 'decimal' }));
    const vatOut = h('output', { class: 'calc-value num', attrs: { for: 'calc-gross calc-rate' } }, formatMoney(0));
    const netOut = h('output', { class: 'calc-value calc-value-main num', attrs: { for: 'calc-gross calc-rate' } }, formatMoney(0));
    const check = h('p', { class: 'muted small', ariaLive: 'polite' });
    let net = 0;
    const recalc = () => {
      net = 0;
      check.textContent = '';
      for (const input of [gross, rate]) input.removeAttribute('aria-invalid');
      if (gross.value === '') {
        vatOut.textContent = formatMoney(0);
        netOut.textContent = formatMoney(0);
        return;
      }
      try {
        const split = splitVatInclusive(gross.value, rate.value === '' ? 0 : rate.value);
        net = split.net;
        vatOut.textContent = formatMoney(split.vat);
        netOut.textContent = formatMoney(split.net);
        check.textContent = `${formatMoney(split.net)} + ${formatMoney(split.vat)} ضريبة = ${formatMoney(split.gross)}`;
      } catch (error) {
        const fieldName = /** @type {any} */ (error)?.field;
        (fieldName === 'vatRate' ? rate : gross).setAttribute('aria-invalid', 'true');
        vatOut.textContent = '—';
        netOut.textContent = '—';
        check.textContent = /** @type {any} */ (error)?.message || '';
      }
    };
    gross.addEventListener('input', recalc);
    rate.addEventListener('input', recalc);
    const copyNet = async () => {
      if (gross.value === '' || !Number.isFinite(net)) { toast('أدخل المبلغ شاملاً الضريبة أولاً.', 'warning'); gross.focus(); return; }
      const text = net.toFixed(2);
      try {
        await navigator.clipboard.writeText(text);
        toast(`تم نسخ المبلغ الصافي ${text}.`, 'success');
      } catch {
        toast(`تعذر الوصول إلى الحافظة. المبلغ الصافي: ${text}`, 'warning', { duration: 8000 });
      }
    };

    return this.card('حاسبة الضريبة', 'percent', h('div', { class: 'stack' },
      h('div', { class: 'form-grid' },
        field('المبلغ الإجمالي شامل الضريبة (ر.س)', gross),
        field('نسبة الضريبة %', rate)
      ),
      h('div', { class: 'calc-results', role: 'group', ariaLabel: 'نتيجة الحساب' },
        h('div', {}, h('span', {}, 'مبلغ الضريبة'), vatOut),
        h('div', {}, h('span', {}, 'المبلغ الصافي بدون ضريبة'), netOut)
      ),
      check,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn-primary', dataset: { role: 'copy-net' }, on: { click: copyNet } }, icon('check', { size: 18 }), 'نسخ المبلغ الصافي'),
        h('button', { type: 'button', class: 'btn btn-ghost', on: { click: () => { gross.value = ''; recalc(); gross.focus(); } } }, icon('refresh', { size: 18 }), 'مسح')
      ),
      h('details', { class: 'disclosure', open: Boolean(s.vatEnabled) },
        h('summary', {}, 'ضريبة النقلات الجديدة', h('span', { class: ['badge', s.vatEnabled ? 'badge-settled' : 'badge-neutral'] }, s.vatEnabled ? `مفعّلة ${formatNumber(s.vatRate)}%` : 'غير مفعّلة')),
        h('form', { id: 'tax-form', class: 'stack', novalidate: true },
          h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', name: 'vatEnabled', checked: s.vatEnabled }), 'إضافة ضريبة القيمة المضافة تلقائياً على النقلات الجديدة'),
          field('نسبة الضريبة %', h('input', { class: 'input num', type: 'text', name: 'vatRate', value: String(s.vatRate), min: '0', max: '100', step: '0.01', inputMode: 'decimal' })),
          h('p', { class: 'muted small' }, 'تُحفظ النسبة مع كل نقلة لحظة تسجيلها، لذلك تغييرها لا يعدّل الفواتير والكشوف السابقة.'),
          h('div', {}, button('حفظ', { icon: 'check', variant: 'primary', type: 'submit' }))
        )
      )
    ), { extra: h('span', { class: 'muted small' }, 'حساب الصافي من مبلغ شامل الضريبة') });
  }

  renderPeriodLock() {
    const locked = this.ctx.settings.lockedThrough;
    const suggestion = shiftMonth(currentMonthISO(), -1);
    return this.card('إقفال الفترات المحاسبية', 'lock', h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'بعد إقفال فترة تصبح جميع النقلات والدفعات والمعاملات المؤرخة فيها غير قابلة للتعديل أو الحذف، ولا يمكن إضافة حركات بتاريخ ضمنها. استخدمه بعد تسليم الكشوف الشهرية للعملاء.'),
      locked
        ? h('div', { class: 'callout warn' }, icon('lock'), h('p', {}, h('strong', {}, `الفترات مقفلة حتى نهاية ${formatMonthLabel(locked)} (${locked}).`)))
        : h('div', { class: 'callout' }, icon('unlock'), h('p', {}, 'لا توجد فترات مقفلة حالياً.')),
      h('div', { class: 'row' },
        field('إقفال حتى شهر', h('input', { class: 'input', type: 'month', id: 'lock-month', value: locked || suggestion, max: currentMonthISO() })),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, ' '), h('div', { class: 'row' },
          button('إقفال', { icon: 'lock', variant: 'primary', action: 'lock-period' }),
          locked ? button('إلغاء الإقفال', { icon: 'unlock', variant: 'danger-soft', action: 'unlock-period' }) : null))
      )
    ));
  }

  renderDisplay() {
    const s = this.ctx.settings;
    return this.card('العرض والتذكيرات', 'calendar', h('form', { id: 'display-form', class: 'stack', novalidate: true },
      h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', name: 'showHijri', checked: s.showHijri !== false }), 'إظهار التاريخ الهجري (أم القرى) بجانب الميلادي'),
      field('تذكير النسخ الاحتياطي كل (يوم) — 0 لإيقافه', h('input', { class: 'input num', type: 'text', inputMode: 'numeric', name: 'backupReminderDays', value: String(s.backupReminderDays), min: '0', max: '90', step: '1' })),
      h('div', {}, button('حفظ', { icon: 'check', variant: 'primary', type: 'submit' }))
    ));
  }

  renderSecurity() {
    const hasPin = isPinRecord(this.ctx.settings.pin);
    return this.card('الأمان — رمز PIN', 'shield', h('div', { class: 'stack' },
      h('p', { class: 'muted' }, hasPin ? 'رمز PIN مفعّل. يُطلب عند فتح التطبيق.' : 'لا يوجد رمز PIN. يمكن لأي شخص يستخدم هذا الجهاز فتح البيانات.'),
      h('form', { id: 'pin-form', class: 'form-grid', novalidate: true, autocomplete: 'off' },
        hasPin ? field('الرمز الحالي', h('input', { class: 'input num', type: 'password', name: 'current', inputMode: 'numeric', maxLength: 8, autocomplete: 'current-password' }), { class: 'span-2' }) : null,
        field('الرمز الجديد (4–8 أرقام)', h('input', { class: 'input num', type: 'password', name: 'pin', inputMode: 'numeric', maxLength: 8, autocomplete: 'new-password', required: true })),
        field('تأكيد الرمز', h('input', { class: 'input num', type: 'password', name: 'confirm', inputMode: 'numeric', maxLength: 8, autocomplete: 'new-password', required: true })),
        h('div', { class: 'row span-2' },
          button(hasPin ? 'تغيير الرمز' : 'تفعيل الرمز', { icon: 'check', variant: 'primary', type: 'submit' }),
          hasPin ? button('إزالة الرمز', { icon: 'unlock', variant: 'danger-soft', action: 'remove-pin' }) : null,
          hasPin ? button('قفل الآن', { icon: 'lock', variant: 'ghost', action: 'lock-now' }) : null
        )
      )
    ));
  }

  renderMaterials() {
    const { materials, trips } = this.state.data;
    const usage = new Map();
    for (const trip of trips) usage.set(trip.material, (usage.get(trip.material) || 0) + 1);
    const sorted = [...materials].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    return this.card('القائمة الافتراضية للمواد', 'package', h('div', {},
      h('form', { id: 'material-form', class: 'toolbar', novalidate: true },
        h('input', { type: 'hidden', name: 'original', value: '' }),
        field('اسم المادة', h('input', { class: 'input', name: 'name', required: true, maxLength: 80 }), { class: 'grow' }),
        field('الوحدة', h('input', { class: 'input', name: 'unit', maxLength: 40, placeholder: 'رد' })),
        field('السعر (ر.س)', h('input', { class: 'input num', type: 'text', name: 'defaultPrice', min: '0', step: '0.01', inputMode: 'decimal', required: true })),
        h('div', { class: 'field', style: { flex: '0 0 auto' } }, h('span', { class: 'field-label' }, ' '), button('حفظ', { icon: 'check', variant: 'primary', type: 'submit' }))
      ),
      sorted.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
          h('thead', {}, h('tr', {}, h('th', {}, 'المادة'), h('th', {}, 'الوحدة'), h('th', { class: 'num' }, 'السعر الافتراضي'), h('th', { class: 'num' }, 'الاستخدام'), h('th', {}, h('span', { class: 'sr-only' }, 'إجراءات')))),
          h('tbody', {}, sorted.map(item => h('tr', {},
            h('td', {}, h('strong', {}, item.name)),
            h('td', {}, item.unit),
            h('td', { class: 'num' }, formatMoney(item.defaultPrice)),
            h('td', { class: 'num muted' }, `${formatNumber(usage.get(item.name) || 0)} نقلة`),
            h('td', {}, h('div', { class: 'actions' },
              iconButton('edit', `تعديل ${item.name}`, { action: 'edit-material', id: item.name }),
              iconButton('trash', `حذف ${item.name}`, { action: 'delete-material', id: item.name, danger: true })))
          )))
        ))
        : emptyState('لا توجد مواد.', 'package')
    ), { flush: true, extra: h('span', { class: 'muted small' }, 'نقطة البداية لقائمة كل عميل · قوائم العملاء تُدار من صفحة الحسابات') });
  }

  renderLicense() {
    const license = /** @type {any} */ (this.ctx).license;
    if (!license?.status) return null;
    return this.card('ترخيص النظام', 'shield', licensePanel(license, status => {
      /** @type {any} */ (this.ctx).setLicenseStatus(status);
      this.update();
    }));
  }

  renderTrucks() {
    const { trucks } = this.state.data;
    return this.card('الشاحنات المحفوظة', 'truck', trucks.length
      ? h('div', { class: 'chips', style: { padding: '16px 20px' } }, trucks.map(plate => h('span', { class: 'chip', style: { cursor: 'default' } },
        h('span', { class: 'mono' }, plate),
        h('button', { type: 'button', class: 'toast-close', ariaLabel: `حذف ${plate}`, title: 'حذف من الاقتراحات', dataset: { action: 'delete-truck', id: plate } }, icon('close', { size: 13 })))))
      : emptyState('تُضاف الشاحنات تلقائياً عند تسجيل النقلات.', 'truck'), { flush: true });
  }

  renderData() {
    const { estimate, data } = this.state;
    return this.card('البيانات والنسخ الاحتياطي', 'database', h('div', { class: 'stack' },
      h('dl', { class: 'kv' },
        h('dt', {}, 'النقلات'), h('dd', { class: 'num' }, formatNumber(data.trips.length)),
        h('dt', {}, 'الدفعات'), h('dd', { class: 'num' }, formatNumber(data.payments.length)),
        h('dt', {}, 'العملاء'), h('dd', { class: 'num' }, formatNumber(data.clients.length)),
        estimate ? [h('dt', {}, 'مساحة التخزين'), h('dd', { class: 'num' }, `${formatBytes(estimate.usage)} من ${formatBytes(estimate.quota)}`)] : null,
        estimate ? [h('dt', {}, 'التخزين الدائم'), h('dd', {}, estimate.persisted ? 'مفعّل — لن يحذفه المتصفح تلقائياً' : h('span', {}, 'غير مفعّل ', h('button', { type: 'button', class: 'btn btn-sm btn-ghost', dataset: { action: 'persist' } }, 'طلب التفعيل')))] : null
      ),
      h('div', { class: 'callout warn' }, icon('alert'), h('p', {}, 'البيانات محفوظة على هذا الجهاز فقط. نزّل نسخة احتياطية بانتظام واحفظها في مكان آمن.')),
      h('div', { class: 'row' },
        button('تنزيل نسخة احتياطية', { icon: 'download', variant: 'primary', action: 'backup' }),
        button('استعادة من ملف', { icon: 'upload', action: 'pick-restore' }),
        h('input', { type: 'file', id: 'restore-input', accept: 'application/json,.json', hidden: true })
      ),
      h('p', { class: 'muted small' }, 'تقبل الاستعادة ملفات النسخ الاحتياطي من هذا الإصدار ومن الإصدار السابق. رمز PIN لا يُضمّن في النسخة الاحتياطية.')
    ));
  }

  renderMigration() {
    const { migration, legacy } = this.state;
    const counts = Object.entries(legacy.counts).filter(([, count]) => count > 0);
    return this.card('الترحيل من الإصدار السابق', 'refresh', h('div', { class: 'stack' },
      migration
        ? h('div', { class: 'callout' }, icon('checkCircle'), h('div', {},
          h('p', {}, h('strong', {}, `تم الترحيل في ${formatDateTime(migration.at)}`)),
          h('p', { class: 'small' }, `كُتب: ${formatNumber(migration.written?.trips || 0)} نقلة، ${formatNumber(migration.written?.payments || 0)} دفعة، ${formatNumber(migration.written?.clients || 0)} عميل.`),
          Object.values(migration.dropped || {}).some(Boolean) ? h('p', { class: 'small' }, `سجلات تالفة تم تجاهلها: ${Object.entries(migration.dropped).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join('، ')}`) : null,
          migration.unreadable?.length ? h('p', { class: 'small text-credit' }, `مفاتيح تعذرت قراءتها: ${migration.unreadable.join('، ')}`) : null
        ))
        : h('p', { class: 'muted' }, 'لم يتم ترحيل بيانات من الإصدار السابق على هذا الجهاز.'),
      counts.length
        ? h('p', {}, 'بيانات قديمة موجودة في هذا المتصفح: ', counts.map(([key, count]) => `${formatNumber(count)} ${LEGACY_LABELS[key] || key}`).join(' · '))
        : h('p', { class: 'muted small' }, 'لا توجد بيانات من الإصدار السابق في هذا المتصفح.'),
      h('p', { class: 'muted small' }, 'الترحيل آمن ويمكن تكراره: يدمج السجلات حسب معرّفاتها دون تكرار، ولا يحذف البيانات القديمة.'),
      h('div', {}, button('ترحيل / إعادة الترحيل الآن', { icon: 'refresh', action: 'migrate', disabled: !counts.length }))
    ));
  }

  renderDanger() {
    const locked = this.ctx.settings.lockedThrough;
    return this.card('منطقة الخطر', 'alert', h('div', { class: 'stack' },
      h('p', {}, 'حذف جميع النقلات والدفعات نهائياً. يبقى العملاء والمواد والحسابات اليدوية.'),
      locked ? h('p', { class: 'small text-credit' }, `الحركات ضمن الفترات المقفلة (حتى ${locked}) لن تُحذف.`) : null,
      h('div', {}, button('تفريغ سجل الحركات', { icon: 'trash', variant: 'danger', action: 'clear-transactions' }))
    ), { class: 'danger-zone' });
  }

  /* ───────────── actions ───────────── */

  /**
   * Persists one settings form.
   * @param {SubmitEvent} event
   * @param {string} message
   */
  async saveSettings(event, message) {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.target);
    const values = readForm(form);
    if ('taxNumber' in values && values.taxNumber && !/^\d{15}$/.test(String(values.taxNumber))) {
      handleFormError(form, new DomainError('الرقم الضريبي يجب أن يتكون من 15 رقماً.', { field: 'taxNumber' }));
      return;
    }
    if ('vatRate' in values) {
      const rate = Number(values.vatRate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        handleFormError(form, new DomainError('نسبة الضريبة يجب أن تكون بين 0 و 100.', { field: 'vatRate' }));
        return;
      }
    }
    const normalized = normalizeSettings({ ...this.ctx.settings, ...values });
    const patch = Object.fromEntries(Object.keys(values).map(key => [key, normalized[key]]));
    await this.ctx.db.setSettings(patch);
    await this.ctx.reloadSettings();
    toast(message, 'success');
    this.update();
  }

  /**
   * Persists a logo ('' restores the default) and refreshes the preview and sidebar in place,
   * leaving any unsaved edits elsewhere in the company form untouched.
   * @param {string} logo
   */
  async saveLogo(logo) {
    await this.ctx.db.setSettings({ companyLogo: logo || undefined });
    await this.ctx.reloadSettings();
    this.root?.querySelector('#logo-preview')?.replaceChildren(this.logoPreview(logo));
    this.root?.querySelector('#remove-logo-slot')?.replaceChildren(...(logo ? [this.removeLogoButton()] : []));
  }

  /** @param {HTMLInputElement} input */
  async uploadLogo(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    let logo;
    try {
      logo = await readImageAsLogo(file, { maxLength: MAX_LOGO_LENGTH });
    } catch (error) {
      toast(/** @type {any} */ (error)?.message || 'تعذر معالجة الصورة.', 'error');
      return;
    }
    if (!isLogoDataUrl(logo)) { toast('تعذر معالجة الصورة.', 'error'); return; }
    await this.saveLogo(logo);
    toast('تم حفظ شعار المنشأة. يظهر الآن في القائمة الجانبية والكشوف المطبوعة.', 'success');
  }

  async removeLogo() {
    await this.saveLogo('');
    toast('تم حذف الشعار واستعادة الشعار الافتراضي.', 'info');
  }

  async lockPeriod() {
    const input = /** @type {HTMLInputElement|null} */ (this.root?.querySelector('#lock-month'));
    const month = input?.value || '';
    if (!/^\d{4}-\d{2}$/.test(month)) { toast('اختر شهراً صحيحاً.', 'warning'); return; }
    if (month > currentMonthISO()) { toast('لا يمكن إقفال شهر مستقبلي.', 'warning'); return; }
    const current = this.ctx.settings.lockedThrough;
    const affected = this.state.data.trips.filter(trip => isPeriodLocked(trip.date, month)).length;
    const ok = await confirmDialog({
      title: 'إقفال الفترات',
      message: `سيتم إقفال جميع الحركات حتى نهاية ${formatMonthLabel(month)} (${formatNumber(affected)} نقلة). لن يمكن تعديلها أو حذفها إلا بعد إلغاء الإقفال.${current && month < current ? `\nملاحظة: سيتم تقليص الإقفال الحالي (${current}).` : ''}`,
      confirmText: 'إقفال'
    });
    if (!ok) return;
    await this.ctx.db.setSettings({ lockedThrough: month, _lockLog: { at: new Date().toISOString(), from: current || null, to: month } });
    await this.ctx.reloadSettings();
    toast(`تم الإقفال حتى ${formatMonthLabel(month)}.`, 'success');
    this.update();
  }

  async unlockPeriod() {
    const ok = await confirmDialog({
      title: 'إلغاء إقفال الفترات',
      message: 'إلغاء الإقفال يسمح بتعديل حركات سبق تسليم كشوفها للعملاء. هل أنت متأكد؟',
      confirmText: 'إلغاء الإقفال',
      danger: true,
      requireText: 'فتح الفترات'
    });
    if (!ok) return;
    await this.ctx.db.setSettings({ lockedThrough: '', _lockLog: { at: new Date().toISOString(), from: this.ctx.settings.lockedThrough, to: null } });
    await this.ctx.reloadSettings();
    toast('تم إلغاء إقفال الفترات.', 'info');
    this.update();
  }

  /** @param {SubmitEvent} event */
  async savePin(event) {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.target);
    const values = readForm(form);
    const existing = this.ctx.settings.pin;
    try {
      if (isPinRecord(existing) && !(await verifyPin(String(values.current || ''), existing))) {
        throw new DomainError('الرمز الحالي غير صحيح.', { field: 'current' });
      }
      if (!isValidPin(values.pin)) throw new DomainError('الرمز يجب أن يتكون من 4 إلى 8 أرقام.', { field: 'pin' });
      if (values.pin !== values.confirm) throw new DomainError('تأكيد الرمز غير مطابق.', { field: 'confirm' });
      const record = await createPinRecord(String(values.pin));
      await this.ctx.db.setSettings({ pin: record, pinAttempts: undefined });
      await this.ctx.reloadSettings();
      toast(isPinRecord(existing) ? 'تم تغيير رمز PIN.' : 'تم تفعيل رمز PIN.', 'success');
      this.update();
    } catch (error) {
      handleFormError(form, error);
    }
  }

  async removePin() {
    const form = /** @type {HTMLFormElement|null} */ (this.root?.querySelector('#pin-form'));
    if (!form) return;
    const current = String(readForm(form).current || '');
    try {
      if (!(await verifyPin(current, this.ctx.settings.pin))) throw new DomainError('أدخل الرمز الحالي الصحيح لإزالته.', { field: 'current' });
      if (!(await confirmDialog({ title: 'إزالة رمز PIN', message: 'سيصبح التطبيق مفتوحاً لأي شخص يستخدم هذا الجهاز.', confirmText: 'إزالة', danger: true }))) return;
      await this.ctx.db.setSettings({ pin: undefined, pinAttempts: undefined });
      await this.ctx.reloadSettings();
      toast('تمت إزالة رمز PIN.', 'info');
      this.update();
    } catch (error) {
      handleFormError(form, error);
    }
  }

  /** @param {SubmitEvent} event */
  async saveMaterial(event) {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.target);
    const values = readForm(form);
    try {
      const material = normalizeMaterial(values);
      const original = String(values.original || '');
      const { materials } = this.state.data;
      if (material.name !== original && materials.some(item => item.name === material.name)) {
        throw new DomainError('توجد مادة بنفس الاسم.', { field: 'name' });
      }
      if (original && original !== material.name) await this.ctx.db.materials.delete(original);
      await this.ctx.db.materials.put(material);
      toast(`تم حفظ ${material.name}. الأسعار الجديدة تُطبّق على النقلات القادمة فقط.`, 'success');
      this.ctx.notifyDataChanged({ source: 'SettingsView' });
      await this.refresh();
    } catch (error) {
      handleFormError(form, error);
    }
  }

  /** @param {string} name */
  editMaterial(name) {
    const material = this.state.data.materials.find(item => item.name === name);
    const form = /** @type {HTMLFormElement|null} */ (this.root?.querySelector('#material-form'));
    if (!material || !form) return;
    /** @type {HTMLInputElement} */ (form.elements.namedItem('original')).value = material.name;
    /** @type {HTMLInputElement} */ (form.elements.namedItem('name')).value = material.name;
    /** @type {HTMLInputElement} */ (form.elements.namedItem('unit')).value = material.unit;
    const price = /** @type {HTMLInputElement} */ (form.elements.namedItem('defaultPrice'));
    price.value = String(material.defaultPrice);
    price.focus();
    price.select();
  }

  /** @param {string} name */
  async deleteMaterial(name) {
    if (this.state.data.materials.length <= 1) { toast('يجب أن تبقى مادة واحدة على الأقل.', 'warning'); return; }
    const used = this.state.data.trips.filter(trip => trip.material === name).length;
    const ok = await confirmDialog({
      title: 'حذف مادة',
      message: `حذف "${name}" من القائمة الافتراضية؟ سيختفي من قوائم العملاء التي لا تحدد له سعراً خاصاً.${used ? `\nالنقلات المسجلة (${formatNumber(used)}) لن تتأثر.` : ''}`,
      confirmText: 'حذف',
      danger: true
    });
    if (!ok) return;
    await this.ctx.db.materials.delete(name);
    toast(`تم حذف ${name}.`, 'info');
    this.ctx.notifyDataChanged({ source: 'SettingsView' });
    await this.refresh();
  }

  /** @param {string} plate */
  async deleteTruck(plate) {
    await this.ctx.db.trucks.delete(plate);
    toast(`تمت إزالة ${plate} من الاقتراحات.`, 'info');
    await this.refresh();
  }

  /**
   * Full backup document: the transport database plus the daily work sheets
   * (stored separately, added under `daily`). A daily read failure never blocks
   * the main backup.
   * @returns {Promise<Record<string, unknown>>}
   */
  async fullBackup() {
    const backup = await this.ctx.db.exportBackup();
    try {
      return { ...backup, daily: new DailyStore().exportBackup() };
    } catch (error) {
      console.error('Daily sheets not included in backup:', error);
      toast(/** @type {any} */ (error)?.userMessage || 'تعذر تضمين يوميات حركة العمل في النسخة الاحتياطية.', 'warning', { duration: 8000 });
      return backup;
    }
  }

  async backup() {
    const backup = await this.fullBackup();
    exportJSON(exportName('نسخة_احتياطية_نقليات'), backup);
    await this.ctx.db.setSetting('_lastBackupReminder', Date.now());
    const days = /** @type {any} */ (backup).daily?.sheets?.length || 0;
    toast(days ? `تم تنزيل النسخة الاحتياطية (تشمل ${formatNumber(days)} يومية لحركة العمل).` : 'تم تنزيل النسخة الاحتياطية.', 'success');
  }

  async persist() {
    const granted = await this.ctx.db.requestPersistence();
    toast(granted ? 'تم تفعيل التخزين الدائم.' : 'رفض المتصفح الطلب. ثبّت التطبيق على الشاشة الرئيسية لزيادة الفرص.', granted ? 'success' : 'warning');
    await this.refresh();
  }

  /** @param {HTMLInputElement} input */
  async restore(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    let parsed;
    let raw;
    try {
      raw = JSON.parse(await readFileAsText(file));
      parsed = normalizeDataset(raw);
    } catch (error) {
      console.error('Restore parse failed:', error);
      toast(error instanceof DomainError ? error.message : 'تعذر قراءة الملف: ليس نسخة احتياطية صالحة.', 'error');
      return;
    }
    const { dataset, report } = parsed;
    const dropped = Object.values(report.dropped).reduce((sum, n) => sum + n, 0);
    const lockedThrough = this.ctx.settings.lockedThrough || '';
    // Daily work sheets travel in the same file (optional; older backups have none).
    const dailyStore = new DailyStore();
    let dailyPreview = null;
    if (raw?.daily) {
      try {
        dailyPreview = dailyStore.previewImport(raw.daily);
      } catch (error) {
        toast(`لن تُستعاد يوميات حركة العمل من هذا الملف: ${/** @type {any} */ (error)?.userMessage || 'بيانات غير صالحة'}`, 'warning', { duration: 8000 });
      }
    }
    const restoreDaily = () => {
      if (!dailyPreview?.sheets.length) return 0;
      if (dailyPreview.replacing) exportJSON(exportName('نسخة_قبل_استعادة_اليوميات'), dailyStore.exportBackup());
      return dailyStore.importBackup(raw.daily).imported;
    };
    const lockedNote = count => (count ? ` تم تجاهل ${formatNumber(count)} سجل ضمن الفترة المقفلة.` : '');
    const dailyNote = count => (count ? ` واستُعيدت ${formatNumber(count)} يومية لحركة العمل.` : '');
    const modal = openModal({
      title: 'استعادة نسخة احتياطية',
      icon: 'upload',
      content: h('div', { class: 'stack' },
        h('p', {}, `الملف: ${file.name} (${report.format === 'current' ? 'الإصدار الحالي' : 'الإصدار السابق'})`),
        h('dl', { class: 'kv' },
          h('dt', {}, 'النقلات'), h('dd', { class: 'num' }, formatNumber(dataset.trips.length)),
          h('dt', {}, 'الدفعات'), h('dd', { class: 'num' }, formatNumber(dataset.payments.length)),
          h('dt', {}, 'العملاء'), h('dd', { class: 'num' }, formatNumber(dataset.clients.length)),
          h('dt', {}, 'الحسابات اليدوية'), h('dd', { class: 'num' }, formatNumber(dataset.accounts.length)),
          h('dt', {}, 'المواد'), h('dd', { class: 'num' }, formatNumber(dataset.materials.length)),
          dailyPreview ? [h('dt', {}, 'يوميات حركة العمل'), h('dd', { class: 'num' }, formatNumber(dailyPreview.sheets.length))] : null
        ),
        lockedThrough ? h('div', { class: 'callout' }, icon('lock'), h('p', {}, `الفترة مقفلة حتى ${formatMonthLabel(lockedThrough)}: لن يتغير أي سجل في الأشهر المقفلة، وسيتم تجاهل سجلات الملف الخاصة بها.`)) : null,
        dailyPreview?.replacing ? h('p', { class: 'muted small' }, `${formatNumber(dailyPreview.replacing)} يومية في الملف بتواريخ موجودة حالياً ستحل محلها (يُنزَّل قبلها نسخة من يومياتك الحالية تلقائياً).`) : null,
        dropped ? h('div', { class: 'callout warn' }, icon('alert'), h('p', {}, `سيتم تجاهل ${formatNumber(dropped)} سجل غير صالح.`)) : null,
        report.warnings.length ? h('details', {}, h('summary', {}, `${formatNumber(report.warnings.length)} ملاحظة`), h('ul', { class: 'small' }, report.warnings.slice(0, 50).map(text => h('li', {}, text)))) : null,
        h('p', { class: 'muted small' }, '"دمج" يضيف السجلات الجديدة ويحدّث الموجودة بنفس المعرّف. "استبدال" يحذف كل البيانات الحالية أولاً — سيتم تنزيل نسخة احتياطية من بياناتك الحالية تلقائياً قبل الاستبدال. يوميات حركة العمل تُدمج حسب التاريخ في الحالتين.')
      ),
      actions: [
        { label: 'إلغاء', variant: 'ghost', onClick: () => undefined },
        {
          label: 'دمج', icon: 'layers',
          onClick: async () => {
            const written = await this.ctx.db.mergeDataset(dataset, { lockedThrough });
            const days = restoreDaily();
            toast(`تم الدمج: ${formatNumber(written.trips)} نقلة، ${formatNumber(written.payments)} دفعة.${dailyNote(days)}${lockedNote(written.lockedSkipped)}`, 'success', { duration: 7000 });
            await this.afterImport();
          }
        },
        {
          label: 'استبدال الكل', icon: 'refresh', variant: 'danger',
          onClick: async () => {
            const confirmed = await confirmDialog({ title: 'تأكيد الاستبدال', message: 'سيتم حذف جميع البيانات الحالية واستبدالها بمحتوى الملف.', confirmText: 'استبدال', danger: true, requireText: 'استبدال' });
            if (!confirmed) return false;
            exportJSON(exportName('نسخة_قبل_الاستعادة'), await this.fullBackup());
            const { lockedSkipped } = await this.ctx.db.replaceAll(dataset, { lockedThrough });
            const days = restoreDaily();
            toast(`تمت استعادة البيانات بنجاح.${dailyNote(days)}${lockedNote(lockedSkipped)}`, 'success', { duration: 7000 });
            await this.afterImport();
            return undefined;
          }
        }
      ]
    });
    await modal.closed;
  }

  async afterImport() {
    await this.ctx.reloadSettings();
    this.ctx.notifyDataChanged({ source: 'SettingsView' });
    await this.refresh();
  }

  async migrate() {
    const result = await migrateFromLegacy(this.ctx.db, { force: true });
    if (result.status === 'none') {
      toast('لا توجد بيانات من الإصدار السابق.', 'info');
      return;
    }
    toast(`اكتمل الترحيل: ${formatNumber(result.written?.trips || 0)} نقلة، ${formatNumber(result.written?.payments || 0)} دفعة.${result.pinMigrated ? ' تم نقل رمز PIN.' : ''}`, 'success', { duration: 7000 });
    await this.afterImport();
  }

  async clearTransactions() {
    const { trips, payments } = this.state.data;
    const lockedThrough = this.ctx.settings.lockedThrough;
    const tripIds = trips.filter(trip => !isPeriodLocked(trip.date, lockedThrough)).map(trip => trip.id);
    const paymentIds = payments.filter(payment => !isPeriodLocked(payment.date, lockedThrough)).map(payment => payment.id);
    const total = tripIds.length + paymentIds.length;
    if (!total) { toast('لا توجد حركات قابلة للحذف.', 'warning'); return; }
    const ok = await confirmDialog({
      title: 'تفريغ سجل الحركات',
      message: `سيتم حذف ${formatNumber(tripIds.length)} نقلة و${formatNumber(paymentIds.length)} دفعة نهائياً. يُنصح بتنزيل نسخة احتياطية أولاً.`,
      confirmText: 'حذف نهائي',
      danger: true,
      requireText: 'حذف'
    });
    if (!ok) return;
    await this.ctx.db.deleteTransactions({ trips: tripIds, payments: paymentIds });
    toast(`تم حذف ${formatNumber(total)} حركة.`, 'info');
    this.ctx.notifyDataChanged({ source: 'SettingsView' });
    await this.refresh();
  }
}
