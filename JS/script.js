/**
 * نظام إدارة نقل مواد البناء والمخلفات
 * سجل النقليات والفوترة الشهرية
 */

// مفاتيح التخزين المحلي
const STORAGE_KEYS = {
  TRIPS: 'dad_transport_trips_v1',
  CLIENTS: 'dad_transport_clients_v1',
  MATERIALS: 'dad_transport_materials_v1',
  TRUCKS: 'dad_transport_trucks_v1',
  ACCOUNTS: 'dad_transport_accounts_v1',
  CLIENT_CATALOGS: 'dad_transport_client_catalogs_v1'
};
const STANDARD_MATERIALS = [
  { name: 'رمل ابيض بناء', unit: 'تريلا 20م', defaultPrice: 0, icon: 'fa-cubes-stacked', badgeClass: 'badge-other' },
  { name: 'رمل احمر', unit: 'تريلا 20م', defaultPrice: 0, icon: 'fa-cubes-stacked', badgeClass: 'badge-other' },
  { name: 'بحص', unit: 'تريلا 20م', defaultPrice: 0, icon: 'fa-cubes-stacked', badgeClass: 'badge-other' },
  { name: 'دفان', unit: 'تريلا 20م', defaultPrice: 0, icon: 'fa-cubes-stacked', badgeClass: 'badge-other' },
  { name: 'مخلفات', unit: 'رد', defaultPrice: 0, icon: 'fa-trash-can', badgeClass: 'badge-waste' }
];
const PIN_STORAGE_KEY = 'dad_transport_pin_v1';
const PIN_ATTEMPTS_KEY = 'dad_transport_pin_attempts_v1';
const BACKUP_REMINDER_KEY = 'dad_transport_backup_reminder_v1';
const BACKUP_REMINDER_INTERVAL = 7 * 24 * 60 * 60 * 1000;
const SW_CACHE_MESSAGE = 'تعذر تفعيل التخزين دون اتصال. افتح التطبيق عبر HTTPS أو localhost.';

// حالة التطبيق
const state = {
  trips: [],
  clients: [],
  materials: [],
  trucks: [],
  accounts: [],
  clientCatalogs: {},
  editingCatalogItem: '',
  activeTab: 'records', // 'records' | 'monthly' | 'accounts'
  filters: {
    client: '',
    material: '',
    month: '',
    search: ''
  }
};

let applicationInitialized = false;
let pinFailedAttempts = 0;
let pinLockoutUntil = 0;
const unreadableStorageKeys = new Set();

// بدء الحماية أولاً قبل تحميل البيانات المالية في الواجهة.
document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();
  initializePinGate();
});

function initializeApplication() {
  if (applicationInitialized) return;
  applicationInitialized = true;
  initStorage();
  renderMaterialSelects();
  initFormDefaults();
  initEventListeners();
  renderClientSelects();
  renderAccountLedger();
  renderTruckSuggestions();
  renderDashboard();
  renderStatementView();
  updatePinControls();
  maybeShowBackupReminder();
}

async function initializePinGate() {
  const screen = document.getElementById('pin-screen');
  const form = document.getElementById('pin-unlock-form');
  const pinInput = document.getElementById('pin-unlock-input');
  const errorElement = document.getElementById('pin-unlock-error');
  let configuredPin;

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (Date.now() < pinLockoutUntil) {
      const seconds = Math.ceil((pinLockoutUntil - Date.now()) / 1000);
      errorElement.textContent = `محاولات كثيرة. حاول بعد ${seconds} ثانية.`;
      return;
    }

    const submittedPin = pinInput.value;
    pinInput.value = '';
    try {
      const currentRecord = readStoredValue(PIN_STORAGE_KEY);
      if (!currentRecord) {
        screen.hidden = true;
        document.documentElement.classList.remove('pin-configured');
        initializeApplication();
        return;
      }

      const pinRecord = JSON.parse(currentRecord);
      if (!/^\d{4}$/.test(submittedPin) || !(await verifyPin(submittedPin, pinRecord))) {
        pinFailedAttempts += 1;
        if (pinFailedAttempts >= 5) {
          pinLockoutUntil = Date.now() + 30_000;
          pinFailedAttempts = 0;
        }
        writeStoredJson(PIN_ATTEMPTS_KEY, {
          count: pinFailedAttempts,
          lockoutUntil: pinLockoutUntil
        });
        errorElement.textContent = pinLockoutUntil > Date.now()
          ? 'تم إيقاف المحاولات مؤقتاً لمدة 30 ثانية.'
          : 'الرمز غير صحيح. حاول مرة أخرى.';
        pinInput.focus();
        return;
      }

      pinFailedAttempts = 0;
      pinLockoutUntil = 0;
      try {
        removeStoredValue(PIN_ATTEMPTS_KEY);
      } catch (error) {
        console.error('تعذر مسح محاولات PIN السابقة:', error);
      }
      screen.hidden = true;
      document.documentElement.classList.remove('pin-configured');
      initializeApplication();
    } catch (error) {
      errorElement.textContent = 'تعذر التحقق من الرمز. تحقق من إعدادات التخزين المحلي.';
      console.error('تعذر التحقق من رمز PIN:', error);
    }
  });

  try {
    configuredPin = readStoredValue(PIN_STORAGE_KEY);
    const storedAttempts = JSON.parse(readStoredValue(PIN_ATTEMPTS_KEY) || 'null');
    if (storedAttempts && Number.isInteger(storedAttempts.count) && Number.isFinite(storedAttempts.lockoutUntil)) {
      pinFailedAttempts = Math.max(0, Math.min(storedAttempts.count, 4));
      pinLockoutUntil = storedAttempts.lockoutUntil > Date.now() ? storedAttempts.lockoutUntil : 0;
      if (!pinLockoutUntil) {
        try {
          removeStoredValue(PIN_ATTEMPTS_KEY);
        } catch (error) {
          console.error('تعذر مسح محاولات PIN المنتهية:', error);
        }
      }
    }
  } catch (error) {
    screen.hidden = false;
    document.getElementById('pin-screen-title').textContent = 'تعذر فتح التخزين المحلي';
    pinInput.hidden = true;
    form.querySelector('button[type="submit"]').hidden = true;
    errorElement.textContent = 'يجب السماح بالتخزين المحلي للمتصفح لاستخدام التطبيق.';
    return;
  }

  if (!configuredPin) {
    initializeApplication();
    return;
  }

  screen.hidden = false;
  document.documentElement.classList.add('pin-configured');
  pinInput.focus();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    window.addEventListener('load', () => {
      if (typeof showToast === 'function') showToast(SW_CACHE_MESSAGE, 'warning');
    }, { once: true });
    return;
  }

  navigator.serviceWorker.register('./sw.js')
    .then(() => console.info('تم تسجيل عامل الخدمة للتشغيل دون اتصال.'))
    .catch(error => {
      console.error('تعذر تسجيل عامل الخدمة:', error);
      window.addEventListener('load', () => {
        if (typeof showToast === 'function') showToast(SW_CACHE_MESSAGE, 'warning');
      }, { once: true });
    });
}

/* =========================================================
   إدارة البيانات والتخزين المحلي (LocalStorage)
   ========================================================= */

function initStorage() {
  const storedMaterials = normalizeMaterials(readStoredArray(STORAGE_KEYS.MATERIALS, 'المواد'));
  state.materials = storedMaterials.length ? storedMaterials : getStandardMaterials();

  state.clients = readStoredArray(STORAGE_KEYS.CLIENTS, 'العملاء')
    .filter(client => typeof client === 'string' && client.trim())
    .map(client => client.trim());
  state.clientCatalogs = readStoredObject(STORAGE_KEYS.CLIENT_CATALOGS, 'تسعيرات العملاء');
  state.accounts = normalizeAccounts(readStoredArray(STORAGE_KEYS.ACCOUNTS, 'حسابات العملاء'));
  state.accounts.forEach(account => {
    if (!state.clients.includes(account.client)) state.clients.push(account.client);
  });
  state.trucks = readStoredArray(STORAGE_KEYS.TRUCKS, 'الشاحنات')
    .filter(truck => typeof truck === 'string' && truck.trim())
    .map(truck => truck.trim());
  state.trips = normalizeTrips(readStoredArray(STORAGE_KEYS.TRIPS, 'النقلات'), state.materials, state.clientCatalogs);
}

function normalizeMaterials(materials) {
  return materials.filter(material =>
    material &&
    typeof material.name === 'string' &&
    material.name.trim() &&
    Number.isFinite(Number(material.defaultPrice)) &&
    Number(material.defaultPrice) >= 0
  ).map(material => ({
    name: material.name.trim(),
    unit: typeof material.unit === 'string' && material.unit.trim() ? material.unit.trim() : 'رد',
    defaultPrice: Number(material.defaultPrice),
    icon: typeof material.icon === 'string' && /^fa-[a-z0-9-]+$/.test(material.icon)
      ? material.icon
      : 'fa-cubes-stacked',
    badgeClass: typeof material.badgeClass === 'string' && /^badge-[a-z0-9-]+$/.test(material.badgeClass)
      ? material.badgeClass
      : 'badge-other'
  }));
}

function getStandardMaterials() {
  return normalizeMaterials(STANDARD_MATERIALS);
}

function normalizeClientCatalogs(catalogs) {
  if (!catalogs || typeof catalogs !== 'object' || Array.isArray(catalogs)) return {};
  return Object.fromEntries(Object.entries(catalogs).map(([client, entries]) => {
    if (typeof client !== 'string' || !client.trim() || !Array.isArray(entries)) return [client, []];
    const seenNames = new Set();
    const normalizedEntries = entries.flatMap(entry => {
      if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) return [];
      const name = entry.name.trim();
      const unit = typeof entry.unit === 'string' && entry.unit.trim() ? entry.unit.trim() : 'رد';
      const defaultPrice = Number(entry.defaultPrice);
      if (seenNames.has(name) || !Number.isFinite(defaultPrice) || defaultPrice < 0) return [];
      seenNames.add(name);
      return [{ name, unit, defaultPrice }];
    });
    return [client.trim(), normalizedEntries];
  }).filter(([client]) => typeof client === 'string' && client.trim()));
}

function normalizeTrips(trips, materials, clientCatalogs = {}) {
  return trips
    .filter(trip => trip && typeof trip === 'object' && !Array.isArray(trip))
    .map(trip => {
      const count = Number.parseInt(trip.count, 10) || 1;
      const catalogItem = clientCatalogs[trip.client]?.find(item => item.name === trip.material);
      const defaultPrice = catalogItem?.defaultPrice
        ?? materials.find(material => material.name === trip.material)?.defaultPrice
        ?? 0;
      const price = trip.price !== null && Number.isFinite(Number(trip.price)) ? Number(trip.price) : defaultPrice;
      const total = trip.total !== null && Number.isFinite(Number(trip.total)) ? Number(trip.total) : count * price;
      return {
        ...trip,
        id: typeof trip.id === 'string' && trip.id ? trip.id : `trip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        date: typeof trip.date === 'string' ? trip.date : '',
        client: typeof trip.client === 'string' ? trip.client : '',
        material: typeof trip.material === 'string' ? trip.material : '',
        count,
        unit: typeof trip.unit === 'string' && trip.unit.trim() ? trip.unit.trim() : catalogItem?.unit || 'رد',
        price,
        total,
        truck: typeof trip.truck === 'string' ? trip.truck : '',
        notes: typeof trip.notes === 'string' ? trip.notes : ''
      };
    });
}

function readStoredArray(key, label) {
  let stored;
  try {
    stored = readStoredValue(key);
  } catch (error) {
    unreadableStorageKeys.add(key);
    console.error(`تعذر تحميل ${label} من التخزين المحلي:`, error);
    return [];
  }

  if (stored === null) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new TypeError('المحتوى المخزن ليس قائمة.');
    return parsed;
  } catch (error) {
    unreadableStorageKeys.add(key);
    console.error(`تعذر تحليل بيانات ${label} من التخزين المحلي:`, error);
    showToast(`تعذر قراءة بيانات ${label}؛ بقيت البيانات المخزنة دون تغيير.`, 'warning');
    return [];
  }
}

function readStoredObject(key, label) {
  let stored;
  try {
    stored = readStoredValue(key);
  } catch (error) {
    unreadableStorageKeys.add(key);
    console.error(`تعذر تحميل ${label} من التخزين المحلي:`, error);
    return {};
  }
  if (stored === null) return {};
  try {
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('المحتوى المخزن ليس سجلاً.');
    }
    return normalizeClientCatalogs(parsed);
  } catch (error) {
    unreadableStorageKeys.add(key);
    console.error(`تعذر تحليل بيانات ${label} من التخزين المحلي:`, error);
    showToast(`تعذر قراءة بيانات ${label}؛ بقيت البيانات المخزنة دون تغيير.`, 'warning');
    return {};
  }
}

function readStoredValue(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    unreadableStorageKeys.add(key);
    reportStorageError('read', error);
    throw error;
  }
}

function reportStorageError(operation, error) {
  const messages = {
    read: 'تعذرت قراءة البيانات من التخزين المحلي.',
    write: 'تعذر حفظ البيانات في التخزين المحلي. تحقق من مساحة التخزين المتاحة.',
    remove: 'تعذر تحديث البيانات في التخزين المحلي.'
  };
  console.error(messages[operation], error);
  showToast(messages[operation], 'error');
}

async function createPinRecord(pin) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('التشفير غير متاح. يلزم فتح التطبيق عبر HTTPS أو localhost.');
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt, byte => byte.toString(16).padStart(2, '0')).join('');
  return {
    version: 1,
    algorithm: 'PBKDF2-SHA-256',
    iterations: 120000,
    salt: saltHex,
    hash: await derivePinHash(pin, salt, 120000)
  };
}

async function derivePinHash(pin, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  );
  return Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyPin(pin, record) {
  if (
    !record ||
    record.version !== 1 ||
    record.algorithm !== 'PBKDF2-SHA-256' ||
    record.iterations !== 120000 ||
    !/^[a-f0-9]{32}$/i.test(record.salt || '') ||
    !/^[a-f0-9]{64}$/i.test(record.hash || '')
  ) {
    throw new Error('صيغة إعداد رمز PIN غير صالحة.');
  }
  const salt = new Uint8Array(record.salt.match(/.{2}/g).map(byte => parseInt(byte, 16)));
  const candidate = await derivePinHash(pin, salt, record.iterations);
  let difference = 0;
  for (let index = 0; index < candidate.length; index++) {
    difference |= candidate.charCodeAt(index) ^ record.hash.toLowerCase().charCodeAt(index);
  }
  return difference === 0;
}

function updatePinControls() {
  const lockButton = document.getElementById('lock-app-btn');
  if (!lockButton) return;
  try {
    lockButton.classList.toggle('hidden', !readStoredValue(PIN_STORAGE_KEY));
  } catch (error) {
    lockButton.classList.add('hidden');
    console.error('تعذر قراءة إعدادات رمز PIN:', error);
  }
}

function openPinSettings() {
  const modal = document.getElementById('pin-settings-modal');
  const currentField = document.getElementById('pin-current-field');
  const removeButton = document.getElementById('remove-pin-btn');
  const error = document.getElementById('pin-settings-error');
  let isConfigured;
  try {
    isConfigured = Boolean(readStoredValue(PIN_STORAGE_KEY));
  } catch (error) {
    console.error('تعذر فتح إعدادات رمز PIN:', error);
    document.getElementById('pin-settings-error').textContent = 'تعذر قراءة إعدادات التخزين المحلي.';
    return;
  }

  document.getElementById('pin-settings-form').reset();
  error.textContent = '';
  currentField.hidden = !isConfigured;
  removeButton.hidden = !isConfigured;
  document.getElementById('pin-settings-title').textContent = isConfigured
    ? 'تغيير أو إزالة رمز الدخول'
    : 'إعداد رمز الدخول';
  modal.hidden = false;
  document.getElementById(isConfigured ? 'pin-current-input' : 'pin-new-input').focus();
}

function closePinSettings() {
  document.getElementById('pin-settings-modal').hidden = true;
  document.getElementById('pin-settings-form').reset();
  document.getElementById('pin-settings-error').textContent = '';
}

async function handleSavePinSettings(event) {
  event.preventDefault();
  const errorElement = document.getElementById('pin-settings-error');
  errorElement.textContent = '';

  try {
    const storedPin = readStoredValue(PIN_STORAGE_KEY);
    if (storedPin) {
      const currentPin = document.getElementById('pin-current-input').value;
      if (!/^\d{4}$/.test(currentPin) || !(await verifyPin(currentPin, JSON.parse(storedPin)))) {
        errorElement.textContent = 'الرمز الحالي غير صحيح.';
        return;
      }
    }

    const newPin = document.getElementById('pin-new-input').value;
    const confirmation = document.getElementById('pin-confirm-input').value;
    if (!/^\d{4}$/.test(newPin)) {
      errorElement.textContent = 'أدخل رمزاً جديداً مكوّناً من أربعة أرقام.';
      return;
    }
    if (newPin !== confirmation) {
      errorElement.textContent = 'تأكيد الرمز لا يطابق الرمز الجديد.';
      return;
    }

    writeStoredJson(PIN_STORAGE_KEY, await createPinRecord(newPin));
    try {
      removeStoredValue(PIN_ATTEMPTS_KEY);
    } catch (error) {
      console.error('تعذر مسح محاولات PIN بعد حفظ الرمز:', error);
    }
    closePinSettings();
    updatePinControls();
    showToast('تم حفظ رمز الدخول. سيُطلب عند فتح التطبيق مجدداً.', 'success');
  } catch (error) {
    errorElement.textContent = error.message || 'تعذر حفظ رمز الدخول في التخزين المحلي.';
    console.error('تعذر حفظ إعداد رمز PIN:', error);
  }
}

async function handleRemovePin() {
  const errorElement = document.getElementById('pin-settings-error');
  errorElement.textContent = '';
  try {
    const storedPin = readStoredValue(PIN_STORAGE_KEY);
    if (!storedPin) {
      closePinSettings();
      updatePinControls();
      return;
    }
    const currentPin = document.getElementById('pin-current-input').value;
    if (!/^\d{4}$/.test(currentPin) || !(await verifyPin(currentPin, JSON.parse(storedPin)))) {
      errorElement.textContent = 'أدخل الرمز الحالي الصحيح لإزالته.';
      return;
    }
    removeStoredValue(PIN_ATTEMPTS_KEY);
    removeStoredValue(PIN_STORAGE_KEY);
    closePinSettings();
    updatePinControls();
    showToast('تمت إزالة رمز الدخول.', 'info');
  } catch (error) {
    errorElement.textContent = error.message || 'تعذر إزالة رمز الدخول.';
    console.error('تعذر إزالة رمز PIN:', error);
  }
}

function lockApplication() {
  const screen = document.getElementById('pin-screen');
  screen.hidden = false;
  document.documentElement.classList.add('pin-configured');
  document.getElementById('pin-screen-title').textContent = 'إدخال رمز الدخول';
  document.getElementById('pin-unlock-input').hidden = false;
  document.querySelector('#pin-unlock-form button[type="submit"]').hidden = false;
  document.getElementById('pin-unlock-error').textContent = '';
  document.getElementById('pin-unlock-input').focus();
}

function saveTrips(trips = state.trips) {
  writeStoredJson(STORAGE_KEYS.TRIPS, trips);
}

function saveClients(clients = state.clients) {
  writeStoredJson(STORAGE_KEYS.CLIENTS, clients);
}

function saveTrucks(trucks = state.trucks) {
  writeStoredJson(STORAGE_KEYS.TRUCKS, trucks);
}

function saveAccounts(accounts = state.accounts) {
  writeStoredJson(STORAGE_KEYS.ACCOUNTS, accounts);
}

function writeStoredJson(key, value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') throw new TypeError('تعذر تحويل البيانات إلى صيغة قابلة للتخزين.');
  } catch (error) {
    reportStorageError('write', error);
    throw error;
  }
  writeStoredValue(key, serialized);
}

function writeStoredValue(key, value) {
  if (unreadableStorageKeys.has(key)) {
    const error = new Error('لن يتم استبدال بيانات تعذر تحميلها أو تحليلها.');
    reportStorageError('write', error);
    throw error;
  }

  try {
    localStorage.setItem(key, value);
  } catch (error) {
    reportStorageError('write', error);
    throw error;
  }
}

function removeStoredValue(key) {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    reportStorageError('remove', error);
    throw error;
  }
}

function maybeShowBackupReminder() {
  const now = Date.now();

  let lastReminder;
  try {
    lastReminder = Number(readStoredValue(BACKUP_REMINDER_KEY));
  } catch (error) {
    console.error('تعذر التحقق من تذكير النسخ الاحتياطي:', error);
    return;
  }

  if (Number.isFinite(lastReminder) && lastReminder > 0 && now - lastReminder < BACKUP_REMINDER_INTERVAL) return;

  showToast('تذكير ودي: نزّل نسخة احتياطية من بياناتك لحمايتها.', 'info');
  try {
    writeStoredJson(BACKUP_REMINDER_KEY, now);
  } catch (error) {
    console.error('تعذر حفظ موعد تذكير النسخ الاحتياطي:', error);
  }
}

/* =========================================================
   تهيئة الواجهة والحقول الافتراضية
   ========================================================= */

function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getCurrentMonthString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function initFormDefaults() {
  const dateInput = document.getElementById('date-input');
  const editDateInput = document.getElementById('edit-date-input');
  const filterMonth = document.getElementById('filter-month');
  const stmtMonth = document.getElementById('statement-month-select');
  const priceInput = document.getElementById('price-input');
  const materialSelect = document.getElementById('material-select');

  const today = getTodayString();
  const currentMonth = getCurrentMonthString();

  if (dateInput) dateInput.value = today;
  if (editDateInput) editDateInput.value = today;
  if (filterMonth) filterMonth.value = currentMonth;
  if (stmtMonth) stmtMonth.value = currentMonth;

  if (priceInput) {
    const currentMatName = materialSelect?.value || state.materials[0]?.name;
    const currentMat = state.materials.find(m => m.name === currentMatName) || state.materials[0];
    if (currentMat) priceInput.value = currentMat.defaultPrice;
  }
  updateRealtimeTotal();
}

function updateRealtimeTotal() {
  const countInput = document.getElementById('count-input');
  const priceInput = document.getElementById('price-input');
  const totalDisplay = document.getElementById('total-amount-display');
  if (!countInput || !priceInput || !totalDisplay) return;

  const count = parseFloat(countInput.value) || 0;
  const price = parseFloat(priceInput.value) || 0;
  const total = count * price;

  totalDisplay.textContent = Number.isInteger(total)
    ? total.toLocaleString('ar-SA')
    : total.toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// إنشاء شرائح الاختيار السريع للمواد (Quick Chips)
function initQuickChips() {
  const container = document.getElementById('quick-chips-container');
  if (!container) return;

  container.innerHTML = '';
  const selectedMaterial = document.getElementById('material-select')?.value;
  getClientMaterials(document.getElementById('client-select')?.value).forEach((item, index) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    const isSelected = item.name === selectedMaterial || (!selectedMaterial && index === 0);
    chip.className = `quick-chip px-3 py-1.5 rounded-lg text-xs font-bold border flex items-center gap-1.5 transition ${
      isSelected
        ? 'bg-rose-50 text-rose-700 border-rose-300 ring-2 ring-rose-400' 
        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
    }`;
    chip.setAttribute('data-material', item.name);
    const icon = document.createElement('i');
    icon.className = `fa-solid ${item.icon} text-[11px] opacity-75`;
    const label = document.createElement('span');
    label.textContent = item.name;
    chip.append(icon, label);

    chip.addEventListener('click', () => {
      selectMaterial(item.name);
    });

    container.appendChild(chip);
  });
}

function selectMaterial(materialName) {
  const select = document.getElementById('material-select');
  if (select) {
    select.value = materialName;
  }

  // تحديث تمييز الشريحة النشطة
  document.querySelectorAll('#quick-chips-container .quick-chip').forEach(btn => {
    if (btn.getAttribute('data-material') === materialName) {
      btn.classList.add('bg-brand-600', 'text-white', 'border-brand-600', 'ring-2', 'ring-brand-400');
      btn.classList.remove('bg-white', 'text-slate-700', 'border-slate-200', 'bg-rose-50', 'text-rose-700', 'border-rose-300', 'ring-rose-400');
    } else {
      btn.classList.remove('bg-brand-600', 'text-white', 'border-brand-600', 'ring-2', 'ring-brand-400');
      btn.classList.add('bg-white', 'text-slate-700', 'border-slate-200');
    }
  });

  // ملء السعر الافتراضي تلقائياً مع السماح بالتعديل
  applySelectedQuickMaterial();

  // توجيه المؤشر لحقل السيارة
  const truckInput = document.getElementById('truck-input');
  if (truckInput) truckInput.focus();
}

function getClientCatalogItem(client, materialName) {
  return state.clientCatalogs[client]?.find(item => item.name === materialName) || null;
}

function getClientMaterials(client) {
  const configuredMaterials = state.clientCatalogs[client];
  if (configuredMaterials?.length) {
    return configuredMaterials.map(material => ({
      ...material,
      icon: 'fa-cubes-stacked',
      badgeClass: 'badge-other'
    }));
  }
  return state.materials;
}

function applySelectedQuickMaterial() {
  const client = document.getElementById('client-select')?.value || '';
  const materialName = document.getElementById('material-select')?.value || '';
  const catalogItem = getClientCatalogItem(client, materialName);
  const material = getClientMaterials(client).find(item => item.name === materialName);
  const unit = catalogItem?.unit || material?.unit || 'رد';
  const countUnitLabel = document.getElementById('count-unit-label');
  const priceUnitLabel = document.getElementById('price-unit-label');
  if (countUnitLabel) countUnitLabel.textContent = unit;
  if (priceUnitLabel) priceUnitLabel.textContent = unit;

  const priceInput = document.getElementById('price-input');
  if (material && priceInput) {
    priceInput.value = material.defaultPrice;
    updateRealtimeTotal();
  }
}

function renderQuickMaterialSelect() {
  const select = document.getElementById('material-select');
  if (!select) return;
  const currentValue = select.value;
  const materials = getClientMaterials(document.getElementById('client-select')?.value || '');
  select.innerHTML = '';

  if (!materials.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'لا توجد مواد متاحة';
    select.appendChild(option);
  } else {
    materials.forEach(material => {
      const option = document.createElement('option');
      option.value = material.name;
      option.textContent = material.name;
      select.appendChild(option);
    });
    select.value = materials.some(material => material.name === currentValue)
      ? currentValue
      : materials[0].name;
  }
  applySelectedQuickMaterial();
  initQuickChips();
}

function renderEditMaterialSelectForClient(client, preserveMaterial = '') {
  const select = document.getElementById('edit-material-select');
  if (!select) return;
  const materials = [...getClientMaterials(client)];
  if (preserveMaterial && !materials.some(item => item.name === preserveMaterial)) {
    materials.push({ name: preserveMaterial, defaultPrice: 0, unit: 'رد' });
  }
  select.replaceChildren();
  materials.forEach(material => {
    const option = document.createElement('option');
    option.value = material.name;
    option.textContent = material.name;
    select.appendChild(option);
  });
  if (materials.some(item => item.name === preserveMaterial)) {
    select.value = preserveMaterial;
  } else if (materials.length) {
    select.selectedIndex = 0;
  }
}

function renderMaterialSelects() {
  const filterSelect = document.getElementById('filter-material');
  const editSelect = document.getElementById('edit-material-select');
  const currentFilterValue = filterSelect?.value || '';
  const currentEditValue = editSelect?.value || '';
  const historicalMaterials = [...new Set(state.trips.map(trip => trip.material).filter(Boolean))]
    .filter(name => !state.materials.some(material => material.name === name))
    .map(name => ({ name, defaultPrice: 0 }));

  const fillSelect = (select, materials, placeholder, currentValue) => {
    if (!select) return;
    select.innerHTML = '';
    if (placeholder) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = placeholder;
      select.appendChild(option);
    }
    materials.forEach(material => {
      const option = document.createElement('option');
      option.value = material.name;
      option.textContent = material.name;
      select.appendChild(option);
    });
    const value = currentValue;
    if (value && Array.from(select.options).some(option => option.value === value)) {
      select.value = value;
    } else if (!placeholder && select.options.length) {
      select.selectedIndex = 0;
    }
  };

  fillSelect(filterSelect, [...state.materials, ...historicalMaterials], 'كل المواد والخدمات', currentFilterValue);
  fillSelect(editSelect, [...state.materials, ...historicalMaterials], 'لا توجد مواد مسجلة', currentEditValue);
  renderQuickMaterialSelect();
}

function renderClientSelects() {
  const selects = [
    document.getElementById('client-select'),
    document.getElementById('filter-client'),
    document.getElementById('statement-client-select'),
    document.getElementById('edit-client-select'),
    document.getElementById('account-client-input'),
    document.getElementById('client-catalog-client-select')
  ];

  selects.forEach(select => {
    if (!select) return;
    const currentVal = select.value;
    const isFilter = select.id === 'filter-client';

    const placeholder = isFilter
      ? 'كل العملاء'
      : select.id === 'statement-client-select' || select.id === 'account-client-input'
        ? 'اختر العميل'
        : select.id === 'client-catalog-client-select'
          ? 'اختر العميل لتخصيص أسعاره'
        : 'أضف عميلاً من إدارة العملاء أولاً';
    select.innerHTML = `<option value="">${placeholder}</option>`;

    state.clients.forEach(client => {
      const opt = document.createElement('option');
      opt.value = client;
      opt.textContent = client;
      select.appendChild(opt);
    });

    if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
      select.value = currentVal;
    }
  });

  renderQuickMaterialSelect();
  renderClientsModalList();
  renderClientCatalogList();
}

function renderTruckSuggestions() {
  const datalist = document.getElementById('truck-suggestions');
  if (!datalist) return;

  // جمع الشاحنات المحفوظة والسيارات التي ظهرت في سجل النقلات.
  const allTrucks = new Set([...state.trucks, ...state.trips.map(t => t.truck)]);

  datalist.innerHTML = '';
  allTrucks.forEach(truck => {
    if (!truck) return;
    const opt = document.createElement('option');
    opt.value = truck;
    datalist.appendChild(opt);
  });
}

function renderClientsModalList() {
  const list = document.getElementById('clients-list');
  if (!list) return;

  list.innerHTML = '';
  state.clients.forEach(client => {
    const li = document.createElement('li');
    li.className = 'px-3 py-2.5 flex items-center justify-between text-xs font-semibold text-slate-800';
    const details = document.createElement('div');
    details.className = 'min-w-0 flex flex-1 items-center gap-2';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-user-check text-emerald-500';
    const name = document.createElement('span');
    name.className = 'truncate';
    name.textContent = client;
    details.append(icon, name);

    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-2';
    const catalogButton = document.createElement('button');
    catalogButton.type = 'button';
    catalogButton.className = 'min-h-10 px-2 text-brand-700 hover:bg-brand-50 rounded-lg';
    catalogButton.title = 'إدارة تسعيرة العميل';
    catalogButton.setAttribute('aria-label', `إدارة تسعيرة العميل ${client}`);
    catalogButton.dataset.clientCatalog = client;
    catalogButton.innerHTML = '<i class="fa-solid fa-tags"></i>';
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'min-w-10 min-h-10 text-rose-700 hover:bg-rose-50 rounded-lg';
    deleteButton.title = 'حذف العميل';
    deleteButton.setAttribute('aria-label', `حذف العميل ${client}`);
    deleteButton.dataset.clientDelete = client;
    deleteButton.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
    actions.append(catalogButton, deleteButton);
    li.append(details, actions);
    list.appendChild(li);
  });
}

function openClientCatalogEditor(client = '') {
  const modal = document.getElementById('client-catalog-modal');
  const clientSelect = document.getElementById('client-catalog-client-select');
  const clientModal = document.getElementById('client-modal');
  if (!clientModal.classList.contains('hidden')) clientModal.classList.add('hidden');
  if (client && state.clients.includes(client)) clientSelect.value = client;
  else if (!state.clients.includes(clientSelect.value)) clientSelect.value = '';
  modal.classList.remove('hidden');
  resetClientCatalogForm();
  renderClientCatalogList();
  if (!clientSelect.value) clientSelect.focus();
}

function renderClientCatalogList() {
  const list = document.getElementById('client-catalog-list');
  if (!list) return;
  list.innerHTML = '';
  const client = document.getElementById('client-catalog-client-select').value;
  const entries = state.clientCatalogs[client] || [];
  if (!entries.length) {
    const empty = document.createElement('tr');
    const message = document.createElement('td');
    empty.className = 'text-center text-slate-500 p-4';
    message.colSpan = 4;
    message.textContent = client
      ? 'لا توجد مواد مخصصة لهذا العميل؛ سيُستخدم الكتالوج العام.'
      : 'اختر عميلاً لعرض أو تخصيص أسعاره.';
    empty.appendChild(message);
    list.appendChild(empty);
    return;
  }

  entries.forEach(item => {
    const row = document.createElement('tr');
    row.className = 'text-slate-800';
    const nameCell = document.createElement('td');
    nameCell.className = 'p-3';
    nameCell.textContent = item.name;
    const unitCell = document.createElement('td');
    unitCell.className = 'p-3';
    unitCell.textContent = item.unit;
    const priceCell = document.createElement('td');
    priceCell.className = 'p-3 text-center font-mono';
    priceCell.textContent = Number(item.defaultPrice).toLocaleString('ar-SA');
    const actionsCell = document.createElement('td');
    actionsCell.className = 'p-2 text-center whitespace-nowrap';
    const actions = document.createElement('div');
    actions.className = 'inline-flex items-center justify-center gap-1';
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'min-w-10 min-h-10 text-brand-700 hover:bg-brand-50 rounded-lg';
    editButton.title = 'تعديل المادة';
    editButton.setAttribute('aria-label', `تعديل مادة ${item.name}`);
    editButton.dataset.catalogEdit = item.name;
    editButton.innerHTML = '<i class="fa-solid fa-pen-to-square"></i><span class="sr-only">تعديل</span>';
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'min-w-10 min-h-10 text-rose-700 hover:bg-rose-50 rounded-lg';
    deleteButton.title = 'حذف المادة';
    deleteButton.setAttribute('aria-label', `حذف مادة ${item.name}`);
    deleteButton.dataset.catalogDelete = item.name;
    deleteButton.innerHTML = '<i class="fa-solid fa-trash-can"></i><span class="sr-only">حذف</span>';
    actions.append(editButton, deleteButton);
    actionsCell.appendChild(actions);
    row.append(nameCell, unitCell, priceCell, actionsCell);
    list.appendChild(row);
  });
}

function resetClientCatalogForm() {
  const form = document.getElementById('client-catalog-form');
  if (form) form.reset();
  document.getElementById('client-catalog-unit').value = 'رد';
  state.editingCatalogItem = '';
  document.getElementById('save-client-catalog-item-btn').innerHTML =
    '<i class="fa-solid fa-plus"></i><span>إضافة للتسعيرة</span>';
  document.getElementById('cancel-client-catalog-edit-btn').classList.add('hidden');
}

function closeClientCatalogModal() {
  document.getElementById('client-catalog-modal').classList.add('hidden');
  resetClientCatalogForm();
}

function handleSaveClientCatalogItem(event) {
  event.preventDefault();
  const client = document.getElementById('client-catalog-client-select').value;
  if (!state.clients.includes(client)) {
    showToast('اختر عميلاً صالحاً لإدارة تسعيرته.', 'error');
    return;
  }
  const name = document.getElementById('client-catalog-material').value.trim();
  const unit = document.getElementById('client-catalog-unit').value.trim();
  const defaultPrice = Number(document.getElementById('client-catalog-price').value);
  if (!name || !unit || !Number.isFinite(defaultPrice) || defaultPrice < 0) {
    showToast('أدخل مادة ووحدة وسعراً افتراضياً صالحاً.', 'error');
    return;
  }

  const entries = [...(state.clientCatalogs[client] || [])];
  const existingIndex = entries.findIndex(item => item.name === name);
  const editingIndex = state.editingCatalogItem
    ? entries.findIndex(item => item.name === state.editingCatalogItem)
    : -1;
  if (existingIndex !== -1 && existingIndex !== editingIndex) {
    showToast('هذه المادة مسجلة بالفعل في تسعيرة العميل.', 'warning');
    return;
  }
  const catalogItem = { name, unit, defaultPrice };
  if (editingIndex >= 0) entries[editingIndex] = catalogItem;
  else entries.push(catalogItem);

  const updatedCatalogs = { ...state.clientCatalogs, [client]: entries };
  try {
    writeStoredJson(STORAGE_KEYS.CLIENT_CATALOGS, updatedCatalogs);
  } catch (error) {
    console.error('تعذر حفظ تسعيرة العميل:', error);
    return;
  }
  state.clientCatalogs = updatedCatalogs;
  resetClientCatalogForm();
  renderClientCatalogList();
  renderQuickMaterialSelect();
  showToast('تم حفظ تسعيرة العميل بنجاح.', 'success');
}

function handleClientCatalogAction(event) {
  const button = event.target.closest('button[data-catalog-edit], button[data-catalog-delete]');
  if (!button) return;
  const name = button.dataset.catalogEdit || button.dataset.catalogDelete;
  const client = document.getElementById('client-catalog-client-select').value;
  const entries = state.clientCatalogs[client] || [];
  const item = entries.find(entry => entry.name === name);
  if (!item) return;

  if (button.dataset.catalogEdit) {
    state.editingCatalogItem = item.name;
    document.getElementById('client-catalog-material').value = item.name;
    document.getElementById('client-catalog-unit').value = item.unit;
    document.getElementById('client-catalog-price').value = item.defaultPrice;
    document.getElementById('save-client-catalog-item-btn').innerHTML =
      '<i class="fa-solid fa-floppy-disk"></i><span>حفظ التعديل</span>';
    document.getElementById('cancel-client-catalog-edit-btn').classList.remove('hidden');
    document.getElementById('client-catalog-material').focus();
    return;
  }
  if (!confirm(`هل تريد حذف "${item.name}" من تسعيرة هذا العميل؟`)) return;
  const updatedEntries = entries.filter(entry => entry.name !== item.name);
  const updatedCatalogs = { ...state.clientCatalogs };
  if (updatedEntries.length) updatedCatalogs[client] = updatedEntries;
  else delete updatedCatalogs[client];
  try {
    writeStoredJson(STORAGE_KEYS.CLIENT_CATALOGS, updatedCatalogs);
  } catch (error) {
    console.error('تعذر حذف مادة من تسعيرة العميل:', error);
    return;
  }
  state.clientCatalogs = updatedCatalogs;
  if (state.editingCatalogItem === item.name) resetClientCatalogForm();
  renderClientCatalogList();
  renderQuickMaterialSelect();
  showToast('تم حذف المادة من تسعيرة العميل.', 'info');
}

/* =========================================================
   إدارة الأحداث وعناصر التحكم
   ========================================================= */

function initEventListeners() {
  const tripsTbody = document.getElementById('trips-tbody');
  if (tripsTbody) {
    tripsTbody.addEventListener('click', event => {
      const button = event.target.closest('button[data-trip-action]');
      if (!button || !tripsTbody.contains(button)) return;
      const { tripAction, tripId } = button.dataset;
      if (tripAction === 'delete') deleteTrip(tripId);
      if (tripAction === 'edit') window.openEditModal(tripId);
    });
  }

  const accountsTbody = document.getElementById('accounts-tbody');
  if (accountsTbody) {
    accountsTbody.addEventListener('click', event => {
      const button = event.target.closest('button[data-account-action]');
      if (!button || !accountsTbody.contains(button)) return;
      const { accountAction, accountId, transactionId } = button.dataset;
      const account = state.accounts.find(item => item.id === accountId);
      if (!account) return;

      if (accountAction === 'debt') startAccountTransaction(account.client, 'debt');
      if (accountAction === 'payment') startAccountTransaction(account.client, 'payment');
      if (accountAction === 'statement') openCustomerStatement(accountId);
      if (accountAction === 'delete') deleteAccount(accountId);
      if (accountAction === 'history') toggleAccountHistory(account, button.closest('tr'));
      if (accountAction === 'delete-transaction') deleteAccountTransaction(accountId, transactionId);
    });
  }

  const clientsList = document.getElementById('clients-list');
  if (clientsList) {
    clientsList.addEventListener('click', event => {
      const button = event.target.closest('button[data-client-delete]');
      if (button && clientsList.contains(button)) deleteClient(button.dataset.clientDelete);
      const catalogButton = event.target.closest('button[data-client-catalog]');
      if (catalogButton && clientsList.contains(catalogButton)) {
        openClientCatalogEditor(catalogButton.dataset.clientCatalog);
      }
    });
  }

  const pinSettingsBtn = document.getElementById('pin-settings-btn');
  const lockAppBtn = document.getElementById('lock-app-btn');
  const pinSettingsForm = document.getElementById('pin-settings-form');
  const removePinBtn = document.getElementById('remove-pin-btn');
  const closePinSettingsBtn = document.getElementById('close-pin-settings-btn');

  if (pinSettingsBtn) pinSettingsBtn.addEventListener('click', openPinSettings);
  if (lockAppBtn) lockAppBtn.addEventListener('click', lockApplication);
  if (pinSettingsForm) pinSettingsForm.addEventListener('submit', handleSavePinSettings);
  if (removePinBtn) removePinBtn.addEventListener('click', handleRemovePin);
  if (closePinSettingsBtn) closePinSettingsBtn.addEventListener('click', closePinSettings);

  // نموذج حفظ النقلة السريعة
  const tripForm = document.getElementById('trip-form');
  if (tripForm) {
    tripForm.addEventListener('submit', handleSaveTrip);
  }

  // تغيير المادة من القائمة المنسدلة يزامن الشريحة النشطة
  const matSelect = document.getElementById('material-select');
  if (matSelect) {
    matSelect.addEventListener('change', (e) => {
      selectMaterial(e.target.value);
    });
  }
  const tripClientSelect = document.getElementById('client-select');
  if (tripClientSelect) {
    tripClientSelect.addEventListener('change', renderQuickMaterialSelect);
  }

  // أزرار زيادة ونقصان عدد الردود
  const btnInc = document.getElementById('btn-increase-count');
  const btnDec = document.getElementById('btn-decrease-count');
  const countInput = document.getElementById('count-input');
  const priceInput = document.getElementById('price-input');

  if (countInput) {
    countInput.addEventListener('input', updateRealtimeTotal);
    countInput.addEventListener('change', updateRealtimeTotal);
  }
  if (priceInput) {
    priceInput.addEventListener('input', updateRealtimeTotal);
    priceInput.addEventListener('change', updateRealtimeTotal);
  }

  if (btnInc && countInput) {
    btnInc.addEventListener('click', () => {
      countInput.value = Math.max(1, (parseInt(countInput.value, 10) || 1) + 1);
      updateRealtimeTotal();
    });
  }
  if (btnDec && countInput) {
    btnDec.addEventListener('click', () => {
      countInput.value = Math.max(1, (parseInt(countInput.value, 10) || 1) - 1);
      updateRealtimeTotal();
    });
  }

  // مستمعات نافذة التعديل لحساب الإجمالي اللحظي
  const editCountInput = document.getElementById('edit-count-input');
  const editPriceInput = document.getElementById('edit-price-input');
  const editMatSelect = document.getElementById('edit-material-select');

  if (editCountInput) {
    editCountInput.addEventListener('input', updateEditModalTotal);
    editCountInput.addEventListener('change', updateEditModalTotal);
  }
  if (editPriceInput) {
    editPriceInput.addEventListener('input', updateEditModalTotal);
    editPriceInput.addEventListener('change', updateEditModalTotal);
  }
  if (editMatSelect) {
    editMatSelect.addEventListener('change', (e) => {
      const selectedClient = document.getElementById('edit-client-select').value;
      const mat = getClientCatalogItem(selectedClient, e.target.value)
        || state.materials.find(m => m.name === e.target.value);
      if (mat && editPriceInput) {
        editPriceInput.value = mat.defaultPrice;
        updateEditModalTotal();
      }
    });
  }
  const editClientSelect = document.getElementById('edit-client-select');
  if (editClientSelect) {
    editClientSelect.addEventListener('change', () => {
      renderEditMaterialSelectForClient(editClientSelect.value);
      const item = getClientCatalogItem(editClientSelect.value, editMatSelect?.value)
        || state.materials.find(material => material.name === editMatSelect?.value);
      if (item && editPriceInput) {
        editPriceInput.value = item.defaultPrice;
        updateEditModalTotal();
      }
    });
  }

  // زر مسح الحقول السريع
  const quickResetBtn = document.getElementById('quick-reset-btn');
  if (quickResetBtn) {
    quickResetBtn.addEventListener('click', resetTripForm);
  }

  // التبويبات
  const tabRecordsBtn = document.getElementById('tab-records-btn');
  const tabMonthlyBtn = document.getElementById('tab-monthly-btn');
  const tabAccountsBtn = document.getElementById('tab-accounts-btn');
  if (tabRecordsBtn) tabRecordsBtn.addEventListener('click', () => switchTab('records'));
  if (tabMonthlyBtn) tabMonthlyBtn.addEventListener('click', () => switchTab('monthly'));
  if (tabAccountsBtn) tabAccountsBtn.addEventListener('click', () => switchTab('accounts'));

  const accountForm = document.getElementById('account-form');
  const accountClientInput = document.getElementById('account-client-input');
  const accountAmountInput = document.getElementById('account-amount-input');
  const accountTypeInput = document.getElementById('account-type-input');
  const accountResetBtn = document.getElementById('account-reset-btn');
  if (accountForm) accountForm.addEventListener('submit', handleSaveAccount);
  if (accountResetBtn) accountResetBtn.addEventListener('click', resetAccountForm);
  if (accountClientInput) accountClientInput.addEventListener('change', updateAccountRemainingPreview);
  if (accountAmountInput) accountAmountInput.addEventListener('input', updateAccountRemainingPreview);
  if (accountTypeInput) accountTypeInput.addEventListener('change', updateAccountRemainingPreview);

  // فلاتر جدول النقلات
  const filterClient = document.getElementById('filter-client');
  const filterMaterial = document.getElementById('filter-material');
  const filterMonth = document.getElementById('filter-month');
  const searchInput = document.getElementById('search-input');
  const resetFiltersBtn = document.getElementById('reset-filters-btn');

  if (filterClient) filterClient.addEventListener('change', handleFilterChange);
  if (filterMaterial) filterMaterial.addEventListener('change', handleFilterChange);
  if (filterMonth) filterMonth.addEventListener('change', handleFilterChange);
  if (searchInput) searchInput.addEventListener('input', handleFilterChange);
  if (resetFiltersBtn) resetFiltersBtn.addEventListener('click', resetFilters);

  // أزرار العمليات
  const exportCsvBtn = document.getElementById('export-csv-btn');
  const printRecordsBtn = document.getElementById('print-records-btn');
  const clearAllBtn = document.getElementById('clear-all-btn');

  if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportToCSV);
  if (printRecordsBtn) printRecordsBtn.addEventListener('click', () => window.print());
  if (clearAllBtn) clearAllBtn.addEventListener('click', handleClearAll);

  // كشف الحساب الشهري
  const generateStmtBtn = document.getElementById('generate-statement-btn');
  const printStmtBtn = document.getElementById('print-statement-btn');

  if (generateStmtBtn) generateStmtBtn.addEventListener('click', renderStatementView);
  if (printStmtBtn) printStmtBtn.addEventListener('click', () => window.print());

  const customerStatementModal = document.getElementById('customer-statement-modal');
  const printCustomerStatementBtn = document.getElementById('print-customer-statement-btn');
  const closeCustomerStatementBtn = document.getElementById('close-customer-statement-btn');
  if (printCustomerStatementBtn) printCustomerStatementBtn.addEventListener('click', printCustomerStatement);
  if (closeCustomerStatementBtn) closeCustomerStatementBtn.addEventListener('click', closeCustomerStatement);
  if (customerStatementModal) {
    customerStatementModal.addEventListener('click', event => {
      if (event.target === customerStatementModal) closeCustomerStatement();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !customerStatementModal.hidden) closeCustomerStatement();
    });
    window.addEventListener('afterprint', () => {
      document.body.classList.remove('printing-customer-statement');
    });
  }

  // إدارة العملاء
  const openClientModalBtn = document.getElementById('open-client-modal-btn');
  const quickAddClientBtn = document.getElementById('quick-add-client-btn');
  const closeClientModalBtn = document.getElementById('close-client-modal-btn');
  const doneClientModalBtn = document.getElementById('done-client-modal-btn');
  const addClientForm = document.getElementById('add-client-form');

  if (openClientModalBtn) openClientModalBtn.addEventListener('click', openClientModal);
  if (quickAddClientBtn) quickAddClientBtn.addEventListener('click', openClientModal);
  if (closeClientModalBtn) closeClientModalBtn.addEventListener('click', closeClientModal);
  if (doneClientModalBtn) doneClientModalBtn.addEventListener('click', closeClientModal);
  if (addClientForm) addClientForm.addEventListener('submit', handleAddClient);
  const clientCatalogForm = document.getElementById('client-catalog-form');
  const cancelCatalogEditBtn = document.getElementById('cancel-client-catalog-edit-btn');
  const clientCatalogList = document.getElementById('client-catalog-list');
  const openClientCatalogModalBtn = document.getElementById('open-client-catalog-modal-btn');
  const clientCatalogClientSelect = document.getElementById('client-catalog-client-select');
  const closeClientCatalogModalBtn = document.getElementById('close-client-catalog-modal-btn');
  const doneClientCatalogModalBtn = document.getElementById('done-client-catalog-modal-btn');
  const clientCatalogModal = document.getElementById('client-catalog-modal');
  if (openClientCatalogModalBtn) openClientCatalogModalBtn.addEventListener('click', () => openClientCatalogEditor());
  if (closeClientCatalogModalBtn) closeClientCatalogModalBtn.addEventListener('click', closeClientCatalogModal);
  if (doneClientCatalogModalBtn) doneClientCatalogModalBtn.addEventListener('click', closeClientCatalogModal);
  if (clientCatalogModal) {
    clientCatalogModal.addEventListener('click', event => {
      if (event.target === clientCatalogModal) closeClientCatalogModal();
    });
  }
  if (clientCatalogClientSelect) {
    clientCatalogClientSelect.addEventListener('change', () => {
      resetClientCatalogForm();
      renderClientCatalogList();
    });
  }
  if (clientCatalogForm) clientCatalogForm.addEventListener('submit', handleSaveClientCatalogItem);
  if (cancelCatalogEditBtn) cancelCatalogEditBtn.addEventListener('click', resetClientCatalogForm);
  if (clientCatalogList) {
    clientCatalogList.addEventListener('click', handleClientCatalogAction);
  }

  // نافذة تعديل النقلة
  const closeEditModalBtn = document.getElementById('close-edit-modal-btn');
  const cancelEditBtn = document.getElementById('cancel-edit-btn');
  const editTripForm = document.getElementById('edit-trip-form');

  if (closeEditModalBtn) closeEditModalBtn.addEventListener('click', closeEditModal);
  if (cancelEditBtn) cancelEditBtn.addEventListener('click', closeEditModal);
  if (editTripForm) editTripForm.addEventListener('submit', handleUpdateTrip);

  // النسخ الاحتياطي والاستعادة
  const backupBtn = document.getElementById('backup-btn');
  const restoreBtn = document.getElementById('restore-btn');
  const restoreInput = document.getElementById('restore-input');

  if (backupBtn) backupBtn.addEventListener('click', handleBackup);
  if (restoreBtn && restoreInput) {
    restoreBtn.addEventListener('click', () => restoreInput.click());
    restoreInput.addEventListener('change', handleRestore);
  }
}

/* =========================================================
   إجراءات النموذج وحفظ النقلة
   ========================================================= */

function handleSaveTrip(e) {
  e.preventDefault();

  const client = document.getElementById('client-select').value.trim();
  const material = document.getElementById('material-select').value.trim();
  const truck = document.getElementById('truck-input').value.trim();
  const date = document.getElementById('date-input').value;
  const count = parseInt(document.getElementById('count-input').value, 10) || 1;
  const price = parseFloat(document.getElementById('price-input').value) || 0;
  const total = count * price;
  const notes = document.getElementById('notes-input').value.trim();

  if (!client || !material || !date) {
    showToast('يرجى ملء جميع الحقول الإلزامية!', 'error');
    return;
  }

  const newTrip = {
    id: 'trip_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    date,
    client,
    material,
    unit: getClientMaterials(client).find(item => item.name === material)?.unit || 'رد',
    truck,
    count,
    price,
    total,
    notes,
    createdAt: new Date().toISOString()
  };

  const updatedTrips = [newTrip, ...state.trips];
  try {
    saveTrips(updatedTrips);
  } catch (error) {
    console.error('تعذر حفظ النقلة:', error);
    return;
  }
  state.trips = updatedTrips;

  // حفظ الشاحنة في قائمة الاقتراحات إذا كانت جديدة
  if (truck && !state.trucks.includes(truck)) {
    const updatedTrucks = [...state.trucks, truck];
    try {
      writeStoredJson(STORAGE_KEYS.TRUCKS, updatedTrucks);
      state.trucks = updatedTrucks;
    } catch (error) {
      console.error('تعذر حفظ الشاحنة ضمن الاقتراحات:', error);
    }
    renderTruckSuggestions();
  }

  showToast(`تم حفظ نقلة (${material}) بقيمة [${total.toLocaleString('ar-SA')} ر.س] بنجاح!`, 'success');

  // تنظيف الحقول مع الاحتفاظ بالتاريخ والعميل لتسريع الإدخال المتكرر
  document.getElementById('truck-input').value = '';
  document.getElementById('notes-input').value = '';
  document.getElementById('count-input').value = '1';
  updateRealtimeTotal();

  // إعادة التركيز على حقل الشاحنة للسرعة القصوى
  document.getElementById('truck-input').focus();

  // تحديث العرض
  renderDashboard();
  renderStatementView();
}

function resetTripForm() {
  document.getElementById('trip-form').reset();
  renderQuickMaterialSelect();
  initFormDefaults();
  selectMaterial(state.materials[0]?.name || '');
  updateRealtimeTotal();
  showToast('تمت إعادة ضبط حقول النموذج', 'info');
}

function normalizeAccounts(accounts) {
  if (!Array.isArray(accounts)) return [];
  return accounts.filter(account =>
    account && typeof account.client === 'string' && account.client.trim()
  ).map(account => {
    const id = typeof account.id === 'string' && account.id
      ? account.id
      : `account_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let transactions;

    if (Array.isArray(account.transactions)) {
      transactions = account.transactions.filter(transaction =>
        transaction &&
        (transaction.type === 'debt' || transaction.type === 'payment') &&
        Number.isFinite(Number(transaction.amount)) &&
        Number(transaction.amount) > 0
      ).map(transaction => ({
        id: typeof transaction.id === 'string' && transaction.id
          ? transaction.id
          : `transaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: transaction.type,
        amount: Number(transaction.amount),
        date: typeof transaction.date === 'string' ? transaction.date : new Date().toISOString()
      }));
    } else {
      const total = Number(account.total);
      const paid = Number(account.paid);
      transactions = [];
      if (Number.isFinite(total) && total > 0) {
        transactions.push({ id: `${id}_opening_debt`, type: 'debt', amount: total, date: new Date().toISOString() });
      }
      if (Number.isFinite(paid) && paid > 0) {
        transactions.push({ id: `${id}_opening_payment`, type: 'payment', amount: paid, date: new Date().toISOString() });
      }
    }

    return {
      id,
      client: account.client.trim(),
      transactions,
      total: transactions.reduce((sum, transaction) => sum + (transaction.type === 'debt' ? transaction.amount : 0), 0),
      paid: transactions.reduce((sum, transaction) => sum + (transaction.type === 'payment' ? transaction.amount : 0), 0)
    };
  });
}

function formatMoney(amount) {
  return Number(amount).toLocaleString('ar-SA', { maximumFractionDigits: 2 });
}

function updateAccountRemainingPreview() {
  const client = document.getElementById('account-client-input').value.trim();
  const amount = Number(document.getElementById('account-amount-input').value) || 0;
  const type = document.getElementById('account-type-input').value;
  const account = state.accounts.find(item => item.client.toLocaleLowerCase('ar') === client.toLocaleLowerCase('ar'));
  const currentBalance = account ? account.total - account.paid : 0;
  const remaining = currentBalance + (type === 'debt' ? amount : -amount);
  const preview = document.getElementById('account-remaining-preview');
  preview.textContent = `${formatMoney(remaining)} ر.س`;
  preview.classList.toggle('text-rose-700', remaining > 0);
  preview.classList.toggle('text-emerald-800', remaining === 0);
  preview.classList.toggle('text-amber-700', remaining < 0);
}

function resetAccountForm() {
  const form = document.getElementById('account-form');
  if (!form) return;

  form.reset();
  document.getElementById('account-client-input').value = '';
  document.getElementById('account-amount-input').value = '';
  updateAccountRemainingPreview();
}

function handleSaveAccount(e) {
  e.preventDefault();
  const client = document.getElementById('account-client-input').value.trim();
  const amount = Number(document.getElementById('account-amount-input').value);
  const type = document.getElementById('account-type-input').value;

  if (!client || !state.clients.includes(client) || !Number.isFinite(amount) || amount <= 0 || (type !== 'debt' && type !== 'payment')) {
    showToast('يرجى إدخال اسم العميل ومبلغ صحيح أكبر من صفر', 'error');
    return;
  }

  const existingAccount = state.accounts.find(item =>
    item.client.toLocaleLowerCase('ar') === client.toLocaleLowerCase('ar')
  );
  const transaction = {
    id: `transaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    amount,
    date: new Date().toISOString()
  };
  const updatedTransactions = existingAccount
    ? [transaction, ...existingAccount.transactions]
    : [transaction];
  const updatedAccount = existingAccount
    ? {
      ...existingAccount,
      transactions: updatedTransactions,
      total: updatedTransactions.reduce((sum, item) => sum + (item.type === 'debt' ? item.amount : 0), 0),
      paid: updatedTransactions.reduce((sum, item) => sum + (item.type === 'payment' ? item.amount : 0), 0)
    }
    : {
      id: `account_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      client,
      total: type === 'debt' ? amount : 0,
      paid: type === 'payment' ? amount : 0,
      transactions: updatedTransactions
    };
  const updatedAccounts = existingAccount
    ? state.accounts.map(item => item.id === existingAccount.id ? updatedAccount : item)
    : [updatedAccount, ...state.accounts];
  try {
    saveAccounts(updatedAccounts);
  } catch (error) {
    console.error('تعذر حفظ معاملة حساب العميل:', error);
    return;
  }
  state.accounts = updatedAccounts;
  renderAccountLedger();
  resetAccountForm();
  showToast(type === 'debt' ? 'تمت إضافة الدين وتحديث الرصيد' : 'تم تسجيل الدفعة وتحديث الرصيد', 'success');
}

function renderAccountLedger() {
  const tbody = document.getElementById('accounts-tbody');
  const placeholder = document.getElementById('no-accounts-placeholder');
  const count = document.getElementById('accounts-count');
  if (!tbody || !placeholder || !count) return;

  tbody.replaceChildren();
  count.textContent = `${state.accounts.length} ${state.accounts.length === 1 ? 'عميل' : 'عملاء'}`;
  placeholder.classList.toggle('hidden', state.accounts.length > 0);

  state.accounts.forEach(account => {
    const remaining = account.total - account.paid;
    const row = document.createElement('tr');
    row.className = 'hover:bg-slate-50 transition';

    const values = [
      { text: account.client, className: 'py-3 px-4 font-bold text-slate-900' },
      { text: `${formatMoney(account.total)} ر.س`, className: 'py-3 px-4 text-center font-semibold text-slate-700 whitespace-nowrap' },
      { text: `${formatMoney(account.paid)} ر.س`, className: 'py-3 px-4 text-center font-semibold text-emerald-700 whitespace-nowrap' },
      { text: `${formatMoney(remaining)} ر.س`, className: `py-3 px-4 text-center font-black whitespace-nowrap ${remaining > 0 ? 'text-rose-700' : 'text-emerald-700'}` }
    ];
    values.forEach(({ text, className }) => {
      const cell = document.createElement('td');
      cell.className = className;
      cell.textContent = text;
      row.appendChild(cell);
    });

    const statusCell = document.createElement('td');
    statusCell.className = 'py-3 px-4 text-center';
    const statusBadge = document.createElement('span');
    statusBadge.className = `inline-flex px-3 py-1 rounded-full text-xs font-bold ${remaining > 0 ? 'bg-rose-50 text-rose-700 border border-rose-200' : remaining < 0 ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}`;
    statusBadge.textContent = remaining > 0 ? 'عليه متبقي' : remaining < 0 ? 'له رصيد' : 'خالص';
    statusCell.appendChild(statusBadge);
    row.appendChild(statusCell);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'py-2 px-3 text-center';
    const actions = document.createElement('div');
    actions.className = 'inline-flex items-center gap-2';
    const debtButton = document.createElement('button');
    debtButton.type = 'button';
    debtButton.className = 'min-h-10 px-3 text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg transition text-xs font-bold whitespace-nowrap';
    debtButton.textContent = 'دين جديد';
    debtButton.dataset.accountAction = 'debt';
    debtButton.dataset.accountId = account.id;
    const paymentButton = document.createElement('button');
    paymentButton.type = 'button';
    paymentButton.className = 'min-h-10 px-3 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition text-xs font-bold whitespace-nowrap';
    paymentButton.textContent = 'تسجيل دفعة';
    paymentButton.dataset.accountAction = 'payment';
    paymentButton.dataset.accountId = account.id;
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'min-w-10 min-h-10 text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg transition';
    deleteButton.title = 'حذف الحساب وسجل معاملاته';
    deleteButton.setAttribute('aria-label', `حذف حساب ${account.client} وسجل معاملاته`);
    deleteButton.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
    deleteButton.dataset.accountAction = 'delete';
    deleteButton.dataset.accountId = account.id;
    const statementButton = document.createElement('button');
    statementButton.type = 'button';
    statementButton.className = 'min-w-10 min-h-10 text-brand-700 bg-brand-50 hover:bg-brand-100 rounded-lg transition';
    statementButton.title = 'عرض وطباعة كشف حساب العميل';
    statementButton.setAttribute('aria-label', `كشف حساب ${account.client}`);
    statementButton.innerHTML = '<i class="fa-solid fa-file-invoice"></i>';
    statementButton.dataset.accountAction = 'statement';
    statementButton.dataset.accountId = account.id;
    actions.append(debtButton, paymentButton, statementButton, deleteButton);
    const historyButton = document.createElement('button');
    historyButton.type = 'button';
    historyButton.className = 'min-h-10 px-3 text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition text-xs font-bold whitespace-nowrap';
    historyButton.textContent = 'سجل المعاملات';
    historyButton.dataset.accountAction = 'history';
    historyButton.dataset.accountId = account.id;
    actions.appendChild(historyButton);
    actionsCell.appendChild(actions);
    row.appendChild(actionsCell);
    tbody.appendChild(row);
  });
}

function openCustomerStatement(accountId) {
  const account = state.accounts.find(item => item.id === accountId);
  if (!account) {
    showToast('تعذر العثور على حساب العميل', 'error');
    return;
  }

  // تبقى رسوم النقلات ضمن كشفها الشهري ولا تُدمج في رصيد الحساب اليدوي.
  const events = [];
  account.transactions.forEach(transaction => {
    events.push({
      date: transaction.date,
      type: transaction.type === 'debt' ? 'دين جديد' : 'دفعة / سداد',
      description: transaction.type === 'debt' ? 'إضافة دين إلى الحساب' : 'دفعة مستلمة من العميل',
      debit: transaction.type === 'debt' ? transaction.amount : 0,
      credit: transaction.type === 'payment' ? transaction.amount : 0
    });
  });

  events.sort((a, b) => {
    const aTime = Date.parse(a.date || '');
    const bTime = Date.parse(b.date || '');
    return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
  });

  document.getElementById('customer-statement-client').textContent = account.client;
  document.getElementById('customer-statement-date').textContent = new Date().toLocaleDateString('ar-SA');
  document.getElementById('customer-statement-count').textContent = events.length.toLocaleString('ar-SA');

  const tbody = document.getElementById('customer-statement-tbody');
  tbody.replaceChildren();
  let totalDebits = 0;
  let totalCredits = 0;
  events.forEach((item, index) => {
    totalDebits += item.debit;
    totalCredits += item.credit;

    const row = document.createElement('tr');
    const numberCell = document.createElement('td');
    numberCell.className = 'statement-number';
    numberCell.textContent = (index + 1).toLocaleString('ar-SA');
    const dateCell = document.createElement('td');
    dateCell.textContent = formatCustomerStatementDate(item.date);
    const descriptionCell = document.createElement('td');
    const description = document.createElement('strong');
    description.textContent = item.type;
    descriptionCell.appendChild(description);
    if (item.description) {
      const details = document.createElement('div');
      details.className = 'customer-statement-details';
      details.textContent = item.description;
      descriptionCell.appendChild(details);
    }
    const debitCell = document.createElement('td');
    debitCell.className = 'statement-money';
    debitCell.textContent = item.debit ? `${formatMoney(item.debit)} ر.س` : '-';
    const creditCell = document.createElement('td');
    creditCell.className = 'statement-money';
    creditCell.textContent = item.credit ? `${formatMoney(item.credit)} ر.س` : '-';
    row.append(numberCell, dateCell, descriptionCell, debitCell, creditCell);
    tbody.appendChild(row);
  });

  if (!events.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'customer-statement-empty';
    cell.textContent = 'لا توجد حركات مسجلة لهذا العميل.';
    row.appendChild(cell);
    tbody.appendChild(row);
  }

  document.getElementById('customer-statement-debits').textContent = `${formatMoney(totalDebits)} ر.س`;
  document.getElementById('customer-statement-credits').textContent = `${formatMoney(totalCredits)} ر.س`;
  document.getElementById('customer-statement-balance').textContent = `${formatMoney(totalDebits - totalCredits)} ر.س`;
  const modal = document.getElementById('customer-statement-modal');
  modal.hidden = false;
  document.getElementById('close-customer-statement-btn').focus();
}

function formatCustomerStatementDate(value) {
  if (!value) return '-';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00`)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('ar-SA');
}

function closeCustomerStatement() {
  document.getElementById('customer-statement-modal').hidden = true;
}

function printCustomerStatement() {
  document.body.classList.add('printing-customer-statement');
  window.print();
}

function startAccountTransaction(client, type) {
  document.getElementById('account-client-input').value = client;
  document.getElementById('account-type-input').value = type;
  updateAccountRemainingPreview();
  const form = document.getElementById('account-form');
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('account-amount-input').focus({ preventScroll: true });
}

function toggleAccountHistory(account, row) {
  const existingHistory = row.nextElementSibling;
  if (existingHistory && existingHistory.dataset.accountHistory === account.id) {
    existingHistory.remove();
    return;
  }

  const historyRow = document.createElement('tr');
  historyRow.dataset.accountHistory = account.id;
  const historyCell = document.createElement('td');
  historyCell.colSpan = 6;
  historyCell.className = 'bg-slate-50 px-4 py-3';
  const historyList = document.createElement('div');
  historyList.className = 'space-y-2';

  if (!account.transactions.length) {
    const emptyMessage = document.createElement('p');
    emptyMessage.className = 'text-xs text-slate-500';
    emptyMessage.textContent = 'لا توجد معاملات مسجلة لهذا الحساب.';
    historyList.appendChild(emptyMessage);
  }

  account.transactions.forEach(transaction => {
    const item = document.createElement('div');
    item.className = 'flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2';
    const description = document.createElement('span');
    description.className = `text-xs font-bold ${transaction.type === 'debt' ? 'text-rose-700' : 'text-emerald-700'}`;
    description.textContent = `${transaction.type === 'debt' ? 'دين جديد' : 'دفعة / سداد'} — ${formatMoney(transaction.amount)} ر.س`;
    const date = document.createElement('time');
    date.className = 'text-[11px] text-slate-500';
    const parsedDate = new Date(transaction.date);
    date.textContent = Number.isNaN(parsedDate.getTime()) ? '-' : parsedDate.toLocaleString('ar-SA');
    date.dateTime = transaction.date;
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'min-h-9 px-3 text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg text-xs font-bold';
    deleteButton.textContent = 'حذف المعاملة';
    deleteButton.dataset.accountAction = 'delete-transaction';
    deleteButton.dataset.accountId = account.id;
    deleteButton.dataset.transactionId = transaction.id;
    item.append(description, date, deleteButton);
    historyList.appendChild(item);
  });

  historyCell.appendChild(historyList);
  historyRow.appendChild(historyCell);
  row.after(historyRow);
}

function deleteAccountTransaction(accountId, transactionId) {
  const account = state.accounts.find(item => item.id === accountId);
  if (!account || !confirm('هل تريد حذف هذه المعاملة وإعادة حساب رصيد العميل؟')) return;
  const updatedAccounts = state.accounts.map(item => {
    if (item.id !== accountId) return item;
    const transactions = item.transactions.filter(transaction => transaction.id !== transactionId);
    return {
      ...item,
      transactions,
      total: transactions.reduce((sum, transaction) => sum + (transaction.type === 'debt' ? transaction.amount : 0), 0),
      paid: transactions.reduce((sum, transaction) => sum + (transaction.type === 'payment' ? transaction.amount : 0), 0)
    };
  });
  try {
    saveAccounts(updatedAccounts);
  } catch (error) {
    console.error('تعذر حفظ حذف المعاملة:', error);
    return;
  }
  state.accounts = updatedAccounts;
  renderAccountLedger();
  showToast('تم حذف المعاملة وإعادة احتساب الرصيد', 'info');
}

function deleteAccount(id) {
  const account = state.accounts.find(item => item.id === id);
  if (!account || !confirm(`هل أنت متأكد من حذف حساب العميل "${account.client}"؟`)) return;
  const updatedAccounts = state.accounts.filter(item => item.id !== id);
  try {
    saveAccounts(updatedAccounts);
  } catch (error) {
    console.error('تعذر حفظ حذف الحساب:', error);
    return;
  }
  state.accounts = updatedAccounts;
  renderAccountLedger();
  showToast('تم حذف حساب العميل', 'info');
}

/* =========================================================
   تحديث لوحة الإحصاءات وجدول النقلات
   ========================================================= */

function renderDashboard() {
  updateStats();
  renderTripsTable();
}

function updateStats() {
  const currentMonthStr = getCurrentMonthString();
  const now = new Date();
  const monthNames = [
    'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
  ];
  const currentMonthName = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;

  const lbl = document.getElementById('stat-current-month-label');
  if (lbl) lbl.textContent = currentMonthName;

  // إجمالي نقلات الشهر الحالي
  const currentMonthTrips = state.trips.filter(t => t.date && t.date.startsWith(currentMonthStr));
  const monthlyClientTripCounts = new Map(state.clients.map(client => [client, 0]));
  currentMonthTrips.forEach(trip => {
    if (monthlyClientTripCounts.has(trip.client)) {
      monthlyClientTripCounts.set(trip.client, monthlyClientTripCounts.get(trip.client) + 1);
    }
  });

  // إجمالي نقلات المخلفات في الشهر الحالي
  const wasteTrips = currentMonthTrips.filter(t => String(t.material || '').includes('مخلفات'));

  document.getElementById('stat-current-month-trips').textContent = `${currentMonthTrips.length}`;
  document.getElementById('stat-waste-trips').textContent = `${wasteTrips.length}`;

  const clientCards = document.getElementById('client-stat-cards');
  if (clientCards) {
    clientCards.replaceChildren();
    state.clients.forEach((client, index) => {
      const tripCount = monthlyClientTripCounts.get(client) || 0;
      const card = document.createElement('div');
      card.className = 'stat-card bg-white rounded-2xl p-4 sm:p-5 border border-slate-200/80 shadow-sm flex items-center justify-between';
      const details = document.createElement('div');
      details.className = 'min-w-0';
      const label = document.createElement('p');
      label.className = 'text-xs sm:text-sm font-semibold text-slate-500 mb-1 truncate';
      label.textContent = client;
      const count = document.createElement('h3');
      count.className = `text-2xl sm:text-3xl font-extrabold ${index % 2 ? 'text-emerald-600' : 'text-amber-600'}`;
      count.textContent = String(tripCount);
      const caption = document.createElement('p');
      caption.className = 'text-xs text-slate-400 mt-1 font-medium';
      caption.textContent = 'نقلة مسجلة هذا الشهر';
      details.append(label, count, caption);
      const icon = document.createElement('div');
      icon.className = `w-12 h-12 rounded-xl ${index % 2 ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'} flex items-center justify-center text-xl`;
      const iconElement = document.createElement('i');
      iconElement.className = 'fa-solid fa-building';
      icon.appendChild(iconElement);
      card.append(details, icon);
      clientCards.appendChild(card);
    });
  }

  // شارة العدد في التبويب
  const badgeCount = document.getElementById('records-badge-count');
  if (badgeCount) badgeCount.textContent = `${state.trips.length}`;
}

function getFilteredTrips() {
  return state.trips.filter(trip => {
    // فلتر العميل
    if (state.filters.client && trip.client !== state.filters.client) {
      return false;
    }
    // فلتر المادة
    if (state.filters.material && trip.material !== state.filters.material) {
      return false;
    }
    // فلتر الشهر
    if (state.filters.month && (!trip.date || !trip.date.startsWith(state.filters.month))) {
      return false;
    }
    // فلتر البحث النصي
    if (state.filters.search) {
      const q = state.filters.search.toLowerCase();
      const matchClient = (trip.client || '').toLowerCase().includes(q);
      const matchMaterial = (trip.material || '').toLowerCase().includes(q);
      const matchTruck = (trip.truck || '').toLowerCase().includes(q);
      const matchNotes = (trip.notes || '').toLowerCase().includes(q);
      if (!matchClient && !matchMaterial && !matchTruck && !matchNotes) {
        return false;
      }
    }
    return true;
  });
}

function renderTripsTable() {
  const tbody = document.getElementById('trips-tbody');
  const noDataPlaceholder = document.getElementById('no-trips-placeholder');
  const shownCount = document.getElementById('shown-trips-count');
  const shownLoads = document.getElementById('shown-trips-loads');

  if (!tbody) return;

  const filtered = getFilteredTrips();

  shownCount.textContent = filtered.length;
  shownLoads.textContent = formatQuantityByUnit(filtered);
  const totalAmount = filtered.reduce((acc, t) => acc + (t.total !== undefined ? t.total : ((t.count || 1) * (t.price || 0))), 0);
  const shownTotalEl = document.getElementById('shown-trips-total');
  if (shownTotalEl) shownTotalEl.textContent = totalAmount.toLocaleString('ar-SA');

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    noDataPlaceholder.classList.remove('hidden');
    return;
  }

  noDataPlaceholder.classList.add('hidden');
  tbody.innerHTML = '';

  filtered.forEach((trip, index) => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50 transition border-b border-slate-100';

    const matInfo = state.materials.find(m => m.name === trip.material) || { badgeClass: 'badge-other', icon: 'fa-truck', defaultPrice: 0 };
    const tripPrice = trip.price !== undefined ? trip.price : (matInfo.defaultPrice || 0);
    const tripTotal = trip.total !== undefined ? trip.total : ((trip.count || 1) * tripPrice);

    tr.innerHTML = `
      <td class="py-3 px-4 text-center font-bold text-slate-400 text-xs">${index + 1}</td>
      <td class="py-3 px-4 font-mono text-slate-700 whitespace-nowrap text-xs font-semibold">
        <i class="fa-regular fa-calendar text-slate-400 ml-1"></i>
        ${escapeHtml(String(trip.date || '—'))}
      </td>
      <td class="py-3 px-4 font-bold text-slate-900">
        ${escapeHtml(trip.client)}
      </td>
      <td class="py-3 px-4">
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${matInfo.badgeClass}">
          <i class="fa-solid ${matInfo.icon} text-[10px]"></i>
          ${escapeHtml(trip.material)}
        </span>
      </td>
      <td class="py-3 px-4 font-bold text-slate-800">
        ${trip.truck ? `<span class="bg-slate-100 border border-slate-200 px-2 py-0.5 rounded text-xs font-mono">${escapeHtml(trip.truck)}</span>` : '<span class="text-slate-400 text-xs">غير محدد</span>'}
      </td>
      <td class="py-3 px-4 text-center font-black text-brand-700">
        ${trip.count || 1} <span class="text-[10px] text-slate-400">${escapeHtml(trip.unit || 'رد')}</span>
      </td>
      <td class="py-3 px-4 text-center font-bold text-slate-700 font-mono whitespace-nowrap text-xs">
        ${tripPrice.toLocaleString('ar-SA')} <span class="text-[10px] text-slate-400">ر.س</span>
      </td>
      <td class="py-3 px-4 text-center font-black text-emerald-700 font-mono whitespace-nowrap text-xs">
        ${tripTotal.toLocaleString('ar-SA')} <span class="text-[10px] text-emerald-600">ر.س</span>
      </td>
      <td class="py-3 px-4 text-xs text-slate-600 max-w-xs truncate" title="${escapeHtml(trip.notes || '')}">
        ${escapeHtml(trip.notes || '-')}
      </td>
      <td class="py-3 px-4 text-center whitespace-nowrap action-buttons">
        <div class="inline-flex items-center gap-1">
          <button type="button" class="p-1.5 text-slate-500 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition" title="تعديل النقلة" data-trip-action="edit" data-trip-id="${escapeHtml(String(trip.id || ''))}">
            <i class="fa-solid fa-pen-to-square text-xs"></i>
          </button>
          <button type="button" class="p-1.5 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition" title="حذف النقلة" data-trip-action="delete" data-trip-id="${escapeHtml(String(trip.id || ''))}">
            <i class="fa-solid fa-trash-can text-xs"></i>
          </button>
        </div>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

function handleFilterChange() {
  state.filters.client = document.getElementById('filter-client').value;
  state.filters.material = document.getElementById('filter-material').value;
  state.filters.month = document.getElementById('filter-month').value;
  state.filters.search = document.getElementById('search-input').value.trim();

  renderTripsTable();
}

function resetFilters() {
  document.getElementById('filter-client').value = '';
  document.getElementById('filter-material').value = '';
  document.getElementById('filter-month').value = '';
  document.getElementById('search-input').value = '';

  state.filters = {
    client: '',
    material: '',
    month: '',
    search: ''
  };

  renderTripsTable();
  showToast('تمت إعادة ضبط فلاتر البحث', 'info');
}

/* =========================================================
   كشف الحساب والملخص الشهري (Corporate Invoicing)
   ========================================================= */

function switchTab(tabName) {
  state.activeTab = tabName;

  const viewRecords = document.getElementById('view-records');
  const viewMonthly = document.getElementById('view-monthly');
  const viewAccounts = document.getElementById('view-accounts');
  const tabRecordsBtn = document.getElementById('tab-records-btn');
  const tabMonthlyBtn = document.getElementById('tab-monthly-btn');
  const tabAccountsBtn = document.getElementById('tab-accounts-btn');

  const views = { records: viewRecords, monthly: viewMonthly, accounts: viewAccounts };
  const buttons = { records: tabRecordsBtn, monthly: tabMonthlyBtn, accounts: tabAccountsBtn };
  Object.entries(views).forEach(([name, view]) => {
    view.classList.toggle('hidden', name !== tabName);
    buttons[name].classList.toggle('border-brand-600', name === tabName);
    buttons[name].classList.toggle('text-brand-700', name === tabName);
    buttons[name].classList.toggle('border-transparent', name !== tabName);
    buttons[name].classList.toggle('text-slate-500', name !== tabName);
  });

  if (tabName === 'monthly') renderStatementView();
  if (tabName === 'accounts') renderAccountLedger();
}

function renderStatementView() {
  const clientSelect = document.getElementById('statement-client-select');
  const monthSelect = document.getElementById('statement-month-select');

  const targetClient = clientSelect ? clientSelect.value : '';
  const targetMonth = monthSelect ? monthSelect.value || getCurrentMonthString() : getCurrentMonthString();

  // تصفية النقلات التابعة لهذا العميل في هذا الشهر
  const tripsForStmt = state.trips.filter(t => {
    const matchClient = t.client === targetClient;
    const matchMonth = targetMonth ? (t.date && t.date.startsWith(targetMonth)) : true;
    return matchClient && matchMonth;
  });

  // فرز حسب التاريخ تصاعدياً
  tripsForStmt.sort((a, b) => (a.date > b.date ? 1 : -1));

  // تحديث الترويسة
  document.getElementById('stmt-client-name').textContent = targetClient || '—';
  document.getElementById('stmt-issued-date').textContent = getTodayString();
  document.getElementById('stmt-reference').textContent = `INV-${targetMonth.replace('-', '')}-${Math.abs(hashString(targetClient)) % 1000}`;

  const periodParts = targetMonth.split('-');
  const monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const monthLabel = periodParts.length === 2 
    ? `${monthNames[parseInt(periodParts[1], 10) - 1]} ${periodParts[0]}`
    : 'جميع الفترات';
  document.getElementById('stmt-period-label').textContent = monthLabel;

  // إجمالي الردود والمبالغ
  const totalAmount = tripsForStmt.reduce((sum, t) => sum + (t.total !== undefined ? t.total : ((t.count || 1) * (t.price || 0))), 0);

  document.getElementById('stmt-total-trips-count').textContent = formatQuantityByUnit(tripsForStmt);
  const stmtTotalAmountEl = document.getElementById('stmt-total-amount');
  if (stmtTotalAmountEl) stmtTotalAmountEl.textContent = `${totalAmount.toLocaleString('ar-SA')} ر.س`;

  // تجميع الإحصائية حسب نوع المادة / الخدمة مع المبالغ
  const breakdown = new Map();
  tripsForStmt.forEach(t => {
    const mat = t.material || 'غير محدد';
    const unit = t.unit || 'رد';
    const c = t.count || 1;
    const p = t.price !== undefined ? t.price : (state.materials.find(m => m.name === mat)?.defaultPrice || 0);
    const itemTotal = t.total !== undefined ? t.total : (c * p);

    const key = JSON.stringify([mat, unit]);
    if (!breakdown.has(key)) {
      breakdown.set(key, { material: mat, unit, count: 0, totalAmount: 0 });
    }
    const entry = breakdown.get(key);
    entry.count += c;
    entry.totalAmount += itemTotal;
  });

  // تعبئة جدول الملخص
  const summaryTbody = document.getElementById('stmt-summary-tbody');
  summaryTbody.innerHTML = '';

  const entries = [...breakdown.values()];
  if (entries.length === 0) {
    summaryTbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400">لا توجد نقلات مسجلة لهذا العميل في الشهر المحدد</td></tr>`;
  } else {
    entries.forEach((data, idx) => {
      const percentage = totalAmount > 0 ? ((data.totalAmount / totalAmount) * 100).toFixed(1) : '0.0';
      const unitPrice = data.count > 0 ? data.totalAmount / data.count : 0;
      const row = document.createElement('tr');
      row.className = idx % 2 === 0 ? 'bg-white' : 'bg-slate-50';
      row.innerHTML = `
        <td class="p-2 border border-slate-200 text-center font-bold text-slate-500">${idx + 1}</td>
        <td class="p-2 border border-slate-200 font-bold text-slate-800">${escapeHtml(data.material)}</td>
        <td class="p-2 border border-slate-200 text-center font-black text-brand-700">${data.count} ${escapeHtml(data.unit)}</td>
        <td class="p-2 border border-slate-200 text-center font-mono font-bold text-slate-700">${unitPrice.toLocaleString('ar-SA')} ر.س</td>
        <td class="p-2 border border-slate-200 text-center font-mono font-black text-emerald-700">${data.totalAmount.toLocaleString('ar-SA')} ر.س</td>
        <td class="p-2 border border-slate-200 text-slate-600 font-mono text-center">${percentage}%</td>
      `;
      summaryTbody.appendChild(row);
    });

    // سطر الإجمالي
    const totalRow = document.createElement('tr');
    totalRow.className = 'bg-slate-200 font-black text-slate-900 border border-slate-300';
    totalRow.innerHTML = `
      <td colspan="2" class="p-2 border border-slate-300 text-center">الإجمالي الكلي</td>
      <td class="p-2 border border-slate-300 text-center text-brand-800 text-sm font-black">${escapeHtml(formatQuantityByUnit(tripsForStmt))}</td>
      <td class="p-2 border border-slate-300 text-center font-bold text-slate-500">-</td>
      <td class="p-2 border border-slate-300 text-center text-emerald-800 text-sm font-black font-mono">${totalAmount.toLocaleString('ar-SA')} ر.س</td>
      <td class="p-2 border border-slate-300 text-center">${totalAmount > 0 ? '100%' : '0%'}</td>
    `;
    summaryTbody.appendChild(totalRow);
  }

  // تعبئة جدول تفاصيل الرحلات
  const detailsTbody = document.getElementById('stmt-details-tbody');
  detailsTbody.innerHTML = '';

  if (tripsForStmt.length === 0) {
    detailsTbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-slate-400">لا توجد تفاصيل لعرضها</td></tr>`;
  } else {
    tripsForStmt.forEach((trip, idx) => {
      const matInfo = state.materials.find(m => m.name === trip.material);
      const tripPrice = trip.price !== undefined ? trip.price : (matInfo ? matInfo.defaultPrice : 0);
      const tripTotal = trip.total !== undefined ? trip.total : ((trip.count || 1) * tripPrice);
      const row = document.createElement('tr');
      row.className = idx % 2 === 0 ? 'bg-white' : 'bg-slate-50';
      row.innerHTML = `
        <td class="p-2 border border-slate-200 text-center font-bold text-slate-400">${idx + 1}</td>
        <td class="p-2 border border-slate-200 font-mono text-slate-800 whitespace-nowrap">${escapeHtml(String(trip.date || '—'))}</td>
        <td class="p-2 border border-slate-200 font-bold text-slate-800">${escapeHtml(trip.material)}</td>
        <td class="p-2 border border-slate-200 font-mono text-slate-700">${escapeHtml(trip.truck || '-')}</td>
        <td class="p-2 border border-slate-200 text-center font-black text-brand-700">${trip.count || 1} ${escapeHtml(trip.unit || 'رد')}</td>
        <td class="p-2 border border-slate-200 text-center font-mono font-bold text-slate-700">${tripPrice.toLocaleString('ar-SA')} ر.س</td>
        <td class="p-2 border border-slate-200 text-center font-mono font-black text-emerald-700">${tripTotal.toLocaleString('ar-SA')} ر.س</td>
        <td class="p-2 border border-slate-200 text-slate-600">${escapeHtml(trip.notes || '-')}</td>
      `;
      detailsTbody.appendChild(row);
    });
  }
}

function formatQuantityByUnit(trips) {
  const totals = new Map();
  trips.forEach(trip => {
    const unit = trip.unit || 'رد';
    totals.set(unit, (totals.get(unit) || 0) + (trip.count || 1));
  });
  if (!totals.size) return '0 رد';
  return [...totals.entries()]
    .map(([unit, count]) => `${count.toLocaleString('ar-SA')} ${unit}`)
    .join(' · ');
}

/* =========================================================
   إدارة العملاء (إضافة وحذف)
   ========================================================= */

function openClientModal() {
  document.getElementById('client-modal').classList.remove('hidden');
  document.getElementById('new-client-name').focus();
}

function closeClientModal() {
  document.getElementById('client-modal').classList.add('hidden');
  document.getElementById('new-client-name').value = '';
}

function handleAddClient(e) {
  e.preventDefault();
  const input = document.getElementById('new-client-name');
  const name = input.value.trim();

  if (!name) return;

  if (state.clients.includes(name)) {
    showToast('هذا العميل مسجل بالفعل!', 'warning');
    return;
  }

  const updatedClients = [...state.clients, name];
  try {
    saveClients(updatedClients);
  } catch (error) {
    console.error('تعذر حفظ العميل الجديد:', error);
    return;
  }
  state.clients = updatedClients;
  renderClientSelects();
  renderDashboard();

  // تحديد العميل الجديد في القائمة الرئيسية فوراً
  document.getElementById('client-select').value = name;
  renderQuickMaterialSelect();

  input.value = '';
  showToast(`تمت إضافة العميل [${name}] بنجاح`, 'success');
}

window.deleteClient = function(name) {
  if (!confirm(`هل أنت متأكد من حذف العميل "${name}" من القائمة؟`)) {
    return;
  }

  if (state.accounts.some(account =>
    account.client.toLocaleLowerCase('ar') === name.toLocaleLowerCase('ar')
  )) {
    showToast('لا يمكن حذف عميل مرتبط بحساب. احذف حسابه أولاً.', 'warning');
    return;
  }

  const updatedClients = state.clients.filter(client => client !== name);
  const hadCatalog = Object.prototype.hasOwnProperty.call(state.clientCatalogs, name);
  const updatedCatalogs = { ...state.clientCatalogs };
  delete updatedCatalogs[name];
  let clientsSaved = false;
  try {
    saveClients(updatedClients);
    clientsSaved = true;
    if (hadCatalog) writeStoredJson(STORAGE_KEYS.CLIENT_CATALOGS, updatedCatalogs);
  } catch (error) {
    console.error('تعذر حفظ حذف العميل:', error);
    if (clientsSaved) {
      try {
        saveClients(state.clients);
      } catch (rollbackError) {
        console.error('تعذر التراجع عن حذف العميل بعد فشل حذف تسعيرته:', rollbackError);
      }
    }
    return;
  }
  state.clients = updatedClients;
  if (hadCatalog) state.clientCatalogs = updatedCatalogs;
  renderClientSelects();
  renderDashboard();
  showToast(`تم حذف العميل [${name}]`, 'info');
};

/* =========================================================
   تعديل وحذف النقلات
   ========================================================= */

function deleteTrip(id) {
  const trip = state.trips.find(t => t.id === id);
  if (!trip) return;

  if (!confirm(`هل أنت متأكد من حذف نقلة "${trip.material}" للعميل "${trip.client}"؟`)) {
    return;
  }

  const updatedTrips = state.trips.filter(t => t.id !== id);
  try {
    saveTrips(updatedTrips);
  } catch (error) {
    console.error('تعذر حفظ حذف النقلة:', error);
    return;
  }
  state.trips = updatedTrips;
  renderDashboard();
  renderStatementView();
  showToast('تم حذف النقلة من السجل', 'info');
}

window.openEditModal = function(id) {
  const trip = state.trips.find(t => t.id === id);
  if (!trip) return;

  const matInfo = state.materials.find(m => m.name === trip.material);
  const catalogItem = getClientCatalogItem(trip.client, trip.material);
  const tripPrice = trip.price !== undefined
    ? trip.price
    : catalogItem?.defaultPrice ?? matInfo?.defaultPrice ?? 0;

  document.getElementById('edit-trip-id').value = trip.id;
  document.getElementById('edit-client-select').value = trip.client;
  renderEditMaterialSelectForClient(trip.client, trip.material);
  document.getElementById('edit-material-select').value = trip.material;
  document.getElementById('edit-truck-input').value = trip.truck || '';
  document.getElementById('edit-date-input').value = trip.date;
  document.getElementById('edit-count-input').value = trip.count || 1;
  document.getElementById('edit-price-input').value = tripPrice;
  document.getElementById('edit-notes-input').value = trip.notes || '';

  updateEditModalTotal();
  document.getElementById('edit-trip-modal').classList.remove('hidden');
};

function updateEditModalTotal() {
  const countEl = document.getElementById('edit-count-input');
  const priceEl = document.getElementById('edit-price-input');
  const displayEl = document.getElementById('edit-total-display');
  if (!countEl || !priceEl || !displayEl) return;
  const count = parseFloat(countEl.value) || 0;
  const price = parseFloat(priceEl.value) || 0;
  const total = count * price;
  displayEl.textContent = `${Number.isInteger(total) ? total.toLocaleString('ar-SA') : total.toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س`;
}

function closeEditModal() {
  document.getElementById('edit-trip-modal').classList.add('hidden');
}

function handleUpdateTrip(e) {
  e.preventDefault();

  const id = document.getElementById('edit-trip-id').value;
  const tripIndex = state.trips.findIndex(t => t.id === id);

  if (tripIndex === -1) return;

  const client = document.getElementById('edit-client-select').value.trim();
  const material = document.getElementById('edit-material-select').value.trim();
  const truck = document.getElementById('edit-truck-input').value.trim();
  const date = document.getElementById('edit-date-input').value;
  const count = parseInt(document.getElementById('edit-count-input').value, 10) || 1;
  const price = parseFloat(document.getElementById('edit-price-input').value) || 0;
  const total = count * price;
  const notes = document.getElementById('edit-notes-input').value.trim();
  const previousTrip = state.trips[tripIndex];
  const unit = getClientCatalogItem(client, material)?.unit
    || state.materials.find(item => item.name === material)?.unit
    || (previousTrip.client === client && previousTrip.material === material ? previousTrip.unit : 'رد');

  const updatedTrips = state.trips.map((trip, index) => index === tripIndex ? {
    ...state.trips[tripIndex],
    client,
    material,
    unit,
    truck,
    date,
    count,
    price,
    total,
    notes,
    updatedAt: new Date().toISOString()
  } : trip);

  try {
    saveTrips(updatedTrips);
  } catch (error) {
    console.error('تعذر حفظ تحديث النقلة:', error);
    return;
  }
  state.trips = updatedTrips;
  closeEditModal();
  renderDashboard();
  renderStatementView();
  showToast('تم تحديث بيانات النقلة بنجاح!', 'success');
}

function handleClearAll() {
  if (state.trips.length === 0) {
    showToast('السجل فارغ بالفعل!', 'warning');
    return;
  }

  if (!confirm(`سيتم حذف جميع النقلات المسجلة (${state.trips.length} نقلة) نهائياً. هل تريد المتابعة؟`)) {
    return;
  }

  try {
    saveTrips([]);
  } catch (error) {
    console.error('تعذر حفظ تفريغ سجل النقلات:', error);
    return;
  }

  state.trips = [];
  renderDashboard();
  renderStatementView();
  showToast('تم تفريغ سجل النقلات بالكامل', 'info');
}

/* =========================================================
   تصدير Excel (CSV مع دعم كامل للغة العربية UTF-8 BOM)
   ========================================================= */

function exportToCSV() {
  const filtered = getFilteredTrips();

  if (filtered.length === 0) {
    showToast('لا توجد بيانات مطابقة لتصديرها!', 'warning');
    return;
  }

  const headers = [...new Set(filtered.flatMap(trip => Object.keys(trip)))];
  const escapeCsvCell = value => {
    if (value === null || value === undefined) return '""';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = filtered.map(trip =>
    headers.map(header => escapeCsvCell(trip[header])).join(',')
  );

  // تضمين BOM لتوافق العربية مع Excel، مع أعمدة مستنتجة من السجلات الحالية.
  const csvContent = '\uFEFF' + [
    headers.map(escapeCsvCell).join(','),
    ...rows
  ].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'تقرير_نقلات_المواد.csv';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);

  showToast(`تم تصدير ${filtered.length} نقلة إلى ملف Excel بنجاح`, 'success');
}

/* =========================================================
   النسخ الاحتياطي والاستعادة (JSON)
   ========================================================= */

function handleBackup() {
  const backupData = {
    version: '1.0',
    exportDate: new Date().toISOString(),
    trips: state.trips,
    clients: state.clients,
    materials: state.materials,
    trucks: state.trucks,
    accounts: state.accounts,
    clientCatalogs: state.clientCatalogs
  };

  const jsonString = JSON.stringify(backupData, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `نسخة_احتياطية_نقليات_${getTodayString()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  try {
    writeStoredJson(BACKUP_REMINDER_KEY, Date.now());
  } catch (error) {
    console.error('تعذر تحديث موعد تذكير النسخ الاحتياطي:', error);
  }

  showToast('تم تنزيل النسخة الاحتياطية من البيانات بنجاح', 'success');
}

function handleRestore(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(event) {
    let data;
    try {
      if (typeof event.target.result !== 'string') throw new TypeError('محتوى الملف ليس نصاً.');
      data = JSON.parse(event.target.result);
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.trips)) {
        throw new TypeError('صيغة الملف غير متوافقة.');
      }
    } catch (error) {
      console.error('تعذر تحليل ملف النسخة الاحتياطية:', error);
      showToast('فشل قراءة الملف: صيغة النسخة الاحتياطية غير صحيحة', 'error');
      return;
    }

    if (!confirm(`تم العثور على ${data.trips.length} نقلة في الملف.\nهل ترغب في استبدال البيانات الحالية بالبيانات المستوردة؟`)) return;

    const importedMaterials = Array.isArray(data.materials)
      ? normalizeMaterials(data.materials)
      : [...state.materials];
    const restoredMaterials = importedMaterials.length ? importedMaterials : getStandardMaterials();
    const restoredClientCatalogs = data.clientCatalogs && typeof data.clientCatalogs === 'object' && !Array.isArray(data.clientCatalogs)
      ? normalizeClientCatalogs(data.clientCatalogs)
      : {};
    const restoredTrips = normalizeTrips(data.trips, restoredMaterials, restoredClientCatalogs);
    const restoredAccounts = Array.isArray(data.accounts)
      ? normalizeAccounts(data.accounts)
      : state.accounts;
    const restoredClients = Array.isArray(data.clients)
      ? data.clients.filter(client => typeof client === 'string' && client.trim()).map(client => client.trim())
      : [...state.clients];
    restoredAccounts.forEach(account => {
      if (!restoredClients.includes(account.client)) restoredClients.push(account.client);
    });
    const restoredTrucks = Array.isArray(data.trucks)
      ? data.trucks.filter(truck => typeof truck === 'string' && truck.trim()).map(truck => truck.trim())
      : state.trucks;
    const storageKeys = [
      STORAGE_KEYS.TRIPS,
      STORAGE_KEYS.CLIENTS,
      STORAGE_KEYS.MATERIALS,
      STORAGE_KEYS.TRUCKS,
      STORAGE_KEYS.ACCOUNTS,
      STORAGE_KEYS.CLIENT_CATALOGS
    ];
    const previousValues = new Map();
    try {
      storageKeys.forEach(key => previousValues.set(key, readStoredValue(key)));
    } catch (error) {
      console.error('تعذر تجهيز استعادة النسخة الاحتياطية:', error);
      return;
    }
    const unreadableBeforeRestore = new Set(
      storageKeys.filter(key => unreadableStorageKeys.has(key))
    );
    storageKeys.forEach(key => unreadableStorageKeys.delete(key));
    const restoredValues = [
      [STORAGE_KEYS.TRIPS, restoredTrips],
      [STORAGE_KEYS.CLIENTS, restoredClients],
      [STORAGE_KEYS.MATERIALS, restoredMaterials],
      [STORAGE_KEYS.TRUCKS, restoredTrucks],
      [STORAGE_KEYS.ACCOUNTS, restoredAccounts],
      [STORAGE_KEYS.CLIENT_CATALOGS, restoredClientCatalogs]
    ];
    const savedKeys = [];

    try {
      restoredValues.forEach(([key, value]) => {
        writeStoredJson(key, value);
        savedKeys.push(key);
      });
    } catch (error) {
      console.error('تعذر حفظ النسخة المستعادة؛ ستُستعاد البيانات السابقة قدر الإمكان:', error);
      savedKeys.reverse().forEach(key => {
        try {
          const previousValue = previousValues.get(key);
          if (previousValue === null) {
            removeStoredValue(key);
          } else {
            writeStoredValue(key, previousValue);
          }
        } catch (rollbackError) {
          console.error(`تعذر التراجع عن استعادة ${key}:`, rollbackError);
        }
      });
      unreadableBeforeRestore.forEach(key => unreadableStorageKeys.add(key));
      return;
    }

    state.trips = restoredTrips;
    state.clients = restoredClients;
    state.materials = restoredMaterials;
    state.trucks = restoredTrucks;
    state.accounts = restoredAccounts;
    state.clientCatalogs = restoredClientCatalogs;
    renderClientSelects();
    renderAccountLedger();
    renderMaterialSelects();
    state.filters.material = document.getElementById('filter-material').value;
    renderTruckSuggestions();
    renderDashboard();
    renderStatementView();

    showToast('تمت استعادة البيانات بنجاح تام!', 'success');
  };
  reader.onerror = () => showToast('تعذر قراءة ملف النسخة الاحتياطية.', 'error');
  reader.readAsText(file);
  e.target.value = '';
}

/* =========================================================
   نظام الإشعارات المدمج (Toasts) ودوال مساعدة
   ========================================================= */

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const bgColors = {
    success: 'bg-emerald-600 text-white',
    error: 'bg-rose-600 text-white',
    warning: 'bg-amber-500 text-slate-950',
    info: 'bg-slate-800 text-white'
  };
  const icons = {
    success: 'fa-circle-check',
    error: 'fa-triangle-exclamation',
    warning: 'fa-circle-exclamation',
    info: 'fa-circle-info'
  };

  toast.className = `toast flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-xl text-xs sm:text-sm font-bold ${bgColors[type] || bgColors.info}`;
  toast.innerHTML = `
    <i class="fa-solid ${icons[type] || icons.info} text-base"></i>
    <span>${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  // أنيميشن الظهور
  setTimeout(() => toast.classList.add('show'), 10);

  // إخفاء وحذف بعد 3.5 ثوانٍ
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str || '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
