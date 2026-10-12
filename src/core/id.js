/**
 * @module core/id
 * Cryptographically secure identifier generation with a non-crypto fallback.
 *
 * IDs keep the legacy shape `<prefix>_<epochMillis>_<random>` so that records
 * created by the old monolith and by this version sort and parse identically.
 */

const HEX = '0123456789abcdef';

/**
 * Returns `byteLength` random bytes, preferring the Web Crypto API.
 * Falls back to Math.random only when no secure source exists (very old runtimes).
 * @param {number} byteLength
 * @returns {Uint8Array}
 */
export function randomBytes(byteLength) {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new RangeError('randomBytes: byteLength must be a positive integer.');
  }
  const bytes = new Uint8Array(byteLength);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
    return bytes;
  }
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/**
 * Encodes bytes as lowercase hex.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toHex(bytes) {
  let out = '';
  for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 15];
  return out;
}

/**
 * Generates a sortable, collision-resistant record id.
 * @param {string} [prefix='id'] Short lowercase entity prefix, e.g. "trip".
 * @returns {string} e.g. "trip_1760169600000_9f2c4e1ab07d"
 */
export function generateId(prefix = 'id') {
  const safePrefix = String(prefix).toLowerCase().replace(/[^a-z0-9]/g, '') || 'id';
  return `${safePrefix}_${Date.now()}_${toHex(randomBytes(6))}`;
}

/**
 * Extracts the creation timestamp embedded in an id (legacy or current format).
 * @param {unknown} id
 * @returns {number|null} epoch milliseconds, or null when the id carries none.
 */
export function extractTimestamp(id) {
  const match = String(id ?? '').match(/(?:^|_)(\d{10,})(?:_|$)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}
