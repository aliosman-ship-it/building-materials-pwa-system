/**
 * Offline licensing: signed keys, device binding, trials, clock rollback,
 * persistence mirroring and grandfathering. Uses a throwaway test key pair,
 * never the developer's real private key.
 */

import 'fake-indexeddb/auto';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LICENSE_PUBLIC_KEY, LICENSE_STORAGE_KEYS, activateDevice, base32Decode, base32Encode, checkActivationStatus,
  createDeviceId, decodeKey, formatKey, generateSigningKeys, getDeviceId, importSigningKey, issueLicenseKey,
  normalizeDeviceId, verifyLicenseKey
} from '../../src/core/license.js';
import { LICENSE_SETTINGS, openLicenseStorage, resolveMasterInstall } from '../../src/js/license-storage.js';
import { Database } from '../../src/js/storage-adapter.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-11T08:00:00Z');

class MemoryStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
}

let publicKey;
let signingKey;
before(async () => {
  const pair = await generateSigningKeys();
  publicKey = pair.publicKey;
  ({ signingKey } = await importSigningKey({ privateKey: pair.privateKey }, { publicKey }));
});

describe('encoding and device ids', () => {
  test('base32 round-trips arbitrary bytes', () => {
    for (let length = 0; length < 80; length += 7) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 255);
      assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
    }
    assert.equal(base32Decode('ABC0'), null, 'look-alike characters are rejected');
  });
  test('device ids are random, canonical and forgiving to input', () => {
    const id = createDeviceId();
    assert.match(id, /^DEV-[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    assert.notEqual(createDeviceId(), id);
    assert.equal(normalizeDeviceId(` ${id.toLowerCase().replace(/-/g, ' ')} `), id);
    assert.equal(normalizeDeviceId('DEV-1234'), '');
  });
  test('getDeviceId persists the id once', () => {
    const storage = new MemoryStorage();
    const id = getDeviceId(storage);
    assert.equal(getDeviceId(storage), id);
    assert.equal(storage.getItem(LICENSE_STORAGE_KEYS.deviceId), id);
  });
});

describe('signed activation keys', () => {
  const device = createDeviceId();

  test('a permanent key verifies only for its device', async () => {
    const { key } = await issueLicenseKey(signingKey, device, { type: 'permanent', now: NOW });
    assert.match(key, /^KEY-[A-Z2-9]{4}(-[A-Z2-9]{1,4})+$/);
    assert.deepEqual(await verifyLicenseKey(key, device, { publicKey, now: NOW + 3650 * DAY }), { ok: true, type: 'permanent', expiresAt: 0 });
    assert.equal((await verifyLicenseKey(key, createDeviceId(), { publicKey })).reason, 'signature');
  });
  test('keys tolerate lowercase, spaces and line breaks', async () => {
    const { key } = await issueLicenseKey(signingKey, device, { type: 'permanent' });
    const messy = `  ${key.toLowerCase().replace(/-/g, ' ').replace(/(.{30})/g, '$1\n')} `;
    assert.equal((await verifyLicenseKey(messy, device, { publicKey })).ok, true);
    assert.equal(formatKey(messy), key);
  });
  test('trial keys expire at their absolute expiry time', async () => {
    const { key, expiresAt } = await issueLicenseKey(signingKey, device, { type: 'trial', days: 7, now: NOW });
    assert.equal(expiresAt, Math.floor((NOW + 7 * DAY) / 1000) * 1000);
    assert.equal((await verifyLicenseKey(key, device, { publicKey, now: NOW + 6 * DAY })).ok, true);
    assert.equal((await verifyLicenseKey(key, device, { publicKey, now: expiresAt })).reason, 'expired');
  });
  test('any tampering breaks the signature', async () => {
    const { key } = await issueLicenseKey(signingKey, device, { type: 'trial', days: 3, now: NOW });
    const body = key.slice(4).replace(/-/g, '');
    const bytes = base32Decode(body);
    for (const index of [3, 5, 20, 69]) {
      const forged = bytes.slice();
      forged[index] ^= 1;
      const result = await verifyLicenseKey(`KEY-${base32Encode(forged)}`, device, { publicKey, now: NOW });
      assert.equal(result.ok, false, `byte ${index}`);
    }
    // Turning a trial into a permanent key (type byte + zero expiry) is rejected.
    const upgraded = bytes.slice();
    upgraded[1] = 1;
    upgraded.fill(0, 2, 6);
    assert.equal((await verifyLicenseKey(`KEY-${base32Encode(upgraded)}`, device, { publicKey })).reason, 'signature');
  });
  test('keys signed by another private key are rejected', async () => {
    const foreign = await generateSigningKeys();
    const { signingKey: other, matchesApp } = await importSigningKey(foreign.privateKey, { publicKey });
    assert.equal(matchesApp, false);
    const { key } = await issueLicenseKey(other, device, { type: 'permanent' });
    assert.equal((await verifyLicenseKey(key, device, { publicKey })).reason, 'signature');
  });
  test('malformed input is reported as a format error', async () => {
    for (const key of ['', 'KEY-ABCD-EFGH', 'hello', 'KEY-' + 'A'.repeat(112)]) {
      assert.equal((await verifyLicenseKey(key, device, { publicKey })).reason, 'format', key);
    }
    assert.equal(decodeKey(null), null);
  });
  test('issuing validates inputs', async () => {
    await assert.rejects(issueLicenseKey(signingKey, 'nope', { type: 'permanent' }));
    await assert.rejects(issueLicenseKey(signingKey, device, { type: 'trial', days: 0 }));
    await assert.rejects(issueLicenseKey(signingKey, device, { type: 'gold' }));
    await assert.rejects(importSigningKey('{"kty":"EC","crv":"P-256","x":"a","y":"b"}'), /مفتاح توقيع/);
  });
  test('the embedded public key is a valid P-256 key', async () => {
    const key = await globalThis.crypto.subtle.importKey('jwk', LICENSE_PUBLIC_KEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.equal(key.type, 'public');
    const source = readFileSync(new URL('../../src/core/license.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /"d"\s*:|\bd:\s*'/, 'no private key material in the app');
    assert.doesNotMatch(source, /DEVELOPER_SECRET/);
  });
});

describe('device activation status', () => {
  test('a fresh device is locked until a valid key is entered', async () => {
    const storage = new MemoryStorage();
    const status = await checkActivationStatus({ storage, publicKey, now: NOW });
    assert.deepEqual([status.active, status.state], [false, 'none']);

    const bad = await activateDevice('KEY-AAAA', { storage, publicKey, now: NOW });
    assert.equal(bad.ok, false);
    assert.equal(storage.getItem(LICENSE_STORAGE_KEYS.key), null, 'invalid keys are never stored');

    const { key } = await issueLicenseKey(signingKey, status.deviceId, { type: 'permanent' });
    const good = await activateDevice(key, { storage, publicKey, now: NOW });
    assert.equal(good.ok, true);
    assert.equal(good.status.state, 'permanent');
    assert.equal((await checkActivationStatus({ storage, publicKey, now: NOW + 9999 * DAY })).active, true);
  });
  test('a trial counts down, then locks automatically', async () => {
    const storage = new MemoryStorage();
    const deviceId = getDeviceId(storage);
    const { key } = await issueLicenseKey(signingKey, deviceId, { type: 'trial', days: 3, now: NOW });
    assert.equal((await activateDevice(key, { storage, publicKey, now: NOW + DAY / 2 })).ok, true);
    const midway = await checkActivationStatus({ storage, publicKey, now: NOW + DAY + 1 });
    assert.deepEqual([midway.state, midway.daysLeft], ['trial', 2]);
    const after = await checkActivationStatus({ storage, publicKey, now: NOW + 3 * DAY + 1000 });
    assert.deepEqual([after.active, after.state], [false, 'expired']);
    assert.equal((await activateDevice(key, { storage, publicKey, now: NOW + 4 * DAY })).reason, 'expired', 'an expired trial cannot be re-entered');
  });
  test('winding the clock back does not extend a trial', async () => {
    const storage = new MemoryStorage();
    const deviceId = getDeviceId(storage);
    const { key } = await issueLicenseKey(signingKey, deviceId, { type: 'trial', days: 7, now: NOW });
    await activateDevice(key, { storage, publicKey, now: NOW });
    await checkActivationStatus({ storage, publicKey, now: NOW + 5 * DAY });
    const rolledBack = await checkActivationStatus({ storage, publicKey, now: NOW + DAY });
    assert.deepEqual([rolledBack.active, rolledBack.state], [false, 'clock']);
    assert.equal((await checkActivationStatus({ storage, publicKey, now: NOW + 5 * DAY + 60_000 })).active, true, 'recovers once the clock is right');
  });
  test('a key copied from another device does not activate this one', async () => {
    const storage = new MemoryStorage();
    const { key } = await issueLicenseKey(signingKey, createDeviceId(), { type: 'permanent' });
    storage.setItem(LICENSE_STORAGE_KEYS.key, key);
    const status = await checkActivationStatus({ storage, publicKey });
    assert.deepEqual([status.active, status.state], [false, 'invalid']);
  });
  test('master installs are always active', async () => {
    const status = await checkActivationStatus({ storage: new MemoryStorage(), master: true, publicKey });
    assert.deepEqual([status.active, status.state], [true, 'master']);
  });
});

describe('license persistence', () => {
  let counter = 0;
  const openDb = () => Database.open({ name: `license_test_${process.pid}_${counter++}` });

  test('values are mirrored so clearing localStorage keeps the activation', async () => {
    const db = await openDb();
    const local = new MemoryStorage();
    const storage = await openLicenseStorage(db, { local });
    const deviceId = getDeviceId(storage);
    const { key } = await issueLicenseKey(signingKey, deviceId, { type: 'permanent' });
    await activateDevice(key, { storage, publicKey });
    await new Promise(done => setTimeout(done, 20));

    const restored = await openLicenseStorage(db, { local: new MemoryStorage() });
    assert.equal(getDeviceId(restored), deviceId);
    assert.equal((await checkActivationStatus({ storage: restored, publicKey })).state, 'permanent');
    db.close();
  });
  test('the trial clock keeps the later of the two copies', async () => {
    const db = await openDb();
    await db.setSetting(LICENSE_SETTINGS.clock, String(NOW + 5 * DAY));
    const storage = await openLicenseStorage(db, { local: new MemoryStorage({ [LICENSE_STORAGE_KEYS.clock]: String(NOW) }) });
    assert.equal(storage.getItem(LICENSE_STORAGE_KEYS.clock), String(NOW + 5 * DAY));
    db.close();
  });
  test('installs that already hold data are grandfathered, fresh ones are not', async () => {
    const existing = await openDb();
    await existing.clients.add({ name: 'أ', createdAt: '' });
    assert.equal(await resolveMasterInstall(existing), true);
    assert.equal(await resolveMasterInstall(existing), true, 'stays master');
    existing.close();

    const fresh = await openDb();
    assert.equal(await resolveMasterInstall(fresh), false);
    await fresh.clients.add({ name: 'ب', createdAt: '' });
    assert.equal(await resolveMasterInstall(fresh), false, 'adding data later never grants master');
    fresh.close();

    const legacy = await openDb();
    assert.equal(await resolveMasterInstall(legacy, { hasLegacyData: true }), true);
    legacy.close();
  });
  test('license settings never leave the device in a backup', async () => {
    const db = await openDb();
    const storage = await openLicenseStorage(db, { local: new MemoryStorage() });
    getDeviceId(storage);
    await resolveMasterInstall(db, { hasLegacyData: true });
    await new Promise(done => setTimeout(done, 20));
    const keys = (await db.exportBackup()).data.settings.map(row => row.key);
    assert.ok(!keys.some(key => key.startsWith('_license')), keys.join(','));
    db.close();
  });
});
