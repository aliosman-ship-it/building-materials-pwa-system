/**
 * @module core/license
 * Offline device licensing with ECDSA P-256 signed activation keys.
 *
 * The app embeds only the PUBLIC key, so it can verify activation keys but can
 * never create them. Keys are minted with the developer's private key file in
 * the admin key generator (#admin-keygen); that file never ships with the app.
 *
 * A key binds one device id, a license type (permanent or trial) and, for
 * trials, an absolute expiry time. Any change to any of them breaks the signature.
 *
 * Key layout (70 bytes, base32 in groups of 4, prefixed "KEY-"):
 *   [version:1][type:1][expiresAt:uint32 seconds, 0 = never][signature:64]
 * Signed message: "DADLIC<version>|<deviceId>|<type>|<expiresAt>"
 *   version 1 — signed with the primary ECDSA P-256 private key (key file)
 *   version 2 — signed with the emergency recovery key (Ed25519), which is
 *               re-derived from the developer's recovery passphrase on demand
 *
 * Disaster recovery: the private key file can be exported as a password-encrypted
 * backup (AES-GCM, PBKDF2) and imported again on a new computer. If every copy is
 * lost, the recovery passphrase alone still issues valid keys from any computer.
 * Only public keys are embedded here, so reading this file reveals nothing usable.
 *
 * Limits: like any purely offline check, this deters key sharing and forgery but
 * cannot stop someone who edits the app's JavaScript.
 */

import { randomBytes } from './id.js';

/** Public verification key. Replace only together with the private key file. */
export const LICENSE_PUBLIC_KEY = Object.freeze({
  kty: 'EC',
  crv: 'P-256',
  x: 'dgsBJeGC-mC-JIlzG2ujm7L4OwQNPzuw0zWhLZTwbWw',
  y: '3t6BkQEkolhp_caTtnAm7wJpBSOcuYp2_YD3qLi4avA'
});

/**
 * Public half of the emergency recovery key, derived from the developer's recovery
 * passphrase (set it up in #admin-keygen → "عبارة الاسترداد"). null = not configured.
 * @type {Readonly<{ kty: 'OKP', crv: 'Ed25519', x: string }>|null}
 */
export const LICENSE_RECOVERY_PUBLIC_KEY = null;

export const LICENSE_TYPE = Object.freeze({ PERMANENT: 'permanent', TRIAL: 'trial' });

/** localStorage keys. */
export const LICENSE_STORAGE_KEYS = Object.freeze({
  deviceId: 'dad_device_id',
  key: 'dad_license_key',
  clock: 'dad_license_clock'
});

/** User-facing (Arabic) explanations for every failure reason. */
export const LICENSE_MESSAGES = Object.freeze({
  format: 'صيغة المفتاح غير صحيحة. انسخ المفتاح كاملاً كما وصلك (يبدأ بـ KEY-).',
  signature: 'هذا المفتاح غير صالح لهذا الجهاز. تأكد أنك أرسلت رقم الجهاز الصحيح.',
  expired: 'انتهت صلاحية هذا المفتاح التجريبي. تواصل مع المطوّر للحصول على مفتاح جديد.',
  clock: 'تاريخ ووقت الجهاز غير صحيحين (أقدم من آخر استخدام). صحّح التاريخ ثم أعد المحاولة.',
  device: 'رقم الجهاز غير صالح.',
  recovery: 'مفاتيح الاسترداد غير مدعومة في هذا المتصفح. حدّث المتصفح أو اطلب مفتاحاً عادياً.',
  crypto: 'التشفير غير متاح في هذا المتصفح. افتح التطبيق عبر HTTPS أو localhost.'
});

const KEY_VERSION = 1;
const RECOVERY_KEY_VERSION = 2;
const TYPE_CODES = Object.freeze({ [LICENSE_TYPE.PERMANENT]: 1, [LICENSE_TYPE.TRIAL]: 2 });
const KEY_BYTES = 70;
const DEVICE_BYTES = 10;
const DAY_MS = 86_400_000;
/** Clock rollbacks smaller than this are tolerated (NTP adjustments, DST). */
const CLOCK_TOLERANCE_MS = 10 * 60_000;
export const MAX_TRIAL_DAYS = 365;
const ECDSA = Object.freeze({ name: 'ECDSA', namedCurve: 'P-256' });
const SIGN = Object.freeze({ name: 'ECDSA', hash: 'SHA-256' });
const ED25519 = Object.freeze({ name: 'Ed25519' });
/** PBKDF2 work factor for the recovery passphrase and encrypted key backups. */
export const KDF_ITERATIONS = 600_000;
const RECOVERY_SALT = 'dad-transport/license-recovery/v1';
export const MIN_RECOVERY_PASSPHRASE = 20;
export const MIN_BACKUP_PASSWORD = 12;

/* ───────────────────────── encoding ───────────────────────── */

/** Base32 alphabet without look-alike characters (no I, O, 0, 1). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base32Encode(bytes) {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * @param {string} text Alphabet characters only.
 * @returns {Uint8Array|null} null when a character is outside the alphabet.
 */
export function base32Decode(text) {
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/**
 * @param {string} text
 * @returns {string} e.g. "ABCD-EFGH-JK"
 */
const group = text => text.match(/.{1,4}/g)?.join('-') || '';

/**
 * Removes a prefix, whitespace and dashes and upper-cases the rest.
 * @param {unknown} value
 * @param {string} prefix
 * @returns {string}
 */
function compact(value, prefix) {
  return String(value ?? '').toUpperCase().replace(/[\s‎‏-]+/g, '').replace(new RegExp(`^${prefix}`), '');
}

/* ───────────────────────── device id ───────────────────────── */

/**
 * Canonical device id ("DEV-XXXX-XXXX-XXXX-XXXX") or '' when invalid.
 * Accepts lowercase, spaces and missing dashes.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDeviceId(value) {
  const body = compact(value, 'DEV');
  if (body.length !== 16 || !base32Decode(body)) return '';
  return `DEV-${group(body)}`;
}

/** @returns {string} A new random device id (80 bits). */
export function createDeviceId() {
  return `DEV-${group(base32Encode(randomBytes(DEVICE_BYTES)).slice(0, 16))}`;
}

/**
 * Returns this device's id, creating and persisting one on first use.
 * @param {Pick<Storage, 'getItem'|'setItem'>} storage
 * @returns {string}
 */
export function getDeviceId(storage) {
  const existing = normalizeDeviceId(storage.getItem(LICENSE_STORAGE_KEYS.deviceId));
  if (existing) return existing;
  const id = createDeviceId();
  storage.setItem(LICENSE_STORAGE_KEYS.deviceId, id);
  return id;
}

/* ───────────────────────── keys ───────────────────────── */

/**
 * @typedef {Object} DecodedKey
 * @property {number} version 1 = primary key, 2 = recovery key.
 * @property {'permanent'|'trial'} type
 * @property {number} expiresAt Epoch ms; 0 for permanent keys.
 * @property {number} expiresSeconds Raw value covered by the signature.
 * @property {Uint8Array} signature
 */

/**
 * Parses a key's structure (does not check the signature).
 * @param {unknown} key
 * @returns {DecodedKey|null}
 */
export function decodeKey(key) {
  const bytes = base32Decode(compact(key, 'KEY'));
  if (!bytes || bytes.length !== KEY_BYTES || (bytes[0] !== KEY_VERSION && bytes[0] !== RECOVERY_KEY_VERSION)) return null;
  const type = Object.keys(TYPE_CODES).find(name => TYPE_CODES[name] === bytes[1]);
  if (!type) return null;
  const expiresSeconds = new DataView(bytes.buffer).getUint32(2);
  if ((type === LICENSE_TYPE.TRIAL) !== (expiresSeconds > 0)) return null;
  return { version: bytes[0], type: /** @type {any} */ (type), expiresAt: expiresSeconds * 1000, expiresSeconds, signature: bytes.slice(6) };
}

/**
 * Canonical printable form of a key ("KEY-XXXX-…") or '' when malformed.
 * @param {unknown} key
 * @returns {string}
 */
export function formatKey(key) {
  return decodeKey(key) ? `KEY-${group(compact(key, 'KEY'))}` : '';
}

/**
 * @param {number} version
 * @param {string} deviceId
 * @param {string} type
 * @param {number} expiresSeconds
 * @returns {Uint8Array}
 */
const signedMessage = (version, deviceId, type, expiresSeconds) =>
  new TextEncoder().encode(`DADLIC${version}|${deviceId}|${type}|${expiresSeconds}`);

/** @returns {SubtleCrypto} */
function subtle() {
  const api = globalThis.crypto?.subtle;
  if (!api) throw Object.assign(new Error(LICENSE_MESSAGES.crypto), { reason: 'crypto' });
  return api;
}

/** @type {Map<string, Promise<CryptoKey>>} */
const verifyKeyCache = new Map();

/**
 * Imports (and caches) a P-256 or Ed25519 public key for verification.
 * @param {JsonWebKey} jwk
 * @returns {Promise<CryptoKey>}
 */
function importVerifyKey(jwk) {
  const cacheKey = `${jwk.crv}.${jwk.x}.${jwk.y || ''}`;
  if (!verifyKeyCache.has(cacheKey)) {
    const imported = jwk.crv === 'Ed25519'
      ? subtle().importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, ED25519, false, ['verify'])
      : subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, ECDSA, false, ['verify']);
    imported.catch(() => verifyKeyCache.delete(cacheKey));
    verifyKeyCache.set(cacheKey, imported);
  }
  return /** @type {Promise<CryptoKey>} */ (verifyKeyCache.get(cacheKey));
}

/* ───────────────────────── binary helpers ───────────────────────── */

/** @param {Uint8Array} bytes @returns {string} */
const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** @param {string} text @returns {Uint8Array} */
function fromBase64Url(text) {
  const binary = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/**
 * PBKDF2-SHA-256 → raw bits.
 * @param {string} secret
 * @param {Uint8Array} salt
 * @param {number} iterations
 * @param {number} bits
 * @returns {Promise<Uint8Array>}
 */
async function pbkdf2(secret, salt, iterations, bits) {
  const material = await subtle().importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, bits));
}

/**
 * @typedef {Object} KeyCheck
 * @property {boolean} ok
 * @property {'format'|'signature'|'expired'|'device'|'recovery'} [reason]
 * @property {'permanent'|'trial'} [type]
 * @property {number} [expiresAt] Epoch ms (0 = never).
 */

/**
 * Verifies a key's signature for a device and, for trials, its expiry.
 * @param {unknown} key
 * @param {string} deviceId
 * @param {{ now?: number, publicKey?: JsonWebKey }} [options]
 * @returns {Promise<KeyCheck>}
 */
export async function verifyLicenseKey(key, deviceId, { now = Date.now(), publicKey = LICENSE_PUBLIC_KEY, recoveryKey = LICENSE_RECOVERY_PUBLIC_KEY } = {}) {
  const device = normalizeDeviceId(deviceId);
  if (!device) return { ok: false, reason: 'device' };
  const decoded = decodeKey(key);
  if (!decoded) return { ok: false, reason: 'format' };
  const message = signedMessage(decoded.version, device, decoded.type, decoded.expiresSeconds);
  let valid = false;
  if (decoded.version === KEY_VERSION) {
    valid = await subtle().verify(SIGN, await importVerifyKey(publicKey), decoded.signature, message);
  } else {
    if (!recoveryKey) return { ok: false, reason: 'signature' };
    try {
      valid = await subtle().verify(ED25519, await importVerifyKey(recoveryKey), decoded.signature, message);
    } catch {
      return { ok: false, reason: 'recovery' };
    }
  }
  if (!valid) return { ok: false, reason: 'signature' };
  const result = { type: decoded.type, expiresAt: decoded.expiresAt };
  if (decoded.type === LICENSE_TYPE.TRIAL && now >= decoded.expiresAt) return { ok: false, reason: 'expired', ...result };
  return { ok: true, ...result };
}

/* ───────────────────────── device status ───────────────────────── */

/**
 * @typedef {Object} ActivationStatus
 * @property {boolean} active True when the app may be used.
 * @property {'master'|'permanent'|'trial'|'expired'|'clock'|'invalid'|'none'} state
 * @property {string} deviceId
 * @property {number} expiresAt Epoch ms (0 = never / not applicable).
 * @property {number} daysLeft Whole days remaining on a trial (rounded up).
 * @property {string} [message] Arabic explanation when not active.
 */

/**
 * Determines whether this device may use the app.
 * @param {{ storage: Pick<Storage, 'getItem'|'setItem'>, master?: boolean, now?: number, publicKey?: JsonWebKey, recoveryKey?: JsonWebKey|null }} options
 *   `master` marks the developer's own grandfathered installs (always active).
 * @returns {Promise<ActivationStatus>}
 */
export async function checkActivationStatus({ storage, master = false, now = Date.now(), publicKey = LICENSE_PUBLIC_KEY, recoveryKey = LICENSE_RECOVERY_PUBLIC_KEY }) {
  const deviceId = getDeviceId(storage);
  const base = { deviceId, expiresAt: 0, daysLeft: 0 };
  if (master) return { ...base, active: true, state: 'master' };
  const key = storage.getItem(LICENSE_STORAGE_KEYS.key);
  if (!key) return { ...base, active: false, state: 'none' };

  // Signature first (ignoring expiry), then the time checks.
  const check = await verifyLicenseKey(key, deviceId, { now: 0, publicKey, recoveryKey });
  if (!check.ok) return { ...base, active: false, state: 'invalid', message: LICENSE_MESSAGES[check.reason || 'signature'] };
  if (check.type === LICENSE_TYPE.PERMANENT) return { ...base, active: true, state: 'permanent' };

  const expiresAt = check.expiresAt || 0;
  const clock = Number(storage.getItem(LICENSE_STORAGE_KEYS.clock)) || 0;
  if (now + CLOCK_TOLERANCE_MS < clock) return { ...base, expiresAt, active: false, state: 'clock', message: LICENSE_MESSAGES.clock };
  if (now > clock) storage.setItem(LICENSE_STORAGE_KEYS.clock, String(now));
  if (now >= expiresAt) return { ...base, expiresAt, active: false, state: 'expired', message: LICENSE_MESSAGES.expired };
  return { ...base, expiresAt, active: true, state: 'trial', daysLeft: Math.ceil((expiresAt - now) / DAY_MS) };
}

/**
 * Verifies a key for this device and, when valid, stores it.
 * Invalid keys never replace a working one.
 * @param {unknown} key
 * @param {{ storage: Pick<Storage, 'getItem'|'setItem'>, now?: number, publicKey?: JsonWebKey, recoveryKey?: JsonWebKey|null }} options
 * @returns {Promise<{ ok: true, status: ActivationStatus } | { ok: false, reason: string, message: string }>}
 */
export async function activateDevice(key, { storage, now = Date.now(), publicKey = LICENSE_PUBLIC_KEY, recoveryKey = LICENSE_RECOVERY_PUBLIC_KEY }) {
  const deviceId = getDeviceId(storage);
  const clock = Number(storage.getItem(LICENSE_STORAGE_KEYS.clock)) || 0;
  if (now + CLOCK_TOLERANCE_MS < clock) return { ok: false, reason: 'clock', message: LICENSE_MESSAGES.clock };
  const check = await verifyLicenseKey(key, deviceId, { now, publicKey, recoveryKey });
  if (!check.ok) {
    const reason = check.reason || 'signature';
    return { ok: false, reason, message: LICENSE_MESSAGES[reason] };
  }
  storage.setItem(LICENSE_STORAGE_KEYS.key, formatKey(key));
  return { ok: true, status: await checkActivationStatus({ storage, now, publicKey, recoveryKey }) };
}

/* ───────────────────────── admin: key issuing ───────────────────────── */

/**
 * Creates a new signing key pair. The private key must be kept secret and
 * the public key pasted into LICENSE_PUBLIC_KEY (which invalidates old keys).
 * @returns {Promise<{ privateKey: JsonWebKey, publicKey: JsonWebKey }>}
 */
export async function generateSigningKeys() {
  const pair = await subtle().generateKey(ECDSA, true, ['sign', 'verify']);
  const [privateKey, publicKey] = await Promise.all([subtle().exportKey('jwk', pair.privateKey), subtle().exportKey('jwk', pair.publicKey)]);
  return { privateKey, publicKey: { kty: 'EC', crv: 'P-256', x: publicKey.x, y: publicKey.y } };
}

/** Marker of password-encrypted private key backups. */
export const ENCRYPTED_BACKUP_KIND = 'encrypted-private-key';

/**
 * True when a parsed key file is a password-encrypted backup.
 * @param {unknown} parsed
 * @returns {boolean}
 */
export const isEncryptedBackup = parsed => /** @type {any} */ (parsed)?.kind === ENCRYPTED_BACKUP_KIND;

/**
 * Encrypts the private key for safe off-device storage (AES-256-GCM with a
 * PBKDF2-SHA-256 key from `password`; random salt and IV per backup).
 * @param {JsonWebKey} privateJwk
 * @param {string} password At least MIN_BACKUP_PASSWORD characters.
 * @returns {Promise<Record<string, unknown>>} JSON-serializable backup document.
 */
export async function encryptPrivateKeyBackup(privateJwk, password) {
  if (typeof password !== 'string' || password.length < MIN_BACKUP_PASSWORD) {
    throw new Error(`كلمة مرور النسخة الاحتياطية يجب ألا تقل عن ${MIN_BACKUP_PASSWORD} حرفاً.`);
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const aesKey = await subtle().importKey('raw', await pbkdf2(password, salt, KDF_ITERATIONS, 256), 'AES-GCM', false, ['encrypt']);
  const plaintext = new TextEncoder().encode(JSON.stringify({ kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, d: privateJwk.d }));
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext));
  return {
    app: 'dad-transport-license',
    kind: ENCRYPTED_BACKUP_KIND,
    version: 1,
    createdAt: new Date().toISOString(),
    publicKey: { kty: 'EC', crv: 'P-256', x: privateJwk.x, y: privateJwk.y },
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: toBase64Url(salt) },
    cipher: { name: 'AES-GCM', iv: toBase64Url(iv) },
    data: toBase64Url(ciphertext)
  };
}

/**
 * Decrypts a backup made by encryptPrivateKeyBackup.
 * @param {Record<string, any>} backup
 * @param {string} password
 * @returns {Promise<JsonWebKey>}
 */
async function decryptPrivateKeyBackup(backup, password) {
  const iterations = Number(backup?.kdf?.iterations);
  if (backup?.kdf?.name !== 'PBKDF2' || backup?.cipher?.name !== 'AES-GCM' || !Number.isInteger(iterations) || iterations < 100_000) {
    throw new Error('ملف النسخة المشفّرة تالف أو غير مدعوم.');
  }
  let plaintext;
  try {
    const aesKey = await subtle().importKey('raw', await pbkdf2(password, fromBase64Url(backup.kdf.salt), iterations, 256), 'AES-GCM', false, ['decrypt']);
    plaintext = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64Url(backup.cipher.iv) }, aesKey, fromBase64Url(backup.data));
  } catch {
    throw new Error('كلمة المرور غير صحيحة أو الملف تالف.');
  }
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/**
 * Loads the developer's private key: a raw JWK, the saved key file, or a
 * password-encrypted backup (pass `password`).
 * @param {unknown} input Parsed JSON or JSON text.
 * @param {{ publicKey?: JsonWebKey, password?: string }} [options]
 * @returns {Promise<{ signingKey: CryptoKey, matchesApp: boolean, jwk: JsonWebKey }>}
 *   `matchesApp` is false when keys signed with it will not verify in this app build;
 *   `jwk` is kept only so the admin tool can re-export a backup.
 */
export async function importSigningKey(input, { publicKey = LICENSE_PUBLIC_KEY, password } = {}) {
  let parsed = input;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { throw new Error('ملف المفتاح الخاص ليس JSON صالحاً.'); }
  }
  if (isEncryptedBackup(parsed)) {
    if (!password) throw Object.assign(new Error('هذه نسخة مشفّرة. أدخل كلمة مرورها ثم أعد التحميل.'), { code: 'password-required' });
    parsed = await decryptPrivateKeyBackup(/** @type {any} */ (parsed), password);
  }
  const jwk = /** @type {any} */ (parsed)?.privateKey ?? parsed;
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string' || !jwk.x || !jwk.y) {
    throw new Error('هذا ليس مفتاح توقيع خاصاً صالحاً (ECDSA P-256).');
  }
  const clean = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
  let signingKey;
  try {
    signingKey = await subtle().importKey('jwk', clean, ECDSA, false, ['sign']);
  } catch {
    throw new Error('هذا ليس مفتاح توقيع خاصاً صالحاً (ECDSA P-256).');
  }
  return { signingKey, matchesApp: jwk.x === publicKey.x && jwk.y === publicKey.y, jwk: clean };
}

/* ───────────────────────── admin: emergency recovery key ───────────────────────── */

/**
 * Canonical form of a recovery passphrase (Unicode NFKC, single spaces).
 * @param {unknown} passphrase
 * @returns {string}
 */
export const normalizePassphrase = passphrase => String(passphrase ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

/**
 * Re-derives the emergency recovery signing key from the developer's passphrase
 * (PBKDF2-SHA-256 → 32-byte Ed25519 seed). Deterministic: the same passphrase
 * yields the same key on any computer, with no files needed.
 * @param {string} passphrase At least MIN_RECOVERY_PASSPHRASE characters.
 * @param {{ recoveryKey?: JsonWebKey|null }} [options]
 * @returns {Promise<{ signingKey: CryptoKey, publicKey: { kty: 'OKP', crv: 'Ed25519', x: string }, matchesApp: boolean }>}
 */
export async function deriveRecoveryKey(passphrase, { recoveryKey = LICENSE_RECOVERY_PUBLIC_KEY } = {}) {
  const phrase = normalizePassphrase(passphrase);
  if (phrase.length < MIN_RECOVERY_PASSPHRASE || new Set(phrase.replace(/ /g, '')).size < 8) {
    throw new Error(`عبارة الاسترداد يجب ألا تقل عن ${MIN_RECOVERY_PASSPHRASE} حرفاً ومتنوعة (مثلاً 5 كلمات عشوائية).`);
  }
  const seed = await pbkdf2(phrase, new TextEncoder().encode(RECOVERY_SALT), KDF_ITERATIONS, 256);
  // PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410).
  const der = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
  let extractable;
  try {
    extractable = await subtle().importKey('pkcs8', der, ED25519, true, ['sign']);
  } catch {
    throw new Error(LICENSE_MESSAGES.recovery);
  }
  const { x } = await subtle().exportKey('jwk', extractable);
  const signingKey = await subtle().importKey('pkcs8', der, ED25519, false, ['sign']);
  seed.fill(0);
  der.fill(0);
  const publicKey = { kty: /** @type {const} */ ('OKP'), crv: /** @type {const} */ ('Ed25519'), x: String(x) };
  return { signingKey, publicKey, matchesApp: Boolean(recoveryKey) && recoveryKey.x === publicKey.x };
}

/**
 * Issues an activation key for a device.
 * @param {CryptoKey} signingKey From importSigningKey or deriveRecoveryKey.
 * @param {string} deviceId
 * @param {{ type: 'permanent'|'trial', days?: number, now?: number }} options
 * @returns {Promise<{ key: string, type: 'permanent'|'trial', expiresAt: number }>}
 */
export async function issueLicenseKey(signingKey, deviceId, { type, days = 7, now = Date.now() }) {
  const device = normalizeDeviceId(deviceId);
  if (!device) throw new Error(LICENSE_MESSAGES.device);
  if (!(type in TYPE_CODES)) throw new Error('نوع الترخيص غير صالح.');
  let expiresSeconds = 0;
  if (type === LICENSE_TYPE.TRIAL) {
    if (!Number.isInteger(days) || days < 1 || days > MAX_TRIAL_DAYS) throw new Error(`مدة التجربة يجب أن تكون من 1 إلى ${MAX_TRIAL_DAYS} يوماً.`);
    expiresSeconds = Math.floor((now + days * DAY_MS) / 1000);
  }
  const recovery = signingKey.algorithm?.name === 'Ed25519';
  const version = recovery ? RECOVERY_KEY_VERSION : KEY_VERSION;
  const signature = new Uint8Array(await subtle().sign(recovery ? ED25519 : SIGN, signingKey, signedMessage(version, device, type, expiresSeconds)));
  const bytes = new Uint8Array(KEY_BYTES);
  bytes[0] = version;
  bytes[1] = TYPE_CODES[type];
  new DataView(bytes.buffer).setUint32(2, expiresSeconds);
  bytes.set(signature, 6);
  return { key: `KEY-${group(base32Encode(bytes))}`, type, expiresAt: expiresSeconds * 1000 };
}
