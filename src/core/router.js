/**
 * @module core/router
 * SPA router supporting hash (`#/ledger?client=x`) and History API modes,
 * lazy-loaded views, async navigation guards and race-safe transitions.
 */

/**
 * @typedef {Object} RouteDefinition
 * @property {string} path e.g. "/accounts" or "/accounts/:client"
 * @property {string} title
 * @property {() => Promise<{ default: typeof import('./view.js').View }>} load Lazy view loader.
 * @property {Record<string, unknown>} [meta]
 */

/**
 * @typedef {Object} Location
 * @property {string} path
 * @property {Record<string, string>} params
 * @property {URLSearchParams} query
 * @property {RouteDefinition|null} route
 * @property {string} fullPath
 */

/**
 * Guard result: `true`/undefined continues, `false` cancels, a string redirects.
 * @typedef {(to: Location, from: Location|null) => (boolean|string|void|Promise<boolean|string|void>)} NavigationGuard
 */

/**
 * Compiles "/a/:id" into a matcher.
 * @param {string} pattern
 * @returns {(path: string) => Record<string, string>|null}
 */
function compilePath(pattern) {
  const keys = [];
  const source = pattern
    .replace(/\/+$/, '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
  const regex = new RegExp(`^${source || ''}/?$`);
  return path => {
    const match = regex.exec(path);
    if (!match) return null;
    return Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
  };
}

export class Router {
  /**
   * @param {{ routes: RouteDefinition[], outlet: HTMLElement, mode?: 'hash'|'history', fallback?: string, base?: string, createView: (ViewClass: any, location: Location) => import('./view.js').View, titleSuffix?: string }} options
   */
  constructor({ routes, outlet, mode = 'hash', fallback = '/', base = '', createView, titleSuffix = '' }) {
    if (!outlet) throw new Error('Router: outlet element is required.');
    this.routes = routes.map(route => ({ ...route, match: compilePath(route.path) }));
    this.outlet = outlet;
    this.mode = mode === 'history' && typeof history.pushState === 'function' ? 'history' : 'hash';
    this.fallback = fallback;
    this.base = base.replace(/\/+$/, '');
    this.createView = createView;
    this.titleSuffix = titleSuffix;
    /** @type {NavigationGuard[]} */
    this._guards = [];
    /** @type {Array<(to: Location, from: Location|null) => void>} */
    this._afterHooks = [];
    /** @type {Location|null} */
    this.current = null;
    /** @type {import('./view.js').View|null} */
    this.view = null;
    this._token = 0;
    this._started = false;
    this._onChange = () => this._resolve(this._readLocation());
    this._onClick = this._onClick.bind(this);
  }

  /**
   * Registers a guard run before every navigation.
   * @param {NavigationGuard} guard
   * @returns {() => void} unregister
   */
  beforeEach(guard) {
    this._guards.push(guard);
    return () => { this._guards = this._guards.filter(item => item !== guard); };
  }

  /**
   * Registers a hook run after every successful navigation.
   * @param {(to: Location, from: Location|null) => void} hook
   * @returns {() => void}
   */
  afterEach(hook) {
    this._afterHooks.push(hook);
    return () => { this._afterHooks = this._afterHooks.filter(item => item !== hook); };
  }

  /** Starts listening and resolves the initial location. */
  start() {
    if (this._started) return Promise.resolve();
    this._started = true;
    window.addEventListener(this.mode === 'hash' ? 'hashchange' : 'popstate', this._onChange);
    if (this.mode === 'history') document.addEventListener('click', this._onClick);
    return this._resolve(this._readLocation());
  }

  /** Stops the router and unmounts the active view. */
  stop() {
    window.removeEventListener(this.mode === 'hash' ? 'hashchange' : 'popstate', this._onChange);
    document.removeEventListener('click', this._onClick);
    this.view?.unmount();
    this.view = null;
    this._started = false;
  }

  /**
   * Navigates to a path (may include a query string).
   * @param {string} fullPath
   * @param {{ replace?: boolean }} [options]
   */
  navigate(fullPath, { replace = false } = {}) {
    const target = fullPath.startsWith('/') ? fullPath : `/${fullPath}`;
    if (this.mode === 'hash') {
      const url = `#${target}`;
      if (location.hash === url) return this._resolve(this._readLocation());
      if (replace) {
        history.replaceState(history.state, '', url);
        return this._resolve(this._readLocation());
      }
      location.hash = target; // hashchange triggers resolution
      return Promise.resolve();
    }
    history[replace ? 'replaceState' : 'pushState']({}, '', `${this.base}${target}`);
    return this._resolve(this._readLocation());
  }

  /** Re-runs the current route (guards included). */
  reload() {
    return this._resolve(this._readLocation(), { force: true });
  }

  /**
   * Builds an href for a path in the active mode.
   * @param {string} path
   * @returns {string}
   */
  href(path) {
    return this.mode === 'hash' ? `#${path}` : `${this.base}${path}`;
  }

  /**
   * Updates query parameters of the current location without re-mounting the view.
   * @param {Record<string, string|null|undefined>} params
   */
  setQuery(params) {
    if (!this.current) return;
    const query = new URLSearchParams(this.current.query);
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined || value === '') query.delete(key);
      else query.set(key, value);
    }
    const qs = query.toString();
    const fullPath = `${this.current.path}${qs ? `?${qs}` : ''}`;
    const url = this.mode === 'hash' ? `#${fullPath}` : `${this.base}${fullPath}`;
    history.replaceState(history.state, '', url);
    this.current = { ...this.current, query, fullPath };
  }

  /** @returns {string} */
  _currentRaw() {
    if (this.mode === 'hash') {
      const raw = location.hash.slice(1);
      try { return decodeURI(raw) || '/'; } catch { return raw || '/'; }
    }
    const path = location.pathname.startsWith(this.base) ? location.pathname.slice(this.base.length) : location.pathname;
    return `${path || '/'}${location.search}`;
  }

  /** @returns {Location} */
  _readLocation() {
    const raw = this._currentRaw();
    const [pathPart, queryPart = ''] = raw.split('?');
    const path = `/${pathPart.replace(/^\/+/, '').replace(/\/+$/, '')}`;
    for (const route of this.routes) {
      const params = route.match(path);
      if (params) return { path, params, query: new URLSearchParams(queryPart), route, fullPath: raw };
    }
    return { path, params: {}, query: new URLSearchParams(queryPart), route: null, fullPath: raw };
  }

  /**
   * Intercepts same-origin link clicks in history mode.
   * @param {MouseEvent} event
   */
  _onClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith(this.base)) return;
    event.preventDefault();
    this.navigate(`${url.pathname.slice(this.base.length)}${url.search}`);
  }

  /**
   * Core transition: guards → load view → swap → hooks.
   * @param {Location} to
   * @param {{ force?: boolean }} [options]
   */
  async _resolve(to, { force = false } = {}) {
    const token = ++this._token;
    const from = this.current;

    if (!to.route) {
      return this.navigate(this.fallback, { replace: true });
    }
    if (!force && from && from.fullPath === to.fullPath && this.view?.mounted) return undefined;

    for (const guard of this._guards) {
      let verdict;
      try {
        verdict = await guard(to, from);
      } catch (error) {
        console.error('Router guard failed:', error);
        verdict = false;
      }
      if (token !== this._token) return undefined; // superseded
      if (verdict === false) {
        if (from) this._restoreUrl(from);
        return undefined;
      }
      if (typeof verdict === 'string' && verdict !== to.fullPath) {
        return this.navigate(verdict, { replace: true });
      }
    }

    let ViewClass;
    try {
      ({ default: ViewClass } = await to.route.load());
    } catch (error) {
      console.error(`Router: failed to load view for ${to.path}`, error);
      if (token !== this._token) return undefined;
      this.outlet.replaceChildren(Object.assign(document.createElement('p'), {
        className: 'error-panel',
        textContent: 'تعذر تحميل الصفحة. تحقق من اكتمال ملفات التطبيق ثم أعد المحاولة.'
      }));
      return undefined;
    }
    if (token !== this._token) return undefined;

    this.view?.unmount();
    this.current = to;
    const view = this.createView(ViewClass, to);
    this.view = view;
    document.title = `${view.title || to.route.title}${this.titleSuffix}`;
    await view.mount(this.outlet);
    if (token !== this._token) return undefined;

    for (const hook of this._afterHooks) {
      try { hook(to, from); } catch (error) { console.error('Router afterEach hook failed:', error); }
    }
    return undefined;
  }

  /**
   * Puts the address bar back after a cancelled navigation.
   * @param {Location} from
   */
  _restoreUrl(from) {
    const url = this.mode === 'hash' ? `#${from.fullPath}` : `${this.base}${from.fullPath}`;
    history.replaceState(history.state, '', url);
  }
}
