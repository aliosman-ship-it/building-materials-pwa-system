/**
 * @module core/view
 * Abstract base class for screens. Lifecycle:
 *   mount(container) → load() → render() → afterRender()
 *   update(patch)    → render() → afterRender()
 *   refresh()        → load() → render() → afterRender()
 *   unmount()        → cleanups → onUnmount()
 *
 * Events are delegated from the persistent container, so they survive re-renders
 * without re-binding. Rendering and loading are wrapped in error boundaries.
 */

import { delegate, h } from './dom.js';
import { icon } from './icons.js';

/**
 * @typedef {Object} AppContext
 * @property {import('../js/storage-adapter.js').Database} db
 * @property {import('./router.js').Router} router
 * @property {Record<string, any>} settings
 * @property {() => Promise<void>} reloadSettings
 * @property {(detail?: { source?: string }) => void} notifyDataChanged
 * @property {EventTarget} events
 */

export class View {
  /**
   * @param {AppContext} ctx
   * @param {{ params?: Record<string, string>, query?: URLSearchParams }} [route]
   */
  constructor(ctx, route = {}) {
    if (new.target === View) throw new TypeError('View is abstract; extend it.');
    /** @type {AppContext} */
    this.ctx = ctx;
    this.route = route;
    /** @type {HTMLElement|null} */
    this.root = null;
    /** @type {Record<string, any>} */
    this.state = {};
    this.mounted = false;
    /** @type {Array<() => void>} */
    this._cleanups = [];
    this._renderQueued = false;
  }

  /** Document title for the route. @returns {string} */
  get title() { return ''; }

  /** Fetches the data the view needs. Override; may be async. */
  async load() {}

  /**
   * Builds the view's DOM. Must be overridden.
   * @returns {Node}
   */
  render() {
    throw new Error(`${this.constructor.name}.render() is not implemented.`);
  }

  /** Hook: called once after the first successful render. */
  afterMount() {}

  /** Hook: called after every render. */
  afterRender() {}

  /** Hook: called during unmount, after listeners are removed. */
  onUnmount() {}

  /**
   * Attaches the view to a container.
   * @param {HTMLElement} container
   */
  async mount(container) {
    this.root = container;
    this.root.replaceChildren(h('div', { class: 'view-loading', role: 'status' }, h('span', { class: 'spinner' }), 'جارٍ التحميل…'));
    try {
      await this.load();
    } catch (error) {
      this._renderError(error, 'تعذر تحميل البيانات');
      return;
    }
    if (!this.root) return; // unmounted while loading
    this._bindDataListener();
    this._paint();
    this.mounted = true;
    try {
      this.afterMount();
    } catch (error) {
      console.error(`${this.constructor.name}.afterMount failed:`, error);
    }
  }

  /**
   * Merges state and re-renders.
   * @param {Record<string, any>} [patch]
   */
  update(patch = {}) {
    Object.assign(this.state, patch);
    if (this.mounted) this._paint();
  }

  /** Reloads data then re-renders. */
  async refresh() {
    if (!this.root) return;
    try {
      await this.load();
      if (this.root) this._paint();
    } catch (error) {
      this._renderError(error, 'تعذر تحديث البيانات');
    }
  }

  /**
   * Delegated event listener scoped to the view's lifetime.
   * @param {string} type
   * @param {string} selector
   * @param {(event: Event, target: HTMLElement) => void} handler
   */
  on(type, selector, handler) {
    if (!this.root) throw new Error('View.on() called before mount.');
    const safeHandler = (event, target) => {
      try {
        const result = handler.call(this, event, target);
        if (result && typeof result.catch === 'function') result.catch(error => this.handleError(error));
      } catch (error) {
        this.handleError(error);
      }
    };
    this._cleanups.push(delegate(this.root, type, selector, safeHandler));
  }

  /**
   * Registers an arbitrary cleanup to run at unmount.
   * @param {() => void} cleanup
   */
  addCleanup(cleanup) {
    this._cleanups.push(cleanup);
  }

  /**
   * Error handler for event callbacks. Views may override for custom reporting.
   * @param {unknown} error
   */
  handleError(error) {
    console.error(`${this.constructor.name} event error:`, error);
    import('./ui.js').then(({ reportError }) => reportError(error));
  }

  /** Detaches the view and releases listeners. */
  unmount() {
    for (const cleanup of this._cleanups.splice(0)) {
      try { cleanup(); } catch (error) { console.error('View cleanup failed:', error); }
    }
    try { this.onUnmount(); } catch (error) { console.error(`${this.constructor.name}.onUnmount failed:`, error); }
    this.root?.replaceChildren();
    this.root = null;
    this.mounted = false;
  }

  /** Re-render on global data changes coming from other components (e.g. modals in the shell). */
  _bindDataListener() {
    const listener = event => {
      if (event.detail?.source !== this.constructor.name) this.refresh();
    };
    this.ctx.events.addEventListener('data-changed', listener);
    this._cleanups.push(() => this.ctx.events.removeEventListener('data-changed', listener));
  }

  /** Renders inside an error boundary, preserving scroll position. */
  _paint() {
    if (!this.root) return;
    const scrollY = window.scrollY;
    try {
      const node = this.render();
      this.root.replaceChildren(node);
      this.afterRender();
    } catch (error) {
      this._renderError(error, 'تعذر عرض الصفحة');
      return;
    }
    // 'instant' overrides the stylesheet's smooth scrolling: restoring the
    // position after a re-render must not animate.
    window.scrollTo({ top: scrollY, behavior: 'instant' });
  }

  /**
   * Error boundary output.
   * @param {unknown} error
   * @param {string} heading
   */
  _renderError(error, heading) {
    console.error(`${this.constructor.name}: ${heading}`, error);
    if (!this.root) return;
    const message = error instanceof Error ? error.message : String(error);
    this.root.replaceChildren(h('section', { class: 'error-panel', role: 'alert' },
      icon('alert', { size: 40, strokeWidth: 1.5 }),
      h('h2', {}, heading),
      h('p', { class: 'muted' }, message),
      h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => this.refresh() } }, icon('refresh'), 'إعادة المحاولة')
    ));
  }
}
