/**
 * @module js/daily-storage
 * Persistence for the daily work sheets under one dedicated localStorage key.
 *
 * Isolated by design from the IndexedDB business database: the transport
 * backup, restore and "delete all data" operations never touch this key, and
 * this module never touches theirs.
 *
 * Every write is a single setItem of the whole envelope, so a sheet is either
 * fully saved or not at all. A corrupt envelope is never overwritten, and
 * individual records that fail validation are kept untouched in `quarantine`
 * (never dropped on the next write).
 */

import { reviveDailySheet, sortSheets } from '../core/daily.js';
import { StorageError, describeStorageError, safeLocalStorage } from './storage-adapter.js';

export const DAILY_STORAGE_KEY = 'dad_daily_operations_v1';
export const DAILY_SCHEMA_VERSION = 1;
/** Marker in exported files so restore can reject unrelated JSON. */
export const DAILY_BACKUP_KIND = 'dad-daily-operations';

/**
 * @typedef {import('../core/daily.js').DailySheet} DailySheet
 * @typedef {{ version: number, sheets: DailySheet[], quarantine: unknown[], updatedAt: string|null }} DailyEnvelope
 *   `quarantine` holds stored records that no longer pass validation (or lost a
 *   same-date duplicate check), exactly as they were, so nothing is ever lost.
 */

export class DailyStore {
  /**
   * @param {{ storage?: Pick<Storage, 'getItem'|'setItem'>|null, key?: string }} [options]
   */
  constructor({ storage = safeLocalStorage(), key = DAILY_STORAGE_KEY } = {}) {
    this.storage = storage;
    this.key = key;
  }

  /** @returns {Pick<Storage, 'getItem'|'setItem'>} */
  _requireStorage() {
    if (!this.storage) {
      throw new StorageError('localStorage unavailable', { userMessage: 'المتصفح يمنع التخزين المحلي، لذلك لا يمكن حفظ اليوميات (وضع التصفح الخاص؟).' });
    }
    return this.storage;
  }

  /**
   * Reads the envelope. Unknown or damaged records are skipped, but an
   * unparseable envelope throws so it is never silently replaced.
   * @returns {DailyEnvelope}
   */
  read() {
    const storage = this._requireStorage();
    let raw;
    try {
      raw = storage.getItem(this.key);
    } catch (error) {
      throw new StorageError('daily read failed', { cause: error });
    }
    if (raw === null || raw === '') return { version: DAILY_SCHEMA_VERSION, sheets: [], quarantine: [], updatedAt: null };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new StorageError('daily envelope is not JSON', { cause: error, userMessage: 'بيانات اليوميات المحفوظة تالفة ولا يمكن قراءتها. لم يتم تعديلها؛ تواصل مع الدعم لاستعادتها.' });
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sheets)) {
      throw new StorageError('daily envelope has an unexpected shape', { userMessage: 'بيانات اليوميات المحفوظة بصيغة غير معروفة. لم يتم تعديلها.' });
    }
    if (Number(parsed.version) > DAILY_SCHEMA_VERSION) {
      throw new StorageError('daily envelope is newer than this build', { userMessage: 'بيانات اليوميات محفوظة بإصدار أحدث من التطبيق. حدّث الصفحة.' });
    }
    const valid = [];
    const quarantine = Array.isArray(parsed.quarantine) ? [...parsed.quarantine] : [];
    for (const record of parsed.sheets) {
      const sheet = reviveDailySheet(record);
      if (sheet) valid.push(sheet);
      else quarantine.push(record);
    }
    const { kept, duplicates } = dedupeByDate(valid);
    return {
      version: DAILY_SCHEMA_VERSION,
      sheets: kept,
      quarantine: [...quarantine, ...duplicates],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
    };
  }

  /**
   * @param {DailySheet[]} sheets
   * @param {unknown[]} quarantine carried over unchanged from the last read
   */
  _write(sheets, quarantine) {
    const storage = this._requireStorage();
    /** @type {DailyEnvelope} */
    const envelope = { version: DAILY_SCHEMA_VERSION, sheets: sortSheets(sheets), quarantine, updatedAt: new Date().toISOString() };
    try {
      storage.setItem(this.key, JSON.stringify(envelope));
    } catch (error) {
      const name = /** @type {any} */ (error)?.name;
      throw new StorageError('daily write failed', {
        cause: error,
        userMessage: name === 'QuotaExceededError'
          ? 'مساحة تخزين اليوميات ممتلئة. نزّل نسخة احتياطية من اليوميات ثم احذف الأشهر القديمة.'
          : describeStorageError(error)
      });
    }
  }

  /** @returns {DailySheet[]} oldest → newest */
  list() {
    return this.read().sheets;
  }

  /** @returns {number} stored records that could not be read (kept as they are) */
  quarantinedCount() {
    return this.read().quarantine.length;
  }

  /**
   * @param {string} date
   * @returns {DailySheet|null}
   */
  getByDate(date) {
    return this.list().find(sheet => sheet.date === date) || null;
  }

  /**
   * Inserts or replaces the sheet for its date. When an edit moves a sheet to a
   * date that already has one, the call fails instead of overwriting it.
   * @param {DailySheet} sheet
   * @returns {DailySheet}
   */
  save(sheet) {
    const { sheets, quarantine } = this.read();
    const clash = sheets.find(item => item.date === sheet.date && item.id !== sheet.id);
    if (clash) {
      throw new StorageError('daily date clash', { userMessage: `توجد يومية محفوظة بتاريخ ${sheet.date}. افتحها وعدّلها بدلاً من إنشاء يومية ثانية لنفس اليوم.` });
    }
    this._write([...sheets.filter(item => item.id !== sheet.id), sheet], quarantine);
    return sheet;
  }

  /**
   * @param {string} id
   * @returns {boolean} whether a sheet was removed
   */
  delete(id) {
    const { sheets, quarantine } = this.read();
    const next = sheets.filter(item => item.id !== id);
    if (next.length === sheets.length) return false;
    this._write(next, quarantine);
    return true;
  }

  /**
   * Portable backup payload (quarantined records travel along, unchanged).
   * @returns {{ kind: string, version: number, exportedAt: string, sheets: DailySheet[], quarantine: unknown[] }}
   */
  exportBackup() {
    const { sheets, quarantine } = this.read();
    return { kind: DAILY_BACKUP_KIND, version: DAILY_SCHEMA_VERSION, exportedAt: new Date().toISOString(), sheets, quarantine };
  }

  /**
   * Validates a backup file without writing anything.
   * @param {unknown} payload
   * @returns {{ sheets: DailySheet[], skipped: number, replacing: number }}
   */
  previewImport(payload) {
    const data = /** @type {any} */ (payload);
    if (!data || data.kind !== DAILY_BACKUP_KIND || !Array.isArray(data.sheets)) {
      throw new StorageError('not a daily backup', { userMessage: 'هذا الملف ليس نسخة احتياطية لحركة العمل اليومية.' });
    }
    if (Number(data.version) > DAILY_SCHEMA_VERSION) {
      throw new StorageError('daily backup is newer', { userMessage: 'الملف صادر من إصدار أحدث من التطبيق. حدّث التطبيق أولاً.' });
    }
    const { kept: sheets } = dedupeByDate(data.sheets.map(reviveDailySheet).filter(Boolean));
    const existing = new Set(this.list().map(sheet => sheet.date));
    return { sheets, skipped: data.sheets.length - sheets.length, replacing: sheets.filter(sheet => existing.has(sheet.date)).length };
  }

  /**
   * Merges backup sheets: sheets in the file replace existing sheets of the
   * same date; every other existing sheet is kept.
   * @param {unknown} payload
   * @returns {{ imported: number, skipped: number, replaced: number }}
   */
  importBackup(payload) {
    const { sheets, skipped, replacing } = this.previewImport(payload);
    const incoming = new Set(sheets.map(sheet => sheet.date));
    const current = this.read();
    this._write([...current.sheets.filter(sheet => !incoming.has(sheet.date)), ...sheets], current.quarantine);
    return { imported: sheets.length, skipped, replaced: replacing };
  }
}

/**
 * Keeps one sheet per date (the most recently updated); the others are returned
 * separately so callers can preserve them.
 * @param {DailySheet[]} sheets
 * @returns {{ kept: DailySheet[], duplicates: DailySheet[] }}
 */
function dedupeByDate(sheets) {
  const byDate = new Map();
  const duplicates = [];
  for (const sheet of sheets) {
    const current = byDate.get(sheet.date);
    if (!current) byDate.set(sheet.date, sheet);
    else if (String(sheet.updatedAt) > String(current.updatedAt)) { duplicates.push(current); byDate.set(sheet.date, sheet); }
    else duplicates.push(sheet);
  }
  return { kept: sortSheets([...byDate.values()]), duplicates };
}
