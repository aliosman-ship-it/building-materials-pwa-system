/**
 * @module core/icons
 * Self-contained stroke icon set (24×24 grid, Lucide-compatible geometry).
 * Icons are built with createElementNS, so no markup parsing is involved and
 * the app needs no icon font or CDN to work offline.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Icon geometry. Each entry is a list of SVG path `d` strings.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const ICONS = Object.freeze({
  dashboard: ['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z'],
  truck: ['M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2', 'M15 18H9', 'M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62L18.3 9.38a1 1 0 0 0-.78-.38H14', 'M5 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0', 'M15 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0'],
  wallet: ['M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1', 'M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4'],
  report: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M10 9H8', 'M16 13H8', 'M16 17H8'],
  settings: ['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0'],
  plus: ['M5 12h14', 'M12 5v14'],
  minus: ['M5 12h14'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6'],
  edit: ['M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7', 'M18.38 2.62a2.12 2.12 0 1 1 3 3L12.36 14.64a2 2 0 0 1-.85.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.85z'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5l5-5', 'M12 15V3'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5l-5 5', 'M12 3v12'],
  printer: ['M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2', 'M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6', 'M6 14h12v8H6z'],
  search: ['M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0', 'M21 21l-4.3-4.3'],
  close: ['M18 6L6 18', 'M6 6l12 12'],
  check: ['M20 6L9 17l-5-5'],
  checkCircle: ['M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0', 'M9 12l2 2l4-4'],
  alert: ['M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  info: ['M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0', 'M12 16v-4', 'M12 8h.01'],
  lock: ['M3 13a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M7 11V7a5 5 0 0 1 10 0v4'],
  unlock: ['M3 13a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M7 11V7a5 5 0 0 1 9.9-1'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  building: ['M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18z', 'M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2', 'M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2', 'M10 6h4', 'M10 10h4', 'M10 14h4', 'M10 18h4'],
  package: ['M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z', 'M12 22V12', 'M3.29 7L12 12l8.71-5', 'M7.5 4.27l9 5.15'],
  calendar: ['M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M16 2v4', 'M8 2v4', 'M3 10h18'],
  filter: ['M22 3H2l8 9.46V19l4 2v-8.54z'],
  refresh: ['M3 12a9 9 0 0 1 9-9a9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9a9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  chevronLeft: ['M15 18l-6-6l6-6'],
  chevronRight: ['M9 18l6-6l-6-6'],
  database: ['M3 5a9 3 0 1 0 18 0a9 3 0 1 0-18 0', 'M3 5v14a9 3 0 0 0 18 0V5', 'M3 12a9 3 0 0 0 18 0'],
  shield: ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z', 'M9 12l2 2l4-4'],
  receipt: ['M4 2v20l2-1l2 1l2-1l2 1l2-1l2 1l2-1l2 1V2l-2 1l-2-1l-2 1l-2-1l-2 1l-2-1l-2 1z', 'M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8', 'M12 17.5v-11'],
  spreadsheet: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M8 13h2', 'M14 13h2', 'M8 17h2', 'M14 17h2'],
  banknote: ['M2 8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z', 'M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0', 'M6 12h.01', 'M18 12h.01'],
  trendingUp: ['M22 7l-8.5 8.5l-5-5L2 17', 'M16 7h6v6'],
  recycle: ['M7 19H4.82a1.83 1.83 0 0 1-1.57-.88a1.79 1.79 0 0 1 0-1.77L7.2 9.6', 'M11 19h8.2a1.83 1.83 0 0 0 1.56-.89a1.78 1.78 0 0 0 0-1.76l-1.22-2.13', 'M14 16l-3 3l3 3', 'M8.29 13.6L7.2 9.6l-4 1.07', 'M9.34 5.86l1.1-1.91a1.83 1.83 0 0 1 1.57-.9a1.8 1.8 0 0 1 1.55.9l3.96 6.89', 'M12.9 9.73l4 1.07l1.07-4'],
  layers: ['M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z', 'M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12', 'M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17'],
  history: ['M3 12a9 9 0 1 0 9-9a9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
  tag: ['M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.41l8.7 8.71a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z', 'M7 7.5a.5.5 0 1 0 1 0a.5.5 0 1 0-1 0'],
  wifiOff: ['M12 20h.01', 'M8.5 16.43a5 5 0 0 1 7 0', 'M2 8.82a15 15 0 0 1 4.18-2.65', 'M19 12.86a10 10 0 0 0-2.29-1.65', 'M5 12.86a10 10 0 0 1 5.17-2.69', 'M22 8.82a15 15 0 0 0-11.29-3.76', 'M2 2l20 20'],
  scale: ['M16 16l3-8l3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z', 'M2 16l3-8l3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z', 'M7 21h10', 'M12 3v18', 'M3 7h2c2 0 5-1 7-2c2 1 5 2 7 2h2'],
  percent: ['M19 5L5 19', 'M4 6.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0', 'M15 17.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0'],
  file: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z', 'M14 2v4a2 2 0 0 0 2 2h4'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5l-5-5', 'M21 12H9'],
  clipboardList: ['M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z', 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', 'M12 11h4', 'M12 16h4', 'M8 11h.01', 'M8 16h.01'],
  cart: ['M7 21a1 1 0 1 0 2 0a1 1 0 1 0-2 0', 'M18 21a1 1 0 1 0 2 0a1 1 0 1 0-2 0', 'M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12'],
  mail: ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M22 7l-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'],
  /** Chat bubble with a handset: a neutral stand-in for the WhatsApp mark. */
  whatsapp: ['M7.9 20A9 9 0 1 0 4 16.1L2 22z', 'M9.3 8.3c.2-.4.6-.4.9-.2l1 1.2c.2.3.2.6 0 .9l-.4.5a5 5 0 0 0 2.8 2.8l.5-.4c.3-.2.6-.2.9 0l1.2 1c.2.3.2.7-.2.9l-.6.5c-.6.4-1.4.5-2 .2a8 8 0 0 1-4.4-4.4c-.3-.6-.2-1.4.2-2z']
});

/**
 * Creates an inline SVG icon.
 * @param {keyof typeof ICONS | string} name
 * @param {{ size?: number, class?: string, label?: string, strokeWidth?: number }} [options]
 *   `label` makes the icon meaningful to screen readers; without it the icon is decorative.
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = 18, class: className = '', label, strokeWidth = 2 } = {}) {
  const paths = ICONS[name] || ICONS.info;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `icon ${className}`.trim());
  svg.setAttribute('focusable', 'false');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * Replaces every `<i data-icon="name">` placeholder within root with its SVG icon.
 * Used by the static app shell in index.html.
 * @param {ParentNode} [root=document]
 */
export function hydrateIcons(root = document) {
  for (const placeholder of root.querySelectorAll('i[data-icon]')) {
    const svg = icon(placeholder.dataset.icon, {
      size: Number(placeholder.dataset.size) || 18,
      class: placeholder.className
    });
    placeholder.replaceWith(svg);
  }
}
