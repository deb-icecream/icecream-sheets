/**
 * Typed computational view: the value model the engine projects over
 * storage. Grid UI, MCP agents and automation are consumers of this view,
 * never of storage internals.
 */

/** Version of the engine protocol. Bump on any breaking command/event change. */
export const ENGINE_PROTOCOL_VERSION = 1;

export type ScalarKind = 'number' | 'string' | 'boolean' | 'null';

export interface ScalarValue {
  kind: ScalarKind;
  value: number | string | boolean | null;
}

export type ErrorCode =
  | '#DIV/0!'
  | '#N/A'
  | '#NAME?'
  | '#NULL!'
  | '#NUM!'
  | '#REF!'
  | '#VALUE!'
  | '#ERROR'
  | '#SPILL!'
  | '#PERM!';

export interface ErrorValue {
  kind: 'error';
  code: ErrorCode;
  message?: string;
}

export type TypedValue = ScalarValue | ErrorValue | ImageValue;

/** In-cell image produced by the IMAGE function (Excel semantics). */
export interface ImageValue {
  kind: 'image';
  /** Image source: http(s) URL or data: URL. */
  src: string;
  /** Alternate text for accessibility / text export. */
  alt: string;
  /**
   * Sizing mode: 0 = fit cell (preserve aspect), 1 = fill cell (stretch),
   * 2 = original size, 3 = custom height/width.
   */
  sizing: number;
  /** Custom height in px (sizing 3). */
  height?: number;
  /** Custom width in px (sizing 3). */
  width?: number;
}

/** Zero-based cell reference with a stable sheet identity (sheet name). */
export interface CellRef {
  sheet: string;
  row: number;
  col: number;
}

export interface RangeRef {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface SheetInfo {
  name: string;
  rowCount: number;
  colCount: number;
}

/** JSON-serializable snapshot of a workbook for save/restore and transport. */
export interface CellSnapshot {
  ref: CellRef;
  /** Raw input: literal value, or formula text beginning with '='. */
  input: string | number | boolean | null;
}

/**
 * A table definition as carried on a snapshot sheet (snapshot-join
 * slicer fix, #69 Piece A): the narrow shape the table-slicer mapper
 * needs — id for the cache's tableId lookup, startCol + columns for
 * the field/column resolution. The full adapter TableDef (style info,
 * totals, refs) stays adapter-side; the snapshot carries only this.
 */
export interface SnapshotTableDef {
  id?: number;
  sheet: string;
  startCol: number;
  columns: string[];
}

export interface SheetSnapshot {
  name: string;
  cells: CellSnapshot[];
  /**
   * Per-sheet table definitions, when the loaded file has tables.
   * Optional and additive: older producers omit it, and consumers
   * that do not need tables ignore it. Without it, a client joining
   * a live session (whose only hydration source is the snapshot)
   * can never resolve a table-bound imported slicer, even though
   * the snapshot metadata carries the slicer model — the mapper
   * resolves table slicers only via supplied TableDefs.
   */
  tables?: SnapshotTableDef[];
}

export interface WorkbookSnapshot {
  protocolVersion: number;
  sheets: SheetSnapshot[];
  /**
   * The workbook's defined names (workbook- + sheet-scoped), live from the
   * engine at snapshot time (defect E1: a snapshot that carried only cells
   * made every snapshot-based save silently DROP all defined names while
   * formulas still referenced them — #NAME? on reopen). Optional for
   * backward compatibility with older snapshot producers; when present it
   * is the authoritative name list for save serialization.
   */
  definedNames?: import('./storage.js').DefinedName[];
  /**
   * The workbook's metadata record (adapter metadata merged under the
   * session's client extras — the same merge a save serializes), attached
   * by the engine service's /snapshot response (File-2 D1 follow-up: the
   * snapshot previously carried NO metadata channel at all, so a client
   * joining or rehydrating a session — whose only hydration source is
   * the snapshot — could never render metadata-driven overlays such as
   * imported pictures (`icecream.pictures`) or text boxes
   * (`icecream.textboxes`), which the first opener gets from the /load
   * payload). Optional and additive: older clients ignore it, and
   * producers that hold no session metadata (the in-process engine host)
   * simply omit it.
   */
  metadata?: Record<string, unknown>;
  /**
   * The session's resolved per-sheet cell styles + number-format codes
   * (#134), attached by the engine service's /snapshot response only
   * (never by filteredSnapshot, so save serialization is untouched —
   * the same route-only pattern as `metadata`). A client joining or
   * rehydrating a session — whose only hydration source is the
   * snapshot — uses these to seed its format store exactly as the
   * first opener seeds from the /load payload. Without them the
   * joiner's store stays empty, its first extras push reports every
   * sheet as authoritatively empty, and the next serialization wipes
   * the file's imported styles (bold loss on reopen). Optional and
   * additive: older clients ignore them, and producers that hold no
   * session styles (the in-process engine host) simply omit them.
   * Keys are sheet names; inner keys are "row:col" (the SaveExtras
   * sheetStyles shape). Resolution mirrors the save path: a sheet the
   * session's client extras report resolves to that map (even empty);
   * any other sheet resolves to the loaded file's own styles/formats.
   */
  sheetStyles?: Record<string, Record<string, import('./storage.js').CellStyle>>;
  sheetFormats?: Record<string, Record<string, string>>;
  /**
   * The session's live native chart specs (round-3 leg-B join fix):
   * agent-authored charts held in the engine session (FIX-G
   * sessionCharts), attached by the engine service's /snapshot
   * response only (never by filteredSnapshot, so save serialization
   * is untouched — the same route-only pattern as `metadata`). A
   * client joining a live session hydrates its chart store from the
   * snapshot's file metadata, which never carries session-authored
   * charts, so without this channel the join hydration replaces the
   * SSE hello echo's live charts with the file's own set and the
   * agent chart vanishes on every join. Opaque here: the engine host
   * has no chart concept, so the specs ride as JSON records and
   * clients cast them to their ChartSpec. Optional and additive:
   * older clients ignore it, and producers that hold no session
   * charts simply omit it.
   */
  charts?: Array<Record<string, unknown>>;
}

export function scalar(value: number | string | boolean | null): ScalarValue {
  if (typeof value === 'number') return { kind: 'number', value };
  if (typeof value === 'string') return { kind: 'string', value };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  return { kind: 'null', value: null };
}

export function err(code: ErrorCode, message?: string): ErrorValue {
  return message === undefined ? { kind: 'error', code } : { kind: 'error', code, message };
}

export function isError(v: TypedValue): v is ErrorValue {
  return v.kind === 'error';
}

export function isImage(v: TypedValue): v is ImageValue {
  return v.kind === 'image';
}

/** Construct an in-cell image value (IMAGE function result). */
export function image(
  src: string,
  alt = '',
  sizing = 0,
  height?: number,
  width?: number,
): ImageValue {
  const v: ImageValue = { kind: 'image', src, alt, sizing };
  if (height !== undefined) v.height = height;
  if (width !== undefined) v.width = width;
  return v;
}

/** A1-style address, e.g. {sheet:'Sheet1',row:0,col:0} -> 'Sheet1!A1'. */
export function toA1(ref: CellRef): string {
  let col = '';
  let n = ref.col;
  do {
    col = String.fromCharCode(65 + (n % 26)) + col;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `${ref.sheet}!${col}${ref.row + 1}`;
}
export type { DefinedName } from './storage.js';
