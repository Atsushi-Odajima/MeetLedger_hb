// RFC 4180 CSV with spreadsheet formula-injection protection (OWASP "CSV Injection"):
// any text cell starting with = + - @ TAB CR (or their full-width forms) is prefixed with a single quote
// so Excel / LibreOffice / Google Sheets treat it as text, never as a formula.

const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;

export function neutralizeFormula(s: string): string {
  return FORMULA_START.test(s) ? `'${s}` : s;
}

export type CsvValue = string | number | boolean | null | undefined | Date;

export function csvCell(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (typeof v === 'number') s = Number.isFinite(v) ? String(v) : '';
  else if (typeof v === 'boolean') s = v ? 'true' : 'false';
  else if (v instanceof Date) s = v.toISOString();
  else s = neutralizeFormula(String(v));
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV document: UTF-8 BOM (Excel opens Japanese correctly), CRLF line endings. */
export function toCsv(headers: string[], data: CsvValue[][]): string {
  const lines = [headers.map((h) => csvCell(h)).join(','), ...data.map((r) => r.map(csvCell).join(','))];
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Minimal RFC 4180 parser (used by tests / tooling to verify exports). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && src[i + 1] === '\n') {
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
      i++;
    } else if (ch === '\n') {
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}
