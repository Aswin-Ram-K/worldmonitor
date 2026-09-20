/**
 * CSV cell escaping. Deliberately a LEAF module with zero imports: the
 * exporter it serves (src/utils/export.ts) pulls @/services/i18n, whose
 * `import.meta.glob` cannot load under plain `node --test`. Keeping the
 * guard here lets the regression tests exercise the SHIPPED function instead
 * of a hand-copied duplicate — the copy had already drifted (`value || ''`
 * vs `value == null ? '' : String(value)`) while the tests stayed green.
 */

/**
 * OWASP CSV Injection guard: a quoted cell that still starts with =, +, -,
 * @, tab, CR, LF, or | is treated as a formula/DDE by Excel, LibreOffice,
 * and Sheets. Quoting/escaping embedded quotes is not enough for
 * third-party RSS/intel strings and user-typed monitor keywords, so prefix
 * the dangerous first character with a single quote (the standard
 * spreadsheet escape, inert for legitimate text). Runs before quoting so
 * the quote wraps the escaped value.
 */
const CSV_FORMULA_PREFIX_RE = /^[=+\-@\t\r\n|]/;

export function sanitizeCsvField(value: string | null | undefined): string {
  const text = value == null ? '' : String(value);
  // A plain numeric literal is never a formula, and prefixing it would break
  // the export: `-` is a formula trigger, so every negative number in the
  // numeric columns (flight/vessel Lat+Lon, market Change, earthquake
  // DepthKm, radiation Value) would arrive in Excel/Sheets as text and stop
  // being sortable, chartable or summable. Number() rejects the formula
  // payloads this guard exists for — Number('-2+3'), Number('=1+1') and
  // Number('+cmd') are all NaN — so the escape still applies to them.
  if (text !== '' && Number.isFinite(Number(text))) return text;
  return CSV_FORMULA_PREFIX_RE.test(text) ? `'${text}` : text;
}

/** Quote one CSV row, escaping embedded quotes after formula neutralization. */
export function csvRow(values: string[]): string {
  return values.map(v => `"${sanitizeCsvField(v || '').replace(/"/g, '""')}"`).join(',');
}
