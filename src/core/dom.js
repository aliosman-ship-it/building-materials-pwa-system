/**
 * @module core/dom
 * Sanitized DOM construction. Nothing in this module ever assigns innerHTML:
 * every string child becomes a Text node, so user data cannot inject markup.
 */

/**
 * @typedef {Object} ElementProps
 * @property {string|Array<string|false|null|undefined>} [class] Class names; falsy entries are skipped.
 * @property {Record<string, string|number|boolean|null|undefined>} [attrs] Attributes; null/false removes.
 * @property {Record<string, string|number|null|undefined>} [dataset]
 * @property {Record<string, string>} [style]
 * @property {Record<string, EventListener>} [on]
 * @property {string|number} [text] Shorthand for a single text child.
 * @property {(el: HTMLElement) => void} [ref] Called with the created element.
 */

/** Properties assigned directly to the element (rather than as attributes). */
const DIRECT_PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'type', 'name', 'id', 'title', 'htmlFor', 'placeholder', 'required', 'readOnly', 'min', 'max', 'step', 'colSpan', 'tabIndex', 'autocomplete', 'inputMode', 'pattern', 'multiple', 'accept', 'rows', 'href', 'download', 'dateTime', 'open']);

/** Attribute names that could execute script and are therefore refused. */
const FORBIDDEN_ATTR = /^on|^srcdoc$|^formaction$/i;
/** Allowed URL schemes; `data:` only for base64 raster images (never SVG, which can carry script). */
const SAFE_URL = /^(?:#|\.{0,2}\/|https?:|mailto:|tel:|blob:|data:image\/(?:png|jpeg|webp);base64,)/i;

/**
 * Appends children (strings, numbers, nodes, nested arrays) to a parent.
 * @param {Node} parent
 * @param {unknown[]} children
 */
export function appendChildren(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) appendChildren(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/**
 * Normalizes the `class` prop into a single string.
 * @param {ElementProps['class']} value
 * @returns {string}
 */
export function classNames(value) {
  if (!value) return '';
  return (Array.isArray(value) ? value : [value]).filter(Boolean).join(' ');
}

/**
 * Sets an attribute safely, rejecting event-handler attributes and scriptable URLs.
 * @param {Element} el
 * @param {string} name
 * @param {unknown} value
 */
export function setAttr(el, name, value) {
  if (FORBIDDEN_ATTR.test(name)) throw new Error(`dom: refusing to set unsafe attribute "${name}".`);
  if (value === null || value === undefined || value === false) {
    el.removeAttribute(name);
    return;
  }
  const text = value === true ? '' : String(value);
  if ((name === 'href' || name === 'src' || name === 'action') && text && !SAFE_URL.test(text)) {
    throw new Error(`dom: refusing unsafe URL for "${name}".`);
  }
  el.setAttribute(name, text);
}

/**
 * Hyperscript-style element factory.
 * @param {string} tag
 * @param {ElementProps & Record<string, unknown>} [props]
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined) continue;
    switch (key) {
      case 'class':
      case 'className': {
        const names = classNames(value);
        if (names) el.className = names;
        break;
      }
      case 'attrs':
        for (const [name, attrValue] of Object.entries(value)) setAttr(el, name, attrValue);
        break;
      case 'dataset':
        for (const [name, dataValue] of Object.entries(value)) {
          if (dataValue !== null && dataValue !== undefined) el.dataset[name] = String(dataValue);
        }
        break;
      case 'style':
        for (const [name, styleValue] of Object.entries(value)) {
          if (name.startsWith('--')) el.style.setProperty(name, String(styleValue));
          else el.style[name] = String(styleValue);
        }
        break;
      case 'on':
        for (const [type, handler] of Object.entries(value)) el.addEventListener(type, handler);
        break;
      case 'text':
        el.textContent = String(value);
        break;
      case 'ref':
        break;
      default:
        if (DIRECT_PROPS.has(key)) {
          if (key === 'href') setAttr(el, 'href', value);
          else el[key] = value;
        } else if (key.startsWith('aria') || key === 'role') {
          setAttr(el, key === 'role' ? 'role' : `aria-${key.slice(4).toLowerCase()}`, value);
        } else {
          setAttr(el, key, value);
        }
    }
  }
  appendChildren(el, children);
  if (typeof props?.ref === 'function') props.ref(el);
  return el;
}

/**
 * Replaces all children of an element.
 * @param {Element} el
 * @param {...unknown} children
 * @returns {Element}
 */
export function render(el, ...children) {
  el.replaceChildren();
  appendChildren(el, children);
  return el;
}

/**
 * querySelector shortcut.
 * @param {string} selector
 * @param {ParentNode} [root=document]
 * @returns {HTMLElement|null}
 */
export const qs = (selector, root = document) => root.querySelector(selector);

/**
 * Event delegation: invokes `handler(event, matchedElement)` for events whose target
 * matches `selector` within `root`.
 * @param {Element|Document} root
 * @param {string} type
 * @param {string} selector
 * @param {(event: Event, target: HTMLElement) => void} handler
 * @param {AddEventListenerOptions} [options]
 * @returns {() => void} Unsubscribe function.
 */
export function delegate(root, type, selector, handler, options) {
  const listener = event => {
    const origin = event.target instanceof Element ? event.target : event.target?.parentElement;
    const match = origin?.closest(selector);
    if (match && root.contains(match)) handler(event, match);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}

/**
 * Escapes text for safe interpolation into HTML strings (used only for print documents).
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Reads a form into a plain object of trimmed strings (checkboxes become booleans).
 * @param {HTMLFormElement} form
 * @returns {Record<string, string|boolean>}
 */
export function readForm(form) {
  const values = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') values[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) values[el.name] = el.value; }
    else if (el.type !== 'file' && el.type !== 'submit' && el.type !== 'button') values[el.name] = String(el.value ?? '').trim();
  }
  return values;
}

/**
 * Creates a <select> populated from options.
 * @param {{ name?: string, id?: string, value?: string, required?: boolean, placeholder?: string, options: Array<{value: string, label: string}|string>, class?: string, ariaLabel?: string, dataset?: Record<string, string> }} config
 * @returns {HTMLSelectElement}
 */
export function select({ name, id, value = '', required = false, placeholder, options, class: className = 'input', ariaLabel, dataset }) {
  const el = h('select', { name, id, required, class: className, ariaLabel, dataset });
  if (placeholder !== undefined) el.appendChild(h('option', { value: '' }, placeholder));
  for (const option of options) {
    const opt = typeof option === 'string' ? { value: option, label: option } : option;
    el.appendChild(h('option', { value: opt.value }, opt.label));
  }
  el.value = value;
  if (el.value !== value && placeholder !== undefined) el.value = '';
  return el;
}

/**
 * Labeled form field wrapper.
 * @param {string} label
 * @param {HTMLElement} control
 * @param {{ hint?: string, class?: string }} [options]
 * @returns {HTMLElement}
 */
export function field(label, control, { hint, class: className } = {}) {
  if (!control.id) control.id = `f_${Math.random().toString(36).slice(2, 9)}`;
  return h('div', { class: ['field', className] },
    h('label', { htmlFor: control.id, class: 'field-label' }, label),
    control,
    hint ? h('small', { class: 'field-hint' }, hint) : null
  );
}

/**
 * Debounces a function.
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} [wait=200]
 * @returns {F & { cancel: () => void }}
 */
export function debounce(fn, wait = 200) {
  let timer = 0;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  return /** @type {any} */ (debounced);
}
