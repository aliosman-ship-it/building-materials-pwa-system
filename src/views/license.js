/**
 * @module views/license
 * Licensing UI: the activation screen shown to unlicensed or expired devices,
 * the developer's key generator (#admin-keygen), and the Settings license card.
 */

import { field, h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { copyText, toast, withBusy } from '../core/ui.js';
import {
  LICENSE_MESSAGES, LICENSE_RECOVERY_PUBLIC_KEY, LICENSE_TYPE, MIN_BACKUP_PASSWORD, MIN_RECOVERY_PASSPHRASE,
  activateDevice, deriveRecoveryKey, encryptPrivateKeyBackup, generateSigningKeys, importSigningKey, issueLicenseKey,
  normalizeDeviceId, normalizePassphrase, verifyLicenseKey
} from '../core/license.js';
import { formatDateTime, formatNumber } from '../core/format.js';
import { exportJSON } from '../core/export.js';

/** @typedef {import('../core/license.js').ActivationStatus} ActivationStatus */

/**
 * Formats an epoch-ms timestamp (formatDateTime expects a Date or string).
 * @param {number} ms
 * @returns {string}
 */
const when = ms => formatDateTime(new Date(ms));

/**
 * WhatsApp share link (the sender picks the contact).
 * @param {string} text
 * @returns {string}
 */
const whatsappLink = text => `https://wa.me/?text=${encodeURIComponent(text)}`;

/**
 * Arabic one-line description of a license status.
 * @param {ActivationStatus} status
 * @returns {string}
 */
export function describeLicense(status) {
  switch (status.state) {
    case 'master': return 'مفعّل — نسخة المالك';
    case 'permanent': return 'مفعّل — ترخيص دائم';
    case 'trial': return `تجريبي — متبقٍ ${formatNumber(status.daysLeft)} يوم (حتى ${when(status.expiresAt)})`;
    case 'expired': return `انتهت الفترة التجريبية في ${when(status.expiresAt)}`;
    case 'clock': return 'تاريخ الجهاز غير صحيح';
    case 'invalid': return 'مفتاح التفعيل المحفوظ غير صالح';
    default: return 'غير مفعّل';
  }
}

/**
 * Read-only device id with copy and WhatsApp buttons.
 * @param {string} deviceId
 * @returns {HTMLElement}
 */
function deviceIdBlock(deviceId) {
  const input = /** @type {HTMLInputElement} */ (h('input', {
    class: 'input device-id', type: 'text', value: deviceId, readOnly: true, dir: 'ltr', ariaLabel: 'رقم الجهاز', spellcheck: 'false'
  }));
  return h('div', { class: 'device-id-block' },
    input,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn-primary', dataset: { role: 'copy-device-id' }, on: { click: () => copyText(deviceId, 'تم نسخ رقم الجهاز.', input) } },
        icon('file', { size: 17 }), 'نسخ رقم الجهاز'),
      h('a', { class: 'btn btn-secondary', href: whatsappLink(`طلب تفعيل نظام النقليات\nرقم الجهاز: ${deviceId}`), attrs: { target: '_blank', rel: 'noopener noreferrer' } },
        icon('upload', { size: 17 }), 'إرسال عبر واتساب')
    )
  );
}

/**
 * Activation key form. Calls `onActivated` after a valid key is stored.
 * @param {Pick<Storage, 'getItem'|'setItem'>} storage
 * @param {(status: ActivationStatus) => void} onActivated
 * @param {{ submitLabel?: string }} [options]
 * @returns {HTMLFormElement}
 */
function activationForm(storage, onActivated, { submitLabel = 'تفعيل' } = {}) {
  const keyInput = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    class: 'input license-key-input', name: 'key', rows: 4, dir: 'ltr', required: true, spellcheck: 'false',
    autocomplete: 'off', placeholder: 'KEY-XXXX-XXXX-XXXX-…'
  }));
  const error = h('p', { class: 'license-error', role: 'alert' });
  const form = /** @type {HTMLFormElement} */ (h('form', { class: 'stack license-form', novalidate: true },
    field('مفتاح التفعيل', keyInput),
    error,
    h('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block' }, icon('check'), submitLabel)
  ));
  keyInput.addEventListener('input', () => { error.textContent = ''; keyInput.removeAttribute('aria-invalid'); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const submit = /** @type {HTMLButtonElement} */ (form.querySelector('[type="submit"]'));
    withBusy(submit, async () => {
      if (!keyInput.value.trim()) {
        error.textContent = 'الصق مفتاح التفعيل أولاً.';
        keyInput.focus();
        return;
      }
      let result;
      try {
        result = await activateDevice(keyInput.value, { storage });
      } catch (failure) {
        console.error('Activation failed:', failure);
        result = { ok: false, message: /** @type {any} */ (failure)?.reason ? /** @type {any} */ (failure).message : LICENSE_MESSAGES.crypto };
      }
      if (!result.ok) {
        error.textContent = result.message;
        keyInput.setAttribute('aria-invalid', 'true');
        keyInput.focus();
        return;
      }
      keyInput.value = '';
      toast(result.status.state === 'trial' ? `تم تفعيل النسخة التجريبية — متبقٍ ${formatNumber(result.status.daysLeft)} يوم.` : 'تم تفعيل النظام بنجاح.', 'success', { duration: 6000 });
      onActivated(result.status);
    });
  });
  return form;
}

/* ───────────────────────── activation screen ───────────────────────── */

/**
 * Blocking full-screen activation gate.
 * @param {{ status: ActivationStatus, storage: Pick<Storage, 'getItem'|'setItem'>, company: string, onActivated: (status: ActivationStatus) => void }} options
 * @returns {{ close: () => void }}
 */
export function showActivationScreen({ status, storage, company, onActivated }) {
  document.getElementById('activation-screen')?.remove();
  const heading = status.state === 'expired' ? 'انتهت الفترة التجريبية'
    : status.state === 'clock' ? 'تاريخ الجهاز غير صحيح'
      : 'تفعيل النظام';
  const explanation = status.state === 'expired'
    ? `انتهت التجربة في ${when(status.expiresAt)}. بياناتك محفوظة كما هي — أرسل رقم الجهاز للمطوّر لتحصل على مفتاح تفعيل.`
    : status.state === 'none'
      ? 'هذا الجهاز غير مفعّل بعد. أرسل رقم الجهاز للمطوّر لتحصل على مفتاح التفعيل، ثم الصقه هنا.'
      : status.message || LICENSE_MESSAGES.signature;

  const screen = h('div', { id: 'activation-screen', class: 'fullscreen activation-screen', role: 'dialog', ariaModal: 'true', ariaLabelledby: 'activation-title' },
    h('div', { class: 'fullscreen-card license-card stack' },
      h('div', { class: 'brand-mark' }, icon('shield', { size: 26 })),
      h('div', {},
        h('h1', { id: 'activation-title' }, heading),
        company ? h('p', { class: 'license-company' }, company) : null
      ),
      h('p', { class: status.state === 'none' ? 'muted' : 'license-error' }, explanation),
      h('div', { class: 'license-section' },
        h('span', { class: 'field-label' }, 'رقم الجهاز'),
        deviceIdBlock(status.deviceId)
      ),
      activationForm(storage, next => {
        close();
        onActivated(next);
      }),
      h('p', { class: 'muted small' }, 'الترخيص مرتبط بهذا الجهاز والمتصفح. مسح بيانات الموقع من المتصفح يتطلب مفتاحاً جديداً.')
    )
  );
  const close = () => screen.remove();
  document.body.appendChild(screen);
  /** @type {HTMLElement|null} */ (screen.querySelector('textarea'))?.focus();
  return { close };
}

/* ───────────────────────── settings card ───────────────────────── */

/**
 * License panel for the Settings screen.
 * @param {{ status: ActivationStatus, storage: Pick<Storage, 'getItem'|'setItem'> }} license
 * @param {(status: ActivationStatus) => void} onActivated
 * @returns {HTMLElement}
 */
export function licensePanel(license, onActivated) {
  const { status } = license;
  return h('div', { class: 'stack' },
    h('dl', { class: 'kv' },
      h('dt', {}, 'الحالة'), h('dd', { class: status.state === 'trial' ? 'text-credit' : 'text-ok' }, describeLicense(status))
    ),
    h('div', { class: 'license-section' }, h('span', { class: 'field-label' }, 'رقم الجهاز'), deviceIdBlock(status.deviceId)),
    status.state === 'master' || status.state === 'permanent'
      ? null
      : h('details', { class: 'disclosure', open: status.state === 'trial' && status.daysLeft <= 2 },
        h('summary', {}, 'إدخال مفتاح تفعيل دائم'),
        activationForm(license.storage, onActivated, { submitLabel: 'تفعيل المفتاح' }))
  );
}

/* ───────────────────────── admin key generator ───────────────────────── */

/**
 * Opens the developer key generator. Signing keys (the loaded private key or the
 * recovery key re-derived from the passphrase) live only in this overlay's memory
 * and are never written to any storage.
 * @param {{ onClose?: () => void }} [options]
 */
export function openKeygen({ onClose } = {}) {
  if (document.getElementById('keygen-screen')) return;
  /** @type {{ signingKey: CryptoKey, source: 'primary'|'recovery', matchesApp: boolean, jwk?: JsonWebKey }|null} */
  let signer = null;
  /** Last key file text, kept so an encrypted file can be retried with its password. */
  let pendingText = '';

  const input = (props) => /** @type {HTMLInputElement} */ (h('input', { class: 'input', dir: 'ltr', spellcheck: 'false', autocomplete: 'off', ...props }));
  const status = (text = '') => h('p', { class: 'muted small', role: 'status' }, text);
  /**
   * @param {HTMLElement} el
   * @param {'ok'|'warn'|'error'|'muted'} tone
   * @param {string} text
   */
  const say = (el, tone, text) => {
    el.className = `small ${{ ok: 'text-ok', warn: 'text-credit', error: 'text-due', muted: 'muted' }[tone]}`;
    el.textContent = text;
  };

  /* ── 1. primary private key: import / export ── */
  const keyStatus = status('لم يُحمَّل مفتاح التوقيع بعد.');
  const fileInput = input({ type: 'file', accept: 'application/json,.json', id: 'keygen-file' });
  const pasteInput = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    class: 'input license-key-input', rows: 3, dir: 'ltr', spellcheck: 'false', autocomplete: 'off',
    placeholder: '{ "privateKey": { "kty": "EC", … } }', dataset: { role: 'private-key' }
  }));
  const filePassword = input({ type: 'password', dataset: { role: 'backup-password-in' }, placeholder: 'فقط للنسخ المشفّرة', autocomplete: 'current-password' });
  const backupPassword = input({ type: 'password', dataset: { role: 'backup-password' }, autocomplete: 'new-password' });
  const backupConfirm = input({ type: 'password', dataset: { role: 'backup-password-confirm' }, autocomplete: 'new-password' });
  const backupStatus = status();
  const backupTools = h('div', { class: 'stack', hidden: true },
    h('h3', { class: 'small' }, 'نسخ احتياطي للمفتاح الخاص'),
    h('div', { class: 'form-grid' },
      field(`كلمة مرور النسخة (${MIN_BACKUP_PASSWORD} حرفاً على الأقل)`, backupPassword),
      field('تأكيد كلمة المرور', backupConfirm)
    ),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn-primary', dataset: { role: 'export-encrypted' }, on: { click: event => exportEncrypted(/** @type {HTMLButtonElement} */ (event.currentTarget)) } },
        icon('download', { size: 17 }), 'تنزيل نسخة مشفّرة'),
      h('button', { type: 'button', class: 'btn btn-secondary', dataset: { role: 'copy-jwk' }, on: { click: () => copyJwk() } },
        icon('file', { size: 17 }), 'نسخ JWK لمدير كلمات المرور')
    ),
    backupStatus,
    h('p', { class: 'muted small' }, 'احتفظ بنسختين على الأقل في مكانين مختلفين (مثلاً مدير كلمات المرور + فلاشة). النسخة المشفّرة لا تُفتح إلا بكلمة مرورها؛ نسخة JWK غير مشفّرة فاحفظها في مدير كلمات مرور فقط.')
  );

  const generateButton = /** @type {HTMLButtonElement} */ (h('button', { type: 'submit', class: 'btn btn-primary btn-lg', disabled: true }, icon('check'), 'إنشاء المفتاح'));
  const signerBadge = h('p', { class: 'small muted' }, 'حمّل المفتاح الخاص أو استخدم عبارة الاسترداد أولاً.');

  /** @param {NonNullable<typeof signer>} next */
  const setSigner = next => {
    signer = next;
    generateButton.disabled = !next;
    backupTools.hidden = next?.source !== 'primary';
    say(signerBadge, next.source === 'recovery' ? 'warn' : 'ok',
      next.source === 'recovery' ? 'التوقيع الآن بمفتاح الاسترداد الطارئ.' : 'التوقيع الآن بالمفتاح الخاص الأساسي.');
  };

  /** @param {string} text */
  const loadKey = async text => {
    if (!text.trim()) {
      say(keyStatus, 'error', 'اختر ملف المفتاح أو الصق محتواه أولاً.');
      return;
    }
    pendingText = text;
    say(keyStatus, 'muted', 'جارٍ التحميل…');
    try {
      const imported = await importSigningKey(text, { password: filePassword.value });
      pendingText = '';
      pasteInput.value = '';
      filePassword.value = '';
      setSigner({ signingKey: imported.signingKey, source: 'primary', matchesApp: imported.matchesApp, jwk: imported.jwk });
      say(keyStatus, imported.matchesApp ? 'ok' : 'warn', imported.matchesApp
        ? '✓ تم تحميل مفتاح التوقيع، وهو مطابق لهذا الإصدار من التطبيق.'
        : '⚠ تم التحميل، لكنه لا يطابق المفتاح العام في هذا الإصدار — المفاتيح الناتجة لن تعمل حتى تُحدَّث LICENSE_PUBLIC_KEY.');
    } catch (error) {
      say(keyStatus, /** @type {any} */ (error)?.code === 'password-required' ? 'warn' : 'error', /** @type {any} */ (error)?.message || 'تعذر قراءة المفتاح.');
      if (/** @type {any} */ (error)?.code === 'password-required') filePassword.focus();
    }
  };
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) await loadKey(await file.text());
  });

  /** @param {HTMLButtonElement} button */
  const exportEncrypted = button => withBusy(button, async () => {
    if (!signer?.jwk) return;
    if (backupPassword.value !== backupConfirm.value) {
      say(backupStatus, 'error', 'تأكيد كلمة المرور غير مطابق.');
      return;
    }
    try {
      const backup = await encryptPrivateKeyBackup(signer.jwk, backupPassword.value);
      exportJSON(`DAD_LICENSE_KEY_BACKUP_${new Date().toISOString().slice(0, 10)}`, backup);
      backupPassword.value = '';
      backupConfirm.value = '';
      say(backupStatus, 'ok', '✓ تم تنزيل النسخة المشفّرة. احفظ كلمة مرورها في مكان منفصل عن الملف.');
    } catch (error) {
      say(backupStatus, 'error', /** @type {any} */ (error)?.message || 'تعذر إنشاء النسخة.');
    }
  });
  const copyJwk = () => {
    if (!signer?.jwk) return;
    copyText(JSON.stringify({ app: 'dad-transport-license', kind: 'private', privateKey: signer.jwk }), 'تم نسخ المفتاح الخاص (JWK). الصقه في مدير كلمات المرور ثم امسح الحافظة.');
  };

  /* ── emergency recovery passphrase ── */
  const recoveryPhrase = input({ type: 'password', dataset: { role: 'recovery-passphrase' }, autocomplete: 'off' });
  const recoveryStatus = status(LICENSE_RECOVERY_PUBLIC_KEY ? 'عبارة الاسترداد مُعدّة في هذا الإصدار.' : 'لم تُعدّ عبارة استرداد في هذا الإصدار بعد — استخدم "إعداد عبارة جديدة" أدناه.');
  const useRecovery = button => withBusy(button, async () => {
    try {
      const derived = await deriveRecoveryKey(recoveryPhrase.value);
      recoveryPhrase.value = '';
      if (!LICENSE_RECOVERY_PUBLIC_KEY) {
        say(recoveryStatus, 'error', 'لا توجد عبارة استرداد مُعدّة في هذا الإصدار من التطبيق.');
        return;
      }
      if (!derived.matchesApp) {
        say(recoveryStatus, 'error', 'العبارة غير صحيحة — لا تطابق مفتاح الاسترداد في التطبيق.');
        return;
      }
      setSigner({ signingKey: derived.signingKey, source: 'recovery', matchesApp: true });
      say(recoveryStatus, 'ok', '✓ تم التحقق من العبارة. يمكنك الآن إصدار مفاتيح بمفتاح الاسترداد.');
    } catch (error) {
      say(recoveryStatus, 'error', /** @type {any} */ (error)?.message || 'تعذر اشتقاق مفتاح الاسترداد.');
    }
  });

  const setupPhrase = input({ type: 'password', dataset: { role: 'setup-passphrase' }, autocomplete: 'new-password' });
  const setupConfirm = input({ type: 'password', dataset: { role: 'setup-passphrase-confirm' }, autocomplete: 'new-password' });
  const setupStatus = status();
  const setupOutput = h('pre', { class: 'license-key-input keygen-public', hidden: true, dir: 'ltr', dataset: { role: 'recovery-snippet' } });
  const setupRecovery = button => withBusy(button, async () => {
    if (normalizePassphrase(setupPhrase.value) !== normalizePassphrase(setupConfirm.value)) {
      say(setupStatus, 'error', 'تأكيد العبارة غير مطابق.');
      return;
    }
    try {
      const derived = await deriveRecoveryKey(setupPhrase.value);
      setupPhrase.value = '';
      setupConfirm.value = '';
      const snippet = `export const LICENSE_RECOVERY_PUBLIC_KEY = Object.freeze({ kty: 'OKP', crv: 'Ed25519', x: '${derived.publicKey.x}' });`;
      setupOutput.hidden = false;
      setupOutput.textContent = snippet;
      say(setupStatus, 'ok', derived.matchesApp
        ? '✓ هذه العبارة مُعدّة بالفعل في هذا الإصدار.'
        : 'انسخ السطر التالي واستبدل به LICENSE_RECOVERY_PUBLIC_KEY في src/core/license.js ثم انشر التطبيق.');
      copyText(snippet, 'تم نسخ السطر إلى الحافظة.');
    } catch (error) {
      say(setupStatus, 'error', /** @type {any} */ (error)?.message || 'تعذر الاشتقاق.');
    }
  });

  /* ── 2. issue a customer key ── */
  const deviceInput = input({ class: 'input device-id', type: 'text', placeholder: 'DEV-XXXX-XXXX-XXXX-XXXX', name: 'deviceId' });
  const daysSelect = /** @type {HTMLSelectElement} */ (h('select', { class: 'input', name: 'days' },
    [3, 5, 7, 14, 30].map(days => h('option', { value: String(days), selected: days === 7 }, `${days} أيام`))));
  const typeRadio = (value, label, checked) => h('label', { class: 'checkbox' },
    h('input', { type: 'radio', name: 'licenseType', value, checked, on: { change: () => { daysSelect.disabled = value === LICENSE_TYPE.PERMANENT; } } }), label);
  const output = h('div', { class: 'stack', hidden: true, ariaLive: 'polite' });

  const form = /** @type {HTMLFormElement} */ (h('form', { class: 'stack', novalidate: true, id: 'keygen-form' },
    signerBadge,
    field('رقم جهاز العميل', deviceInput),
    h('div', { class: 'row', role: 'radiogroup', ariaLabel: 'نوع الترخيص' },
      typeRadio(LICENSE_TYPE.TRIAL, 'تجريبي', true),
      typeRadio(LICENSE_TYPE.PERMANENT, 'دائم', false)
    ),
    field('مدة التجربة', daysSelect),
    h('div', {}, generateButton)
  ));
  form.addEventListener('submit', event => {
    event.preventDefault();
    withBusy(generateButton, async () => {
      if (!signer) return;
      const deviceId = normalizeDeviceId(deviceInput.value);
      if (!deviceId) {
        toast(LICENSE_MESSAGES.device, 'error');
        deviceInput.setAttribute('aria-invalid', 'true');
        deviceInput.focus();
        return;
      }
      deviceInput.removeAttribute('aria-invalid');
      deviceInput.value = deviceId;
      const type = /** @type {'permanent'|'trial'} */ (String(new FormData(form).get('licenseType')));
      try {
        const issued = await issueLicenseKey(signer.signingKey, deviceId, { type, days: Number(daysSelect.value) });
        const selfCheck = await verifyLicenseKey(issued.key, deviceId);
        const keyBox = /** @type {HTMLTextAreaElement} */ (h('textarea', { class: 'input license-key-input', rows: 4, dir: 'ltr', readOnly: true, dataset: { role: 'issued-key' } }, issued.key));
        const summary = `${type === LICENSE_TYPE.TRIAL ? `مفتاح تجريبي ينتهي في ${when(issued.expiresAt)}` : 'مفتاح دائم'}${signer.source === 'recovery' ? ' (موقّع بمفتاح الاسترداد)' : ''}`;
        output.hidden = false;
        output.replaceChildren(
          h('div', { class: ['callout', !selfCheck.ok && 'warn'] }, icon(selfCheck.ok ? 'checkCircle' : 'alert'),
            h('p', {}, `${summary} للجهاز ${deviceId}. `, selfCheck.ok ? 'تم التحقق منه بمفتاح التطبيق.' : 'تحذير: لن يقبله هذا الإصدار من التطبيق.')),
          keyBox,
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn btn-primary', dataset: { role: 'copy-key' }, on: { click: () => copyText(issued.key, 'تم نسخ مفتاح التفعيل.', keyBox) } }, icon('file', { size: 17 }), 'نسخ المفتاح'),
            h('a', { class: 'btn btn-secondary', href: whatsappLink(`مفتاح تفعيل نظام النقليات (${summary}):\n${issued.key}`), attrs: { target: '_blank', rel: 'noopener noreferrer' } }, icon('upload', { size: 17 }), 'إرسال عبر واتساب')
          )
        );
      } catch (error) {
        toast(/** @type {any} */ (error)?.message || 'تعذر إنشاء المفتاح.', 'error');
      }
    });
  });

  /* ── advanced: brand-new key pair ── */
  const newPairButton = h('button', { type: 'button', class: 'btn btn-danger-soft' }, icon('refresh', { size: 17 }), 'إنشاء زوج مفاتيح جديد');
  const newPairOutput = h('pre', { class: 'license-key-input keygen-public', hidden: true, dir: 'ltr' });
  newPairButton.addEventListener('click', () => withBusy(/** @type {HTMLButtonElement} */ (newPairButton), async () => {
    const pair = await generateSigningKeys();
    exportJSON('DAD_LICENSE_PRIVATE_KEY', { app: 'dad-transport-license', kind: 'private', createdAt: new Date().toISOString(), privateKey: pair.privateKey });
    newPairOutput.hidden = false;
    newPairOutput.textContent = JSON.stringify(pair.publicKey, null, 2);
    await loadKey(JSON.stringify(pair.privateKey));
    toast('تم تنزيل ملف المفتاح الخاص. احفظه وأنشئ نسخة مشفّرة منه.', 'warning', { duration: 8000 });
  }));

  const close = () => {
    screen.remove();
    if (location.hash === '#admin-keygen') history.replaceState(history.state, '', '#/dashboard');
    onClose?.();
  };
  const screen = h('div', { id: 'keygen-screen', class: 'fullscreen keygen-screen', role: 'dialog', ariaModal: 'true', ariaLabelledby: 'keygen-title' },
    h('div', { class: 'fullscreen-card license-card keygen-card stack' },
      h('div', { class: 'row keygen-header' },
        h('h1', { id: 'keygen-title' }, icon('shield', { size: 22 }), 'مولّد مفاتيح التفعيل'),
        h('button', { type: 'button', class: 'icon-btn', ariaLabel: 'إغلاق', on: { click: close } }, icon('close'))
      ),
      h('p', { class: 'muted small' }, 'أداة المطوّر. لا تعمل إلا بملف المفتاح الخاص أو بعبارة الاسترداد، وكلاهما يبقى في ذاكرة هذه الصفحة فقط ولا يُحفظ في التطبيق. استخدمها على جهازك أنت، لا على جهاز العميل.'),
      h('section', { class: 'license-section stack' },
        h('h2', {}, '1. مفتاح التوقيع الخاص'),
        field('ملف المفتاح الخاص أو نسخته المشفّرة (JSON)', fileInput),
        field('أو الصق محتوى الملف', pasteInput),
        field('كلمة مرور النسخة المشفّرة', filePassword),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn btn-secondary', dataset: { role: 'load-private-key' }, on: { click: () => loadKey(pasteInput.value || pendingText) } }, icon('upload', { size: 17 }), 'تحميل المفتاح')),
        keyStatus,
        backupTools
      ),
      h('section', { class: 'license-section stack' }, h('h2', {}, '2. مفتاح العميل'), form, output),
      h('details', { class: 'disclosure', dataset: { role: 'recovery-section' } },
        h('summary', {}, 'استرداد الطوارئ — عبارة المرور'),
        h('div', { class: 'stack' },
          h('p', { class: 'muted small' }, 'إذا فُقدت كل نسخ المفتاح الخاص، تعيد عبارة الاسترداد إنشاء مفتاح توقيع بديل على أي جهاز دون أي ملفات، فتصدر به مفاتيح مرتبطة بجهاز كل عميل. لا تُكتب العبارة أبداً على جهاز عميل.'),
          field('عبارة الاسترداد', recoveryPhrase),
          h('div', {}, h('button', { type: 'button', class: 'btn btn-secondary', dataset: { role: 'use-recovery' }, on: { click: event => useRecovery(/** @type {HTMLButtonElement} */ (event.currentTarget)) } }, icon('unlock', { size: 17 }), 'استخدام عبارة الاسترداد')),
          recoveryStatus,
          h('details', { class: 'disclosure' },
            h('summary', {}, 'إعداد عبارة استرداد جديدة'),
            h('div', { class: 'stack' },
              h('div', { class: 'callout warn' }, icon('alert'), h('p', {}, `اختر عبارة طويلة لا يمكن تخمينها (${MIN_RECOVERY_PASSPHRASE} حرفاً على الأقل، يفضّل 5–6 كلمات عشوائية) واكتبها على ورق في مكان آمن. من يعرفها يستطيع إصدار مفاتيح، ونسيانها يعطّل الاسترداد.`)),
              h('div', { class: 'form-grid' }, field('العبارة الجديدة', setupPhrase), field('تأكيد العبارة', setupConfirm)),
              h('div', {}, h('button', { type: 'button', class: 'btn btn-secondary', dataset: { role: 'setup-recovery' }, on: { click: event => setupRecovery(/** @type {HTMLButtonElement} */ (event.currentTarget)) } }, icon('shield', { size: 17 }), 'اشتقاق المفتاح العام')),
              setupStatus,
              setupOutput
            )
          )
        )
      ),
      h('details', { class: 'disclosure' },
        h('summary', {}, 'متقدم: إنشاء زوج مفاتيح جديد'),
        h('div', { class: 'stack' },
          h('div', { class: 'callout danger' }, icon('alert'), h('p', {}, 'للاستخدام عند فقدان المفتاح الخاص وعبارة الاسترداد معاً فقط. بعد إنشائه يجب لصق المفتاح العام الظاهر في LICENSE_PUBLIC_KEY داخل src/core/license.js ونشر التطبيق، وعندها تتوقف جميع المفاتيح الصادرة سابقاً عن العمل.')),
          h('div', {}, newPairButton),
          newPairOutput
        )
      )
    )
  );
  screen.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  document.body.appendChild(screen);
  fileInput.focus();
}
