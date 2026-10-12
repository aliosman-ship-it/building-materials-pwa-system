/**
 * @module js/license-storage
 * Persistence for the licensing layer: the device id, activation key and trial
 * clock live in localStorage and are mirrored into IndexedDB settings, so
 * clearing only one of the two does not lose the activation. Also decides,
 * once per device, whether an existing install is grandfathered as "master".
 */

import { LICENSE_STORAGE_KEYS } from '../core/license.js';

/** IndexedDB settings keys (underscore-prefixed: never exported in backups). */
export const LICENSE_SETTINGS = Object.freeze({
  deviceId: '_licenseDeviceId',
  key: '_licenseKey',
  clock: '_licenseClock',
  master: '_licenseMaster',
  init: '_licenseInit'
});

/** Maps localStorage keys to their IndexedDB mirror. */
const MIRROR = Object.freeze({
  [LICENSE_STORAGE_KEYS.deviceId]: LICENSE_SETTINGS.deviceId,
  [LICENSE_STORAGE_KEYS.key]: LICENSE_SETTINGS.key,
  [LICENSE_STORAGE_KEYS.clock]: LICENSE_SETTINGS.clock
});

/** @returns {Storage|null} */
function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Synchronous storage facade for core/license backed by localStorage with an
 * IndexedDB mirror. Values are loaded once; writes go to both stores.
 * @param {import('./storage-adapter.js').Database} db
 * @param {{ local?: Storage|null }} [options]
 * @returns {Promise<Pick<Storage, 'getItem'|'setItem'>>}
 */
export async function openLicenseStorage(db, { local = safeLocalStorage() } = {}) {
  /** @type {Map<string, string>} */
  const cache = new Map();
  const readLocal = key => {
    try { return local?.getItem(key) ?? null; } catch { return null; }
  };
  const writeLocal = (key, value) => {
    try { local?.setItem(key, value); } catch { /* storage blocked: the IndexedDB mirror still holds it */ }
  };

  for (const [key, setting] of Object.entries(MIRROR)) {
    const fromLocal = readLocal(key);
    const mirrored = await db.getSetting(setting);
    // The trial clock only ever moves forward: keep the later of the two copies.
    const value = key === LICENSE_STORAGE_KEYS.clock
      ? String(Math.max(Number(fromLocal) || 0, Number(mirrored) || 0) || '')
      : fromLocal ?? (mirrored === undefined ? null : String(mirrored));
    if (!value) continue;
    cache.set(key, value);
    if (fromLocal !== value) writeLocal(key, value);
    if (mirrored !== value) await db.setSetting(setting, value);
  }

  return {
    getItem: key => cache.get(key) ?? null,
    setItem(key, value) {
      const text = String(value);
      cache.set(key, text);
      writeLocal(key, text);
      if (MIRROR[key]) db.setSetting(MIRROR[key], text).catch(error => console.error('License mirror write failed:', error));
    }
  };
}

/**
 * Grandfathering: the first time this licensed build runs on a device, an install
 * that already holds business data (or legacy-app data) is marked master and stays
 * unlocked forever. Fresh installs are recorded as non-master and must activate.
 * @param {import('./storage-adapter.js').Database} db
 * @param {{ hasLegacyData?: boolean }} [options]
 * @returns {Promise<boolean>} true for a master install.
 */
export async function resolveMasterInstall(db, { hasLegacyData = false } = {}) {
  if (await db.getSetting(LICENSE_SETTINGS.master)) return true;
  if (await db.getSetting(LICENSE_SETTINGS.init)) return false;
  const [trips, payments, clients, accounts] = await Promise.all([db.trips.count(), db.payments.count(), db.clients.count(), db.accounts.count()]);
  const existing = hasLegacyData || trips + payments + clients + accounts > 0;
  const at = new Date().toISOString();
  await db.setSettings({
    [LICENSE_SETTINGS.init]: { at },
    ...(existing ? { [LICENSE_SETTINGS.master]: { at, reason: hasLegacyData ? 'legacy-data' : 'existing-data' } } : {})
  });
  return existing;
}
