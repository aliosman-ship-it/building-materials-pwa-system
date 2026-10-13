/**
 * @module core/export
 * Offline exporters: CSV (UTF-8 BOM for Excel), native .xlsx (Office Open XML
 * packaged by a built-in ZIP writer — no libraries), JSON backups, and printable
 * A4 reports that the browser can save as PDF.
 */

import { escapeHtml } from './dom.js';
import { formatDateTime, toISODate } from './format.js';

/**
 * @typedef {Object} ExportColumn
 * @property {string} header
 * @property {(row: any, index: number) => unknown} value
 * @property {'text'|'number'|'money'|'date'} [type]
 * @property {number} [width] Excel column width (characters).
 */

/**
 * @typedef {Object} SheetSpec
 * @property {string} name
 * @property {ExportColumn[]} columns
 * @property {any[]} rows
 * @property {unknown[][]} [footer] Extra bold rows appended after the data (e.g. totals).
 * @property {unknown[][]} [preamble] Rows written above the header (e.g. report title).
 */

/**
 * Makes a string safe for use as a file name on all platforms.
 * @param {string} name
 * @returns {string}
 */
export function safeFileName(name) {
  return String(name || 'export').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, '_').slice(0, 120);
}

/**
 * Triggers a download for a Blob.
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFileName(filename);
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Converts a cell value for numeric columns.
 * @param {unknown} value
 * @returns {number|null}
 */
function numericValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/* ───────────────────────── CSV ───────────────────────── */

/**
 * Escapes a CSV cell and neutralizes spreadsheet formula injection.
 * @param {unknown} value
 * @returns {string}
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Builds CSV text (with BOM so Excel detects UTF-8 Arabic).
 * @param {ExportColumn[]} columns
 * @param {any[]} rows
 * @param {unknown[][]} [footer]
 * @returns {string}
 */
export function toCSV(columns, rows, footer = []) {
  const lines = [columns.map(column => csvCell(column.header)).join(',')];
  rows.forEach((row, index) => {
    lines.push(columns.map(column => {
      const value = column.value(row, index);
      if (column.type === 'number' || column.type === 'money') return csvCell(numericValue(value) ?? '');
      return csvCell(value);
    }).join(','));
  });
  for (const extra of footer) lines.push(extra.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}`;
}

/**
 * Downloads a CSV file.
 * @param {string} filename
 * @param {ExportColumn[]} columns
 * @param {any[]} rows
 * @param {unknown[][]} [footer]
 */
export function exportCSV(filename, columns, rows, footer) {
  downloadBlob(new Blob([toCSV(columns, rows, footer)], { type: 'text/csv;charset=utf-8' }), filename.endsWith('.csv') ? filename : `${filename}.csv`);
}

/* ───────────────────────── ZIP (store) ───────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32 (IEEE) of a byte array.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Creates an uncompressed ZIP archive.
 * @param {Array<{ name: string, data: string|Uint8Array }>} files
 * @param {Date} [date]
 * @returns {Uint8Array}
 */
export function createZip(files, date = new Date()) {
  const encoder = new TextEncoder();
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff;
  const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const output = new Uint8Array(offset + centralSize + end.length);
  let position = 0;
  for (const part of [...locals, ...centrals, end]) {
    output.set(part, position);
    position += part.length;
  }
  return output;
}

/* ───────────────────────── XLSX ───────────────────────── */

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STYLE = Object.freeze({ normal: 0, header: 1, money: 2, moneyBold: 3, bold: 4, title: 5 });

/**
 * Escapes XML text and strips characters that are illegal in XML 1.0.
 * @param {unknown} value
 * @returns {string}
 */
function xmlText(value) {
  return String(value ?? '')
    .replace(/[^\u0009\u000a\u000d -퟿-�\u{10000}-\u{10ffff}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Column index (0-based) to Excel letters.
 * @param {number} index
 * @returns {string}
 */
export function columnLetter(index) {
  let letters = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * @param {string} ref
 * @param {unknown} value
 * @param {number} style
 * @param {boolean} numeric
 * @returns {string}
 */
function xlsxCell(ref, value, style, numeric) {
  const number = numeric ? numericValue(value) : (typeof value === 'number' && Number.isFinite(value) ? value : null);
  if (number !== null) return `<c r="${ref}" s="${style}"><v>${number}</v></c>`;
  if (value === null || value === undefined || value === '') return `<c r="${ref}" s="${style}"/>`;
  return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

/**
 * Serializes one worksheet.
 * @param {SheetSpec} sheet
 * @returns {string}
 */
function sheetXml(sheet) {
  const rows = [];
  let r = 0;
  for (const line of sheet.preamble || []) {
    r += 1;
    rows.push(`<row r="${r}">${line.map((value, c) => xlsxCell(`${columnLetter(c)}${r}`, value, c === 0 ? STYLE.title : STYLE.normal, false)).join('')}</row>`);
  }
  if (sheet.preamble?.length) r += 1; // blank spacer row
  const headerRow = r + 1;
  r += 1;
  rows.push(`<row r="${r}">${sheet.columns.map((column, c) => xlsxCell(`${columnLetter(c)}${r}`, column.header, STYLE.header, false)).join('')}</row>`);
  sheet.rows.forEach((row, index) => {
    r += 1;
    rows.push(`<row r="${r}">${sheet.columns.map((column, c) => {
      const isMoney = column.type === 'money';
      const isNumber = isMoney || column.type === 'number';
      return xlsxCell(`${columnLetter(c)}${r}`, column.value(row, index), isMoney ? STYLE.money : STYLE.normal, isNumber);
    }).join('')}</row>`);
  });
  for (const line of sheet.footer || []) {
    r += 1;
    rows.push(`<row r="${r}">${line.map((value, c) => {
      const isMoney = sheet.columns[c]?.type === 'money';
      return xlsxCell(`${columnLetter(c)}${r}`, value, isMoney ? STYLE.moneyBold : STYLE.bold, isMoney || sheet.columns[c]?.type === 'number');
    }).join('')}</row>`);
  }
  const cols = sheet.columns.map((column, c) => {
    const width = column.width ?? (column.type === 'money' ? 16 : column.type === 'date' ? 13 : Math.min(40, Math.max(10, column.header.length + 4)));
    return `<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"/>`;
  }).join('');
  const pane = `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheetViews><sheetView workbookViewId="0" rightToLeft="1">${pane}</sheetView></sheetViews><cols>${cols}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS_MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD1FAE5"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF10B981"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/**
 * Builds an .xlsx workbook.
 * @param {SheetSpec[]} sheets
 * @returns {Blob}
 */
export function buildXlsx(sheets) {
  if (!sheets.length) throw new Error('buildXlsx: at least one sheet is required.');
  const usedNames = new Set();
  const names = sheets.map((sheet, index) => {
    let name = String(sheet.name || `Sheet${index + 1}`).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || `Sheet${index + 1}`;
    while (usedNames.has(name)) name = `${name.slice(0, 28)}_${index + 1}`;
    usedNames.add(name);
    return name;
  });
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView/></bookViews><sheets>${names.map((name, i) => `<sheet name="${xmlText(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`
    },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet) }))
  ];
  return new Blob([createZip(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/**
 * Downloads an .xlsx workbook.
 * @param {string} filename
 * @param {SheetSpec[]} sheets
 */
export function exportXlsx(filename, sheets) {
  downloadBlob(buildXlsx(sheets), filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

/* ───────────────────────── JSON ───────────────────────── */

/**
 * Downloads pretty-printed JSON.
 * @param {string} filename
 * @param {unknown} data
 */
export function exportJSON(filename, data) {
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename.endsWith('.json') ? filename : `${filename}.json`);
}

/**
 * Reads a user-selected file as text.
 * @param {File} file
 * @param {number} [maxBytes=50MB]
 * @returns {Promise<string>}
 */
export function readFileAsText(file, maxBytes = 50 * 1024 * 1024) {
  if (file.size > maxBytes) return Promise.reject(new Error('حجم الملف أكبر من الحد المسموح.'));
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error || new Error('تعذر قراءة الملف.'));
    reader.readAsText(file);
  });
}

/** Image types accepted as a company logo. */
export const LOGO_FILE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Shrinks a user-selected image to fit within maxSide×maxSide (never upscaling)
 * and returns the smallest of its WebP/PNG (and, for photos, JPEG) encodings
 * as a base64 data URL. Transparency is kept for PNG/WebP sources.
 * @param {File} file
 * @param {{ maxSide?: number, maxBytes?: number, maxLength?: number }} [options]
 *   maxBytes caps the input file; maxLength caps the resulting data URL.
 * @returns {Promise<string>}
 */
export async function readImageAsLogo(file, { maxSide = 200, maxBytes = 5 * 1024 * 1024, maxLength = 200_000 } = {}) {
  if (!LOGO_FILE_TYPES.includes(file.type)) throw new Error('صيغة الصورة غير مدعومة. استخدم PNG أو JPG أو WebP.');
  if (file.size > maxBytes) throw new Error(`حجم الصورة أكبر من ${Math.round(maxBytes / 1024 / 1024)} ميجابايت.`);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error('تعذر قراءة الصورة. قد يكون الملف تالفاً.');
    }
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('تعذر معالجة الصورة في هذا المتصفح.');
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // Browsers without a WebP encoder return PNG for the WebP request, which is still valid.
    const encodings = [canvas.toDataURL('image/webp', 0.9), canvas.toDataURL('image/png')];
    if (file.type === 'image/jpeg') encodings.push(canvas.toDataURL('image/jpeg', 0.9));
    const smallest = encodings.reduce((best, next) => (next.length < best.length ? next : best));
    if (smallest.length > maxLength) throw new Error('الصورة كبيرة جداً حتى بعد ضغطها. جرّب شعاراً أبسط.');
    return smallest;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ───────────────────────── printable reports (PDF) ───────────────────────── */

/**
 * @typedef {Object} PrintColumn
 * @property {string} header
 * @property {'start'|'center'|'end'} [align]
 */

/**
 * @typedef {Object} PrintSection
 * @property {string} [title]
 * @property {PrintColumn[]} columns
 * @property {string[][]} rows Pre-formatted cell text.
 * @property {string[][]} [footer]
 * @property {string} [empty] Message shown when there are no rows.
 */

/**
 * @typedef {Object} PrintReport
 * @property {string} title
 * @property {string} [subtitle]
 * @property {PrintCompany} company
 * @property {Array<{ label: string, value: string }>} [meta]
 * @property {Array<{ label: string, value: string, tone?: 'due'|'credit'|'settled'|'neutral' }>} [summary]
 * @property {PrintSection[]} sections
 * @property {string} [notes]
 * @property {boolean|string[]} [signatures] `true` for the default accountant/customer lines, or custom labels.
 */

/**
 * @typedef {Object} PrintCompany
 * @property {string} name
 * @property {string} [taxNumber]
 * @property {string} [phone]
 * @property {string} [logo] Base64 image data URL (validated by `companyForPrint`).
 */

/** Printed documents load nothing external; inline styles and the embedded logo only. */
export const PRINT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** Logo + company details block shared by every printed header. */
export const COMPANY_BLOCK_CSS = `
.company-block { display: flex; align-items: center; gap: 10px; min-width: 0; }
.company-logo { display: block; max-height: 40px; max-width: 120px; width: auto; height: auto; object-fit: contain; flex-shrink: 0; }
`;

/**
 * Header block with the optional company logo, name, tax number and phone.
 * @param {PrintCompany} company
 * @returns {string}
 */
export function companyBlockHtml(company) {
  const logo = /^data:image\/(?:png|jpeg|webp);base64,/.test(company.logo || '') ? `<img class="company-logo" src="${escapeHtml(company.logo)}" alt="">` : '';
  return `<div class="company-block">${logo}<div class="company">${escapeHtml(company.name || '')}${company.taxNumber ? `<small>الرقم الضريبي: ${escapeHtml(company.taxNumber)}</small>` : ''}${company.phone ? `<small>هاتف: ${escapeHtml(company.phone)}</small>` : ''}</div></div>`;
}

const PRINT_CSS = `
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Cairo", "Segoe UI", Tahoma, "Noto Naskh Arabic", Arial, sans-serif; color: #0f172a; font-size: 11.5px; line-height: 1.55; direction: rtl; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
header.doc { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #1e3a8a; padding-bottom: 10px; margin-bottom: 14px; }
.company { font-size: 16px; font-weight: 800; color: #064e3b; }
.company small { display: block; font-size: 11px; font-weight: 500; color: #475569; }
.doc-title { text-align: left; }
.doc-title h1 { margin: 0; font-size: 18px; color: #0f172a; }
.doc-title p { margin: 2px 0 0; color: #64748b; }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; }
.meta div span { color: #64748b; display: block; font-size: 10px; }
.meta div strong { font-size: 12px; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin-bottom: 14px; }
.summary div { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; }
.summary span { display: block; color: #64748b; font-size: 10px; }
.summary strong { font-size: 14px; font-variant-numeric: tabular-nums; }
.tone-due strong { color: #be123c; } .tone-credit strong { color: #b45309; } .tone-settled strong { color: #047857; }
h2 { font-size: 13px; margin: 16px 0 6px; color: #064e3b; }
table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
thead { display: table-header-group; } tfoot { display: table-footer-group; }
tr { page-break-inside: avoid; }
th { background: #f1f5f9; color: #0f172a; font-weight: 700; border: 1px solid #cbd5e1; padding: 5px 6px; font-size: 10.5px; }
td { border: 1px solid #e2e8f0; padding: 4px 6px; font-variant-numeric: tabular-nums; vertical-align: top; }
tbody tr:nth-child(even) td { background: #f8fafc; }
tfoot td { background: #f1f5f9; font-weight: 800; border-color: #cbd5e1; }
.a-center { text-align: center; } .a-end { text-align: left; } .a-start { text-align: right; }
.empty { text-align: center; color: #94a3b8; padding: 14px; }
.notes { margin-top: 14px; padding: 8px 10px; border-inline-start: 3px solid #1d4ed8; background: #f8fafc; color: #334155; }
.signatures { display: flex; justify-content: space-between; margin-top: 40px; gap: 40px; }
.signatures div { flex: 1; border-top: 1px dashed #94a3b8; padding-top: 6px; text-align: center; color: #475569; }
footer.doc { margin-top: 18px; font-size: 9.5px; color: #94a3b8; text-align: center; }
`;

/**
 * Builds a standalone printable HTML document. All dynamic text is escaped.
 * @param {PrintReport} report
 * @returns {string}
 */
export function buildPrintableHtml(report) {
  const cell = (text, column) => `<td class="a-${column?.align || 'start'}">${escapeHtml(text)}</td>`;
  const section = item => {
    const head = `<thead><tr>${item.columns.map(column => `<th class="a-${column.align || 'start'}">${escapeHtml(column.header)}</th>`).join('')}</tr></thead>`;
    const body = item.rows.length
      ? item.rows.map(row => `<tr>${row.map((text, c) => cell(text, item.columns[c])).join('')}</tr>`).join('')
      : `<tr><td class="empty" colspan="${item.columns.length}">${escapeHtml(item.empty || 'لا توجد بيانات.')}</td></tr>`;
    const foot = item.footer?.length
      ? `<tfoot>${item.footer.map(row => `<tr>${row.map((text, c) => cell(text, item.columns[c])).join('')}</tr>`).join('')}</tfoot>`
      : '';
    return `${item.title ? `<h2>${escapeHtml(item.title)}</h2>` : ''}<table>${head}<tbody>${body}</tbody>${foot}</table>`;
  };
  const company = report.company || { name: '' };
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}"><title>${escapeHtml(report.title)}</title><style>${PRINT_CSS}${COMPANY_BLOCK_CSS}</style></head><body>
<header class="doc">${companyBlockHtml(company)}
<div class="doc-title"><h1>${escapeHtml(report.title)}</h1>${report.subtitle ? `<p>${escapeHtml(report.subtitle)}</p>` : ''}</div></header>
${report.meta?.length ? `<section class="meta">${report.meta.map(item => `<div><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>`).join('')}</section>` : ''}
${report.summary?.length ? `<section class="summary">${report.summary.map(item => `<div class="tone-${item.tone || 'neutral'}"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>`).join('')}</section>` : ''}
${report.sections.map(section).join('')}
${report.notes ? `<p class="notes">${escapeHtml(report.notes)}</p>` : ''}
${report.signatures ? `<div class="signatures">${(Array.isArray(report.signatures) ? report.signatures : ['توقيع المحاسب', 'توقيع العميل / المستلم']).map(label => `<div>${escapeHtml(label)}</div>`).join('')}</div>` : ''}
<footer class="doc">صدر بتاريخ ${escapeHtml(formatDateTime(new Date()))}${company.name ? ` — ${escapeHtml(company.name)}` : ''}</footer>
</body></html>`;
}

/**
 * Opens the browser print dialog for a report (choose "Save as PDF" to export).
 * @param {PrintReport} report
 * @returns {Promise<void>}
 */
export function printReport(report) {
  return printHtml(buildPrintableHtml(report));
}

/**
 * Prints a standalone HTML document (all dynamic text must already be escaped).
 * Uses an isolated hidden iframe so the app's own styles and state are untouched.
 * @param {string} html
 * @returns {Promise<void>}
 */
export function printHtml(html) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    Object.assign(frame.style, { position: 'fixed', width: '0', height: '0', border: '0', insetInlineStart: '-9999px', bottom: '0' });
    const cleanup = () => setTimeout(() => frame.remove(), 1000);
    frame.onload = () => {
      try {
        const win = frame.contentWindow;
        if (!win) throw new Error('تعذر تجهيز نافذة الطباعة.');
        win.addEventListener('afterprint', cleanup, { once: true });
        win.focus();
        win.print();
        setTimeout(cleanup, 60_000);
        resolve();
      } catch (error) {
        frame.remove();
        reject(error);
      }
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

/**
 * Standard export file base name, e.g. "كشف_حساب_مؤسسة_الريان_2026-10-11".
 * @param {...string} parts
 * @returns {string}
 */
export function exportName(...parts) {
  return safeFileName([...parts.filter(Boolean), toISODate()].join('_'));
}
