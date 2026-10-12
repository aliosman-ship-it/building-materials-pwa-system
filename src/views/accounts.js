/**
 * @module views/accounts
 * Client accounts: balances (transport + manual debt ledger), settlement,
 * client-specific pricing, account statements and client lifecycle.
 */

import { View } from '../core/view.js';
import { debounce, field, h, readForm, select } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { confirmDialog, emptyState, openModal, toast } from '../core/ui.js';
import {
  ACCOUNT_TX, accountTotals, compareChronological, companyForPrint, addAccountTransaction, balanceStatus, canDeleteClient, computeClientBalances,
  createAccount, createSettlementPayment, getClientPriceList, hiddenCatalogEntry, isPeriodLocked,
  normalizeCatalogEntry, removeAccountTransaction, roundMoney, validateNewClient
} from '../core/domain.js';
import { formatDate, formatMoney, formatNumber, todayISO } from '../core/format.js';
import { exportName, exportXlsx, printReport } from '../core/export.js';
import {
  balanceBadge, balanceClass, button, handleFormError, iconButton, kpi, lockBadge, openPaymentDialog, pageHeader,
  vatAmountField, vatDeductionRate
} from './shared.js';

export default class AccountsView extends View {
  get title() { return 'حسابات العملاء'; }

  constructor(ctx, route) {
    super(ctx, route);
    this.state.search = '';
    this.state.onlyDue = false;
    /** @type {Record<string, any>} */
    this.refs = {};
    this.repaintTableDebounced = debounce(() => this.repaintTable(), 150);
  }

  async load() {
    this.state.data = await this.ctx.db.loadAll();
    this.state.balances = computeClientBalances(this.state.data)
      .sort((a, b) => b.totalBalance - a.totalBalance || a.client.localeCompare(b.client, 'ar'));
  }

  afterMount() {
    this.on('click', '[data-action="add-client"]', () => this.openAddClient());
    this.on('input', '[data-role="client-search"]', (_e, target) => { this.state.search = /** @type {HTMLInputElement} */ (target).value; this.repaintTableDebounced(); });
    this.on('change', '[data-role="only-due"]', (_e, target) => { this.state.onlyDue = /** @type {HTMLInputElement} */ (target).checked; this.repaintTable(); });
    this.on('click', '[data-action="statement"]', (_e, t) => this.openStatement(t.dataset.client || ''));
    this.on('click', '[data-action="payment"]', (_e, t) => this.addPayment(t.dataset.client || ''));
    this.on('click', '[data-action="settle"]', (_e, t) => this.settle(t.dataset.client || ''));
    this.on('click', '[data-action="manual"]', (_e, t) => this.openManualLedger(t.dataset.client || ''));
    this.on('click', '[data-action="pricing"]', (_e, t) => this.openPricing(t.dataset.client || ''));
    this.on('click', '[data-action="delete-client"]', (_e, t) => this.deleteClient(t.dataset.client || ''));
    this.addCleanup(() => this.repaintTableDebounced.cancel());
    if (this.route.query?.get('new') === '1') {
      this.ctx.router.setQuery({ new: null });
      this.openAddClient();
    }
  }

  /* ───────────── rendering ───────────── */

  render() {
    const { balances } = this.state;
    const transport = roundMoney(balances.reduce((sum, row) => sum + Math.max(0, row.transportBalance), 0));
    const manual = roundMoney(balances.reduce((sum, row) => sum + Math.max(0, row.manualBalance), 0));
    const credits = roundMoney(balances.reduce((sum, row) => sum + Math.min(0, row.totalBalance), 0));
    const dueCount = balances.filter(row => balanceStatus(row.totalBalance) === 'due').length;

    this.refs.tableHost = h('div');
    this.repaintTable();

    return h('div', {},
      pageHeader('حسابات العملاء', 'الأرصدة والتحصيل وقوائم أسعار العملاء وكشوف الحساب',
        button('أسعار العملاء', { icon: 'tag', action: 'pricing' }),
        button('إضافة عميل', { icon: 'plus', variant: 'primary', action: 'add-client' })
      ),
      h('section', { class: 'kpi-grid' },
        kpi({ label: 'عدد العملاء', value: formatNumber(balances.length), caption: `${formatNumber(dueCount)} عليه مستحقات`, icon: 'users' }),
        kpi({ label: 'مستحقات النقليات', value: formatMoney(transport), caption: 'قيمة النقلات ناقص الدفعات', icon: 'truck', tone: transport > 0 ? 'due' : '' }),
        kpi({ label: 'ديون الحسابات اليدوية', value: formatMoney(manual), caption: 'ديون مسجلة خارج النقليات', icon: 'wallet', tone: manual > 0 ? 'due' : '' }),
        kpi({ label: 'أرصدة دائنة للعملاء', value: formatMoney(Math.abs(credits)), caption: 'مبالغ مدفوعة مقدماً', icon: 'banknote', tone: credits < 0 ? 'credit' : '' })
      ),
      h('section', { class: 'card' },
        h('header', { class: 'card-header' }, h('h2', {}, icon('users'), 'قائمة العملاء')),
        h('div', { class: 'toolbar' },
          field('بحث', h('div', { class: 'search-input' }, icon('search', { size: 16 }),
            h('input', { class: 'input', type: 'search', value: this.state.search, placeholder: 'اسم العميل', dataset: { role: 'client-search' } })), { class: 'grow' }),
          h('label', { class: 'checkbox', style: { paddingBottom: '10px' } },
            h('input', { type: 'checkbox', checked: this.state.onlyDue, dataset: { role: 'only-due' } }), 'المستحق عليهم فقط')
        ),
        this.refs.tableHost
      ),
      h('p', { class: 'muted small', style: { marginTop: '12px' } },
        'رصيد النقليات = قيمة النقلات − الدفعات النقدية. الحساب اليدوي يسجل الديون والسداد خارج النقليات ويُعرض منفصلاً كما في النظام السابق، والإجمالي مجموعهما.')
    );
  }

  repaintTable() {
    const host = this.refs.tableHost;
    if (!host) return;
    const query = this.state.search.trim().toLocaleLowerCase('ar');
    const rows = this.state.balances.filter(row =>
      (!query || row.client.toLocaleLowerCase('ar').includes(query)) &&
      (!this.state.onlyDue || balanceStatus(row.totalBalance) === 'due'));
    if (!this.state.balances.length) {
      host.replaceChildren(h('div', {}, emptyState('لا يوجد عملاء بعد.', 'users'),
        h('div', { class: 'row', style: { justifyContent: 'center', paddingBottom: '24px' } }, button('إضافة أول عميل', { icon: 'plus', variant: 'primary', action: 'add-client' }))));
      return;
    }
    if (!rows.length) {
      host.replaceChildren(emptyState('لا يوجد عملاء مطابقون.', 'search'));
      return;
    }
    host.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'العميل'), h('th', { class: 'num' }, 'النقلات'), h('th', { class: 'num' }, 'قيمة النقلات'), h('th', { class: 'num' }, 'المدفوع'),
        h('th', { class: 'num' }, 'رصيد النقليات'), h('th', { class: 'num' }, 'الحساب اليدوي'), h('th', { class: 'num' }, 'الإجمالي'),
        h('th', {}, 'الحالة'), h('th', {}, 'آخر حركة'), h('th', {}, h('span', { class: 'sr-only' }, 'إجراءات'))
      )),
      h('tbody', {}, rows.map(row => h('tr', {},
        h('td', {}, h('a', { href: `#/ledger?client=${encodeURIComponent(row.client)}` }, h('strong', {}, row.client))),
        h('td', { class: 'num' }, formatNumber(row.tripCount)),
        h('td', { class: 'num' }, formatMoney(row.deliveries)),
        h('td', { class: 'num text-ok' }, formatMoney(row.payments)),
        h('td', { class: ['num', balanceClass(row.transportBalance)] }, formatMoney(row.transportBalance)),
        h('td', { class: ['num', balanceClass(row.manualBalance)] }, formatMoney(row.manualBalance)),
        h('td', { class: ['num', balanceClass(row.totalBalance)] }, h('strong', {}, formatMoney(row.totalBalance))),
        h('td', {}, balanceBadge(row.totalBalance)),
        h('td', { class: 'num nowrap muted' }, row.lastActivity ? formatDate(row.lastActivity) : '—'),
        h('td', { class: 'nowrap' }, h('div', { class: 'actions' },
          iconButton('report', `كشف حساب ${row.client}`, { action: 'statement', dataset: { client: row.client } }),
          iconButton('banknote', `تسجيل دفعة من ${row.client}`, { action: 'payment', dataset: { client: row.client } }),
          iconButton('checkCircle', `تسوية رصيد نقليات ${row.client}`, { action: 'settle', disabled: balanceStatus(row.transportBalance) !== 'due', dataset: { client: row.client } }),
          iconButton('wallet', `الحساب اليدوي لـ ${row.client}`, { action: 'manual', dataset: { client: row.client } }),
          iconButton('tag', `أسعار ${row.client}`, { action: 'pricing', dataset: { client: row.client } }),
          iconButton('trash', `حذف ${row.client}`, { action: 'delete-client', danger: true, dataset: { client: row.client } })
        ))
      )))
    )));
  }

  /* ───────────── helpers ───────────── */

  async reloadAndNotify() {
    this.ctx.notifyDataChanged({ source: 'AccountsView' });
    await this.refresh();
  }

  /** @param {string} client */
  balanceOf(client) {
    return this.state.balances.find(row => row.client === client);
  }

  /* ───────────── clients ───────────── */

  openAddClient() {
    const formId = 'add-client-form';
    const input = h('input', { class: 'input', name: 'name', type: 'text', required: true, maxLength: 80, autofocus: true, placeholder: 'مثال: مؤسسة الريان للمقاولات' });
    const form = h('form', { id: formId, novalidate: true }, field('اسم العميل', input));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        const name = validateNewClient(input.value, this.state.data.clients);
        await this.ctx.db.addClient(name, createAccount(name));
        modal.close('saved');
        toast(`تمت إضافة العميل ${name}.`, 'success');
        await this.reloadAndNotify();
      } catch (error) {
        handleFormError(form, error);
      }
    });
    const modal = openModal({
      title: 'إضافة عميل جديد', icon: 'users', size: 'sm', content: form,
      actions: [{ label: 'إلغاء', variant: 'ghost', onClick: () => undefined }, { label: 'إضافة', variant: 'primary', icon: 'plus', type: 'submit', form: formId }]
    });
  }

  /** @param {string} client */
  async deleteClient(client) {
    const check = canDeleteClient(client, this.state.data);
    if (!check.ok) {
      toast(check.reason || 'لا يمكن حذف العميل.', 'warning', { duration: 6000 });
      return;
    }
    if (!(await confirmDialog({ title: 'حذف عميل', message: `حذف العميل "${client}" وتسعيرته الخاصة نهائياً؟`, confirmText: 'حذف', danger: true }))) return;
    await this.ctx.db.deleteClient(client);
    toast(`تم حذف العميل ${client}.`, 'info');
    await this.reloadAndNotify();
  }

  /* ───────────── payments & settlement ───────────── */

  /** @param {string} client */
  async addPayment(client) {
    if (await openPaymentDialog(this.ctx, this.state.data, { client, source: 'AccountsView' })) await this.refresh();
  }

  /** @param {string} client */
  async settle(client) {
    const row = this.balanceOf(client);
    if (!row) return;
    const payment = createSettlementPayment(client, row.transportBalance, this.ctx.mutationContext(this.state.data));
    const ok = await confirmDialog({
      title: 'تسوية رصيد النقليات',
      message: `سيتم تسجيل دفعة نقدية بتاريخ اليوم بقيمة ${formatMoney(payment.amount)} للعميل "${client}" لتصفير رصيد النقليات.`,
      confirmText: 'تسجيل التسوية'
    });
    if (!ok) return;
    await this.ctx.db.payments.add(payment);
    toast(`تمت تسوية رصيد ${client}.`, 'success');
    await this.reloadAndNotify();
  }

  /* ───────────── manual ledger ───────────── */

  /** @param {string} client */
  async getOrCreateAccount(client) {
    const existing = this.state.data.accounts.find(account => account.client === client);
    if (existing) return existing;
    const account = createAccount(client);
    await this.ctx.db.accounts.add(account);
    this.state.data = await this.ctx.db.loadAll();
    return account;
  }

  /** @param {string} client */
  async openManualLedger(client) {
    let account = await this.getOrCreateAccount(client);
    const lockedThrough = this.ctx.settings.lockedThrough;
    const formId = 'manual-tx-form';
    let dirty = false;

    const build = () => {
      const totals = accountTotals(account);
      const typeSelect = select({ name: 'type', value: ACCOUNT_TX.DEBT, options: [{ value: ACCOUNT_TX.DEBT, label: 'دين جديد (مدين)' }, { value: ACCOUNT_TX.PAYMENT, label: 'سداد / دفعة (دائن)' }] });
      const amountInput = h('input', { class: 'input num', type: 'text', name: 'amount', min: '0.01', step: '0.01', inputMode: 'decimal', required: true, autofocus: true });
      const preview = h('strong', { class: 'num' }, formatMoney(totals.balance));
      const updatePreview = () => {
        const amount = Number(amountInput.value) || 0;
        const next = roundMoney(totals.balance + (typeSelect.value === ACCOUNT_TX.DEBT ? amount : -amount));
        preview.textContent = formatMoney(next);
        preview.className = `num ${balanceClass(next)}`;
      };
      typeSelect.addEventListener('change', updatePreview);
      amountInput.addEventListener('input', updatePreview);

      const form = h('form', { id: formId, class: 'form-grid', novalidate: true },
        field('نوع المعاملة', typeSelect),
        field('المبلغ (ر.س)', amountInput),
        field('التاريخ', h('input', { class: 'input', type: 'date', name: 'date', value: todayISO(), required: true })),
        field('ملاحظة', h('input', { class: 'input', type: 'text', name: 'note', maxLength: 500 })),
        h('div', { class: 'total-preview span-2' }, h('span', {}, 'الرصيد بعد المعاملة'), preview)
      );
      form.addEventListener('submit', async event => {
        event.preventDefault();
        try {
          account = addAccountTransaction(account, readForm(form), this.ctx.mutationContext(this.state.data));
          await this.ctx.db.accounts.put(account);
          dirty = true;
          toast('تم تسجيل المعاملة وتحديث الرصيد.', 'success');
          modal.body.replaceChildren(build());
        } catch (error) {
          handleFormError(form, error);
        }
      });

      const transactions = [...account.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
      const list = transactions.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
          h('thead', {}, h('tr', {}, h('th', {}, 'التاريخ'), h('th', {}, 'النوع'), h('th', { class: 'num' }, 'المبلغ'), h('th', {}, 'ملاحظة'), h('th', {}, h('span', { class: 'sr-only' }, 'إجراءات')))),
          h('tbody', {}, transactions.map(tx => {
            const locked = isPeriodLocked(tx.date, lockedThrough);
            const del = h('button', { type: 'button', class: 'icon-btn danger', title: 'حذف المعاملة', ariaLabel: 'حذف المعاملة' }, icon('trash', { size: 16 }));
            del.addEventListener('click', async () => {
              if (!(await confirmDialog({ title: 'حذف معاملة', message: `حذف ${tx.type === 'debt' ? 'الدين' : 'الدفعة'} بقيمة ${formatMoney(tx.amount)} وإعادة احتساب الرصيد؟`, confirmText: 'حذف', danger: true }))) return;
              try {
                account = removeAccountTransaction(account, tx.id, this.ctx.mutationContext(this.state.data));
                await this.ctx.db.accounts.put(account);
                dirty = true;
                toast('تم حذف المعاملة.', 'info');
                modal.body.replaceChildren(build());
              } catch (error) {
                handleFormError(form, error);
              }
            });
            return h('tr', {},
              h('td', { class: 'num nowrap' }, formatDate(tx.date)),
              h('td', {}, h('span', { class: ['badge', tx.type === 'debt' ? 'badge-due' : 'badge-settled'] }, tx.type === 'debt' ? 'دين' : 'سداد')),
              h('td', { class: ['num', tx.type === 'debt' ? 'text-due' : 'text-ok'] }, formatMoney(tx.amount)),
              h('td', { class: 'truncate' }, tx.note || '—'),
              h('td', {}, locked ? lockBadge() : del)
            );
          }))
        ))
        : emptyState('لا توجد معاملات يدوية لهذا العميل.', 'wallet');

      return h('div', { class: 'stack' },
        h('dl', { class: 'kv' },
          h('dt', {}, 'إجمالي الديون'), h('dd', { class: 'num text-due' }, formatMoney(totals.debt)),
          h('dt', {}, 'إجمالي السداد'), h('dd', { class: 'num text-ok' }, formatMoney(totals.paid)),
          h('dt', {}, 'الرصيد الحالي'), h('dd', { class: ['num', balanceClass(totals.balance)] }, formatMoney(totals.balance))
        ),
        form,
        h('h3', { class: 'small muted' }, 'سجل المعاملات'),
        list
      );
    };

    const modal = openModal({
      title: `الحساب اليدوي — ${client}`, icon: 'wallet', size: 'lg', content: build(),
      actions: [
        { label: 'إغلاق', variant: 'ghost', onClick: () => undefined },
        { label: 'تسجيل المعاملة', variant: 'primary', icon: 'check', type: 'submit', form: formId }
      ],
      onClose: () => { if (dirty) this.reloadAndNotify(); }
    });
  }

  /* ───────────── client price lists ───────────── */

  /**
   * Client-first pricing dialog: pick a client/company from the dropdown, then view,
   * add or override that client's materials and prices. Only the selected client's
   * list is shown and changed.
   * @param {string} [initialClient] Preselected client (from a table row).
   */
  openPricing(initialClient = '') {
    const { clients, materials } = this.state.data;
    let client = clients.includes(initialClient) ? initialClient : '';
    let catalogs = [...this.state.data.catalogs];
    /** Name of the item being edited, or '' when adding. */
    let editing = '';
    let dirty = false;
    const formId = 'pricing-form';
    const STATUS = {
      default: { label: 'افتراضي', badge: 'badge-neutral' },
      override: { label: 'سعر خاص', badge: 'badge-material' },
      custom: { label: 'مادة خاصة', badge: 'badge-settled' },
      hidden: { label: 'مستبعدة', badge: 'badge-lock' }
    };

    const clientSelect = /** @type {HTMLSelectElement} */ (select({
      id: 'pricing-client', value: client, placeholder: 'اختر العميل / الشركة', options: clients, ariaLabel: 'العميل / الشركة'
    }));
    const host = h('div', { class: 'stack' });

    /** @param {import('../core/domain.js').CatalogEntry} entry */
    const putEntry = async entry => {
      await this.ctx.db.catalogs.put(entry);
      catalogs = [...catalogs.filter(item => !(item.client === entry.client && item.name === entry.name)), entry];
    };
    /** @param {string} name */
    const removeEntry = async name => {
      await this.ctx.db.catalogs.delete([client, name]);
      catalogs = catalogs.filter(item => !(item.client === client && item.name === name));
    };
    /**
     * Persists a change for the selected client and redraws the list.
     * @param {() => Promise<void>} write
     * @param {string} message
     */
    const commit = async (write, message) => {
      try {
        await write();
        dirty = true;
        editing = '';
        toast(message, 'success');
        draw();
      } catch (error) {
        const form = /** @type {HTMLFormElement|null} */ (host.querySelector(`#${formId}`));
        if (form) handleFormError(form, error);
        else toast(/** @type {any} */ (error)?.userMessage || 'تعذر حفظ التسعيرة.', 'error');
      }
    };

    const buildList = () => {
      const list = getClientPriceList(client, { catalogs, materials });
      const active = list.filter(item => item.status !== 'hidden');
      const editItem = list.find(item => item.name === editing);

      const nameInput = /** @type {HTMLInputElement} */ (h('input', {
        class: 'input', type: 'text', name: 'name', list: 'pricing-materials', required: true, maxLength: 80,
        placeholder: 'اختر من القائمة الافتراضية أو اكتب مادة جديدة', value: editItem?.name || '', readOnly: Boolean(editItem)
      }));
      const unitInput = /** @type {HTMLInputElement} */ (h('input', { class: 'input', type: 'text', name: 'unit', maxLength: 40, placeholder: 'رد', value: editItem?.unit || '' }));
      const priceInput = /** @type {HTMLInputElement} */ (h('input', {
        class: 'input num', type: 'text', name: 'defaultPrice', min: '0', step: '0.01', inputMode: 'decimal', required: true,
        value: editItem && editItem.status !== 'hidden' ? String(editItem.defaultPrice) : ''
      }));
      nameInput.addEventListener('change', () => {
        const known = list.find(item => item.name === nameInput.value.trim());
        if (!known) return;
        unitInput.value = known.unit;
        if (!priceInput.value) priceInput.value = String(known.defaultPrice);
      });
      const form = /** @type {HTMLFormElement} */ (h('form', { id: formId, class: 'form-grid pricing-form', novalidate: true },
        h('div', { class: 'span-2 row pricing-form-title' },
          h('strong', {}, editItem ? `تعديل سعر ${editItem.name}` : `إضافة مادة أو سعر خاص لـ ${client}`),
          editItem ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: () => { editing = ''; draw(); } } }, icon('close', { size: 15 }), 'إلغاء التعديل') : null
        ),
        field('المادة / الخدمة', nameInput, { class: 'span-2' }),
        h('datalist', { id: 'pricing-materials' }, materials.map(item => h('option', { value: item.name }))),
        field('الوحدة', unitInput),
        vatAmountField('سعر العميل (ر.س)', priceInput, vatDeductionRate(this.ctx.settings))
      ));
      form.addEventListener('submit', event => {
        event.preventDefault();
        let entry;
        try {
          entry = normalizeCatalogEntry({ ...readForm(form), client });
        } catch (error) {
          handleFormError(form, error);
          return;
        }
        commit(() => putEntry(entry), `تم حفظ ${entry.name} بسعر ${formatMoney(entry.defaultPrice)} لـ ${client}.`);
      });

      /**
       * @param {string} iconName
       * @param {string} label
       * @param {() => void} onClick
       * @param {boolean} [danger]
       */
      const action = (iconName, label, onClick, danger = false) =>
        h('button', { type: 'button', class: ['icon-btn', danger && 'danger'], title: label, ariaLabel: label, on: { click: onClick } }, icon(iconName, { size: 16 }));
      const rows = list.map(item => {
        const edit = () => { editing = item.name; draw(); host.querySelector('[name="defaultPrice"]')?.focus(); };
        const global = materials.find(material => material.name === item.name);
        const exclude = () => global && commit(() => putEntry(hiddenCatalogEntry(client, global)), `تم استبعاد ${item.name} من قائمة ${client}.`);
        const buttons = {
          default: [action('edit', `تحديد سعر خاص لـ ${item.name}`, edit), action('close', `استبعاد ${item.name} من قائمة العميل`, exclude, true)],
          override: [
            action('edit', `تعديل سعر ${item.name}`, edit),
            action('refresh', `العودة للسعر الافتراضي لـ ${item.name}`, () => commit(() => removeEntry(item.name), `${item.name} يعود للسعر الافتراضي.`)),
            action('close', `استبعاد ${item.name} من قائمة العميل`, exclude, true)
          ],
          custom: [
            action('edit', `تعديل ${item.name}`, edit),
            action('trash', `حذف ${item.name}`, () => commit(() => removeEntry(item.name), `تم حذف ${item.name} من قائمة ${client}.`), true)
          ],
          hidden: [action('plus', `إعادة ${item.name} إلى قائمة العميل`, () => commit(() => removeEntry(item.name), `تمت إعادة ${item.name} إلى قائمة ${client}.`))]
        }[item.status];
        return h('tr', { class: [item.status === 'hidden' && 'row-muted', item.name === editing && 'row-editing'] },
          h('td', {}, h('strong', {}, item.name)),
          h('td', {}, item.unit),
          h('td', { class: 'num' }, item.status === 'hidden' ? '—' : formatMoney(item.defaultPrice)),
          h('td', { class: 'num muted' }, item.globalPrice === null ? '—' : formatMoney(item.globalPrice)),
          h('td', {}, h('span', { class: ['badge', STATUS[item.status].badge] }, STATUS[item.status].label)),
          h('td', {}, h('div', { class: 'actions' }, buttons))
        );
      });

      return [
        h('p', { class: 'muted small' },
          `${formatNumber(active.length)} مادة في قائمة ${client} · ${formatNumber(list.length - active.length)} مستبعدة. `,
          'هذه المواد وأسعارها فقط تظهر عند اختيار العميل في سجل النقليات.'),
        rows.length
          ? h('div', { class: 'table-wrap pricing-table' }, h('table', { class: 'table table-compact' },
            h('thead', {}, h('tr', {}, h('th', {}, 'المادة'), h('th', {}, 'الوحدة'), h('th', { class: 'num' }, 'سعر العميل'), h('th', { class: 'num' }, 'الافتراضي'), h('th', {}, 'الحالة'), h('th', {}, h('span', { class: 'sr-only' }, 'إجراءات')))),
            h('tbody', {}, rows)))
          : emptyState('لا توجد مواد لهذا العميل. أضف مادة من النموذج أدناه.', 'tag'),
        form
      ];
    };

    const draw = () => {
      const save = /** @type {HTMLButtonElement|null} */ (modal?.dialog.querySelector('.modal-footer .btn-primary'));
      if (save) save.disabled = !client;
      if (!clients.length) {
        host.replaceChildren(emptyState('لا يوجد عملاء بعد. أضف عميلاً أولاً ثم خصص أسعاره.', 'users'));
        return;
      }
      host.replaceChildren(...(client ? buildList() : [emptyState('اختر عميلاً أو شركة من القائمة لعرض أسعاره الخاصة وتعديلها.', 'tag')]));
    };

    clientSelect.addEventListener('change', () => {
      client = clientSelect.value;
      editing = '';
      draw();
    });

    /** @type {import('../core/ui.js').ModalHandle|null} */
    let modal = null;
    draw();
    modal = openModal({
      title: 'أسعار العملاء', icon: 'tag', size: 'lg',
      content: h('div', { class: 'stack' }, field('العميل / الشركة', clientSelect), host),
      actions: [
        { label: 'إغلاق', variant: 'ghost', onClick: () => undefined },
        { label: 'حفظ السعر', variant: 'primary', icon: 'check', type: 'submit', form: formId }
      ],
      onClose: () => { if (dirty) this.reloadAndNotify(); }
    });
    draw();
    if (!client) clientSelect.focus();
    else /** @type {HTMLElement|null} */ (host.querySelector('[name="name"]'))?.focus();
  }

  /* ───────────── statement ───────────── */

  /**
   * Full chronological statement combining trips, cash receipts and the manual ledger.
   * @param {string} client
   */
  buildStatementRows(client) {
    const { data } = this.state;
    const account = data.accounts.find(item => item.client === client);
    const events = [
      ...data.trips.filter(trip => trip.client === client).map(trip => ({
        date: trip.date, record: trip, source: 'نقليات',
        description: `${trip.material} × ${formatNumber(trip.count)} ${trip.unit}${trip.truck ? ` — ${trip.truck}` : ''}`,
        debit: trip.total, credit: 0
      })),
      ...data.payments.filter(payment => payment.client === client).map(payment => ({
        date: payment.date, record: payment, source: 'نقليات',
        description: `دفعة نقدية${payment.note ? ` — ${payment.note}` : ''}`, debit: 0, credit: payment.amount
      })),
      ...(account?.transactions || []).map(tx => ({
        date: tx.date, record: tx, source: 'حساب يدوي',
        description: `${tx.type === 'debt' ? 'دين' : 'سداد'}${tx.note ? ` — ${tx.note}` : ''}`,
        debit: tx.type === 'debt' ? tx.amount : 0, credit: tx.type === 'payment' ? tx.amount : 0
      }))
    ].sort(compareChronological);
    let balance = 0;
    return events.map(event => {
      balance = roundMoney(balance + event.debit - event.credit);
      return { ...event, balance };
    });
  }

  /** @param {string} client */
  openStatement(client) {
    const rows = this.buildStatementRows(client);
    const row = this.balanceOf(client);
    const debit = roundMoney(rows.reduce((sum, item) => sum + item.debit, 0));
    const credit = roundMoney(rows.reduce((sum, item) => sum + item.credit, 0));
    const balance = roundMoney(debit - credit);
    const settings = this.ctx.settings;

    const printIt = () => printReport({
      title: 'كشف حساب عميل',
      subtitle: client,
      company: companyForPrint(settings),
      meta: [
        { label: 'العميل', value: client },
        { label: 'تاريخ الإصدار', value: formatDate(todayISO(), { style: 'long' }) },
        { label: 'عدد الحركات', value: formatNumber(rows.length) }
      ],
      summary: [
        { label: 'إجمالي المدين', value: formatMoney(debit) },
        { label: 'إجمالي الدائن', value: formatMoney(credit) },
        { label: 'رصيد النقليات', value: formatMoney(row?.transportBalance ?? 0), tone: balanceStatus(row?.transportBalance ?? 0) },
        { label: 'الرصيد الختامي', value: formatMoney(balance), tone: balanceStatus(balance) }
      ],
      sections: [{
        columns: [{ header: '#', align: 'center' }, { header: 'التاريخ', align: 'center' }, { header: 'المصدر' }, { header: 'البيان' }, { header: 'مدين', align: 'end' }, { header: 'دائن', align: 'end' }, { header: 'الرصيد', align: 'end' }],
        rows: rows.map((item, index) => [String(index + 1), formatDate(item.date), item.source, item.description, item.debit ? formatMoney(item.debit) : '—', item.credit ? formatMoney(item.credit) : '—', formatMoney(item.balance)]),
        footer: [['', '', '', 'الإجمالي', formatMoney(debit), formatMoney(credit), formatMoney(balance)]],
        empty: 'لا توجد حركات مسجلة لهذا العميل.'
      }],
      signatures: true
    }).catch(error => toast(error.message || 'تعذرت الطباعة.', 'error'));

    const exportIt = () => {
      exportXlsx(exportName('كشف_حساب', client), [{
        name: 'كشف الحساب',
        preamble: [[`كشف حساب: ${client}`], [`تاريخ الإصدار: ${todayISO()}`]],
        columns: [
          { header: '#', value: (_r, i) => i + 1, type: 'number', width: 6 },
          { header: 'التاريخ', value: r => r.date, type: 'date' },
          { header: 'المصدر', value: r => r.source, width: 12 },
          { header: 'البيان', value: r => r.description, width: 40 },
          { header: 'مدين', value: r => r.debit || '', type: 'money' },
          { header: 'دائن', value: r => r.credit || '', type: 'money' },
          { header: 'الرصيد', value: r => r.balance, type: 'money' }
        ],
        rows,
        footer: [['', 'الإجمالي', '', '', debit, credit, balance]]
      }]);
      toast('تم تصدير كشف الحساب.', 'success');
    };

    openModal({
      title: `كشف حساب — ${client}`, icon: 'report', size: 'xl',
      content: h('div', { class: 'statement' },
        h('div', { class: 'statement-meta' },
          h('div', {}, h('span', {}, 'إجمالي المدين'), h('strong', { class: 'num' }, formatMoney(debit))),
          h('div', {}, h('span', {}, 'إجمالي الدائن'), h('strong', { class: 'num text-ok' }, formatMoney(credit))),
          h('div', {}, h('span', {}, 'رصيد النقليات'), h('strong', { class: ['num', balanceClass(row?.transportBalance ?? 0)] }, formatMoney(row?.transportBalance ?? 0))),
          h('div', {}, h('span', {}, 'رصيد الحساب اليدوي'), h('strong', { class: ['num', balanceClass(row?.manualBalance ?? 0)] }, formatMoney(row?.manualBalance ?? 0))),
          h('div', {}, h('span', {}, 'الرصيد الختامي'), h('strong', { class: ['num', balanceClass(balance)] }, formatMoney(balance)))
        ),
        rows.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
            h('thead', {}, h('tr', {}, h('th', { class: 'center' }, '#'), h('th', {}, 'التاريخ'), h('th', {}, 'المصدر'), h('th', {}, 'البيان'), h('th', { class: 'num' }, 'مدين'), h('th', { class: 'num' }, 'دائن'), h('th', { class: 'num' }, 'الرصيد'))),
            h('tbody', {}, rows.map((item, index) => h('tr', {},
              h('td', { class: 'index num' }, formatNumber(index + 1)),
              h('td', { class: 'num nowrap' }, formatDate(item.date)),
              h('td', {}, h('span', { class: 'badge badge-neutral' }, item.source)),
              h('td', {}, item.description),
              h('td', { class: 'num' }, item.debit ? formatMoney(item.debit) : '—'),
              h('td', { class: 'num text-ok' }, item.credit ? formatMoney(item.credit) : '—'),
              h('td', { class: ['num', balanceClass(item.balance)] }, formatMoney(item.balance))
            ))),
            h('tfoot', {}, h('tr', {}, h('td', { colSpan: 4 }, 'الإجمالي'), h('td', { class: 'num' }, formatMoney(debit)), h('td', { class: 'num' }, formatMoney(credit)), h('td', { class: ['num', balanceClass(balance)] }, formatMoney(balance))))
          ))
          : emptyState('لا توجد حركات مسجلة لهذا العميل.', 'report')
      ),
      actions: [
        { label: 'إغلاق', variant: 'ghost', onClick: () => undefined },
        { label: 'Excel', icon: 'spreadsheet', onClick: () => { exportIt(); return false; } },
        { label: 'طباعة / PDF', icon: 'printer', variant: 'primary', onClick: () => { printIt(); return false; } }
      ]
    });
  }
}
