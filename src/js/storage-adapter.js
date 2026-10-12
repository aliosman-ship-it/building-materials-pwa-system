/**
 * @module js/storage-adapter
 * IndexedDB persistence: schema/versioning, promise-based repositories,
 * atomic multi-store transactions, backup/restore, and a non-destructive
 * auto-migration from the legacy localStorage application.
 */

import { DomainError, PRIVATE_SETTING_KEYS, deepFreeze, normalizeDataset, normalizeSettings } from '../core/domain.js';
import { isPinRecord } from '../core/security.js';

export const DB_NAME = 'dad_transport_db';
export const DB_VERSION = 1;
export const BACKUP_SCHEMA_VERSION = 1;

/** Object store names. */
export const STORES = Object.freeze({
  trips: 'trips',
  payments: 'payments',
  clients: 'clients',
  materials: 'materials',
  catalogs: 'catalogs',
  trucks: 'trucks',
  accounts: 'accounts',
  settings: 'settings'
});

/** Stores holding business data (everything except settings). */
export const DATA_STORES = Object.freeze(['trips', 'payments', 'clients', 'materials', 'catalogs', 'trucks', 'accounts']);

/**
 * Store definitions. Adding an index or store = bump DB_VERSION; the upgrade
 * handler creates whatever is missing, so upgrades are additive and idempotent.
 * @type {Record<string, { keyPath: string|string[], indexes?: Array<[string, string|string[], IDBIndexParameters?]> }>}
 */
const SCHEMA = {
  trips: { keyPath: 'id', indexes: [['date', 'date'], ['client', 'client'], ['material', 'material']] },
  payments: { keyPath: 'id', indexes: [['date', 'date'], ['client', 'client']] },
  clients: { keyPath: 'name' },
  materials: { keyPath: 'name' },
  catalogs: { keyPath: ['client', 'name'], indexes: [['client', 'client']] },
  trucks: { keyPath: 'plate' },
  accounts: { keyPath: 'id', indexes: [['client', 'client', { unique: true }]] },
  settings: { keyPath: 'key' }
};

/** localStorage keys used by the legacy monolith. */
export const LEGACY_KEYS = Object.freeze({
  trips: 'dad_transport_trips_v1',
  clients: 'dad_transport_clients_v1',
  materials: 'dad_transport_materials_v1',
  trucks: 'dad_transport_trucks_v1',
  accounts: 'dad_transport_accounts_v1',
  clientCatalogs: 'dad_transport_client_catalogs_v1',
  payments: 'materials_data',
  pin: 'dad_transport_pin_v1',
  pinAttempts: 'dad_transport_pin_attempts_v1',
  backupReminder: 'dad_transport_backup_reminder_v1'
});

/** Persistence failure with a user-facing Arabic message. */
export class StorageError extends Error {
  /**
   * @param {string} message Technical message.
   * @param {{ cause?: unknown, userMessage?: string }} [options]
   */
  constructor(message, { cause, userMessage } = {}) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
    this.userMessage = userMessage || describeStorageError(cause);
  }
}

/**
 * Maps low-level DOMExceptions to actionable Arabic messages.
 * @param {unknown} error
 * @returns {string}
 */
export function describeStorageError(error) {
  const name = /** @type {any} */ (error)?.name;
  if (name === 'QuotaExceededError') return 'مساحة التخزين ممتلئة. نزّل نسخة احتياطية ثم احذف بيانات قديمة أو حرّر مساحة في الجهاز.';
  if (name === 'ConstraintError') return 'يوجد سجل مكرر بنفس المعرّف أو الاسم.';
  if (name === 'VersionError') return 'قاعدة البيانات أحدث من هذا الإصدار من التطبيق. حدّث الصفحة.';
  if (name === 'InvalidStateError') return 'قاعدة البيانات مغلقة. أعد تحميل الصفحة.';
  if (name === 'SecurityError') return 'المتصفح يمنع التخزين المحلي (وضع التصفح الخاص؟).';
  return 'تعذر حفظ البيانات أو قراءتها من التخزين المحلي.';
}

/**
 * Wraps an IDBRequest in a promise.
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
export function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Resolves when a transaction commits; rejects on error or abort.
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // tx.error is only populated once the abort completes; the failing request
    // (event.target) carries the real cause, e.g. ConstraintError.
    tx.onerror = event => reject(/** @type {IDBRequest} */ (event.target)?.error || tx.error);
    tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
  });
}

/**
 * Opens (and creates/upgrades) the database.
 * @param {{ name?: string, version?: number, factory?: IDBFactory }} [options]
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase({ name = DB_NAME, version = DB_VERSION, factory = globalThis.indexedDB } = {}) {
  if (!factory) {
    return Promise.reject(new StorageError('IndexedDB unavailable', { userMessage: 'هذا المتصفح لا يدعم التخزين دون اتصال (IndexedDB). استخدم متصفحاً حديثاً وتأكد من عدم تفعيل التصفح الخاص.' }));
  }
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = factory.open(name, version);
    } catch (error) {
      reject(new StorageError('indexedDB.open threw', { cause: error }));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;
      for (const [storeName, definition] of Object.entries(SCHEMA)) {
        const store = db.objectStoreNames.contains(storeName)
          ? tx.objectStore(storeName)
          : db.createObjectStore(storeName, { keyPath: definition.keyPath });
        for (const [indexName, keyPath, params] of definition.indexes || []) {
          if (!store.indexNames.contains(indexName)) store.createIndex(indexName, keyPath, params);
        }
      }
    };
    request.onblocked = () => {
      console.warn('IndexedDB upgrade blocked by another open tab.');
      globalThis.dispatchEvent?.(new CustomEvent('dad:db-blocked'));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        globalThis.dispatchEvent?.(new CustomEvent('dad:db-versionchange'));
      };
      resolve(db);
    };
    request.onerror = () => reject(new StorageError('indexedDB.open failed', { cause: request.error }));
  });
}

/**
 * Generic repository over one object store.
 * @template T
 */
export class Repository {
  /**
   * @param {Database} database
   * @param {string} storeName
   */
  constructor(database, storeName) {
    this.database = database;
    this.storeName = storeName;
  }

  /** @returns {Promise<T[]>} */
  getAll() {
    return this.database.run([this.storeName], 'readonly', stores => requestToPromise(stores[this.storeName].getAll()));
  }

  /**
   * @param {IDBValidKey} key
   * @returns {Promise<T|undefined>}
   */
  get(key) {
    return this.database.run([this.storeName], 'readonly', stores => requestToPromise(stores[this.storeName].get(key)));
  }

  /**
   * @param {string} indexName
   * @param {IDBValidKey|IDBKeyRange} query
   * @returns {Promise<T[]>}
   */
  getAllByIndex(indexName, query) {
    return this.database.run([this.storeName], 'readonly', stores => requestToPromise(stores[this.storeName].index(indexName).getAll(query)));
  }

  /** @returns {Promise<number>} */
  count() {
    return this.database.run([this.storeName], 'readonly', stores => requestToPromise(stores[this.storeName].count()));
  }

  /**
   * Inserts or replaces a record.
   * @param {T} record
   * @returns {Promise<T>}
   */
  async put(record) {
    await this.database.run([this.storeName], 'readwrite', stores => { stores[this.storeName].put(record); });
    return record;
  }

  /**
   * Inserts a record, failing if the key already exists.
   * @param {T} record
   * @returns {Promise<T>}
   */
  async add(record) {
    await this.database.run([this.storeName], 'readwrite', stores => { stores[this.storeName].add(record); });
    return record;
  }

  /**
   * Upserts many records atomically.
   * @param {T[]} records
   * @returns {Promise<void>}
   */
  putMany(records) {
    return this.database.run([this.storeName], 'readwrite', stores => {
      for (const record of records) stores[this.storeName].put(record);
    });
  }

  /**
   * @param {IDBValidKey} key
   * @returns {Promise<void>}
   */
  delete(key) {
    return this.database.run([this.storeName], 'readwrite', stores => { stores[this.storeName].delete(key); });
  }

  /** @returns {Promise<void>} */
  clear() {
    return this.database.run([this.storeName], 'readwrite', stores => { stores[this.storeName].clear(); });
  }
}

/**
 * @typedef {Object} Snapshot
 * @property {string[]} clients
 * @property {import('../core/domain.js').Material[]} materials
 * @property {import('../core/domain.js').CatalogEntry[]} catalogs
 * @property {string[]} trucks
 * @property {import('../core/domain.js').Trip[]} trips
 * @property {import('../core/domain.js').Payment[]} payments
 * @property {import('../core/domain.js').Account[]} accounts
 */

/** Database facade exposing repositories and atomic domain-level operations. */
export class Database {
  /**
   * @param {IDBDatabase} idb
   */
  constructor(idb) {
    this.idb = idb;
    /** @type {Repository<import('../core/domain.js').Trip>} */
    this.trips = new Repository(this, STORES.trips);
    /** @type {Repository<import('../core/domain.js').Payment>} */
    this.payments = new Repository(this, STORES.payments);
    /** @type {Repository<{ name: string, createdAt: string }>} */
    this.clients = new Repository(this, STORES.clients);
    /** @type {Repository<import('../core/domain.js').Material>} */
    this.materials = new Repository(this, STORES.materials);
    /** @type {Repository<import('../core/domain.js').CatalogEntry>} */
    this.catalogs = new Repository(this, STORES.catalogs);
    /** @type {Repository<{ plate: string }>} */
    this.trucks = new Repository(this, STORES.trucks);
    /** @type {Repository<import('../core/domain.js').Account>} */
    this.accounts = new Repository(this, STORES.accounts);
    /** @type {Repository<{ key: string, value: unknown }>} */
    this.settings = new Repository(this, STORES.settings);
  }

  /**
   * Opens the database and returns a facade.
   * @param {Parameters<typeof openDatabase>[0]} [options]
   * @returns {Promise<Database>}
   */
  static async open(options) {
    return new Database(await openDatabase(options));
  }

  /**
   * Runs `work` inside a single transaction. The transaction commits only if every
   * request succeeds; any thrown error or failed request aborts all writes.
   * `work` must only await IndexedDB requests (never timers/network) or the
   * transaction will auto-commit early.
   * @template R
   * @param {string[]} storeNames
   * @param {IDBTransactionMode} mode
   * @param {(stores: Record<string, IDBObjectStore>, tx: IDBTransaction) => R|Promise<R>} work
   * @returns {Promise<R>}
   */
  async run(storeNames, mode, work) {
    let tx;
    try {
      tx = this.idb.transaction(storeNames, mode);
    } catch (error) {
      throw new StorageError(`Cannot open transaction on ${storeNames.join(',')}`, { cause: error });
    }
    const done = transactionDone(tx);
    const stores = Object.fromEntries(storeNames.map(name => [name, tx.objectStore(name)]));
    let result;
    try {
      result = await work(stores, tx);
    } catch (error) {
      try { tx.abort(); } catch { /* already finished */ }
      await done.catch(() => undefined);
      if (error instanceof DomainError || error instanceof StorageError) throw error;
      throw new StorageError(`Transaction failed on ${storeNames.join(',')}`, { cause: error });
    }
    try {
      await done;
    } catch (error) {
      throw new StorageError(`Commit failed on ${storeNames.join(',')}`, { cause: error });
    }
    return result;
  }

  /* ─────────────── settings ─────────────── */

  /**
   * Reads all settings merged with defaults (private keys included for app use).
   * @returns {Promise<Record<string, any>>}
   */
  async getSettings() {
    const rows = await this.settings.getAll();
    const raw = Object.fromEntries(rows.map(row => [row.key, row.value]));
    return { ...raw, ...normalizeSettings(raw) };
  }

  /**
   * @param {string} key
   * @param {unknown} [fallback]
   * @returns {Promise<any>}
   */
  async getSetting(key, fallback = undefined) {
    const row = await this.settings.get(key);
    return row === undefined ? fallback : row.value;
  }

  /**
   * Writes several settings atomically.
   * @param {Record<string, unknown>} values
   */
  setSettings(values) {
    return this.run([STORES.settings], 'readwrite', stores => {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) stores.settings.delete(key);
        else stores.settings.put({ key, value });
      }
    });
  }

  /**
   * @param {string} key
   * @param {unknown} value
   */
  setSetting(key, value) {
    return this.setSettings({ [key]: value });
  }

  /* ─────────────── snapshot ─────────────── */

  /**
   * Loads every business store in one consistent read transaction.
   * @returns {Promise<Readonly<Snapshot>>}
   */
  loadAll() {
    return this.run([...DATA_STORES], 'readonly', async stores => {
      const results = await Promise.all(DATA_STORES.map(name => requestToPromise(stores[name].getAll())));
      const byStore = Object.fromEntries(DATA_STORES.map((name, index) => [name, results[index]]));
      const { clients, materials, catalogs, trucks, trips, payments, accounts } = byStore;
      return deepFreeze({
        clients: clients.map(row => row.name).sort((a, b) => a.localeCompare(b, 'ar')),
        materials,
        catalogs,
        trucks: trucks.map(row => row.plate).sort((a, b) => a.localeCompare(b, 'ar')),
        trips,
        payments,
        accounts
      });
    });
  }

  /* ─────────────── atomic domain operations ─────────────── */

  /**
   * Saves a trip and remembers its truck plate for autocomplete.
   * @param {import('../core/domain.js').Trip} trip
   */
  saveTrip(trip) {
    return this.run([STORES.trips, STORES.trucks], 'readwrite', stores => {
      stores.trips.put(trip);
      if (trip.truck) stores.trucks.put({ plate: trip.truck });
    });
  }

  /**
   * Creates a client together with an (empty) manual account.
   * @param {string} name
   * @param {import('../core/domain.js').Account} account
   */
  addClient(name, account) {
    return this.run([STORES.clients, STORES.accounts], 'readwrite', async stores => {
      await requestToPromise(stores.clients.add({ name, createdAt: new Date().toISOString() }));
      const existing = await requestToPromise(stores.accounts.index('client').get(name));
      if (!existing) stores.accounts.add(account);
    });
  }

  /**
   * Deletes a client, its custom prices and its (empty) manual account.
   * Callers must first verify `canDeleteClient` from the domain layer.
   * @param {string} name
   */
  deleteClient(name) {
    return this.run([STORES.clients, STORES.catalogs, STORES.accounts], 'readwrite', async stores => {
      stores.clients.delete(name);
      const catalogKeys = await requestToPromise(stores.catalogs.index('client').getAllKeys(name));
      for (const key of catalogKeys) stores.catalogs.delete(key);
      const account = await requestToPromise(stores.accounts.index('client').get(name));
      if (account) stores.accounts.delete(account.id);
    });
  }

  /**
   * Deletes trips/payments by id in one transaction.
   * @param {{ trips?: string[], payments?: string[] }} ids
   */
  deleteTransactions({ trips = [], payments = [] }) {
    return this.run([STORES.trips, STORES.payments], 'readwrite', stores => {
      trips.forEach(id => stores.trips.delete(id));
      payments.forEach(id => stores.payments.delete(id));
    });
  }

  /* ─────────────── backup / restore ─────────────── */

  /**
   * Builds a full backup document (private settings such as the PIN are excluded).
   * @returns {Promise<Record<string, unknown>>}
   */
  async exportBackup() {
    const stores = [...DATA_STORES, STORES.settings];
    const data = await this.run(stores, 'readonly', async tx => {
      const results = await Promise.all(stores.map(name => requestToPromise(tx[name].getAll())));
      return Object.fromEntries(stores.map((name, index) => [name, results[index]]));
    });
    data.settings = data.settings.filter(row => !PRIVATE_SETTING_KEYS.includes(row.key) && !String(row.key).startsWith('_'));
    return { app: 'dad-transport', schemaVersion: BACKUP_SCHEMA_VERSION, dbVersion: DB_VERSION, exportedAt: new Date().toISOString(), data };
  }

  /**
   * Replaces all business data with a normalized dataset in one atomic transaction.
   * Settings present in the dataset overwrite current values; others are kept.
   * @param {import('../core/domain.js').Dataset} dataset
   */
  replaceAll(dataset) {
    return this.run([...DATA_STORES, STORES.settings], 'readwrite', stores => {
      for (const name of DATA_STORES) stores[name].clear();
      dataset.clients.forEach(record => stores.clients.put(record));
      dataset.materials.forEach(record => stores.materials.put(record));
      dataset.catalogs.forEach(record => stores.catalogs.put(record));
      dataset.trucks.forEach(record => stores.trucks.put(record));
      dataset.trips.forEach(record => stores.trips.put(record));
      dataset.payments.forEach(record => stores.payments.put(record));
      dataset.accounts.forEach(record => stores.accounts.put(record));
      for (const [key, value] of Object.entries(dataset.settings || {})) stores.settings.put({ key, value });
    });
  }

  /**
   * Merges a dataset into existing data atomically and idempotently:
   * reference data (clients, materials, prices, trucks) is inserted only when absent;
   * trips and payments are upserted by id; accounts are merged per client.
   * @param {import('../core/domain.js').Dataset} dataset
   * @returns {Promise<Record<string, number>>} Count of records written per store.
   */
  mergeDataset(dataset) {
    return this.run([...DATA_STORES], 'readwrite', async stores => {
      const written = { clients: 0, materials: 0, catalogs: 0, trucks: 0, trips: 0, payments: 0, accounts: 0 };
      const insertIfAbsent = async (storeName, record, key) => {
        const existing = await requestToPromise(stores[storeName].getKey(key));
        if (existing === undefined) {
          stores[storeName].put(record);
          written[storeName] += 1;
        }
      };
      for (const record of dataset.clients) await insertIfAbsent('clients', record, record.name);
      for (const record of dataset.materials) await insertIfAbsent('materials', record, record.name);
      for (const record of dataset.catalogs) await insertIfAbsent('catalogs', record, [record.client, record.name]);
      for (const record of dataset.trucks) await insertIfAbsent('trucks', record, record.plate);
      for (const record of dataset.trips) { stores.trips.put(record); written.trips += 1; }
      for (const record of dataset.payments) { stores.payments.put(record); written.payments += 1; }
      for (const account of dataset.accounts) {
        const existing = await requestToPromise(stores.accounts.index('client').get(account.client));
        if (!existing) {
          stores.accounts.put(account);
        } else {
          const known = new Set(existing.transactions.map(tx => tx.id));
          const extra = account.transactions.filter(tx => !known.has(tx.id));
          if (!extra.length) continue;
          stores.accounts.put({ ...existing, transactions: [...existing.transactions, ...extra], updatedAt: new Date().toISOString() });
        }
        written.accounts += 1;
      }
      return written;
    });
  }

  /**
   * Seeds default materials when the catalog is empty (first run).
   * @param {ReadonlyArray<import('../core/domain.js').Material>} materials
   * @returns {Promise<boolean>} true when seeding happened.
   */
  async seedMaterials(materials) {
    return this.run([STORES.materials], 'readwrite', async stores => {
      const count = await requestToPromise(stores.materials.count());
      if (count > 0) return false;
      materials.forEach(material => stores.materials.put({ ...material }));
      return true;
    });
  }

  /* ─────────────── device storage ─────────────── */

  /**
   * Storage usage estimate.
   * @returns {Promise<{ usage: number, quota: number, persisted: boolean }|null>}
   */
  async estimate() {
    if (!navigator.storage?.estimate) return null;
    const [{ usage = 0, quota = 0 }, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false)
    ]);
    return { usage, quota, persisted };
  }

  /**
   * Asks the browser not to evict this origin's data under storage pressure.
   * @returns {Promise<boolean>}
   */
  async requestPersistence() {
    if (!navigator.storage?.persist) return false;
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }

  /** Closes the connection. */
  close() {
    this.idb.close();
  }
}

/* ───────────────────────── legacy migration ───────────────────────── */

/**
 * @typedef {Object} LegacySnapshot
 * @property {boolean} found True when at least one legacy data key exists.
 * @property {Record<string, unknown>} data Legacy-backup-shaped payload.
 * @property {Record<string, number>} counts Raw record counts per key.
 * @property {unknown} pin Legacy PIN record, if any.
 * @property {number|null} backupReminder Last backup reminder timestamp.
 * @property {string[]} errors Keys that could not be read/parsed.
 */

/**
 * Reads the legacy localStorage keys without modifying them.
 * @param {Storage|null} [storage]
 * @returns {LegacySnapshot}
 */
export function readLegacySnapshot(storage = safeLocalStorage()) {
  const snapshot = { found: false, data: {}, counts: {}, pin: null, backupReminder: null, errors: [] };
  if (!storage) return snapshot;
  const read = key => {
    try {
      const raw = storage.getItem(key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch (error) {
      snapshot.errors.push(key);
      console.error(`Legacy migration: cannot read ${key}`, error);
      return undefined;
    }
  };
  for (const field of ['trips', 'clients', 'materials', 'trucks', 'accounts', 'payments']) {
    const value = read(LEGACY_KEYS[field]);
    if (Array.isArray(value)) {
      snapshot.data[field] = value;
      snapshot.counts[field] = value.length;
      if (value.length) snapshot.found = true;
    }
  }
  const catalogs = read(LEGACY_KEYS.clientCatalogs);
  if (catalogs && typeof catalogs === 'object' && !Array.isArray(catalogs)) {
    snapshot.data.clientCatalogs = catalogs;
    snapshot.counts.clientCatalogs = Object.keys(catalogs).length;
    if (snapshot.counts.clientCatalogs) snapshot.found = true;
  }
  snapshot.pin = read(LEGACY_KEYS.pin) ?? null;
  const reminder = Number(read(LEGACY_KEYS.backupReminder));
  snapshot.backupReminder = Number.isFinite(reminder) && reminder > 0 ? reminder : null;
  if (!Array.isArray(snapshot.data.trips)) snapshot.data.trips = [];
  return snapshot;
}

/**
 * localStorage accessor that tolerates browsers where access throws.
 * @returns {Storage|null}
 */
function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} MigrationResult
 * @property {'migrated'|'skipped'|'none'} status
 * @property {Record<string, number>} [written]
 * @property {Record<string, number>} [dropped]
 * @property {string[]} [warnings]
 * @property {string[]} [unreadable]
 * @property {boolean} [pinMigrated]
 */

/**
 * Imports legacy localStorage data into IndexedDB. Idempotent (records keep their
 * ids and are upserted) and non-destructive (legacy keys are left untouched so the
 * archived app in legacy-backup/ still works). Runs automatically once; pass
 * `force: true` to re-run manually from settings.
 * @param {Database} database
 * @param {{ force?: boolean, storage?: Storage|null }} [options]
 * @returns {Promise<MigrationResult>}
 */
export async function migrateFromLegacy(database, { force = false, storage } = {}) {
  if (!force && (await database.getSetting('_legacyMigration'))) return { status: 'skipped' };
  const snapshot = readLegacySnapshot(storage === undefined ? safeLocalStorage() : storage);
  if (!snapshot.found && !isPinRecord(snapshot.pin)) return { status: 'none', unreadable: snapshot.errors };

  const { dataset, report } = normalizeDataset(snapshot.data);
  const written = await database.mergeDataset(dataset);

  const settings = {};
  let pinMigrated = false;
  if (isPinRecord(snapshot.pin) && !(await database.getSetting('pin'))) {
    settings.pin = snapshot.pin;
    pinMigrated = true;
  }
  if (snapshot.backupReminder && !(await database.getSetting('_lastBackupReminder'))) {
    settings._lastBackupReminder = snapshot.backupReminder;
  }
  settings._legacyMigration = {
    at: new Date().toISOString(),
    source: snapshot.counts,
    written,
    dropped: report.dropped,
    warnings: report.warnings.length,
    unreadable: snapshot.errors
  };
  await database.setSettings(settings);
  return { status: 'migrated', written, dropped: report.dropped, warnings: report.warnings, unreadable: snapshot.errors, pinMigrated };
}
