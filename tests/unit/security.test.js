/**
 * PIN handling, output escaping, and static checks over the source tree:
 * no unsafe HTML sinks, every relative import resolves, and the service worker
 * precaches every runtime file.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCKOUT_MS, MAX_ATTEMPTS, MAX_LOCKOUT_MS, createPinRecord, isPinRecord, isValidPin, lockoutRemaining,
  registerFailure, verifyPin
} from '../../src/core/security.js';
import { escapeHtml } from '../../src/core/dom.js';
import { buildPrintableHtml, toCSV } from '../../src/core/export.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(ROOT, 'src');

/** @returns {string[]} absolute paths of every file under dir */
const walk = dir => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
const sourceFiles = walk(SRC).filter(file => file.endsWith('.js'));

describe('PIN security', () => {
  test('PINs are salted PBKDF2 hashes that verify only the right PIN', async () => {
    const record = await createPinRecord('482913');
    assert.ok(isPinRecord(record));
    assert.ok(!JSON.stringify(record).includes('482913'), 'plain PIN must never be stored');
    assert.ok(await verifyPin('482913', record));
    assert.equal(await verifyPin('482914', record), false);
    assert.equal(await verifyPin('', record), false);
    const again = await createPinRecord('482913');
    assert.notEqual(again.salt, record.salt);
    assert.notEqual(again.hash, record.hash);
  });
  test('malformed or weakened records are rejected', async () => {
    const record = await createPinRecord('1234');
    assert.equal(isPinRecord({ ...record, iterations: 1000 }), false);
    assert.equal(isPinRecord({ ...record, hash: 'zz' }), false);
    await assert.rejects(verifyPin('1234', /** @type {any} */ ({ ...record, algorithm: 'MD5' })));
  });
  test('only 4–8 digit PINs are valid', () => {
    for (const pin of ['1234', '12345678']) assert.ok(isValidPin(pin));
    for (const pin of ['123', '123456789', '12a4', 1234, ' 1234']) assert.equal(isValidPin(pin), false);
  });
  test('lockouts start after MAX_ATTEMPTS and escalate up to the ceiling', () => {
    const now = 1_000_000;
    let attempts;
    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      attempts = registerFailure(attempts, now);
      assert.equal(lockoutRemaining(attempts, now), 0);
    }
    attempts = registerFailure(attempts, now);
    assert.equal(lockoutRemaining(attempts, now), LOCKOUT_MS);
    const durations = [];
    for (let round = 0; round < 12; round += 1) {
      for (let i = 0; i < MAX_ATTEMPTS; i += 1) attempts = registerFailure(attempts, now);
      durations.push(lockoutRemaining(attempts, now));
    }
    assert.equal(durations[0], LOCKOUT_MS * 2);
    assert.equal(durations[1], LOCKOUT_MS * 4);
    assert.equal(Math.max(...durations), MAX_LOCKOUT_MS);
    assert.equal(lockoutRemaining(attempts, now + MAX_LOCKOUT_MS), 0);
  });
});

describe('output escaping', () => {
  const payload = '<img src=x onerror=alert(1)>"\'&';
  test('escapeHtml neutralizes markup', () => {
    assert.equal(escapeHtml(payload), '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;');
  });
  test('printable reports escape every user-provided string and lock down scripts', () => {
    const html = buildPrintableHtml({
      title: payload, subtitle: payload, company: { name: payload, taxNumber: payload, phone: payload },
      meta: [{ label: payload, value: payload }], summary: [{ label: payload, value: payload }],
      sections: [{ title: payload, columns: [{ header: payload }], rows: [[payload]], footer: [[payload]], empty: payload }],
      notes: payload
    });
    assert.ok(!html.includes('<img'), 'raw markup must not survive');
    assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  });
  test('CSV export neutralizes spreadsheet formula injection', () => {
    const csv = toCSV([{ header: 'name', value: row => row }], ['=HYPERLINK("http://evil")', '+1', '-2', '@SUM(A1)', 'safe']);
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    assert.deepEqual(lines.slice(1), ['"\'=HYPERLINK(""http://evil"")"', "'+1", "'-2", "'@SUM(A1)", 'safe']);
  });
});

describe('source tree integrity', () => {
  test('no unsafe HTML or code-evaluation sinks are used', () => {
    const sink = /\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML\s*\(|document\.write\s*\(|\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`]/;
    for (const file of sourceFiles) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(code, sink, relative(ROOT, file));
    }
  });
  test('every relative import resolves to an existing file', () => {
    const importRe = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let count = 0;
    for (const file of sourceFiles) {
      for (const match of readFileSync(file, 'utf8').matchAll(importRe)) {
        const target = resolve(dirname(file), match[1] || match[2]);
        assert.ok(existsSync(target), `${relative(ROOT, file)} → ${match[1] || match[2]}`);
        count += 1;
      }
    }
    assert.ok(count > 30, `expected many imports, found ${count}`);
  });
  test('index.html loads the app as an ES module entry point', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /<script type="module" src="\.\/src\/app\.js"><\/script>/);
    assert.match(html, /http-equiv="Content-Security-Policy"/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts (CSP forbids them)');
  });
  test('the service worker precaches every runtime file', () => {
    const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    const listed = new Set([...sw.matchAll(/'\.\/([^']*)'/g)].map(match => match[1]));
    const required = [
      ...walk(SRC), ...walk(join(ROOT, 'assets')), join(ROOT, 'index.html'), join(ROOT, 'manifest.json')
    ].map(file => relative(ROOT, file).split('\\').join('/'));
    for (const path of required) assert.ok(listed.has(path), `sw.js CORE_FILES is missing ./${path}`);
    for (const path of listed) if (path) assert.ok(existsSync(join(ROOT, path)), `sw.js lists missing file ./${path}`);
  });
  test('the root directory only holds the deployable app (plus tests)', () => {
    const allowed = new Set(['assets', 'legacy-backup', 'src', 'tests', 'index.html', 'manifest.json', 'sw.js', '.git', '.gitignore']);
    const extra = readdirSync(ROOT).filter(name => !allowed.has(name));
    assert.deepEqual(extra, []);
  });
});
