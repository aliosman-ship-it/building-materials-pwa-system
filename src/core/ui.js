/**
 * @module core/ui
 * Toast notifications, confirm dialogs and modals built on the native <dialog>
 * element (focus trapping, Escape handling and inertness come from the platform).
 */

import { h } from './dom.js';
import { icon } from './icons.js';

const TOAST_ICONS = { success: 'checkCircle', error: 'alert', warning: 'alert', info: 'info' };
const TOAST_LIMIT = 4;

/**
 * Returns (creating if needed) the live region that hosts toasts.
 * @returns {HTMLElement}
 */
function toastRegion() {
  let region = document.getElementById('toast-region');
  if (!region) {
    region = h('div', { id: 'toast-region', class: 'toast-region', role: 'region', ariaLabel: 'الإشعارات' });
    document.body.appendChild(region);
  }
  return region;
}

/**
 * Shows a transient notification.
 * @param {string} message
 * @param {'success'|'error'|'warning'|'info'} [type='success']
 * @param {{ duration?: number, action?: { label: string, onClick: () => void } }} [options]
 *   duration in ms (errors stay longer by default); `action` adds a button to the toast.
 * @returns {() => void} Function that dismisses the toast early.
 */
export function toast(message, type = 'success', { duration, action } = {}) {
  const region = toastRegion();
  const ttl = duration ?? (type === 'error' ? 6000 : 3800);
  const dismiss = () => {
    item.classList.remove('is-visible');
    setTimeout(() => item.remove(), 250);
  };
  const item = h('div', {
    class: ['toast', `toast-${type}`],
    role: type === 'error' ? 'alert' : 'status',
    ariaLive: type === 'error' ? 'assertive' : 'polite'
  },
    icon(TOAST_ICONS[type] || 'info', { size: 20 }),
    h('span', { class: 'toast-text' }, message),
    action ? h('button', { type: 'button', class: 'btn btn-primary btn-sm toast-action', on: { click: () => { dismiss(); action.onClick(); } } }, action.label) : null,
    h('button', { type: 'button', class: 'toast-close', ariaLabel: 'إغلاق الإشعار', on: { click: dismiss } }, icon('close', { size: 16 }))
  );
  while (region.children.length >= TOAST_LIMIT) region.firstElementChild.remove();
  region.appendChild(item);
  requestAnimationFrame(() => item.classList.add('is-visible'));
  const timer = setTimeout(dismiss, ttl);
  item.addEventListener('mouseenter', () => clearTimeout(timer), { once: true });
  item.addEventListener('mouseleave', () => setTimeout(dismiss, 1500), { once: true });
  return dismiss;
}

/**
 * @typedef {Object} ModalAction
 * @property {string} label
 * @property {'primary'|'danger'|'ghost'|'secondary'} [variant]
 * @property {string} [icon]
 * @property {'submit'|'button'} [type] `submit` submits the modal's form (by `form` id).
 * @property {string} [form] Form id the submit button belongs to.
 * @property {(modal: ModalHandle) => (void|boolean|Promise<void|boolean>)} [onClick]
 *   Return `false` to keep the modal open.
 */

/**
 * @typedef {Object} ModalHandle
 * @property {HTMLDialogElement} dialog
 * @property {HTMLElement} body
 * @property {(result?: unknown) => void} close
 * @property {Promise<unknown>} closed Resolves with the close result.
 */

/**
 * Opens a modal dialog.
 * @param {{ title: string, content: Node, actions?: ModalAction[], size?: 'sm'|'md'|'lg'|'xl', icon?: string, onClose?: (result: unknown) => void, dismissible?: boolean, className?: string }} options
 * @returns {ModalHandle}
 */
export function openModal({ title, content, actions = [], size = 'md', icon: iconName, onClose, dismissible = true, className }) {
  const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;
  /** @type {unknown} */
  let result;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });

  const body = h('div', { class: 'modal-body' }, content);
  const footer = actions.length ? h('div', { class: 'modal-footer' }) : null;
  const dialog = h('dialog', { class: ['modal', `modal-${size}`, className], ariaLabelledby: titleId },
    h('div', { class: 'modal-card' },
      h('header', { class: 'modal-header' },
        h('h2', { id: titleId, class: 'modal-title' }, iconName ? icon(iconName, { size: 20 }) : null, title),
        dismissible ? h('button', { type: 'button', class: 'icon-btn', ariaLabel: 'إغلاق', on: { click: () => handle.close() } }, icon('close')) : null
      ),
      body,
      footer
    )
  );

  /** @type {ModalHandle} */
  const handle = {
    dialog,
    body,
    closed,
    close(value) {
      result = value;
      if (dialog.open) dialog.close();
    }
  };

  for (const action of actions) {
    const button = h('button', {
      type: action.type || 'button',
      class: ['btn', `btn-${action.variant || 'secondary'}`],
      attrs: action.form ? { form: action.form } : undefined
    }, action.icon ? icon(action.icon) : null, action.label);
    if (action.onClick) {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const keepOpen = (await action.onClick(handle)) === false;
          if (!keepOpen) handle.close(action.label);
        } catch (error) {
          console.error('Modal action failed:', error);
          toast(error?.message || 'تعذر تنفيذ العملية.', 'error');
        } finally {
          button.disabled = false;
        }
      });
    }
    footer.appendChild(button);
  }

  dialog.addEventListener('cancel', event => {
    if (!dismissible) event.preventDefault();
  });
  dialog.addEventListener('click', event => {
    if (dismissible && event.target === dialog) handle.close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.(result);
    resolveClosed(result);
  });

  document.body.appendChild(dialog);
  dialog.showModal();
  const autofocus = body.querySelector('[autofocus], input:not([type=hidden]):not([disabled]), select, textarea');
  (autofocus || dialog.querySelector('.modal-footer .btn'))?.focus();
  return handle;
}

/**
 * Asks the user to confirm an action.
 * @param {{ title?: string, message: string, confirmText?: string, cancelText?: string, danger?: boolean, requireText?: string }} options
 *   `requireText` forces the user to type an exact phrase (for destructive operations).
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title = 'تأكيد العملية', message, confirmText = 'تأكيد', cancelText = 'إلغاء', danger = false, requireText }) {
  return new Promise(resolve => {
    let confirmed = false;
    const input = requireText
      ? h('input', { class: 'input', type: 'text', autocomplete: 'off', placeholder: requireText, ariaLabel: `اكتب "${requireText}" للتأكيد` })
      : null;
    const content = h('div', { class: 'confirm-content' },
      h('p', { class: 'confirm-message' }, message),
      input ? h('p', { class: 'field-hint' }, 'للمتابعة اكتب: ', h('strong', {}, requireText)) : null,
      input
    );
    const modal = openModal({
      title,
      content,
      size: 'sm',
      icon: danger ? 'alert' : 'info',
      className: danger ? 'modal-danger' : '',
      actions: [
        { label: cancelText, variant: 'ghost', onClick: () => undefined },
        {
          label: confirmText,
          variant: danger ? 'danger' : 'primary',
          onClick: () => {
            if (input && input.value.trim() !== requireText) {
              input.setCustomValidity('النص غير مطابق');
              input.reportValidity();
              return false;
            }
            confirmed = true;
            return undefined;
          }
        }
      ],
      onClose: () => resolve(confirmed)
    });
    input?.addEventListener('input', () => input.setCustomValidity(''));
    if (!input) modal.dialog.querySelector(`.modal-footer .btn-${danger ? 'danger' : 'primary'}`)?.focus();
  });
}

/**
 * Toggles a button's busy state while an async operation runs.
 * @template T
 * @param {HTMLButtonElement|null|undefined} button
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export async function withBusy(button, task) {
  if (button) {
    button.disabled = true;
    button.classList.add('is-busy');
    button.setAttribute('aria-busy', 'true');
  }
  try {
    return await task();
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove('is-busy');
      button.removeAttribute('aria-busy');
    }
  }
}

/**
 * Copies text to the clipboard. When the Clipboard API is unavailable or denied,
 * selects `fallback` (if given) so the user can copy it manually.
 * @param {string} text
 * @param {string} successMessage
 * @param {HTMLInputElement|HTMLTextAreaElement|null} [fallback]
 * @returns {Promise<boolean>}
 */
export async function copyText(text, successMessage, fallback = null) {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMessage, 'success');
    return true;
  } catch {
    fallback?.focus();
    fallback?.select();
    toast(fallback ? 'تعذر النسخ تلقائياً. النص محدد الآن — انسخه يدوياً.' : `تعذر النسخ تلقائياً: ${text}`, 'warning', { duration: 8000 });
    return false;
  }
}

/**
 * Standard empty-state block.
 * @param {string} message
 * @param {string} [iconName='info']
 * @returns {HTMLElement}
 */
export function emptyState(message, iconName = 'info') {
  return h('div', { class: 'empty-state' }, icon(iconName, { size: 36, strokeWidth: 1.5 }), h('p', {}, message));
}

/**
 * Reports an error to the console and the user in one call.
 * @param {unknown} error
 * @param {string} [fallback]
 */
export function reportError(error, fallback = 'حدث خطأ غير متوقع.') {
  console.error(error);
  const message = error && typeof error === 'object' && 'message' in error && error.name === 'DomainError'
    ? String(error.message)
    : error && typeof error === 'object' && 'userMessage' in error
      ? String(error.userMessage)
      : fallback;
  toast(message, 'error');
}
