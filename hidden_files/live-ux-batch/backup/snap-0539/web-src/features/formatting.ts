/**
 * Cell formatting model for the web UI (v2: cascade).
 *
 * Formatting is a pure UI concern: it never touches cell data or formulas,
 * so it does not go through the Authorizer/engine protocol. Three separate
 * layers:
 *   1. Value/formula — the data, in the engine.
 *   2. Data type — column/range metadata from the source schema (e.g. a
 *      connector's typed columns). Informs the DEFAULT format.
 *   3. Format — presentation metadata, resolved through the cascade:
 *      cell > range > column > default (General).
 *
 * The ribbon writes to the appropriate cascade level; Grid.tsx resolves the
 * effective format per cell at render time.
 */

import { formatWithCode } from '@icecream-sheets/xlsx-adapter';
import {
  DEFAULT_LOCALE,
  formatLocaleCurrency,
  formatLocaleDate,
  formatLocaleNumber,
  type LocaleConfig,
} from './locale';

export interface BorderSide {
  style: BorderStyle;
  color: string;
}

export type BorderStyle =
  | 'none'
  | 'thin'
  | 'medium'
  | 'thick'
  | 'dashed'
  | 'dotted'
  | 'double';

export interface CellBorders {
  top?: BorderSide;
  bottom?: BorderSide;
  left?: BorderSide;
  right?: BorderSide;
}

export type HAlign = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'middle' | 'bottom';

/** Number format categories (Excel-style). */
export type NumberFormat =
  | 'General'
  | 'Number'
  | 'Currency'
  | 'Accounting'
  | 'Date'
  | 'Time'
  | 'Percentage'
  | 'Fraction'
  | 'Scientific'
  | 'Text'
  | 'Special';

/** Excel Special formats: zip code, zip+4, phone number, SSN. */
export type SpecialFormatKind = 'zip' | 'zip4' | 'phone' | 'ssn';

/** Excel built-in date format variants (numFmtIds 14-17, 22, 45-46). */
export type DateVariant =
  | 'mdyyyy'      // 14: m/d/yyyy (locale-aware order)
  | 'dmmmyy'      // 15: d-mmm-yy
  | 'dmmm'        // 16: d-mmm
  | 'mmmyy'       // 17: mmm-yy
  | 'mdyyyyhm'    // 22: m/d/yyyy h:mm
  | 'mmss'        // 45: mm:ss
  | 'hmmss';      // 46: [h]:mm:ss (elapsed)

/** Excel built-in time format variants (numFmtIds 18-21). */
export type TimeVariant =
  | 'hmmAMPM'     // 18: h:mm AM/PM
  | 'hmmssAMPM'   // 19: h:mm:ss AM/PM
  | 'hmm'         // 20: h:mm (24h)
  | 'hmmss';      // 21: h:mm:ss (24h)

/** Negative number display styles (Excel Number/Currency). */
export type NegativeStyle = 'minus' | 'red' | 'parens' | 'redParens';

export interface CellFormat {
  fontName?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean | 'double';
  strikethrough?: boolean;
  fontColor?: string;
  fillColor?: string;
  borders?: CellBorders;
  hAlign?: HAlign;
  vAlign?: VAlign;
  wrapText?: boolean;
  numberFormat?: NumberFormat;
  /**
   * Raw Excel number format code imported from the file (e.g.
   * "0.0%;\\(0.0%\\);\\-"). Rendered via the Excel format interpreter until
   * the user sets their own numberFormat on the cell, which always wins.
   */
  formatCode?: string;
  /** Fixed decimal places for Number/Percentage/Scientific-style formats. */
  decimals?: number;
  /** Special format kind (when numberFormat is 'Special'). */
  specialKind?: SpecialFormatKind;
  /** Date format variant (when numberFormat is 'Date'). Default 'mdyyyy'. */
  dateVariant?: DateVariant;
  /** Time format variant (when numberFormat is 'Time'). Default 'hmmAMPM'. */
  timeVariant?: TimeVariant;
  /** Negative display style for Number/Currency. */
  negativeStyle?: NegativeStyle;
  /**
   * Explicit currency symbol override (e.g. '€'). When set, wins over the
   * locale default. Does not change the locale itself.
   */
  currencySymbol?: string;
  indent?: number;
  /**
   * Text rotation in degrees, -90..90 (Excel Orientation). Positive angles
   * tilt counterclockwise. Undefined = no rotation.
   */
  orientation?: number;
  /** Stacked vertical text (Excel "Vertical Text"). Overrides orientation. */
  verticalText?: boolean;
}

/**
 * Format cascade (v2).
 *
 * Formats live at three levels, resolved cell > range > column > default:
 * - **Column**: `columns` map keyed "sheet:col" — e.g. column D is Currency.
 * - **Range**: `ranges` list of rectangular regions — e.g. B7:J8 is Percentage.
 *   Later entries win over earlier ones on overlap.
 * - **Cell**: `cells` map keyed "sheet:row:col" — per-cell overrides.
 *
 * `getFormat` merges the three levels (like CSS): a level only overrides the
 * fields it sets, so a bold cell in a Currency column renders bold+Currency.
 * Clearing a field (setting it to undefined) falls through to the next level.
 *
 * Formats are presentation metadata only: they never touch values or
 * formulas, which live in the engine.
 */
export interface RangeFormatEntry {
  id: string;
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  format: CellFormat;
}

export interface FormatStore {
  cells: Map<string, CellFormat>;
  ranges: RangeFormatEntry[];
  columns: Map<string, CellFormat>;
}

/** Create an empty format store. */
export function createFormatStore(): FormatStore {
  return { cells: new Map(), ranges: [], columns: new Map() };
}

export function formatKey(sheet: string, row: number, col: number): string {
  return `${sheet}:${row}:${col}`;
}

/** Key for a column-level format entry. */
export function columnKey(sheet: string, col: number): string {
  return `${sheet}:${col}`;
}

let rangeFormatSeq = 0;
function nextRangeId(): string {
  rangeFormatSeq += 1;
  return `rf_${Date.now().toString(36)}_${rangeFormatSeq}`;
}

/**
 * Resolve the effective format for a cell through the cascade:
 * column < range < cell. Each level merges over the lower ones, so a level
 * only overrides the fields it explicitly sets. Returns undefined when no
 * level has any format for the cell (caller falls back to General / the
 * data-type default).
 */
export function getFormat(store: FormatStore, sheet: string, row: number, col: number): CellFormat | undefined {
  const colFmt = store.columns.get(columnKey(sheet, col));
  let rangeFmt: CellFormat | undefined;
  for (const r of store.ranges) {
    if (
      r.sheet === sheet &&
      row >= r.startRow && row <= r.endRow &&
      col >= r.startCol && col <= r.endCol
    ) {
      rangeFmt = r.format;
    }
  }
  const cellFmt = store.cells.get(formatKey(sheet, row, col));
  if (!colFmt && !rangeFmt && !cellFmt) return undefined;
  return { ...colFmt, ...rangeFmt, ...cellFmt };
}

/**
 * Bulk-import per-cell formats (file-open path): builds the cell map mutably
 * in O(n). The immutable setFormat() copies the whole map per call — O(n²) —
 * which hung the P95 open (1M formatted cells) for 10+ minutes (2026-10-19
 * perf benchmarking). Interactive edits keep using setFormat().
 */
export function importCellFormats(
  entries: Array<{ sheet: string; row: number; col: number; format: CellFormat }>,
): FormatStore {
  const cells = new Map<string, CellFormat>();
  for (const e of entries) {
    const key = formatKey(e.sheet, e.row, e.col);
    const existing = cells.get(key);
    cells.set(key, existing ? { ...existing, ...e.format } : { ...e.format });
  }
  return { cells, ranges: [], columns: new Map() };
}

/**
 * Apply a partial format update to a single cell (cell level of the cascade).
 * Merges with any existing cell-level format. Setting a field to undefined
 * clears that field (falls through to range/column).
 */
export function setFormat(
  store: FormatStore,
  sheet: string,
  row: number,
  col: number,
  update: Partial<CellFormat>,
): FormatStore {
  const key = formatKey(sheet, row, col);
  const existing = store.cells.get(key) ?? {};
  const merged: CellFormat = { ...existing };
  for (const [k, v] of Object.entries(update)) {
    if (v === undefined) delete (merged as Record<string, unknown>)[k];
    else (merged as Record<string, unknown>)[k] = v;
  }
  const cells = new Map(store.cells);
  if (Object.keys(merged).length === 0) cells.delete(key);
  else cells.set(key, merged);
  return { cells, ranges: store.ranges, columns: store.columns };
}

/**
 * Apply a format update at range level (stored as ONE range entry, not
 * exploded per-cell). Merges with an existing entry covering the exact same
 * range; otherwise appends a new entry (later entries win on overlap).
 */
export function setRangeFormat(
  store: FormatStore,
  sheet: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  update: Partial<CellFormat>,
): FormatStore {
  const sr = Math.min(startRow, endRow);
  const er = Math.max(startRow, endRow);
  const sc = Math.min(startCol, endCol);
  const ec = Math.max(startCol, endCol);
  const ranges = store.ranges.slice();
  const existingIdx = ranges.findIndex(
    (r) =>
      r.sheet === sheet &&
      r.startRow === sr && r.endRow === er &&
      r.startCol === sc && r.endCol === ec,
  );
  if (existingIdx >= 0) {
    const existing = ranges[existingIdx];
    const merged: CellFormat = { ...existing.format };
    for (const [k, v] of Object.entries(update)) {
      if (v === undefined) delete (merged as Record<string, unknown>)[k];
      else (merged as Record<string, unknown>)[k] = v;
    }
    if (Object.keys(merged).length === 0) ranges.splice(existingIdx, 1);
    else ranges[existingIdx] = { ...existing, format: merged };
  } else {
    const format: CellFormat = {};
    for (const [k, v] of Object.entries(update)) {
      if (v !== undefined) (format as Record<string, unknown>)[k] = v;
    }
    if (Object.keys(format).length > 0) {
      ranges.push({ id: nextRangeId(), sheet, startRow: sr, startCol: sc, endRow: er, endCol: ec, format });
    }
  }
  return { cells: store.cells, ranges, columns: store.columns };
}

/**
 * Apply a partial format update at column level (stored once per column,
 * not per-cell). Merges with any existing column format.
 */
export function setColumnFormat(
  store: FormatStore,
  sheet: string,
  col: number,
  update: Partial<CellFormat>,
): FormatStore {
  const key = columnKey(sheet, col);
  const existing = store.columns.get(key) ?? {};
  const merged: CellFormat = { ...existing };
  for (const [k, v] of Object.entries(update)) {
    if (v === undefined) delete (merged as Record<string, unknown>)[k];
    else (merged as Record<string, unknown>)[k] = v;
  }
  const columns = new Map(store.columns);
  if (Object.keys(merged).length === 0) columns.delete(key);
  else columns.set(key, merged);
  return { cells: store.cells, ranges: store.ranges, columns };
}

/** Remove the cell-level format for a cell (range/column still apply). */
export function clearFormat(store: FormatStore, sheet: string, row: number, col: number): FormatStore {
  const cells = new Map(store.cells);
  cells.delete(formatKey(sheet, row, col));
  return { cells, ranges: store.ranges, columns: store.columns };
}

/**
 * Remove range-level entries overlapping a rectangular region, and clear
 * cell-level formats inside it. Column formats are left intact (they are
 * broader than the range).
 */
export function clearRangeFormat(
  store: FormatStore,
  sheet: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): FormatStore {
  const sr = Math.min(startRow, endRow);
  const er = Math.max(startRow, endRow);
  const sc = Math.min(startCol, endCol);
  const ec = Math.max(startCol, endCol);
  const ranges = store.ranges.filter(
    (r) =>
      r.sheet !== sheet ||
      r.endRow < sr || r.startRow > er ||
      r.endCol < sc || r.startCol > ec,
  );
  const cells = new Map(store.cells);
  for (const key of cells.keys()) {
    const parts = key.split(':');
    if (parts.length !== 3 || parts[0] !== sheet) continue;
    const r = Number(parts[1]);
    const c = Number(parts[2]);
    if (r >= sr && r <= er && c >= sc && c <= ec) cells.delete(key);
  }
  return { cells, ranges, columns: store.columns };
}

/** Remove the column-level format for a column. */
export function clearColumnFormat(store: FormatStore, sheet: string, col: number): FormatStore {
  const columns = new Map(store.columns);
  columns.delete(columnKey(sheet, col));
  return { cells: store.cells, ranges: store.ranges, columns };
}

/**
 * Resolve the whole cascade for one sheet into per-cell formats, for the
 * SAVE path (defect D4): the file format is per-cell, so column entries
 * expand over rows 0..endRow and range entries expand over their rect;
 * cell entries win, then ranges (later wins), then columns — the same
 * precedence getFormat() applies per cell. `endRow` is a floor: explicit
 * cell/range entries beyond it are still included (a formatted empty
 * cell past the data extent must persist too).
 */
export function expandFormatStore(
  store: FormatStore,
  sheet: string,
  endRow: number,
): Map<string, CellFormat> {
  const out = new Map<string, CellFormat>();
  const merge = (row: number, col: number, fmt: CellFormat): void => {
    const key = formatKey(sheet, row, col);
    const existing = out.get(key);
    out.set(key, existing ? { ...existing, ...fmt } : { ...fmt });
  };
  let maxRow = endRow;
  for (const key of store.cells.keys()) {
    const parts = key.split(':');
    if (parts.length !== 3 || parts[0] !== sheet) continue;
    const r = Number(parts[1]);
    if (Number.isInteger(r) && r > maxRow) maxRow = r;
  }
  for (const r of store.ranges) {
    if (r.sheet === sheet && r.endRow > maxRow) maxRow = r.endRow;
  }
  // Column level (lowest precedence).
  for (const [key, fmt] of store.columns) {
    const parts = key.split(':');
    if (parts.length !== 2 || parts[0] !== sheet) continue;
    const col = Number(parts[1]);
    if (!Number.isInteger(col) || col < 0) continue;
    for (let row = 0; row <= maxRow; row++) merge(row, col, fmt);
  }
  // Range level (later entries win, as in getFormat).
  for (const r of store.ranges) {
    if (r.sheet !== sheet) continue;
    for (let row = r.startRow; row <= r.endRow; row++) {
      for (let col = r.startCol; col <= r.endCol; col++) merge(row, col, r.format);
    }
  }
  // Cell level (highest precedence).
  for (const [key, fmt] of store.cells) {
    const parts = key.split(':');
    if (parts.length !== 3 || parts[0] !== sheet) continue;
    const row = Number(parts[1]);
    const col = Number(parts[2]);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) continue;
    merge(row, col, fmt);
  }
  return out;
}

/** Excel format codes for the built-in date/time variants. */
const DATE_VARIANT_CODES: Record<DateVariant, string> = {
  mdyyyy: 'm/d/yyyy',
  dmmmyy: 'd-mmm-yy',
  dmmm: 'd-mmm',
  mmmyy: 'mmm-yy',
  mdyyyyhm: 'm/d/yyyy h:mm',
  mmss: 'mm:ss',
  hmmss: '[h]:mm:ss',
};
const TIME_VARIANT_CODES: Record<TimeVariant, string> = {
  hmmAMPM: 'h:mm AM/PM',
  hmmssAMPM: 'h:mm:ss AM/PM',
  hmm: 'h:mm',
  hmmss: 'h:mm:ss',
};
const SPECIAL_KIND_CODES: Record<SpecialFormatKind, string> = {
  zip: '00000',
  zip4: '00000-0000',
  phone: '[<=9999999]###-####;(###) ###-####',
  ssn: '000-00-0000',
};

/**
 * The Excel number format code a CellFormat renders with (save path,
 * defect D4). Mirrors formatNumber()'s semantics: an explicit
 * numberFormat category always wins over an imported raw formatCode
 * (the same precedence Grid.tsx renders with); General maps to
 * undefined (no code is written for it). Returns undefined when the
 * format carries no number formatting at all.
 */
export function numberFormatToCode(fmt: CellFormat): string | undefined {
  if (!fmt.numberFormat) return fmt.formatCode;
  const decimals = fmt.decimals ?? 2;
  const dec = decimals > 0 ? `.${'0'.repeat(decimals)}` : '';
  const sym = fmt.currencySymbol ?? '$';
  const symLit = `"${sym.replace(/"/g, '""')}"`;
  switch (fmt.numberFormat) {
    case 'General':
      return undefined;
    case 'Number': {
      const base = `#,##0${dec}`;
      if (fmt.negativeStyle === 'parens' || fmt.negativeStyle === 'redParens') return `${base}_);(${base})`;
      if (fmt.negativeStyle === 'red') return `[Red]${base}`;
      return base;
    }
    case 'Currency': {
      const base = `${symLit}#,##0.00`;
      if (fmt.negativeStyle === 'parens' || fmt.negativeStyle === 'redParens') return `${base}_);(${base})`;
      if (fmt.negativeStyle === 'red') return `[Red]${base}`;
      return base;
    }
    case 'Accounting':
      return `_(${symLit}* #,##0.00_);_(${symLit}* (#,##0.00);_(${symLit}* "-"??_);_(@_)`;
    case 'Percentage':
      return `0${dec}%`;
    case 'Scientific':
      return `0${dec}E+00`;
    case 'Fraction':
      return '# ?/?';
    case 'Date':
      return DATE_VARIANT_CODES[fmt.dateVariant ?? 'mdyyyy'];
    case 'Time':
      return TIME_VARIANT_CODES[fmt.timeVariant ?? 'hmmAMPM'];
    case 'Special':
      return SPECIAL_KIND_CODES[fmt.specialKind ?? 'zip'];
    case 'Text':
      return '@';
    default:
      return fmt.formatCode;
  }
}

/** Remove every format entry for a sheet (used on sheet clear/delete). */
export function clearSheetFormats(store: FormatStore, sheet: string): FormatStore {
  const cells = new Map(store.cells);
  for (const key of cells.keys()) {
    if (key.startsWith(`${sheet}:`)) cells.delete(key);
  }
  const ranges = store.ranges.filter((r) => r.sheet !== sheet);
  const columns = new Map(store.columns);
  for (const key of columns.keys()) {
    if (key.startsWith(`${sheet}:`)) columns.delete(key);
  }
  return { cells, ranges, columns };
}

// ---------------------------------------------------------------------------
// Data type metadata (layer 2 of 3: value/formula | data type | format)
// ---------------------------------------------------------------------------

/**
 * Column/range data type, seeded from the data-source schema when a sheet is
 * a VIEW over a connector (SQL, API, CSV…). Independent of values, formulas
 * and formats: it describes what the source column IS, and informs the
 * DEFAULT format (a date column defaults to Date rendering) unless the user
 * overrides the format — changing the format never touches the type.
 */
export type ColumnDataType = 'text' | 'number' | 'boolean' | 'date' | 'currency' | 'unknown';

export interface DataTypeRangeEntry {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  type: ColumnDataType;
}

export interface DataTypeStore {
  columns: Map<string, ColumnDataType>;
  ranges: DataTypeRangeEntry[];
}

/** Create an empty data-type store. */
export function createDataTypeStore(): DataTypeStore {
  return { columns: new Map(), ranges: [] };
}

/** Seed column data types for a sheet (e.g. from TableData.types at import). */
export function setColumnDataTypes(
  store: DataTypeStore,
  sheet: string,
  types: ColumnDataType[],
): DataTypeStore {
  const columns = new Map(store.columns);
  types.forEach((t, col) => {
    columns.set(columnKey(sheet, col), t);
  });
  return { columns, ranges: store.ranges };
}

/** Resolve the data type for a cell: range entry wins, else column, else 'unknown'. */
export function getDataType(store: DataTypeStore, sheet: string, row: number, col: number): ColumnDataType {
  for (let i = store.ranges.length - 1; i >= 0; i--) {
    const r = store.ranges[i];
    if (
      r.sheet === sheet &&
      row >= r.startRow && row <= r.endRow &&
      col >= r.startCol && col <= r.endCol
    ) {
      return r.type;
    }
  }
  return store.columns.get(columnKey(sheet, col)) ?? 'unknown';
}

/**
 * Default number format implied by a data type. Used when the cascade has no
 * explicit number format for the cell. The user can always override via the
 * ribbon without affecting the stored type.
 */
export function dataTypeToDefaultFormat(type: ColumnDataType): NumberFormat | undefined {
  switch (type) {
    case 'date':
      return 'Date';
    case 'currency':
      return 'Currency';
    default:
      return undefined;
  }
}

/** Metadata key for persisting the DataTypeStore through XLSX custom properties. */
export const DATATYPES_METADATA_KEY = 'icecream.datatypes.v1';

/**
 * Serialize a DataTypeStore to JSON-safe metadata for the save path.
 * Returns undefined when the store is empty (nothing to persist).
 */
export function dataTypesToMetadata(store: DataTypeStore): Record<string, unknown> | undefined {
  const columns: Record<string, ColumnDataType> = {};
  for (const [k, v] of store.columns) columns[k] = v;
  if (Object.keys(columns).length === 0 && store.ranges.length === 0) return undefined;
  return {
    columns,
    ranges: store.ranges.map((r) => ({ ...r })),
  };
}

/**
 * Restore a DataTypeStore from save-path metadata. Corrupt or missing data
 * yields an empty store — a bad metadata blob must never break open.
 */
export function dataTypesFromMetadata(meta: unknown): DataTypeStore {
  const store = createDataTypeStore();
  if (!meta || typeof meta !== 'object') return store;
  const m = meta as { columns?: unknown; ranges?: unknown };
  if (m.columns && typeof m.columns === 'object') {
    for (const [k, v] of Object.entries(m.columns as Record<string, unknown>)) {
      if (typeof v === 'string' && isColumnDataType(v)) store.columns.set(k, v);
    }
  }
  if (Array.isArray(m.ranges)) {
    for (const r of m.ranges) {
      if (isDataTypeRangeEntry(r)) store.ranges.push({ ...(r as DataTypeRangeEntry) });
    }
  }
  return store;
}

function isColumnDataType(v: string): v is ColumnDataType {
  return v === 'text' || v === 'number' || v === 'boolean' || v === 'date' || v === 'currency' || v === 'unknown';
}

function isDataTypeRangeEntry(r: unknown): boolean {
  if (!r || typeof r !== 'object') return false;
  const e = r as Record<string, unknown>;
  return (
    typeof e.sheet === 'string' &&
    Number.isInteger(e.startRow) && Number.isInteger(e.startCol) &&
    Number.isInteger(e.endRow) && Number.isInteger(e.endCol) &&
    typeof e.type === 'string' && isColumnDataType(e.type)
  );
}

// ---------------------------------------------------------------------------
// Number formatting: TypedValue -> display string
// ---------------------------------------------------------------------------

export interface SimpleTypedValue {
  kind: string;
  value?: unknown;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Excel serial date (days since 1899-12-30) -> {y,m,d}. */
function excelDateParts(serial: number): { y: number; m: number; d: number } | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}

/**
 * Options for formatNumber: locale-aware rendering.
 */
export interface FormatNumberOptions {
  /** Locale for separators/symbols/date order (default en-US). */
  locale?: LocaleConfig;
  /** Explicit currency symbol override (wins over locale default). */
  currencySymbol?: string;
  /** Special format kind (when fmt is 'Special'). */
  specialKind?: SpecialFormatKind;
  /** Date variant (when fmt is 'Date'). */
  dateVariant?: DateVariant;
  /** Time variant (when fmt is 'Time'). */
  timeVariant?: TimeVariant;
  /** Negative display style for Number/Currency. */
  negativeStyle?: NegativeStyle;
}

/** Apply a negative style to an already-formatted magnitude string. */
function applyNegativeStyle(body: string, n: number, style: NegativeStyle | undefined): string {
  if (n >= 0) return body;
  switch (style) {
    case 'parens':
      return `(${body})`;
    case 'redParens':
      return `(${body})`; // red via CSS; text keeps parens
    case 'red':
      return body; // red via CSS
    case 'minus':
    default:
      return `-${body}`;
  }
}

/** Format an integer with locale thousands separators. */
function groupInteger(intStr: string, loc: LocaleConfig): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, loc.thousandsSeparator);
}

/**
 * Format a numeric value according to an Excel-style number format.
 * Locale-aware: separators, currency symbol/position, and date order follow
 * the provided locale (default en-US). Falls back to plain string conversion
 * for non-numbers or unknown formats.
 */
export function formatNumber(
  value: unknown,
  fmt: NumberFormat,
  decimals = 2,
  options: FormatNumberOptions = {},
): string {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : Number(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (!Number.isFinite(n)) return String(value);
  const loc = options.locale ?? DEFAULT_LOCALE;

  switch (fmt) {
    case 'General':
      // Excel General: up to 10 significant digits, scientific for very
      // large/small magnitudes (not the full float repr).
      return formatWithCode(n);
    case 'Number': {
      const body = formatLocaleNumber(n, decimals, loc);
      return applyNegativeStyle(body, n, options.negativeStyle);
    }
    case 'Currency': {
      const sym = options.currencySymbol ?? loc.currencySymbol;
      const body = formatLocaleNumber(n, 2, loc);
      const withSym = loc.currencyPosition === 'before' ? `${sym}${body}` : `${body} ${sym}`;
      return applyNegativeStyle(withSym, n, options.negativeStyle);
    }
    case 'Accounting': {
      // Excel Accounting: symbol left-aligned in the cell, number right;
      // negatives in parens, zero as dash. We render "$ 1,234.00" with a
      // space approximating the alignment; negatives wrap in parens.
      const sym = options.currencySymbol ?? loc.currencySymbol;
      if (n === 0) return `${sym} ${formatLocaleNumber(0, 2, loc).replace(/-/g, '')} `.trim() + '';
      const body = formatLocaleNumber(n, 2, loc);
      const rendered = loc.currencyPosition === 'before' ? `${sym} ${body}` : `${body} ${sym}`;
      return n < 0 ? `(${rendered})` : rendered;
    }
    case 'Percentage': {
      const pct = n * 100;
      const body = formatLocaleNumber(pct, decimals, loc) + '%';
      return applyNegativeStyle(body, n, options.negativeStyle);
    }
    case 'Scientific': {
      // Locale-aware mantissa separator; exponent stays ASCII.
      const exp = n.toExponential(decimals);
      const [mant, e] = exp.split('e');
      const mantLoc = mant.replace('.', loc.decimalSeparator);
      return `${mantLoc}e${e}`;
    }
    case 'Fraction': {
      // Approximate as a fraction with denominator <= 99.
      const sign = n < 0 ? '-' : '';
      const abs = Math.abs(n);
      const whole = Math.floor(abs);
      const frac = abs - whole;
      if (frac < 1e-9) return sign + String(whole);
      let bestN = 0, bestD = 1, bestErr = Infinity;
      for (let d = 1; d <= 99; d++) {
        const nn = Math.round(frac * d);
        const err = Math.abs(frac - nn / d);
        if (err < bestErr) { bestErr = err; bestN = nn; bestD = d; }
      }
      const fracStr = bestN === 0 ? '' : `${bestN}/${bestD}`;
      if (whole === 0) return sign + fracStr;
      return sign + (fracStr ? `${whole} ${fracStr}` : String(whole));
    }
    case 'Date': {
      const p = excelDateParts(n);
      if (!p) return String(value);
      return formatDateVariant(p.y, p.m, p.d, n, options.dateVariant ?? 'mdyyyy', loc);
    }
    case 'Time': {
      return formatTimeVariant(n, options.timeVariant ?? 'hmmAMPM');
    }
    case 'Special':
      return formatSpecial(n, options.specialKind ?? 'zip');
    case 'Text':
      return String(value);
    default:
      return String(value);
  }
}

/** Excel built-in date variants (numFmtIds 14-17, 22, 45-46). */
export function formatDateVariant(
  y: number, m0: number, d: number, serial: number,
  variant: DateVariant, loc: LocaleConfig,
): string {
  const mmm = MONTHS[m0];
  const mm = String(m0 + 1).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  const yy = String(y).slice(-2);
  switch (variant) {
    case 'dmmmyy':
      return `${d}-${mmm}-${yy}`; // 15
    case 'dmmm':
      return `${d}-${mmm}`; // 16
    case 'mmmyy':
      return `${mmm}-${yy}`; // 17
    case 'mdyyyyhm': {
      const t = formatTimeVariant(serial, 'hmm');
      return `${formatLocaleDate(y, m0, d, loc)} ${t}`; // 22
    }
    case 'mmss': {
      const totalSec = Math.round((((serial % 1) + 1) % 1) * 86400);
      return `${String(Math.floor(totalSec / 60)).padStart(2, '0')}:${String(totalSec % 60).padStart(2, '0')}`; // 45
    }
    case 'hmmss': {
      // [h]:mm:ss — elapsed hours: full days count (1.5 -> 36:00:00).
      const totalSec = Math.max(0, Math.round(serial * 86400));
      const h = Math.floor(totalSec / 3600);
      return `${h}:${String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0')}:${String(totalSec % 60).padStart(2, '0')}`; // 46 [h]:mm:ss
    }
    case 'mdyyyy':
    default:
      return formatLocaleDate(y, m0, d, loc); // 14, locale-aware order
  }
}

/** Excel built-in time variants (numFmtIds 18-21). */
export function formatTimeVariant(serial: number, variant: TimeVariant): string {
  const frac = ((serial % 1) + 1) % 1;
  const totalSec = Math.round(frac * 86400);
  const h24 = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  switch (variant) {
    case 'hmmssAMPM': {
      const ampm = h24 >= 12 ? 'PM' : 'AM';
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      return `${h12}:${mm}:${ss} ${ampm}`; // 19
    }
    case 'hmm': {
      return `${h24}:${mm}`; // 20
    }
    case 'hmmss': {
      return `${h24}:${mm}:${ss}`; // 21
    }
    case 'hmmAMPM':
    default: {
      const ampm = h24 >= 12 ? 'PM' : 'AM';
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      return `${h12}:${mm} ${ampm}`; // 18
    }
  }
}

/** Excel Special formats: zip, zip+4, phone, SSN. */
function formatSpecial(n: number, kind: SpecialFormatKind): string {
  const digits = String(Math.abs(Math.trunc(n))).padStart(kind === 'ssn' ? 9 : 10, '0');
  switch (kind) {
    case 'zip':
      return digits.slice(-5);
    case 'zip4': {
      const z = digits.slice(-9);
      return `${z.slice(0, 5)}-${z.slice(5)}`;
    }
    case 'phone': {
      const p = digits.slice(-10);
      return `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`;
    }
    case 'ssn': {
      const s = digits.slice(-9);
      return `${s.slice(0, 3)}-${s.slice(3, 5)}-${s.slice(5)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Cell style presets (Excel "Cell Styles")
// ---------------------------------------------------------------------------

/** Named preset formats matching Excel's Cell Styles gallery. */
export const CELL_STYLE_PRESETS: Record<string, CellFormat> = {
  Normal: {},
  Good: { fontColor: '#006100', fillColor: '#C6EFCE' },
  Bad: { fontColor: '#9C0006', fillColor: '#FFC7CE' },
  Neutral: { fontColor: '#9C6500', fillColor: '#FFEB9C' },
  Input: { fontColor: '#3F3F76', fillColor: '#FFCC99', borders: { top: { style: 'thin', color: '#7F7F7F' }, bottom: { style: 'thin', color: '#7F7F7F' }, left: { style: 'thin', color: '#7F7F7F' }, right: { style: 'thin', color: '#7F7F7F' } } },
  Output: { fontColor: '#3F3F3F', fillColor: '#F2F2F2', bold: true, borders: { top: { style: 'thin', color: '#7F7F7F' }, bottom: { style: 'thin', color: '#7F7F7F' }, left: { style: 'thin', color: '#7F7F7F' }, right: { style: 'thin', color: '#7F7F7F' } } },
  Calculation: { fontColor: '#FA7D00', fillColor: '#F2F2F2', borders: { top: { style: 'thin', color: '#7F7F7F' }, bottom: { style: 'thin', color: '#7F7F7F' }, left: { style: 'thin', color: '#7F7F7F' }, right: { style: 'thin', color: '#7F7F7F' } } },
  'Heading 1': { fontColor: '#FFFFFF', fillColor: '#305496', bold: true, fontSize: 15, hAlign: 'left' },
  'Heading 2': { fontColor: '#FFFFFF', fillColor: '#4472C4', bold: true, fontSize: 13, hAlign: 'left' },
  'Heading 3': { fontColor: '#FFFFFF', fillColor: '#5B9BD5', bold: true, fontSize: 11, hAlign: 'left' },
  'Heading 4': { fontColor: '#305496', bold: true, fontSize: 11, underline: true },
  Title: { fontColor: '#305496', bold: true, fontSize: 18 },
  Total: { bold: true, borders: { top: { style: 'thin', color: '#305496' }, bottom: { style: 'double', color: '#305496' } } },
  'Percent': { numberFormat: 'Percentage' },
  'Currency': { numberFormat: 'Currency' },
  'Comma': { numberFormat: 'Number' },
};

export const CELL_STYLE_NAMES = Object.keys(CELL_STYLE_PRESETS);

// ---------------------------------------------------------------------------
// CSS conversion: CellFormat -> React.CSSProperties
// ---------------------------------------------------------------------------

const BORDER_STYLE_CSS: Record<BorderStyle, string> = {
  none: 'none',
  thin: '1px solid',
  medium: '2px solid',
  thick: '3px solid',
  dashed: '1px dashed',
  dotted: '1px dotted',
  double: '3px double',
};

export interface FormatCSS {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
  textDecorationStyle?: string;
  color?: string;
  backgroundColor?: string;
  borderTop?: string;
  borderBottom?: string;
  borderLeft?: string;
  borderRight?: string;
  textAlign?: string;
  verticalAlign?: string;
  whiteSpace?: string;
  overflowWrap?: string;
  paddingLeft?: number;
  writingMode?: string;
  transform?: string;
}

/** Convert a CellFormat into CSS properties for the cell div. */
export function formatToCSS(fmt: CellFormat | undefined): FormatCSS {
  if (!fmt) return {};
  const css: FormatCSS = {};
  if (fmt.fontName) css.fontFamily = fmt.fontName;
  if (fmt.fontSize) css.fontSize = fmt.fontSize;
  if (fmt.bold) css.fontWeight = '700';
  if (fmt.italic) css.fontStyle = 'italic';
  const deco: string[] = [];
  if (fmt.underline === 'double') { deco.push('underline'); css.textDecorationStyle = 'double'; }
  else if (fmt.underline) deco.push('underline');
  if (fmt.strikethrough) deco.push('line-through');
  if (deco.length) css.textDecoration = deco.join(' ');
  if (fmt.fontColor) css.color = fmt.fontColor;
  if (fmt.fillColor) css.backgroundColor = fmt.fillColor;
  if (fmt.borders) {
    const b = fmt.borders;
    const side = (s?: BorderSide) =>
      s && s.style !== 'none' ? `${BORDER_STYLE_CSS[s.style]} ${s.color}` : undefined;
    const t = side(b.top); if (t) css.borderTop = t;
    const bo = side(b.bottom); if (bo) css.borderBottom = bo;
    const l = side(b.left); if (l) css.borderLeft = l;
    const r = side(b.right); if (r) css.borderRight = r;
  }
  if (fmt.hAlign) css.textAlign = fmt.hAlign;
  if (fmt.vAlign) {
    css.verticalAlign = fmt.vAlign === 'middle' ? 'middle' : fmt.vAlign;
  }
  if (fmt.wrapText) { css.whiteSpace = 'normal'; css.overflowWrap = 'break-word'; }
  if (fmt.indent) css.paddingLeft = 4 + fmt.indent * 12;
  if (fmt.verticalText) {
    css.writingMode = 'vertical-rl';
  } else if (typeof fmt.orientation === 'number' && fmt.orientation !== 0) {
    css.transform = `rotate(${-fmt.orientation}deg)`;
  }
  return css;
}

// ---------------------------------------------------------------------------
// Border presets (Excel's 13 border options)
// ---------------------------------------------------------------------------

export interface BorderPreset {
  name: string;
  apply: CellBorders;
}

const THIN_BLACK: BorderSide = { style: 'thin', color: '#000000' };

export const BORDER_PRESETS: BorderPreset[] = [
  { name: 'No Border', apply: {} },
  { name: 'All Borders', apply: { top: THIN_BLACK, bottom: THIN_BLACK, left: THIN_BLACK, right: THIN_BLACK } },
  { name: 'Outside Borders', apply: { top: THIN_BLACK, bottom: THIN_BLACK, left: THIN_BLACK, right: THIN_BLACK } },
  { name: 'Thick Outside Borders', apply: { top: { style: 'thick', color: '#000000' }, bottom: { style: 'thick', color: '#000000' }, left: { style: 'thick', color: '#000000' }, right: { style: 'thick', color: '#000000' } } },
  { name: 'Bottom Border', apply: { bottom: THIN_BLACK } },
  { name: 'Top Border', apply: { top: THIN_BLACK } },
  { name: 'Left Border', apply: { left: THIN_BLACK } },
  { name: 'Right Border', apply: { right: THIN_BLACK } },
  { name: 'Top and Bottom Border', apply: { top: THIN_BLACK, bottom: THIN_BLACK } },
  { name: 'Top and Thick Bottom Border', apply: { top: THIN_BLACK, bottom: { style: 'thick', color: '#000000' } } },
  { name: 'Top and Double Bottom Border', apply: { top: THIN_BLACK, bottom: { style: 'double', color: '#000000' } } },
  { name: 'Bottom Double Border', apply: { bottom: { style: 'double', color: '#000000' } } },
  { name: 'All Borders (Dashed)', apply: { top: { style: 'dashed', color: '#000000' }, bottom: { style: 'dashed', color: '#000000' }, left: { style: 'dashed', color: '#000000' }, right: { style: 'dashed', color: '#000000' } } },
];

export const FONT_NAMES = [
  'Calibri', 'Arial', 'Times New Roman', 'Georgia', 'Verdana', 'Courier New',
  'Tahoma', 'Trebuchet MS', 'Comic Sans MS', 'Impact', 'Helvetica', 'Consolas',
];

export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

export const NUMBER_FORMATS: NumberFormat[] = [
  'General', 'Number', 'Currency', 'Accounting', 'Date', 'Time',
  'Percentage', 'Fraction', 'Scientific', 'Special', 'Text',
];

export const SPECIAL_FORMATS: { kind: SpecialFormatKind; label: string }[] = [
  { kind: 'zip', label: 'Zip Code' },
  { kind: 'zip4', label: 'Zip Code + 4' },
  { kind: 'phone', label: 'Phone Number' },
  { kind: 'ssn', label: 'Social Security Number' },
];

export const THEME_COLORS = [
  '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF',
  '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#C0C0C0', '#808080',
  '#305496', '#4472C4', '#5B9BD5', '#70AD47', '#FFC000', '#ED7D31', '#A5A5A5', '#404040',
];
