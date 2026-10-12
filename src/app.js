/**
 * @module app
 * Application bootstrap: opens IndexedDB, checks the device license, runs the
 * one-time legacy migration, seeds defaults, wires the PIN lock and router
 * guards, and starts the SPA.
 */

import { Router } from './core/router.js';
import { hydrateIcons } from './core/icons.js';
import { toast } from './core/ui.js';
import { DEFAULT_SETTINGS, OWNER_COMPANY_NAME, STANDARD_MATERIALS, effectiveVatRate, isDefaultCompanyName } from './core/domain.js';
import { isPinRecord, lockoutRemaining, registerFailure, verifyPin } from './core/security.js';
import { formatDateDual, formatNumber, todayISO } from './core/format.js';
import { checkActivationStatus } from './core/license.js';
import { Database, migrateFromLegacy, readLegacySnapshot } from './js/storage-adapter.js';
import { openLicenseStorage, resolveMasterInstall } from './js/license-storage.js';
import { openKeygen, showActivationScreen } from './views/license.js';

export const APP_VERSION = '2.7.0';

/** Hash that opens the developer key generator. */
const KEYGEN_HASH = '#admin-keygen';

/** @type {import('./core/router.js').RouteDefinition[]} */
const ROUTES = [
  { path: '/dashboard', title: 'لوحة المعلومات', load: () => import('./views/dashboard.js') },
  { path: '/ledger', title: 'سجل النقليات', load: () => import('./views/ledger.js') },
  { path: '/accounts', title: 'حسابات العملاء', load: () => import('./views/accounts.js') },
  { path: '/reports', title: 'التقارير والكشوف', load: () => import('./views/reports.js') },
  { path: '/settings', title: 'الإعدادات', load: () => import('./views/settings.js') }
];

const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * Shared application context handed to every view.
 * @type {import('./core/view.js').AppContext & { locked: boolean, lock: () => void, mutationContext: (data: { clients: string[] }) => Record<string, unknown>, version: string }}
 */
const ctx = {
  db: /** @type {any} */ (null),
  router: /** @type {any} */ (null),
  settings: {},
  events: new EventTarget(),
  locked: false,
  version: APP_VERSION,
  async reloadSettings() {
    ctx.settings = await ctx.db.getSettings();
    applyBranding();
  },
  notifyDataChanged(detail = {}) {
    ctx.events.dispatchEvent(new CustomEvent('data-changed', { detail }));
  },
  mutationContext(data) {
    return { lockedThrough: ctx.settings.lockedThrough, clients: data.clients, vatRate: effectiveVatRate(ctx.settings) };
  },
  lock() {
    if (!isPinRecord(ctx.settings.pin)) return;
    showLockScreen();
  },
  /** @type {{ storage: Pick<Storage, 'getItem'|'setItem'>|null, master: boolean, status: import('./core/license.js').ActivationStatus|null }} */
  license: { storage: null, master: false, status: null },
  /** @param {import('./core/license.js').ActivationStatus} status */
  setLicenseStatus(status) {
    ctx.license.status = status;
    renderLicensePill();
  }
};

/* ───────────────────────── boot ───────────────────────── */

/**
 * Shows a blocking error on the boot screen.
 * @param {string} title
 * @param {string} message
 */
function showFatal(title, message) {
  $('boot-screen').hidden = false;
  $('app-shell').hidden = true;
  $('boot-title').textContent = title;
  $('boot-message').textContent = message;
  $('boot-spinner').hidden = true;
  const retry = $('boot-retry');
  retry.hidden = false;
  retry.onclick = () => location.reload();
}

async function boot() {
  hydrateIcons();
  registerServiceWorker();
  // The key generator works without a license (it needs the developer's private key).
  window.addEventListener('hashchange', () => { if (location.hash === KEYGEN_HASH) openKeygen(); });
  if (location.hash === KEYGEN_HASH) openKeygen();

  try {
    ctx.db = await Database.open();
  } catch (error) {
    console.error('Database open failed:', error);
    showFatal('تعذر فتح قاعدة البيانات', /** @type {any} */ (error)?.userMessage || 'تعذر الوصول إلى التخزين المحلي في هذا المتصفح.');
    return;
  }

  try {
    $('boot-message').textContent = 'التحقق من ترخيص الجهاز';
    // Must run before the migration so grandfathering sees this device's prior state.
    const legacy = readLegacySnapshot();
    ctx.license.storage = await openLicenseStorage(ctx.db);
    ctx.license.master = await resolveMasterInstall(ctx.db, { hasLegacyData: legacy.found || isPinRecord(legacy.pin) });
    ctx.license.status = await checkActivationStatus({ storage: ctx.license.storage, master: ctx.license.master });
    // The owner's install predates the generic default: keep its company name.
    if (ctx.license.master && (await ctx.db.getSetting('companyName')) === undefined) {
      await ctx.db.setSetting('companyName', OWNER_COMPANY_NAME);
    }
  } catch (error) {
    console.error('License check failed:', error);
    showFatal('تعذر التحقق من ترخيص الجهاز', /** @type {any} */ (error)?.userMessage || /** @type {any} */ (error)?.message || 'حدث خطأ أثناء قراءة بيانات الترخيص.');
    return;
  }

  /** @type {import('./js/storage-adapter.js').MigrationResult|null} */
  let migration = null;
  try {
    $('boot-message').textContent = 'التحقق من بيانات الإصدار السابق';
    migration = await migrateFromLegacy(ctx.db);
  } catch (error) {
    console.error('Legacy migration failed:', error);
    migration = null;
    queueMicrotask(() => toast('تعذر استيراد بيانات الإصدار السابق تلقائياً. يمكنك إعادة المحاولة من الإعدادات.', 'error'));
  }

  try {
    await ctx.db.seedMaterials(STANDARD_MATERIALS);
    ctx.settings = await ctx.db.getSettings();
  } catch (error) {
    console.error('Initial data load failed:', error);
    showFatal('تعذر تحميل الإعدادات', /** @type {any} */ (error)?.userMessage || 'حدث خطأ أثناء قراءة البيانات المحلية.');
    return;
  }

  setupShell();

  ctx.router = new Router({
    routes: ROUTES,
    outlet: $('app-outlet'),
    mode: 'hash',
    fallback: '/dashboard',
    titleSuffix: ' — نظام النقليات',
    createView: (ViewClass, location) => new ViewClass(ctx, location)
  });
  // Guard: nothing renders without an active license or while the PIN lock is active.
  ctx.router.beforeEach(() => Boolean(ctx.license.status?.active) && !ctx.locked);
  ctx.router.afterEach(to => {
    for (const link of document.querySelectorAll('.nav-link[data-route]')) {
      if (link.getAttribute('data-route') === to.path) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    $('page-title').textContent = ctx.router.view?.title || to.route?.title || '';
    closeMobileNav();
    $('app-outlet').focus({ preventScroll: true });
  });

  $('boot-screen').hidden = true;
  $('app-shell').hidden = false;

  renderLicensePill();
  if (!ctx.license.status?.active) showLicenseGate();
  else if (isPinRecord(ctx.settings.pin)) showLockScreen();
  else await ctx.router.start();

  reportMigration(migration);
  maybeRemindBackup();
  ctx.db.requestPersistence().catch(() => undefined);
}

/* ───────────────────────── shell ───────────────────────── */

function applyBranding() {
  const unnamed = isDefaultCompanyName(ctx.settings.companyName);
  $('brand-name').textContent = ctx.settings.companyName || DEFAULT_SETTINGS.companyName;
  $('brand-sub').textContent = unnamed ? 'أدخل اسم شركتك من الإعدادات' : 'نظام النقليات وحسابات العملاء';
  $('lock-btn').hidden = !isPinRecord(ctx.settings.pin);
  $('today-label').textContent = ctx.settings.showHijri === false ? todayISO() : formatDateDual(todayISO(), { style: 'long' });
}

/* Sidebar: an icon-only rail on wide screens, an off-canvas drawer on narrow ones. */
const SIDEBAR_KEY = 'dad_sidebar_collapsed';
const wideScreen = window.matchMedia('(min-width: 961px)');

/** @returns {boolean} */
function readCollapsedPreference() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

/** @param {boolean} collapsed */
function writeCollapsedPreference(collapsed) {
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
  } catch { /* storage unavailable: the preference just won't persist */ }
}

/** Mirrors the visible sidebar state onto the toggle for assistive tech. */
function syncMenuToggle() {
  const body = document.body;
  const expanded = wideScreen.matches ? !body.classList.contains('sidebar-collapsed') : body.classList.contains('nav-open');
  const toggle = $('menu-toggle');
  toggle.setAttribute('aria-expanded', String(expanded));
  const label = expanded ? 'طي القائمة' : 'إظهار القائمة';
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
}

function closeMobileNav() {
  document.body.classList.remove('nav-open');
  syncMenuToggle();
}

function setupShell() {
  applyBranding();
  $('app-version').textContent = `v${APP_VERSION}`;

  const toggle = $('menu-toggle');
  document.body.classList.toggle('sidebar-collapsed', readCollapsedPreference());
  syncMenuToggle();
  toggle.addEventListener('click', () => {
    if (wideScreen.matches) writeCollapsedPreference(document.body.classList.toggle('sidebar-collapsed'));
    else document.body.classList.toggle('nav-open');
    syncMenuToggle();
  });
  wideScreen.addEventListener('change', closeMobileNav);
  $('sidebar-backdrop').addEventListener('click', closeMobileNav);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('nav-open')) {
      closeMobileNav();
      toggle.focus();
    }
  });

  $('lock-btn').addEventListener('click', () => ctx.lock());
  $('lock-form').addEventListener('submit', handleUnlock);

  const net = $('net-status');
  const updateNet = () => {
    const online = navigator.onLine;
    net.textContent = online ? 'متصل' : 'دون اتصال — يعمل محلياً';
    net.classList.toggle('is-offline', !online);
  };
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  updateNet();

  // Keep the date label correct across midnight for long-running sessions.
  setInterval(() => { applyBranding(); refreshLicense(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshLicense(); });

  window.addEventListener('dad:db-versionchange', () => {
    showFatal('تم تحديث قاعدة البيانات', 'تم فتح إصدار أحدث من التطبيق في نافذة أخرى. أعد تحميل الصفحة للمتابعة.');
  });
  window.addEventListener('dad:db-blocked', () => {
    toast('أغلق نوافذ التطبيق الأخرى لإكمال تحديث قاعدة البيانات.', 'warning', { duration: 8000 });
  });
  window.addEventListener('unhandledrejection', event => {
    console.error('Unhandled rejection:', event.reason);
    toast(event.reason?.userMessage || 'حدث خطأ غير متوقع. لم تُفقد أي بيانات محفوظة.', 'error');
  });
}

/* ───────────────────────── license gate ───────────────────────── */

/** Blocks the app behind the activation screen until a valid key is entered. */
function showLicenseGate() {
  const status = ctx.license.status;
  if (!status || !ctx.license.storage) return;
  $('app-shell').inert = true;
  showActivationScreen({
    status,
    storage: ctx.license.storage,
    company: isDefaultCompanyName(ctx.settings.companyName) ? '' : ctx.settings.companyName,
    onActivated: next => {
      ctx.setLicenseStatus(next);
      continueAfterLicense().catch(error => console.error('Start after activation failed:', error));
    }
  });
}

async function continueAfterLicense() {
  $('app-shell').inert = ctx.locked;
  if (ctx.locked) return;
  if (!ctx.router._started && isPinRecord(ctx.settings.pin)) {
    showLockScreen();
    return;
  }
  if (ctx.router._started) await ctx.router.reload();
  else await ctx.router.start();
}

/** Re-evaluates the license (trials can expire while the app is open). */
async function refreshLicense() {
  if (!ctx.license.storage || !ctx.license.status?.active) return;
  try {
    const status = await checkActivationStatus({ storage: ctx.license.storage, master: ctx.license.master });
    ctx.setLicenseStatus(status);
    if (!status.active) showLicenseGate();
  } catch (error) {
    console.error('License refresh failed:', error);
  }
}

/** Trial countdown pill in the top bar. */
function renderLicensePill() {
  const pill = $('license-pill');
  const status = ctx.license.status;
  if (!pill) return;
  pill.hidden = status?.state !== 'trial';
  if (status?.state === 'trial') {
    pill.textContent = `نسخة تجريبية · ${formatNumber(status.daysLeft)} يوم`;
    pill.title = 'افتح الإعدادات لإدخال مفتاح التفعيل الدائم';
  }
}

/* ───────────────────────── PIN lock ───────────────────────── */

function showLockScreen() {
  ctx.locked = true;
  $('app-shell').inert = true;
  $('lock-screen').hidden = false;
  $('lock-error').textContent = '';
  const input = /** @type {HTMLInputElement} */ ($('lock-pin'));
  input.value = '';
  input.focus();
}

async function hideLockScreen() {
  ctx.locked = false;
  $('lock-screen').hidden = true;
  $('app-shell').inert = false;
  if (ctx.router._started) await ctx.router.reload();
  else await ctx.router.start();
}

/**
 * @param {SubmitEvent} event
 */
async function handleUnlock(event) {
  event.preventDefault();
  const input = /** @type {HTMLInputElement} */ ($('lock-pin'));
  const errorEl = $('lock-error');
  const submit = /** @type {HTMLButtonElement} */ (/** @type {HTMLFormElement} */ (event.currentTarget).querySelector('button[type="submit"]'));
  const pin = input.value.trim();
  input.value = '';

  try {
    const attempts = await ctx.db.getSetting('pinAttempts');
    const remaining = lockoutRemaining(attempts);
    if (remaining > 0) {
      errorEl.textContent = `محاولات كثيرة. حاول بعد ${formatNumber(Math.ceil(remaining / 1000))} ثانية.`;
      return;
    }
    const record = await ctx.db.getSetting('pin');
    if (!isPinRecord(record)) {
      await hideLockScreen();
      return;
    }
    submit.disabled = true;
    const valid = await verifyPin(pin, record);
    if (!valid) {
      const next = registerFailure(attempts);
      await ctx.db.setSetting('pinAttempts', next);
      errorEl.textContent = next.lockoutUntil
        ? `تم إيقاف المحاولات مؤقتاً لمدة ${formatNumber(Math.ceil(lockoutRemaining(next) / 1000))} ثانية.`
        : 'الرمز غير صحيح. حاول مرة أخرى.';
      input.focus();
      return;
    }
    await ctx.db.setSetting('pinAttempts', undefined);
    await hideLockScreen();
  } catch (error) {
    console.error('PIN verification failed:', error);
    errorEl.textContent = 'تعذر التحقق من الرمز. تحقق من إعدادات التخزين في المتصفح.';
  } finally {
    submit.disabled = false;
  }
}

/* ───────────────────────── notices ───────────────────────── */

/**
 * @param {import('./js/storage-adapter.js').MigrationResult|null} migration
 */
function reportMigration(migration) {
  if (!migration || migration.status !== 'migrated') return;
  const written = migration.written || {};
  const dropped = Object.values(migration.dropped || {}).reduce((sum, value) => sum + value, 0);
  toast(`تم نقل بيانات الإصدار السابق: ${formatNumber(written.trips || 0)} نقلة، ${formatNumber(written.payments || 0)} دفعة، ${formatNumber(written.clients || 0)} عميل.`, 'success', { duration: 8000 });
  if (dropped) toast(`تم تجاهل ${formatNumber(dropped)} سجل تالف أثناء النقل. التفاصيل في الإعدادات.`, 'warning', { duration: 8000 });
  if (migration.unreadable?.length) toast('تعذرت قراءة بعض مفاتيح التخزين القديمة؛ بقيت كما هي دون تغيير.', 'warning', { duration: 8000 });
}

async function maybeRemindBackup() {
  try {
    const days = Number(ctx.settings.backupReminderDays) || 0;
    if (!days) return;
    const last = Number(await ctx.db.getSetting('_lastBackupReminder', 0)) || 0;
    if (Date.now() - last < days * 86_400_000) return;
    const tripCount = await ctx.db.trips.count();
    if (!tripCount) return;
    toast('تذكير: نزّل نسخة احتياطية من بياناتك من صفحة الإعدادات لحمايتها.', 'info', { duration: 7000 });
    await ctx.db.setSetting('_lastBackupReminder', Date.now());
  } catch (error) {
    console.error('Backup reminder failed:', error);
  }
}

/* ───────────────────────── service worker ───────────────────────── */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            toast('يتوفر تحديث جديد للتطبيق. أعد تحميل الصفحة لتطبيقه.', 'info', { duration: 10000 });
          }
        });
      });
    } catch (error) {
      console.warn('Service worker registration failed:', error);
      toast('تعذر تفعيل العمل دون اتصال. افتح التطبيق عبر HTTPS أو localhost.', 'warning');
    }
  });
}

boot().catch(error => {
  console.error('Fatal boot error:', error);
  showFatal('تعذر تشغيل النظام', error?.userMessage || error?.message || 'خطأ غير معروف.');
});
