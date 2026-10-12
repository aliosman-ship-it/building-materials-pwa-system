/**
 * @module core/security
 * PIN hashing (PBKDF2-SHA-256) and brute-force lockout policy.
 * The record format is identical to the legacy app, so migrated PINs keep working.
 */

import { randomBytes, toHex } from './id.js';

export const PIN_ITERATIONS = 120000;
export const PIN_ALGORITHM = 'PBKDF2-SHA-256';
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 30_000;
/** Each consecutive lockout doubles the wait, up to this ceiling. */
export const MAX_LOCKOUT_MS = 60 * 60_000;

/**
 * @typedef {{ version: 1, algorithm: string, iterations: number, salt: string, hash: string }} PinRecord
 * @typedef {{ count: number, lockoutUntil: number, lockouts?: number }} PinAttempts
 */

/** @returns {SubtleCrypto} */
function subtle() {
  const api = globalThis.crypto?.subtle;
  if (!api) throw new Error('التشفير غير متاح. يلزم فتح التطبيق عبر HTTPS أو localhost.');
  return api;
}

/**
 * @param {string} pin
 * @param {Uint8Array} salt
 * @param {number} iterations
 * @returns {Promise<string>} hex digest
 */
async function derive(pin, salt, iterations) {
  const key = await subtle().importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toHex(new Uint8Array(bits));
}

/**
 * True for a 4–8 digit PIN.
 * @param {unknown} pin
 * @returns {boolean}
 */
export const isValidPin = pin => typeof pin === 'string' && /^\d{4,8}$/.test(pin);

/**
 * Hashes a new PIN.
 * @param {string} pin
 * @returns {Promise<PinRecord>}
 */
export async function createPinRecord(pin) {
  if (!isValidPin(pin)) throw new Error('رمز PIN يجب أن يتكون من 4 إلى 8 أرقام.');
  const salt = randomBytes(16);
  return { version: 1, algorithm: PIN_ALGORITHM, iterations: PIN_ITERATIONS, salt: toHex(salt), hash: await derive(pin, salt, PIN_ITERATIONS) };
}

/**
 * Structural validation of a stored PIN record.
 * @param {unknown} record
 * @returns {record is PinRecord}
 */
export function isPinRecord(record) {
  return Boolean(record) && typeof record === 'object'
    && /** @type {any} */ (record).version === 1
    && /** @type {any} */ (record).algorithm === PIN_ALGORITHM
    && Number.isInteger(/** @type {any} */ (record).iterations) && /** @type {any} */ (record).iterations >= 100000
    && /^[a-f0-9]{32}$/i.test(/** @type {any} */ (record).salt || '')
    && /^[a-f0-9]{64}$/i.test(/** @type {any} */ (record).hash || '');
}

/**
 * Verifies a PIN in constant time relative to the digest.
 * @param {string} pin
 * @param {PinRecord} record
 * @returns {Promise<boolean>}
 */
export async function verifyPin(pin, record) {
  if (!isPinRecord(record)) throw new Error('صيغة إعداد رمز PIN غير صالحة.');
  if (!isValidPin(pin)) return false;
  const salt = new Uint8Array(record.salt.match(/.{2}/g).map(byte => Number.parseInt(byte, 16)));
  const candidate = await derive(pin, salt, record.iterations);
  const expected = record.hash.toLowerCase();
  let difference = candidate.length ^ expected.length;
  for (let index = 0; index < candidate.length; index += 1) {
    difference |= candidate.charCodeAt(index) ^ expected.charCodeAt(index % expected.length);
  }
  return difference === 0;
}

/**
 * Records a failed attempt and returns the new attempt state. Every
 * MAX_ATTEMPTS failures trigger a lockout that doubles each time (30s, 1m, 2m…
 * capped at one hour) until a successful unlock clears the record.
 * @param {PinAttempts|undefined} attempts
 * @param {number} [now]
 * @returns {PinAttempts}
 */
export function registerFailure(attempts, now = Date.now()) {
  const count = (Number(attempts?.count) || 0) + 1;
  const lockouts = Number(attempts?.lockouts) || 0;
  if (count >= MAX_ATTEMPTS) {
    const duration = Math.min(MAX_LOCKOUT_MS, LOCKOUT_MS * 2 ** lockouts);
    return { count: 0, lockoutUntil: now + duration, lockouts: lockouts + 1 };
  }
  return { count, lockoutUntil: 0, lockouts };
}

/**
 * Milliseconds remaining in a lockout (0 when not locked out).
 * @param {PinAttempts|undefined} attempts
 * @param {number} [now]
 * @returns {number}
 */
export function lockoutRemaining(attempts, now = Date.now()) {
  return Math.max(0, (attempts?.lockoutUntil || 0) - now);
}
