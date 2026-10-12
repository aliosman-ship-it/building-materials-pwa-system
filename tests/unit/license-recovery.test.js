/**
 * Disaster recovery for the licensing system: password-encrypted private key
 * backups and the passphrase-derived emergency recovery key.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LICENSE_RECOVERY_PUBLIC_KEY, activateDevice, base32Decode, base32Encode, createDeviceId, deriveRecoveryKey,
  encryptPrivateKeyBackup, generateSigningKeys, importSigningKey, issueLicenseKey, verifyLicenseKey
} from '../../src/core/license.js';

const PHRASE = 'copper lantern orbit meadow seventy quiet';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
}

describe('encrypted private key backups', () => {
  let pair;
  before(async () => { pair = await generateSigningKeys(); });

  test('round-trips through the password and still signs valid keys', async () => {
    const backup = await encryptPrivateKeyBackup(pair.privateKey, 'correct horse battery');
    const text = JSON.stringify(backup);
    assert.ok(!text.includes(pair.privateKey.d), 'the private scalar never appears in clear');
    assert.equal(backup.kdf.iterations, 600_000);

    const restored = await importSigningKey(text, { password: 'correct horse battery', publicKey: pair.publicKey });
    assert.equal(restored.matchesApp, true);
    assert.equal(restored.jwk.d, pair.privateKey.d);
    const device = createDeviceId();
    const { key } = await issueLicenseKey(restored.signingKey, device, { type: 'permanent' });
    assert.equal((await verifyLicenseKey(key, device, { publicKey: pair.publicKey })).ok, true);
  });
  test('asks for a password, rejects wrong ones and detects tampering', async () => {
    const backup = await encryptPrivateKeyBackup(pair.privateKey, 'correct horse battery');
    await assert.rejects(importSigningKey(backup), err => err.code === 'password-required');
    await assert.rejects(importSigningKey(backup, { password: 'wrong password!!' }), /كلمة المرور غير صحيحة/);
    const flipped = { ...backup, data: backup.data.slice(0, -2) + (backup.data.endsWith('AA') ? 'AB' : 'AA') };
    await assert.rejects(importSigningKey(flipped, { password: 'correct horse battery' }), /كلمة المرور غير صحيحة أو الملف تالف/);
    await assert.rejects(importSigningKey({ ...backup, kdf: { ...backup.kdf, iterations: 10 } }, { password: 'x' }), /تالف أو غير مدعوم/);
  });
  test('each backup uses a fresh salt and IV; short passwords are refused', async () => {
    const [a, b] = await Promise.all([encryptPrivateKeyBackup(pair.privateKey, 'same password 1'), encryptPrivateKeyBackup(pair.privateKey, 'same password 1')]);
    assert.notEqual(a.kdf.salt, b.kdf.salt);
    assert.notEqual(a.cipher.iv, b.cipher.iv);
    await assert.rejects(encryptPrivateKeyBackup(pair.privateKey, 'short'), /12/);
  });
  test('plain key files from before still import', async () => {
    const plain = JSON.stringify({ app: 'dad-transport-license', kind: 'private', privateKey: pair.privateKey });
    assert.equal((await importSigningKey(plain, { publicKey: pair.publicKey })).matchesApp, true);
  });
});

describe('emergency recovery key', () => {
  let recovery;
  before(async () => { recovery = await deriveRecoveryKey(PHRASE); });

  test('the same passphrase derives the same key anywhere (spacing/Unicode-normalized)', async () => {
    const again = await deriveRecoveryKey(`  ${PHRASE.replace(/ /g, '   ')}\n`);
    assert.equal(again.publicKey.x, recovery.publicKey.x);
    assert.equal(again.publicKey.crv, 'Ed25519');
    const other = await deriveRecoveryKey(`${PHRASE} x`);
    assert.notEqual(other.publicKey.x, recovery.publicKey.x);
  });
  test('weak passphrases are refused', async () => {
    await assert.rejects(deriveRecoveryKey('too short'), /20/);
    await assert.rejects(deriveRecoveryKey('aaaaaaaaaaaaaaaaaaaaaaaaaa'), /20/);
  });
  test('recovery-signed keys activate a device only when the app trusts that recovery key', async () => {
    const device = createDeviceId();
    const { key } = await issueLicenseKey(recovery.signingKey, device, { type: 'permanent' });
    assert.equal(base32Decode(key.slice(4).replace(/-/g, ''))[0], 2, 'version byte marks a recovery key');
    assert.equal((await verifyLicenseKey(key, device, { recoveryKey: recovery.publicKey })).ok, true);
    assert.equal((await verifyLicenseKey(key, device, { recoveryKey: null })).reason, 'signature', 'disabled when not configured');
    assert.equal((await verifyLicenseKey(key, createDeviceId(), { recoveryKey: recovery.publicKey })).reason, 'signature', 'still device-bound');
    const other = await deriveRecoveryKey('a completely different passphrase here');
    assert.equal((await verifyLicenseKey(key, device, { recoveryKey: other.publicKey })).reason, 'signature');
  });
  test('recovery trials expire and cannot be relabelled as primary keys', async () => {
    const device = createDeviceId();
    const now = Date.parse('2026-10-11T00:00:00Z');
    const { key } = await issueLicenseKey(recovery.signingKey, device, { type: 'trial', days: 3, now });
    assert.equal((await verifyLicenseKey(key, device, { recoveryKey: recovery.publicKey, now: now + 4 * 86_400_000 })).reason, 'expired');
    const bytes = base32Decode(key.slice(4).replace(/-/g, ''));
    bytes[0] = 1;
    assert.equal((await verifyLicenseKey(`KEY-${base32Encode(bytes)}`, device, { recoveryKey: recovery.publicKey })).ok, false);
  });
  test('activateDevice accepts recovery keys end to end', async () => {
    const storage = new MemoryStorage();
    storage.setItem('dad_device_id', createDeviceId());
    const { key } = await issueLicenseKey(recovery.signingKey, storage.getItem('dad_device_id'), { type: 'permanent' });
    const result = await activateDevice(key, { storage, recoveryKey: recovery.publicKey });
    assert.equal(result.ok, true);
    assert.equal(result.status.state, 'permanent');
  });
  test('the app source holds no passphrase, hash or private material', () => {
    const source = readFileSync(new URL('../../src/core/license.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bd:\s*'|"d"\s*:|passphraseHash|MASTER_KEY|bypass/i);
    assert.ok(LICENSE_RECOVERY_PUBLIC_KEY === null || /^[A-Za-z0-9_-]{43}$/.test(LICENSE_RECOVERY_PUBLIC_KEY.x));
  });
});
