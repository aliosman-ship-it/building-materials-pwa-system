/**
 * End-to-end smoke test in a real browser (system Firefox via puppeteer-core).
 *
 * Serves the project root over HTTP, then exercises: boot with zero console
 * errors, client price lists, the ledger's client-scoped material dropdown and
 * VAT deduction, the payment dialog, the tax calculator, the collapsible
 * sidebar, layout at phone/tablet/desktop widths, DOM sanitization, and a full
 * offline reload served by the service worker.
 *
 * Licensing: a fresh browser profile is a new, unlicensed device. With the
 * developer's private key file available (LICENSE_PRIVATE_KEY, default
 * ~/DAD_LICENSE_PRIVATE_KEY.json) the test issues a real key through the
 * #admin-keygen tool; without it the device is unlocked via grandfathering.
 *
 * Usage: npm run test:e2e   (FIREFOX_PATH overrides /usr/bin/firefox)
 */

import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { encryptPrivateKeyBackup } from '../../src/core/license.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SHOTS = join(HERE, 'screenshots');
const CLIENT = 'مؤسسة الاختبار';
const OTHER_CLIENT = 'شركة النخبة';
const OWNER_COMPANY = 'شركة علي عثمان لتوريد مواد البناء والنقليات';
const PLACEHOLDER_COMPANY = 'اسم الشركة';
const CUSTOMER_COMPANY = 'مؤسسة الاختبار لمواد البناء';
const PRIVATE_KEY_FILE = process.env.LICENSE_PRIVATE_KEY || join(homedir(), 'DAD_LICENSE_PRIVATE_KEY.json');
const HAS_PRIVATE_KEY = existsSync(PRIVATE_KEY_FILE);
/** A recovery key from a throwaway e2e passphrase verifies against the app only if that phrase were configured. */
const L_RECOVERY_CONFIGURED = false;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon' };

/* ───────────── static server with an on/off switch to simulate going offline ───────────── */

let online = true;
const sockets = new Set();
const server = http.createServer((req, res) => {
  if (!online) { req.socket.destroy(); return; }
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(ROOT, path);
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!file.startsWith(ROOT) || /[/\\](tests|legacy-backup|\.git)([/\\]|$)/.test(file.slice(ROOT.length))) throw new Error('forbidden');
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const BASE = `http://localhost:${server.address().port}`;

/* ───────────── browser ───────────── */

const browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.FIREFOX_PATH || '/usr/bin/firefox', headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(15_000);
await page.setViewport({ width: 1280, height: 900 });
mkdirSync(SHOTS, { recursive: true });

const consoleErrors = [];
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));

const results = [];
/** Runs one named check and records its outcome. */
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  ✖ ${name}\n      ${String(error?.stack || error).split('\n').slice(0, 4).join('\n      ')}`);
    await page.screenshot({ path: join(SHOTS, `fail-${results.length}.png`) }).catch(() => undefined);
  }
}

const sleep = ms => new Promise(done => setTimeout(done, ms));
const go = async hash => {
  await page.evaluate(target => { location.hash = target; }, hash);
  const path = hash.split('?')[0];
  await page.waitForFunction(target => location.hash.split('?')[0] === target && !document.querySelector('#app-outlet .view-loading') && document.querySelector('#app-outlet .page-header'), {}, path);
};
const value = selector => page.$eval(selector, el => /** @type {HTMLInputElement} */ (el).value);
// Focus first: leaving the previous field may legitimately auto-fill this one.
const setValue = async (selector, text) => {
  await page.focus(selector);
  await page.$eval(selector, el => { el.value = ''; });
  await page.type(selector, text);
};
const lastToast = () => page.$$eval('.toast .toast-text', nodes => nodes.map(node => node.textContent).at(-1) || '');
const waitToast = pattern => page.waitForFunction(source => [...document.querySelectorAll('.toast .toast-text')].some(node => new RegExp(source).test(node.textContent)), {}, pattern.source);
// Toasts float above the bottom of the page; clear them so clicks reach the controls underneath.
const clearToasts = () => page.evaluate(() => document.querySelectorAll('.toast').forEach(node => node.remove()));
const noHorizontalOverflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

console.log(`DAD Transport e2e — ${await browser.version()} @ ${BASE}`);

let deviceId = '';
await step('a fresh device is blocked by the activation screen', async () => {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('#activation-screen');
  assert.equal(await page.$eval('#app-shell', el => el.inert), true, 'app shell is inert');
  assert.equal(await page.$('#app-outlet .page-header'), null, 'no screen renders behind the gate');
  deviceId = await page.$eval('#activation-screen .device-id', el => el.value);
  assert.match(deviceId, /^DEV-[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.equal(await page.$('#activation-screen .license-company'), null, 'no placeholder company name on a new device');
  await page.type('#activation-screen textarea', 'KEY-ABCD-EFGH-JKLM');
  await page.click('#activation-screen [type="submit"]');
  await page.waitForFunction(() => /صيغة المفتاح/.test(document.querySelector('#activation-screen .license-form .license-error')?.textContent || ''));
  assert.equal(await page.$eval('#activation-screen .license-form .license-error', el => getComputedStyle(el).color), 'rgb(185, 28, 28)', 'errors render in red');
  await page.screenshot({ path: join(SHOTS, 'activation-screen.png') });
});

await step('service worker installs and controls the page', async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
});

if (HAS_PRIVATE_KEY) {
  await step('admin key generator issues a trial key that unlocks the device', async () => {
    await page.evaluate(() => { location.hash = '#admin-keygen'; });
    await page.waitForSelector('#keygen-screen');
    assert.equal(await page.$eval('#keygen-screen [type="submit"]', el => el.disabled), true, 'locked until the private key is loaded');
    // Restore admin control from a password-encrypted backup, as on a new computer.
    const keyFile = JSON.parse(readFileSync(PRIVATE_KEY_FILE, 'utf8'));
    const backup = JSON.stringify(await encryptPrivateKeyBackup(keyFile.privateKey ?? keyFile, 'e2e backup password'));
    const keyStatus = () => page.$eval('#keygen-screen [role="status"]', el => el.textContent);
    await page.$eval('#keygen-screen [data-role="private-key"]', (el, text) => { el.value = text; }, backup);
    await page.click('#keygen-screen [data-role="load-private-key"]');
    await page.waitForFunction(() => /نسخة مشفّرة/.test(document.querySelector('#keygen-screen [role="status"]')?.textContent || ''));
    await page.type('#keygen-screen [data-role="backup-password-in"]', 'wrong password here');
    await page.click('#keygen-screen [data-role="load-private-key"]');
    await page.waitForFunction(() => /كلمة المرور غير صحيحة/.test(document.querySelector('#keygen-screen [role="status"]')?.textContent || ''));
    await page.$eval('#keygen-screen [data-role="backup-password-in"]', el => { el.value = ''; });
    await page.type('#keygen-screen [data-role="backup-password-in"]', 'e2e backup password');
    await page.click('#keygen-screen [data-role="load-private-key"]');
    await page.waitForFunction(() => /مطابق/.test(document.querySelector('#keygen-screen [role="status"]')?.textContent || ''));
    assert.match(await keyStatus(), /مطابق/);
    assert.equal(await page.$eval('#keygen-screen [data-role="export-encrypted"]', el => el.closest('[hidden]') === null), true, 'backup tools appear');
    await page.type('#keygen-screen [name="deviceId"]', deviceId.toLowerCase().replace(/-/g, ' '));
    await page.click('#keygen-screen [type="submit"]');
    await page.waitForSelector('#keygen-screen [data-role="issued-key"]');
    const key = await page.$eval('#keygen-screen [data-role="issued-key"]', el => el.value);
    assert.match(key, /^KEY-/);
    assert.match(await page.$eval('#keygen-screen .callout', el => el.textContent), /ينتهي في \d{4}-\d{2}-\d{2} \d{2}:\d{2}.*تم التحقق/);
    await page.screenshot({ path: join(SHOTS, 'keygen.png') });

    // Emergency recovery: setup derives the Ed25519 key in this browser; using an
    // unconfigured phrase is refused.
    await page.evaluate(() => { document.querySelector('#keygen-screen [data-role="recovery-section"]').open = true; document.querySelectorAll('#keygen-screen [data-role="recovery-section"] details').forEach(d => { d.open = true; }); });
    await page.type('#keygen-screen [data-role="recovery-passphrase"]', 'e2e emergency recovery passphrase');
    await page.click('#keygen-screen [data-role="use-recovery"]');
    await page.waitForFunction(() => /لا توجد عبارة استرداد مُعدّة|غير صحيحة/.test(document.querySelector('#keygen-screen [data-role="recovery-section"] [role="status"]')?.textContent || ''), { timeout: 20_000 });
    await page.type('#keygen-screen [data-role="setup-passphrase"]', 'e2e emergency recovery passphrase');
    await page.type('#keygen-screen [data-role="setup-passphrase-confirm"]', 'e2e emergency recovery passphrase');
    await page.click('#keygen-screen [data-role="setup-recovery"]');
    await page.waitForFunction(() => /LICENSE_RECOVERY_PUBLIC_KEY = Object\.freeze\(\{ kty: 'OKP', crv: 'Ed25519', x: '[A-Za-z0-9_-]{43}' \}\);/.test(document.querySelector('#keygen-screen [data-role="recovery-snippet"]')?.textContent || ''), { timeout: 20_000 });
    const inBrowser = await page.evaluate(async () => {
      const L = await import('./src/core/license.js');
      const recovery = await L.deriveRecoveryKey('e2e emergency recovery passphrase');
      const device = L.createDeviceId();
      const { key } = await L.issueLicenseKey(recovery.signingKey, device, { type: 'permanent' });
      return [(await L.verifyLicenseKey(key, device, { recoveryKey: recovery.publicKey })).ok, (await L.verifyLicenseKey(key, device)).ok];
    });
    assert.deepEqual(inBrowser, [true, L_RECOVERY_CONFIGURED], 'Ed25519 recovery keys sign and verify in this browser');
    await page.click('#keygen-screen .keygen-header .icon-btn');
    await page.waitForFunction(() => !document.getElementById('keygen-screen'));

    await page.$eval('#activation-screen textarea', (el, text) => { el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); }, key);
    await page.click('#activation-screen [type="submit"]');
    await page.waitForFunction(() => !document.getElementById('activation-screen'));
    await page.waitForSelector('#app-outlet .page-header');
    assert.match(await page.$eval('#license-pill', el => (el.hidden ? '' : el.textContent)), /تجريبية · 7 يوم/);
  });
} else {
  await step('device unlocks (no private key file: skipping keygen check)', async () => {
    console.log(`      note: ${PRIVATE_KEY_FILE} not found — admin keygen flow not exercised`);
    await page.goto(`${BASE}/blank.txt`);
    await page.evaluate(() => indexedDB.deleteDatabase('dad_transport_db'));
    await page.evaluate(() => localStorage.setItem('dad_transport_clients_v1', JSON.stringify(['عميل قديم'])));
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('#app-outlet .page-header');
  });
}

await step('boots to the dashboard', async () => {
  await page.waitForSelector('#app-shell:not([hidden])');
  await page.waitForSelector('#app-outlet .page-header');
  assert.equal(await page.$eval('#boot-screen', el => el.hidden), true);
  assert.equal(await page.$eval('#app-shell', el => el.inert), false);
});

await step('uses the light theme', async () => {
  const colors = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    sidebar: getComputedStyle(document.getElementById('sidebar')).backgroundColor,
    text: getComputedStyle(document.body).color
  }));
  assert.equal(colors.body, 'rgb(248, 250, 252)');
  assert.equal(colors.sidebar, 'rgb(255, 255, 255)');
  assert.equal(colors.text, 'rgb(15, 23, 42)');
  await page.screenshot({ path: join(SHOTS, 'desktop-dashboard.png') });
});

await step('a new device shows a generic company name and serves every icon', async () => {
  assert.equal(await page.$eval('#brand-name', el => el.textContent), PLACEHOLDER_COMPANY);
  assert.match(await page.$eval('#brand-sub', el => el.textContent), /أدخل اسم شركتك/);
  assert.doesNotMatch(await page.title(), /سعد|القحطاني|علي عثمان/);
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.doesNotMatch(html + readFileSync(join(ROOT, 'manifest.json'), 'utf8'), /سعد|القحطاني|علي عثمان/, 'no client names in the static shell');
  const icons = await page.$$eval('link[rel~="icon"], link[rel="apple-touch-icon"]', links => links.map(link => [link.getAttribute('href'), link.type]));
  assert.ok(icons.length >= 4);
  for (const [href, type] of icons) {
    assert.match(href, /^\/assets\/icons\//, `${href} must be an absolute web path`);
    const response = await page.evaluate(async url => { const r = await fetch(url, { cache: 'no-store' }); return [r.status, r.headers.get('content-type')]; }, href);
    assert.deepEqual(response, [200, type], href);
  }
  const manifest = await page.evaluate(async () => (await fetch('/manifest.json')).json());
  assert.equal(manifest.name, 'نظام إدارة النقليات ومواد البناء');
});

await step('the company name is saved from Settings and shown everywhere', async () => {
  await go('#/settings');
  assert.equal(await page.$eval('#company-form [name="companyName"]', el => el.value), '', 'placeholder is not prefilled as a real value');
  assert.ok(await page.$('#company-form .callout'), 'settings prompts for the name');
  await page.type('#company-form [name="companyName"]', CUSTOMER_COMPANY);
  await page.click('#company-form [type="submit"]');
  await waitToast(/تم حفظ بيانات المنشأة/);
  await page.waitForFunction(name => document.getElementById('brand-name').textContent === name, {}, CUSTOMER_COMPANY);
  await page.reload();
  await page.waitForSelector('#app-outlet .page-header');
  assert.equal(await page.$eval('#brand-name', el => el.textContent), CUSTOMER_COMPANY, 'persists across reloads');
  assert.equal(await page.$('#company-form .callout'), null);
});

await step('footer shows clickable WhatsApp and email contacts', async () => {
  const links = await page.$$eval('.app-footer a', nodes => nodes.map(node => ({
    href: node.getAttribute('href'), text: node.querySelector('.contact-value').textContent, target: node.target,
    icon: Boolean(node.querySelector('svg.icon')), visible: node.getBoundingClientRect().height > 0
  })));
  assert.deepEqual(links.map(link => [link.href, link.text]), [
    ['https://wa.me/249117704860?text=مرحباً،%20أود%20الاستفسار%20عن%20نظام%20إدارة%20المواد%20والترحيل', '+249 11 770 4860'],
    ['mailto:tbhalryh@gmail.com', 'tbhalryh@gmail.com']
  ]);
  assert.equal(links[0].target, '_blank');
  assert.ok(links.every(link => link.icon && link.visible));
  const url = await page.$eval('.contact-whatsapp', el => el.href);
  assert.match(decodeURIComponent(url), /^https:\/\/wa\.me\/249117704860\?text=مرحباً، أود الاستفسار عن نظام إدارة المواد والترحيل$/);
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await page.screenshot({ path: join(SHOTS, 'footer-desktop.png') });
  await page.setViewport({ width: 375, height: 812 });
  await sleep(400);
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  assert.ok((await noHorizontalOverflow()) <= 1, 'footer fits a phone screen');
  await page.screenshot({ path: join(SHOTS, 'footer-mobile.png') });
  await page.setViewport({ width: 1280, height: 900 });
  await sleep(400);
});

await step('DOM builder never parses user strings as markup', async () => {
  const outcome = await page.evaluate(async () => {
    const { h, setAttr } = await import('./src/core/dom.js');
    const el = h('div', { title: '"><img src=x onerror=alert(1)>' }, '<img src=x onerror=alert(1)>');
    const refusals = [];
    for (const [name, val] of [['onclick', 'alert(1)'], ['href', 'javascript:alert(1)'], ['srcdoc', '<b>']]) {
      try { setAttr(document.createElement('a'), name, val); } catch { refusals.push(name); }
    }
    return { images: el.querySelectorAll('img').length, text: el.textContent, refusals };
  });
  assert.equal(outcome.images, 0);
  assert.equal(outcome.text, '<img src=x onerror=alert(1)>');
  assert.deepEqual(outcome.refusals, ['onclick', 'href', 'srcdoc']);
});

await step('adds a client', async () => {
  await go('#/accounts?new=1');
  await page.waitForSelector('dialog[open] input[name="name"]');
  await page.type('dialog[open] input[name="name"]', CLIENT);
  await page.click('dialog[open] .modal-footer .btn-primary');
  await waitToast(/تمت إضافة العميل/);
  await page.waitForSelector(`[data-action="pricing"][data-client="${CLIENT}"]`);
  await clearToasts();
  await page.click('[data-action="add-client"]');
  await page.waitForSelector('dialog[open] input[name="name"]');
  await page.type('dialog[open] input[name="name"]', OTHER_CLIENT);
  await page.click('dialog[open] .modal-footer .btn-primary');
  await page.waitForSelector(`[data-action="pricing"][data-client="${OTHER_CLIENT}"]`);
});

await step('client-first pricing: choose the client, then manage only its prices', async () => {
  await clearToasts();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.click('.page-header [data-action="pricing"]');
  await page.waitForSelector('dialog[open] #pricing-client');
  assert.equal(await page.$('dialog[open] #pricing-form'), null, 'no form before a client is chosen');
  assert.equal(await page.$eval('dialog[open] .modal-footer .btn-primary', el => el.disabled), true);
  await page.select('dialog[open] #pricing-client', CLIENT);
  await page.waitForSelector('dialog[open] #pricing-form');
  assert.equal(await page.$eval('dialog[open] .modal-footer .btn-primary', el => el.disabled), false);
  const saveItem = async (name, unit, price) => {
    await setValue('dialog[open] #pricing-form [name="name"]', name);
    await setValue('dialog[open] #pricing-form [name="unit"]', unit);
    await setValue('dialog[open] #pricing-form [name="defaultPrice"]', price);
    await page.click('dialog[open] .modal-footer .btn-primary');
    await waitToast(new RegExp(`تم حفظ ${name}`));
  };
  await saveItem('رمل احمر', 'تريلا 20م', '500');
  await saveItem('حجر جبلي', 'رد', '900');
  await page.click('dialog[open] button[aria-label="استبعاد دفان من قائمة العميل"]');
  await waitToast(/تم استبعاد دفان/);
  const statuses = await page.$$eval('dialog[open] tbody tr', rows => Object.fromEntries(rows.map(row => [row.cells[0].textContent, row.cells[4].textContent])));
  const units = await page.$$eval('dialog[open] tbody tr', rows => Object.fromEntries(rows.map(row => [row.cells[0].textContent, row.cells[1].textContent])));
  assert.equal(units['رمل احمر'], 'تريلا 20م');
  assert.equal(units['حجر جبلي'], 'رد');
  assert.equal(statuses['رمل احمر'], 'سعر خاص');
  assert.equal(statuses['حجر جبلي'], 'مادة خاصة');
  assert.equal(statuses['دفان'], 'مستبعدة');
  await page.screenshot({ path: join(SHOTS, 'desktop-price-list.png') });
  // Switching the dropdown shows the other client's untouched list.
  await page.select('dialog[open] #pricing-client', OTHER_CLIENT);
  const other = await page.$$eval('dialog[open] tbody tr', rows => rows.map(row => [row.cells[0].textContent, row.cells[4].textContent]));
  assert.ok(other.every(([, status]) => status === 'افتراضي'), 'other client has only defaults');
  assert.ok(!other.some(([name]) => name === 'حجر جبلي'), 'client-only item stays with its client');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
});

await step('ledger material dropdown and price follow the selected client', async () => {
  await go('#/ledger');
  await page.select('#trip-form [name="client"]', CLIENT);
  const options = await page.$$eval('#trip-form [name="material"] option', nodes => nodes.map(node => node.value));
  assert.ok(options.includes('حجر جبلي'), 'client-only item is offered');
  assert.ok(!options.includes('دفان'), 'removed item is not offered');
  await page.select('#trip-form [name="material"]', 'رمل احمر');
  assert.equal(await value('#trip-form [name="price"]'), '500');
  await page.select('#trip-form [name="client"]', OTHER_CLIENT);
  const otherOptions = await page.$$eval('#trip-form [name="material"] option', nodes => nodes.map(node => node.value));
  assert.ok(!otherOptions.includes('حجر جبلي') && otherOptions.includes('دفان'), 'switching client swaps the list');
  await page.select('#trip-form [name="material"]', 'رمل احمر');
  assert.equal(await value('#trip-form [name="price"]'), '0', 'other client gets the default price');
  await page.select('#trip-form [name="client"]', CLIENT);
  await page.select('#trip-form [name="material"]', 'حجر جبلي');
  assert.equal(await value('#trip-form [name="price"]'), '900');
  assert.match(await page.$eval('#trip-form [name="price"]', el => [...el.closest('.field').querySelectorAll('.field-hint')].at(-1).textContent), /سعر خاص بالعميل/);
});

await step('month filter lists only months that have movements', async () => {
  const before = await page.$$eval('[data-filter="month"] option', nodes => nodes.map(node => [node.value, node.textContent]));
  assert.deepEqual(before, [['', 'جميع الأشهر']], 'no movements yet → only "all months"');
  assert.equal(await page.$eval('[data-filter="month"]', el => el.tagName), 'SELECT');
});

await step('inline VAT deduction sets the net unit price before saving', async () => {
  await clearToasts();
  await setValue('#trip-form [name="price"]', '575');
  await page.click('#trip-form [data-role="vat-deduct"]');
  assert.equal(await value('#trip-form [name="price"]'), '500');
  await page.type('#trip-form [name="truck"]', '7788 ر س ع');
  await page.click('#trip-form [type="submit"]');
  await waitToast(/تم حفظ نقلة حجر جبلي/);
  assert.match(await lastToast(), /500/);
});

await step('payment dialog deducts VAT from the amount', async () => {
  await clearToasts();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.click('[data-action="new-payment"]');
  await page.waitForSelector('dialog[open] [name="amount"]');
  await page.select('dialog[open] [name="client"]', CLIENT);
  await page.type('dialog[open] [name="amount"]', '1150');
  await page.click('dialog[open] [data-role="vat-deduct"]');
  assert.equal(await value('dialog[open] [name="amount"]'), '1000');
  await page.click('dialog[open] .modal-footer .btn-primary');
  await waitToast(/تم تسجيل دفعة/);
  assert.match(await lastToast(), /1,000/);
  await page.waitForFunction(() => document.querySelectorAll('#app-outlet tbody tr').length >= 2);
  // Same-day trip then payment: shown in the order they were entered.
  const kinds = await page.$$eval('#app-outlet tbody tr', rows => rows.map(row => (row.classList.contains('row-payment') ? 'payment' : 'trip')));
  assert.deepEqual(kinds, ['trip', 'payment']);
  const month = new Date().toISOString().slice(0, 7);
  const options = await page.$$eval('[data-filter="month"] option', nodes => nodes.map(node => node.value));
  assert.deepEqual(options, ['', month], 'the dropdown picks up the new month');
  await page.select('[data-filter="month"]', month);
  await page.waitForFunction(m => location.hash.includes(`month=${m}`), {}, month);
  assert.equal(await page.$$eval('#app-outlet tbody tr', rows => rows.length), 2);
  await page.select('[data-filter="month"]', '');
});

await step('tax calculator splits a VAT-inclusive total', async () => {
  await go('#/settings');
  await page.type('#calc-gross', '2300');
  const outputs = await page.$$eval('.calc-results output', nodes => nodes.map(node => node.textContent));
  assert.match(outputs[0], /300/);
  assert.match(outputs[1], /2,000/);
  await clearToasts();
  await page.click('[data-role="copy-net"]');
  await waitToast(/2000\.00/);
  await setValue('#calc-rate', '150');
  assert.equal(await page.$eval('#calc-rate', el => el.getAttribute('aria-invalid')), 'true');
});

await step('sidebar collapses to an icon rail and main expands', async () => {
  const measure = () => page.evaluate(() => ({
    sidebar: document.getElementById('sidebar').getBoundingClientRect().width,
    main: document.querySelector('.main').getBoundingClientRect().width,
    expanded: document.getElementById('menu-toggle').getAttribute('aria-expanded'),
    label: getComputedStyle(document.querySelector('.nav-label')).opacity
  }));
  const before = await measure();
  assert.ok(before.sidebar > 200, `open width ${before.sidebar}`);
  await clearToasts();
  await page.click('#menu-toggle');
  await sleep(450);
  const collapsed = await measure();
  assert.ok(collapsed.sidebar <= 80, `rail width ${collapsed.sidebar}`);
  assert.ok(collapsed.main >= 1280 - 80, `main width ${collapsed.main}`);
  assert.equal(collapsed.expanded, 'false');
  assert.equal(collapsed.label, '0');
  await page.screenshot({ path: join(SHOTS, 'desktop-collapsed.png') });
  await page.reload();
  await page.waitForSelector('#app-outlet .page-header');
  assert.ok((await measure()).sidebar <= 80, 'collapsed state persists across reloads');
  await page.click('#menu-toggle');
  await sleep(450);
  assert.ok((await measure()).sidebar > 200);
});

for (const [width, height] of [[375, 812], [768, 1024], [1024, 768], [1440, 900]]) {
  await step(`no horizontal overflow at ${width}px on every screen`, async () => {
    await page.setViewport({ width, height });
    for (const route of ['#/dashboard', '#/ledger', '#/accounts', '#/reports', '#/settings']) {
      await go(route);
      await sleep(50);
      const overflow = await noHorizontalOverflow();
      assert.ok(overflow <= 1, `${route} overflows by ${overflow}px`);
    }
    if (width === 375) await page.screenshot({ path: join(SHOTS, 'mobile-settings.png'), fullPage: true });
  });
}

await step('mobile drawer opens and closes', async () => {
  await page.setViewport({ width: 375, height: 812 });
  await go('#/ledger');
  await sleep(400); // let the 0.3s sidebar transition from the desktop layout finish
  const visible = () => page.$eval('#sidebar', el => getComputedStyle(el).visibility === 'visible' && el.getBoundingClientRect().left < window.innerWidth);
  assert.equal(await visible(), false);
  await page.click('#menu-toggle');
  await sleep(400);
  assert.equal(await visible(), true);
  await page.screenshot({ path: join(SHOTS, 'mobile-drawer.png') });
  await page.click('#sidebar-backdrop', { offset: { x: 20, y: 400 } });
  await sleep(400);
  assert.equal(await visible(), false);
  await page.click('#menu-toggle');
  await sleep(350);
  await page.click('.nav-link[data-route="/accounts"]');
  await page.waitForFunction(() => location.hash === '#/accounts' && !document.body.classList.contains('nav-open'));
  await page.setViewport({ width: 1280, height: 900 });
});

await step('client statements carry the saved company name', async () => {
  await go('#/reports?type=statement');
  assert.match(await page.$eval('#app-outlet .statement-head', el => el.textContent), new RegExp(CUSTOMER_COMPANY));
});

await step('settings shows the license and device id', async () => {
  await go('#/settings');
  const text = await page.evaluate(() => [...document.querySelectorAll('.card')].find(card => /ترخيص النظام/.test(card.textContent)).textContent);
  assert.match(text, HAS_PRIVATE_KEY ? /تجريبي — متبقٍ 7 يوم \(حتى \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/ : /نسخة المالك/);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.card .device-id')].map(el => el.value)[0]), deviceId);
});

await step('existing installs are grandfathered as master (separate browser profile)', async () => {
  const context = await browser.createBrowserContext();
  const other = await context.newPage();
  other.on('console', message => { if (message.type() === 'error') consoleErrors.push(`[master] ${message.text()}`); });
  other.on('pageerror', error => consoleErrors.push(`[master] pageerror: ${error.message}`));
  await other.goto(`${BASE}/blank.txt`);
  await other.evaluate(() => localStorage.setItem('dad_transport_clients_v1', JSON.stringify(['عميل من النسخة القديمة'])));
  await other.goto(`${BASE}/index.html#/settings`);
  await other.waitForSelector('#app-outlet .page-header');
  assert.equal(await other.$('#activation-screen'), null);
  assert.match(await other.evaluate(() => document.body.textContent), /مفعّل — نسخة المالك/);
  assert.equal(await other.$eval('#brand-name', el => el.textContent), OWNER_COMPANY, "the owner's install keeps its company name");
  await context.close();
});

await step('works fully offline after the first visit', async () => {
  online = false;
  for (const socket of sockets) socket.destroy();
  await page.reload();
  await page.waitForSelector('#app-shell:not([hidden])');
  for (const route of ['#/dashboard', '#/accounts', '#/reports', '#/settings', '#/ledger']) await go(route);
  const rows = await page.$$eval('#app-outlet tbody tr', nodes => nodes.map(node => node.textContent).join(' '));
  assert.match(rows, /حجر جبلي/, 'saved trip is still there offline');
  assert.equal(await page.$('#activation-screen'), null, 'activation survives an offline reload');
  online = true;
});

await step('zero console errors across the session', async () => {
  assert.deepEqual(consoleErrors, []);
});

await browser.close();
server.close();

const failed = results.filter(result => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);
