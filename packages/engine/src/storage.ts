/**
 * Pluggable storage backends. Adapters implement the capability interface;
 * the engine never assumes which adapter backs the view.
 */
import type { CellInput } from './workbook.js';

export interface AdapterCapabilities {
  readable: boolean;
  writable: boolean;
  transactional: boolean;
  /** Unknown file parts are preserved byte-for-byte on round-trip. */
  preservesUnknownParts: boolean;
  supportsEncryption: boolean;
  maxFileSizeBytes?: number;
}

/** Border line styles at the storage layer (mirrors the UI's BorderStyle). */
export type CellBorderStyle =
  | 'none'
  | 'thin'
  | 'medium'
  | 'thick'
  | 'dashed'
  | 'dotted'
  | 'double';

export interface CellBorderSide {
  style: CellBorderStyle;
  /** CSS-style hex color, e.g. '#305496'. */
  color: string;
}

export interface CellBordersData {
  top?: CellBorderSide;
  bottom?: CellBorderSide;
  left?: CellBorderSide;
  right?: CellBorderSide;
}

/**
 * Full per-cell presentation style at the STORAGE layer: the serialized
 * form of one cell's resolved entry in the UI format store (the cascade
 * in apps/web features/formatting.ts). Like `formats`, `colWidths` and
 * `rowHeights` below, this is a pure presentation hint: the engine never
 * reads it — a cell still has exactly formula + cached value + rich data
 * type; the data type remains the presentation spec's semantic layer and
 * this record is only how a resolved format travels to/from a file.
 * Fields left undefined mean "no override" (the file default applies).
 */
export interface CellStyle {
  /** Excel number format code, e.g. '0.00%' (never 'General'). */
  numberFormatCode?: string;
  fontName?: string;
  /** Font size in points (the UI store's fontSize, carried verbatim). */
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean | 'double';
  strikethrough?: boolean;
  /** CSS-style hex color, e.g. '#FF0000'. */
  fontColor?: string;
  /** Solid fill color, CSS-style hex. */
  fillColor?: string;
  borders?: CellBordersData;
  hAlign?: 'left' | 'center' | 'right';
  vAlign?: 'top' | 'middle' | 'bottom';
  wrapText?: boolean;
  indent?: number;
  /** Text rotation in degrees, -90..90 (Excel orientation). */
  orientation?: number;
  /** Stacked vertical text (Excel "Vertical Text"). */
  verticalText?: boolean;
}

export interface SheetData {
  name: string;
  /** Row-major grid of raw inputs (literals or '=formula' strings). */
  rows: CellInput[][];
  /**
   * Excel number format code per cell, keyed "row:col" (0-based indices).
   * Only cells with a non-General format are present. Pure UI hint: the
   * engine ignores it — formatting never affects values or formulas
   * (features/formatting.ts: formatting is a UI concern).
   */
  formats?: Record<string, string>;
  /**
   * Full per-cell styles keyed "row:col" (0-based indices): fonts, fills,
   * borders, alignment and the number format code, resolved from the UI
   * format store at save time and parsed from xl/styles.xml at read time.
   * Pure UI hint like `formats` (which it extends: a style's
   * numberFormatCode and the formats entry for the same cell always agree).
   * Only cells with a non-default style are present.
   */
  styles?: Record<string, CellStyle>;
  /**
   * Column widths in pixels, keyed by 0-based column index. From the file's
   * column dimensions (!cols). Pure UI hint: stored on the column, never
   * per-cell. The engine ignores it.
   */
  colWidths?: Record<string, number>;
  /**
   * Row heights in pixels, keyed by 0-based row index. From the file's row
   * dimensions (!rows). Pure UI hint: stored on the row, never per-cell.
   * The engine ignores it.
   */
  rowHeights?: Record<string, number>;
  /**
   * Hidden columns (0-based indices). Pure UI hint.
   */
  hiddenCols?: number[];
  /**
   * Hidden rows (0-based indices). Pure UI hint.
   */
  hiddenRows?: number[];
}

export interface DefinedName {
  /** The name as used in formulas (case-insensitive in Excel). */
  name: string;
  /** A1-style reference, e.g. "Sheet1!$A$1" or "{1,2,3}". */
  ref: string;
  /** 0-based sheet index for sheet-scoped names; undefined = workbook scope. */
  sheet?: number;
}

export interface WorkbookData {
  sheets: SheetData[];
  /** Adapter-specific metadata (page setup, print settings, ...). */
  metadata: Record<string, unknown>;
  /** Workbook/sheet-scoped defined names (from XLSX definedNames). */
  definedNames?: DefinedName[];
}

/**
 * Storage adapter contract. v1 requires: the XLSX adapter (SheetJS).
 * Future: SQL, API, DataFrame adapters projecting tables/ranges.
 */
export interface StorageAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  /** Parse bytes into workbook data. Throws on unsupported/corrupt input. */
  read(buffer: Uint8Array): WorkbookData;
  /**
   * Serialize workbook data. When `original` is given, the adapter should
   * preserve unknown parts of the original package byte-for-byte.
   */
  write(data: WorkbookData, original?: Uint8Array): Uint8Array;
}
