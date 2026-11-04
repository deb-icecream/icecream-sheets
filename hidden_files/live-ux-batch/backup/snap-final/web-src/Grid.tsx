import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EngineHost, TypedValue } from '@icecream-sheets/engine';
/** D8: a presence flag's label is the participant's display name —
 * never the raw principal/UID (a payload "name" equal to the
 * principal or its bare id is no name; fall back to a neutral label).
 * Kept local to Grid: this module must not import the services graph
 * (bundle initialization cycle). Mirrors services/presenceNames. */
function presenceLabel(p: { principal: string; name?: string }): string {
  const raw = typeof p.name === 'string' ? p.name.trim() : '';
  if (raw && raw !== p.principal && raw !== p.principal.replace(/^user:/, '')) return raw;
  return 'Guest';
}
import { cellRef, colLabel, formatDisplay } from './engine';
import { formatWithCode } from '@icecream-sheets/xlsx-adapter';
import { formatNumber, formatToCSS, getFormat, getDataType, dataTypeToDefaultFormat, type FormatStore, type DataTypeStore } from './features/formatting';
import type { LocaleConfig } from './features/locale';
import type { Selection } from './App';
import type { MenuItem } from './components/ContextMenu';
import {
  cfColorFor,
  findMerge,
  findValidation,
  isMergeAnchor,
  rowPassesFilter,
  type CFRule,
  type FilterState,
  type MergeRange,
  type ValidationRule,
} from './features/models';
import { slicerPasses, type SlicerSpec } from './features/slicers';
import { timelinePasses, type TimelineSpec } from './features/timelines';
import { suggestCellValues, type PaginatedPage } from '@icecream-sheets/service';
import { hasPageBreaks, type PageBreaks } from './features/pageBreaks';
import PageBreakLines from './components/PageBreakLines';
import { readColumnHistory } from './inference';
import AutocompleteDropdown, { type DropdownItem } from './components/AutocompleteDropdown';
import {
  renderSparkline,
  sparklineValues,
  type SparklinePlacement,
} from './features/sparklines';
import type { SmartChipValue } from './features/smartChips';
import {
  allSelection,
  cellSelection,
  headerDragSpans,
  headerSelect,
  inSelection,
  isSingleCell,
  rangeSelection,
  selectionBounds,
  type GridSelection,
  type SelSpan,
} from './features/selection';

/**
 * Render a cell's value. In-cell images (the IMAGE function's typed value)
 * become an <img> sized per the Excel sizing mode: 0 = fit cell
 * (object-fit: contain), 1 = fill cell (stretch), 2 = original size,
 * 3 = custom height/width in px. The engine only produces http(s) and
 * data:image: sources, so the src is safe to render directly (same pattern
 * as components/Pictures.tsx).
 */
function cellValueContent(
  value: TypedValue | undefined,
  text: string,
  textStyle?: React.CSSProperties,
): React.ReactNode {
  if (value && value.kind === 'image') {
    const custom = value.sizing === 3;
    return (
      <img
        src={value.src}
        alt={value.alt || 'Image'}
        draggable={false}
        style={{
          display: 'block',
          width: custom && value.width ? `${value.width}px` : '100%',
          height: custom && value.height ? `${value.height}px` : '100%',
          objectFit: value.sizing === 1 ? 'fill' : value.sizing === 2 ? 'none' : 'contain',
        }}
      />
    );
  }
  return (
    <span className="cell-text" style={textStyle}>
      {text}
    </span>
  );
}

/**
 * Virtualized infinite grid with freeze panes, merged cells,
 * conditional formatting, data validation indicators, and row filtering.
 *
 * Only the visible cells (plus a small overscan) are in the DOM. The scroll
 * container holds a large spacer sized to the current grid dimensions; column
 * headers stick to the top and row headers stick to the left via CSS sticky.
 *
 * Freeze panes: rows [0, freeze.row) and cols [0, freeze.col) render in
 * sticky strips that stay visible while the rest scrolls.
 */

// Fixed cell metrics (px). Kept as constants for v1 simplicity.
export const ROW_HEIGHT = 24;
export const COL_WIDTH = 96;
export const ROW_HEADER_WIDTH = 44;
export const COL_HEADER_HEIGHT = 24;

// Growth policy.
export const INITIAL_ROWS = 100;
export const INITIAL_COLS = 26;
export const GROW_MARGIN = 20;
export const GROW_ROWS = 200;
export const GROW_COLS = 52;
export const OVERSCAN = 4;

// Hard caps (Excel parity).
export const MAX_ROWS = 1048576;
export const MAX_COLS = 16384;

interface GridProps {
  host: EngineHost;
  sheet: string;
  sel: Selection;
  onSelect: (row: number, col: number) => void;
  /**
   * Rich selection model (features/selection.ts): cell / range / rows /
   * cols / all shapes. Optional — when absent the grid behaves exactly as
   * the single-anchor model (sel + onSelect). Selection is view-only:
   * changing it never touches the engine/host.
   */
  selection?: GridSelection;
  onSelectionChange?: (next: GridSelection) => void;
  /** Clear the (non-single-cell) selection's contents (Delete key). */
  onClearSelection?: () => void;
  onCommit: (row: number, col: number, text: string) => void;
  version: number;
  cfRules: CFRule[];
  validations: ValidationRule[];
  merges: MergeRange[];
  freeze: { row: number; col: number } | null;
  filters: FilterState;
  sortState: { col: number; dir: 'asc' | 'desc' } | null;
  formats: FormatStore;
  /** Column/range data-type metadata (layer 2: informs default formats). */
  dataTypes: DataTypeStore;
  /** Locale for number/date/currency rendering. */
  locale: LocaleConfig;
  showHeadings: boolean;
  /** Per-row height overrides (px). */
  rowHeights: Map<number, number>;
  /** Per-column width overrides (px). */
  colWidths: Map<number, number>;
  /** Hidden rows/cols (0-size). */
  hiddenRows: Set<number>;
  hiddenCols: Set<number>;
  /** Show formula text instead of values. */
  showFormulas: boolean;
  /** Formula text per cell, keyed `${sheet}:${row}:${col}`. */
  formulaTexts: Map<string, string>;
  /** Comments per cell, keyed `${sheet}:${row}:${col}`. */
  comments: Map<string, string>;
  /** Linked data-type values, keyed `${sheet}:${row}:${col}`. */
  dataTypeCells: Map<string, import('./features/dataTypes').DataTypeValue>;
  /** Currently open data-type card cell key (for highlight). */
  dataTypeCardKey: string | null;
  /** Open/close the data-type card for a cell. */
  onToggleDataTypeCard: (key: string) => void;
  /** Slicer specs (floating categorical filters) filtering rows. */
  slicerSpecs: SlicerSpec[];
  /** Timeline specs (floating date filters) filtering rows. */
  timelineSpecs: TimelineSpec[];
  /** Sparklines, keyed by `${sheet}:${row}:${col}` of the host cell. */
  sparklineCells: Map<string, import('./features/sparklines').SparklinePlacement>;
  /** Smart chip values, keyed `${sheet}:${row}:${col}`. */
  smartChipCells: Map<string, SmartChipValue>;
  /** Currently open smart-chip card cell key (for highlight). */
  smartChipCardKey: string | null;
  /** Open/close the smart-chip card for a cell. */
  onToggleSmartChipCard: (key: string) => void;
  /** Extra highlight on the selected cell. */
  focusCell: boolean;
  /** Extended CF (data bars, color scales, icon sets, top-N) style resolver. */
  extCfStyle: (row: number, col: number) => React.CSSProperties | null;
  onContextMenu: (x: number, y: number, items: MenuItem[]) => void;
  onOpenFilter: (col: number) => void;
  getCellMenu: () => MenuItem[];
  /** Protection face d (§2 UI indicators): locked cells show a subtle marker. */
  isCellLocked?: (row: number, col: number) => boolean;
  /**
   * Protection face e (§2 UI indicators): hidden cells show an eye-off badge
   * ONLY to principals allowed to see them (the caller must already filter
   * with isHiddenFrom — hidden means hidden to everyone else).
   */
  isCellHiddenVisible?: (row: number, col: number) => boolean;
  /** Manual page breaks for the sheet → dashed blue break lines. */
  pageBreaks?: PageBreaks;
  /** Paginated pages (page-break preview) → "Page N" badges. */
  printPages?: PaginatedPage[];
  getColumnMenu: (col: number) => MenuItem[];
  getRowMenu: (row: number) => MenuItem[];
  /**
   * Floating overlay elements (charts, shapes, pictures, text boxes).
   * Rendered inside the grid's scrollable content div in content
   * coordinates, so they scroll with the cells and are clipped by the
   * grid viewport — never painting over the ribbon, sheet tabs, or
   * status bar.
   */
  overlays?: React.ReactNode;
  /**
   * Phase 2 presence: remote collaborators' selections (from the SSE
   * presence channel). Rendered as a colored outline + name tag on the
   * remote user's selected cell — their sheet only. Silent by design:
   * no markers for overwrites, only live presence (§8).
   */
  remoteSelections?: Array<{
    principal: string;
    /** Display name from the presence payload (D8: labels render this, never the principal). */
    name?: string;
    color: string;
    sheet: string;
    row: number;
    col: number;
    editing?: boolean;
  }>;
}

interface Editing {
  row: number;
  col: number;
  draft: string;
  /**
   * True while the draft is exactly the content the editor was opened
   * with (opened on existing content via click/dblclick/F2, untouched
   * since). Autocomplete suggestions stay suppressed while pristine —
   * Excel parity (suggestions follow typing, not opening) and a real
   * corruption guard: the suggestion listbox renders over the cell, so
   * the second click of a double-click aimed at the cell would land on
   * the top suggestion and commit it (cell 1 silently became 10 in
   * leg-a validation, 2026-10-21). Typing (onChange) or opening the
   * editor BY typing a character clears pristine.
   */
  pristine: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Column width for grid content-coordinate mapping (0 for hidden). */
export function gridColWidth(
  c: number,
  colWidths: Map<number, number>,
  hiddenCols: Set<number>,
): number {
  return hiddenCols.has(c) ? 0 : (colWidths.get(c) ?? COL_WIDTH);
}

/** Row height for grid content-coordinate mapping (0 for hidden). */
export function gridRowHeight(
  r: number,
  rowHeights: Map<number, number>,
  hiddenRows: Set<number>,
): number {
  return hiddenRows.has(r) ? 0 : (rowHeights.get(r) ?? ROW_HEIGHT);
}

/**
 * Build an O(1) row-offset lookup from prefix sums of effective row heights.
 * Perf (2026-10-19): gridContentY() is O(r) per call and the grid calls
 * rowTop() per visible cell per render — 360 cells × 30k rows ≈ 10M ops per
 * scroll frame on large sheets (200–500 ms of jank). The prefix array is
 * rebuilt only when rowHeights/hiddenRows/rowCount change.
 */
export function buildRowOffsets(
  rowCount: number,
  rowHeights: Map<number, number>,
  hiddenRows: Set<number>,
  showHeadings: boolean,
): (r: number) => number {
  const n = Math.max(0, rowCount);
  const offsets = new Float64Array(n + 2);
  let t = showHeadings ? COL_HEADER_HEIGHT : 0;
  offsets[0] = t;
  for (let i = 0; i <= n; i++) {
    t += gridRowHeight(i, rowHeights, hiddenRows);
    offsets[i + 1] = t;
  }
  return (r: number) => offsets[r < 0 ? 0 : r > n + 1 ? n + 1 : r] ?? t;
}

/**
 * Absolute left px of column c in grid content coordinates (includes the
 * row-header width when headings are shown). Overlays positioned with this
 * scroll with the grid content and are clipped by the grid viewport.
 */
export function gridContentX(
  c: number,
  colWidths: Map<number, number>,
  hiddenCols: Set<number>,
  showHeadings: boolean,
): number {
  let l = showHeadings ? ROW_HEADER_WIDTH : 0;
  for (let i = 0; i < c; i++) l += gridColWidth(i, colWidths, hiddenCols);
  return l;
}

/**
 * Absolute top px of row r in grid content coordinates (includes the
 * column-header height when headings are shown).
 */
export function gridContentY(
  r: number,
  rowHeights: Map<number, number>,
  hiddenRows: Set<number>,
  showHeadings: boolean,
): number {
  let t = showHeadings ? COL_HEADER_HEIGHT : 0;
  for (let i = 0; i < r; i++) t += gridRowHeight(i, rowHeights, hiddenRows);
  return t;
}

export interface VisibleRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export function computeVisibleRange(
  scrollTop: number,
  scrollLeft: number,
  viewportW: number,
  viewportH: number,
  rowCount: number,
  colCount: number,
  headerW: number,
  headerH: number,
): VisibleRange {
  const endRow = Math.min(
    rowCount - 1,
    Math.ceil((scrollTop - headerH + viewportH) / ROW_HEIGHT) + OVERSCAN,
  );
  const endCol = Math.min(
    colCount - 1,
    Math.ceil((scrollLeft - headerW + viewportW) / COL_WIDTH) + OVERSCAN,
  );
  const startRow = Math.min(
    endRow,
    Math.max(0, Math.floor(Math.max(0, scrollTop - headerH) / ROW_HEIGHT) - OVERSCAN),
  );
  const startCol = Math.min(
    endCol,
    Math.max(0, Math.floor(Math.max(0, scrollLeft - headerW) / COL_WIDTH) - OVERSCAN),
  );
  return { startRow, endRow, startCol, endCol };
}

export default function Grid({
  host,
  sheet,
  sel,
  onSelect,
  selection,
  onSelectionChange,
  onClearSelection,
  onCommit,
  version,
  cfRules,
  validations,
  merges,
  freeze,
  filters,
  sortState,
  formats,
  dataTypes,
  locale,
  showHeadings,
  rowHeights,
  colWidths,
  hiddenRows,
  hiddenCols,
  showFormulas,
  formulaTexts,
  comments,
  dataTypeCells,
  dataTypeCardKey,
  onToggleDataTypeCard,
  slicerSpecs,
  timelineSpecs,
  sparklineCells,
  smartChipCells,
  smartChipCardKey,
  onToggleSmartChipCard,
  focusCell,
  extCfStyle,
  onContextMenu,
  onOpenFilter,
  getCellMenu,
  getColumnMenu,
  getRowMenu,
  isCellLocked,
  isCellHiddenVisible,
  pageBreaks,
  printPages,
  overlays,
  remoteSelections,
}: GridProps) {
  // Effective header dimensions (0 when headings are hidden).
  const RHW = showHeadings ? ROW_HEADER_WIDTH : 0;
  const CHH = showHeadings ? COL_HEADER_HEIGHT : 0;

  // ---- Rich selection model (view-only; see features/selection.ts) ----
  // Effective selection: the rich model when the caller supplies it, else
  // a single-cell selection synthesized from the legacy anchor. emitSel
  // routes every selection change through onSelectionChange when present
  // and falls back to the legacy onSelect(anchor) otherwise, so behavior
  // without the new props is exactly the old single-cell behavior.
  const effSel: GridSelection = selection ?? cellSelection(sel.row, sel.col);
  const emitSel = useCallback(
    (next: GridSelection) => {
      if (onSelectionChange) onSelectionChange(next);
      else onSelect(next.anchorRow, next.anchorCol);
    },
    [onSelectionChange, onSelect],
  );
  const selBounds = selectionBounds(effSel, MAX_ROWS - 1, MAX_COLS - 1);
  /**
   * Excel semantics for header right-click (D-SEL-2): a right-click on a
   * row/column header that lies INSIDE the current selection — a same-kind
   * rows/cols selection covering the header, or select-all — opens the
   * menu on the existing selection instead of destroying it. Only a
   * right-click OUTSIDE the current selection re-points.
   */
  const headerCtxKeepsSelection = (kind: 'rows' | 'cols', index: number): boolean => {
    if (effSel.shape === 'all') return true;
    if (kind === 'rows' && effSel.shape === 'rows') {
      return effSel.rowSpans.some((s) => index >= s.start && index <= s.end);
    }
    if (kind === 'cols' && effSel.shape === 'cols') {
      return effSel.colSpans.some((s) => index >= s.start && index <= s.end);
    }
    return false;
  };
  // Cell-body drag state (mousedown → mouseenter sweep → window mouseup).
  const dragRef = useRef<{ pressedRow: number; pressedCol: number; shift: boolean; active: boolean } | null>(null);
  const dragMovedRef = useRef(false);
  // Header drag state (row/column header sweep).
  const headerDragRef = useRef<{
    kind: 'rows' | 'cols';
    startIndex: number;
    baseSpans: SelSpan[];
    additive: boolean;
  } | null>(null);
  useEffect(() => {
    const up = () => {
      dragRef.current = null;
      headerDragRef.current = null;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);
  /** Begin a body-cell drag (left button, not while editing that cell). */
  const beginCellDrag = (e: React.MouseEvent, r: number, c: number) => {
    if (e.button !== 0) return;
    if (editing && editing.row === r && editing.col === c) return;
    dragRef.current = { pressedRow: r, pressedCol: c, shift: e.shiftKey, active: false };
  };
  /** Extend a body-cell drag into the entered cell. */
  const enterCellDrag = (r: number, c: number) => {
    const d = dragRef.current;
    if (!d) return;
    if (r === d.pressedRow && c === d.pressedCol) return;
    if (!d.active) {
      d.active = true;
      dragMovedRef.current = true;
    }
    const anchorRow = d.shift ? effSel.anchorRow : d.pressedRow;
    const anchorCol = d.shift ? effSel.anchorCol : d.pressedCol;
    emitSel(rangeSelection(anchorRow, anchorCol, r, c));
  };

  // ---- Variable row/column sizing ----
  const rh = useCallback((r: number) => (hiddenRows.has(r) ? 0 : (rowHeights.get(r) ?? ROW_HEIGHT)), [rowHeights, hiddenRows]);
  const cw = useCallback((c: number) => (hiddenCols.has(c) ? 0 : (colWidths.get(c) ?? COL_WIDTH)), [colWidths, hiddenCols]);
  // rowTop/colLeft are defined below (after rowCount state) via memoized
  // prefix sums — see buildRowOffsets.

  const [editing, setEditing] = useState<Editing | null>(null);
  /**
   * One-edit-one-commit guard (Worker F, defect F2): the editing-session
   * object whose value has already been committed. The Enter/Tab editor
   * paths commit and then moveSel() focuses the scroll container, which
   * SYNCHRONOUSLY blurs the editor input — and the blur handler's closure
   * still holds the pre-commit `editing` state (React has not re-rendered
   * yet), so an unguarded commitEdit() fired onCommit a second time for
   * the same keystroke (one grid edit → two server ops, clientSeq n and
   * n+1, identical value). Keying the guard on the editing object's
   * identity makes every commit path below idempotent per editing
   * session; each keystroke mints a fresh editing object, so the next
   * genuine edit is never swallowed.
   */
  const committedEditingRef = useRef<Editing | null>(null);

  // ---- Autocomplete (deterministic-inference.md §5): type-ahead from column history ----
  const [acIndex, setAcIndex] = useState(0);
  const acSuggestions: DropdownItem[] = useMemo(() => {
    if (!editing) return [];
    if (editing.pristine) return []; // no suggestions until the user types (see Editing.pristine)
    const draft = editing.draft;
    if (draft === '' || draft.startsWith('=')) return []; // values only; formulas handled in FormulaBar
    try {
      const history = readColumnHistory(host, sheet, editing.col);
      return suggestCellValues(history, draft).map((s) => ({
        value: s.text,
        label: s.text,
        hint: s.count > 1 ? `×${s.count}` : undefined,
      }));
    } catch {
      return [];
    }
  }, [editing, host, sheet, version]);
  const acOpen = editing !== null && acSuggestions.length > 0 && acIndex >= 0;
  // Reset highlight when the suggestion list changes.
  useEffect(() => setAcIndex(0), [acSuggestions]);
  const pickAcItem = useCallback(
    (item: DropdownItem) => {
      if (!editing) return;
      setEditing({ ...editing, draft: item.value });
      setAcIndex(0);
    },
    [editing],
  );

  /**
   * Compute the display text and CSS for a cell, applying the user's
   * number format (if any) over the engine's default display, and the
   * file-imported Excel format code when the user hasn't set their own.
   */
  const cellDisplay = useCallback(
    (row: number, col: number, value: TypedValue | undefined): { text: string; css: React.CSSProperties } => {
      const fmt = getFormat(formats, sheet, row, col);
      const css = formatToCSS(fmt) as React.CSSProperties;
      // Extended CF (data bars / color scales / icon sets) paints backgrounds.
      const ext = extCfStyle(row, col);
      if (ext) Object.assign(css, ext);
      let text: string;
      if (showFormulas) {
        text = formulaTexts.get(`${sheet}:${row}:${col}`) ?? (value ? formatDisplay(value) : '');
      } else {
        text = value ? formatDisplay(value) : '';
        const fmtOpts = {
          locale,
          currencySymbol: fmt?.currencySymbol,
          specialKind: fmt?.specialKind,
          dateVariant: fmt?.dateVariant,
          timeVariant: fmt?.timeVariant,
          negativeStyle: fmt?.negativeStyle,
        };
        if (fmt?.numberFormat && fmt.numberFormat !== 'General' && value && value.kind === 'number') {
          text = formatNumber(value.value, fmt.numberFormat, fmt.decimals ?? 2, fmtOpts);
        } else if (fmt?.formatCode && value && value.kind === 'number' && typeof value.value === 'number') {
          // Imported Excel format code (styles.xml): the user override above
          // always wins; otherwise render through the format interpreter.
          text = formatWithCode(value.value, fmt.formatCode);
        } else if (!fmt?.numberFormat && !fmt?.formatCode && value && value.kind === 'number') {
          // Layer-2 data type default: a date-typed column renders dates
          // unless the cascade sets an explicit format. Never touches the
          // underlying value — presentation only.
          const typeDefault = dataTypeToDefaultFormat(getDataType(dataTypes, sheet, row, col));
          if (typeDefault && typeDefault !== 'General') {
            text = formatNumber(value.value, typeDefault, fmt?.decimals ?? 2, { locale });
          }
        }
      }
      return { text, css };
    },
    [formats, dataTypes, locale, sheet, showFormulas, formulaTexts, extCfStyle],
  );

  /** Comment indicator key for a cell. */
  const hasComment = useCallback(
    (row: number, col: number) => comments.has(`${sheet}:${row}:${col}`),
    [comments, sheet],
  );
  const [rowCount, setRowCount] = useState(INITIAL_ROWS);
  const [colCount, setColCount] = useState(INITIAL_COLS);
  // O(1) row/column offset lookups via memoized prefix sums (perf 2026-10-19:
  // the old per-call O(r)/O(c) gridContentY/gridContentX made every scroll
  // frame on large sheets cost 200–500 ms: 360 visible cells × 30k rows).
  const rowTopFn = useMemo(
    () => buildRowOffsets(rowCount, rowHeights, hiddenRows, showHeadings),
    [rowCount, rowHeights, hiddenRows, showHeadings],
  );
  /** Top offset of row r (below column headers). */
  const rowTop = useCallback((r: number) => rowTopFn(r), [rowTopFn]);
  /** Left offset of column c (right of row headers). Columns are few, but
   * the same memo pattern keeps the call sites uniform. */
  const colLeft = useCallback((c: number) => {
    return gridContentX(c, colWidths, hiddenCols, showHeadings);
  }, [colWidths, hiddenCols, showHeadings]);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEditing(null);
    setRowCount(INITIAL_ROWS);
    setColCount(INITIAL_COLS);
    scrollRef.current?.scrollTo(0, 0);
    setScroll({ top: 0, left: 0 });
  }, [sheet, host]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) setViewport({ w: el.clientWidth, h: el.clientHeight });
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewport({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const used = host.getView().usedRange(sheet);
    if (!used) return;
    const needRows = Math.min(MAX_ROWS, used.endRow + 1 + GROW_MARGIN);
    const needCols = Math.min(MAX_COLS, used.endCol + 1 + GROW_MARGIN);
    setRowCount((p) => Math.max(p, needRows));
    setColCount((p) => Math.max(p, needCols));
  });

  const ensureCapacity = useCallback((needRows: number, needCols: number) => {
    setRowCount((p) => Math.max(p, Math.min(MAX_ROWS, needRows)));
    setColCount((p) => Math.max(p, Math.min(MAX_COLS, needCols)));
  }, []);

  const ensureVisible = useCallback((row: number, col: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const cellTop = rowTop(row);
    const cellLeft = colLeft(col);
    let top = el.scrollTop;
    let left = el.scrollLeft;
    if (cellTop < top + CHH) {
      top = cellTop - CHH;
    } else if (cellTop + rh(row) > top + el.clientHeight) {
      top = cellTop + rh(row) - el.clientHeight;
    }
    if (cellLeft < left + RHW) {
      left = cellLeft - RHW;
    } else if (cellLeft + cw(col) > left + el.clientWidth) {
      left = cellLeft + cw(col) - el.clientWidth;
    }
    if (top !== el.scrollTop || left !== el.scrollLeft) {
      el.scrollTo(left, top);
    }
  }, []);

  useEffect(() => {
    const r = clamp(sel.row, 0, MAX_ROWS - 1);
    const c = clamp(sel.col, 0, MAX_COLS - 1);
    ensureCapacity(r + GROW_MARGIN + 1, c + GROW_MARGIN + 1);
    ensureVisible(r, c);
  }, [sel.row, sel.col, ensureCapacity, ensureVisible]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const left = el.scrollLeft;
    setScroll({ top, left });
    if (top + el.clientHeight > CHH + (rowCount - GROW_MARGIN) * ROW_HEIGHT) {
      setRowCount((p) => Math.min(MAX_ROWS, p + GROW_ROWS));
    }
    if (left + el.clientWidth > RHW + (colCount - GROW_MARGIN) * COL_WIDTH) {
      setColCount((p) => Math.min(MAX_COLS, p + GROW_COLS));
    }
  };

  const { startRow, endRow, startCol, endCol } = computeVisibleRange(
    scroll.top,
    scroll.left,
    viewport.w,
    viewport.h,
    rowCount,
    colCount,
    RHW,
    CHH,
  );

  const values = useMemo(
    () =>
      host.readRange({
        sheet,
        startRow,
        startCol,
        endRow: Math.max(endRow, startRow),
        endCol: Math.max(endCol, startCol),
      }),
    [host, sheet, startRow, startCol, endRow, endCol, version],
  );

  // Filtered-column values for the visible window (to decide row visibility).
  // Includes slicer and timeline columns so those floating filters can
  // hide rows too.
  const filterCols = useMemo(() => {
    const cols = new Set<number>(filters.keys());
    for (const s of slicerSpecs) cols.add(s.col);
    for (const t of timelineSpecs) cols.add(t.col);
    return [...cols];
  }, [filters, slicerSpecs, timelineSpecs]);
  const filterValues = useMemo(() => {
    if (filterCols.length === 0) return new Map<number, Map<number, string>>();
    const out = new Map<number, Map<number, string>>();
    for (const col of filterCols) {
      const vals = host.readRange({ sheet, startRow, startCol: col, endRow, endCol: col });
      const colMap = new Map<number, string>();
      vals.forEach((rowVals, i) => {
        colMap.set(startRow + i, formatDisplay(rowVals[0]));
      });
      out.set(col, colMap);
    }
    return out;
  }, [host, sheet, startRow, endRow, filterCols, version]);

  const isRowVisible = useCallback(
    (row: number): boolean => {
      if (filters.size === 0 && slicerSpecs.length === 0 && timelineSpecs.length === 0) return true;
      const rowVals = new Map<number, string>();
      for (const col of filterCols) {
        rowVals.set(col, filterValues.get(col)?.get(row) ?? '');
      }
      if (!rowPassesFilter(filters, rowVals)) return false;
      for (const s of slicerSpecs) {
        if (!slicerPasses(s, rowVals.get(s.col) ?? '')) return false;
      }
      for (const t of timelineSpecs) {
        if (!timelinePasses(rowVals.get(t.col) ?? '', t)) return false;
      }
      return true;
    },
    [filters, filterCols, filterValues, slicerSpecs, timelineSpecs],
  );

  // Frozen cell values (read once per render for the frozen strips).
  const frozenRowValues = useMemo(() => {
    if (!freeze || freeze.row <= 0) return null;
    return host.readRange({
      sheet,
      startRow: 0,
      startCol: startCol,
      endRow: freeze.row - 1,
      endCol,
    });
  }, [host, sheet, freeze, startCol, endCol, version]);

  const frozenColValues = useMemo(() => {
    if (!freeze || freeze.col <= 0) return null;
    return host.readRange({
      sheet,
      startRow,
      startCol: 0,
      endRow,
      endCol: freeze.col - 1,
    });
  }, [host, sheet, freeze, startRow, endRow, version]);

  const startEdit = (row: number, col: number, initial?: string) => {
    const cell = host.getView().readCell(cellRef(sheet, row, col));
    let text = initial;
    if (text === undefined) {
      const formula = cell.formula;
      text = formula !== undefined ? formula : formatDisplay(cell.value);
    }
    setEditing({ row, col, draft: text, pristine: initial === undefined });
    emitSel(cellSelection(row, col));
  };

  /**
   * Commit a value for the CURRENT editing session, exactly once (F2):
   * every editor commit path (Enter/Tab keydown, blur, autocomplete
   * pick) funnels through here, and the identity guard drops any
   * re-entrant call for the same editing session — notably the blur
   * that Enter/Tab's moveSel focus() fires synchronously before React
   * re-renders (see committedEditingRef).
   */
  const commitEditingValue = (row: number, col: number, value: string): void => {
    if (!editing || committedEditingRef.current === editing) return;
    committedEditingRef.current = editing;
    setEditing(null);
    onCommit(row, col, value);
  };

  const commitEdit = () => {
    if (!editing) return;
    commitEditingValue(editing.row, editing.col, editing.draft);
  };

  const moveSel = (row: number, col: number) => {
    emitSel(cellSelection(clamp(row, 0, MAX_ROWS - 1), clamp(col, 0, MAX_COLS - 1)));
    scrollRef.current?.focus({ preventScroll: true });
  };

  const handleCellClick = (row: number, col: number, e?: React.MouseEvent) => {
    // A drag that returns to its press cell fires its trailing click on
    // that cell: swallow it once so the drag does not also start an edit.
    // (A drag ending on a different cell fires its trailing click on the
    // scroll container, which clears the flag in its own onClick — so this
    // swallow can never eat a later genuine click. D-SEL-1.)
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      return;
    }
    // Shift+click extends a rectangular range from the anchor.
    if (e?.shiftKey) {
      emitSel(rangeSelection(effSel.anchorRow, effSel.anchorCol, row, col));
      return;
    }
    if (editing && editing.row === row && editing.col === col) return;
    // A plain click on the already-selected cell must NOT start an edit
    // (issue #21): Excel enters edit mode on double-click / F2 / typing
    // only. The old click-to-edit branch silently opened the editor when
    // a user clicked back into the grid after using the ribbon, so the
    // next Ctrl+Z landed inside the editor input instead of the app's
    // undo — and the cell sat in edit mode looking painted blank.
    if (editing) commitEdit();
    emitSel(cellSelection(row, col));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const { row, col } = sel;
    // Ctrl/Cmd+A: select all (whole grid as a shape, never enumerated).
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      emitSel(allSelection(row, col));
      return;
    }
    // Shift+Arrow: extend the range by moving the focus corner.
    const arrowDelta =
      e.key === 'ArrowUp' ? { dr: -1, dc: 0 }
      : e.key === 'ArrowDown' ? { dr: 1, dc: 0 }
      : e.key === 'ArrowLeft' ? { dr: 0, dc: -1 }
      : e.key === 'ArrowRight' ? { dr: 0, dc: 1 }
      : null;
    if (arrowDelta && e.shiftKey) {
      e.preventDefault();
      emitSel(rangeSelection(
        effSel.anchorRow,
        effSel.anchorCol,
        clamp(effSel.focusRow + arrowDelta.dr, 0, MAX_ROWS - 1),
        clamp(effSel.focusCol + arrowDelta.dc, 0, MAX_COLS - 1),
      ));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSel(row - 1, col);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSel(row + 1, col);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      moveSel(row, col - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      moveSel(row, col + 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      moveSel(row + 1, col);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      moveSel(row, col + 1);
    } else if (e.key === 'F2') {
      e.preventDefault();
      startEdit(row, col);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      // Multi-cell selection: content-clear the whole selection via the
      // caller's batch path; a single cell keeps the legacy commit path.
      if (onClearSelection && !isSingleCell(effSel)) onClearSelection();
      else onCommit(row, col, '');
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      startEdit(row, col, e.key);
    }
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (!editing) return;
    // Autocomplete dropdown navigation takes precedence while open.
    if (acOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % acSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + acSuggestions.length) % acSuggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = acSuggestions[acIndex];
        const { row, col } = editing;
        // Commit the picked completion directly (avoids stale-draft closure).
        commitEditingValue(row, col, item ? item.value : editing.draft);
        if (e.key === 'Enter') moveSel(row + 1, col);
        else moveSel(row, col + 1);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // First Escape dismisses the dropdown; the edit continues.
        setAcIndex(-1);
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const { row, col } = editing;
      commitEdit();
      moveSel(row + 1, col);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const { row, col } = editing;
      commitEdit();
      moveSel(row, col + 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(null);
      scrollRef.current?.focus({ preventScroll: true });
    } else if (e.key.startsWith('Arrow')) {
      e.stopPropagation();
    }
  };

  const handleCellContext = (e: React.MouseEvent, row: number, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    // D-SEL-4 (selection re-run finding; the cell-side remainder of
    // D-SEL-2): a right-click INSIDE the current selection keeps it, so
    // the cell menu's Copy/Clear/Delete act on the whole selection, as
    // in Excel. Only a right-click OUTSIDE the selection re-points it
    // to the clicked cell. The header menus got the same rule in the
    // D-SEL-2 fix (headerCtxKeepsSelection); this handler never did —
    // it collapsed every range/select-all to the clicked cell, and the
    // original tours masked it because menu closures then captured the
    // pre-menu selection.
    if (!inSelection(effSel, row, col, MAX_ROWS - 1, MAX_COLS - 1)) {
      emitSel(cellSelection(row, col));
    }
    onContextMenu(e.clientX, e.clientY, getCellMenu());
  };

  const totalW = (() => { let w = RHW; for (let i = 0; i < colCount; i++) w += (hiddenCols.has(i) ? 0 : (colWidths.get(i) ?? COL_WIDTH)); return w; })();
  const totalH = (() => { let h = CHH; for (let i = 0; i < rowCount; i++) h += (hiddenRows.has(i) ? 0 : (rowHeights.get(i) ?? ROW_HEIGHT)); return h; })();

  // ---- Column headers (with sort/filter affordances) ----
  // ARIA: headers live in a role="row" so the grid owns proper row children
  // (axe aria-required-children). display:contents keeps the absolute layout.
  const colHeaderCells: React.ReactNode[] = [];
  for (let c = startCol; c <= endCol; c++) {
    const isFiltered = filters.has(c);
    const isSorted = sortState?.col === c;
    // Only show indicator if column is filtered or sorted (Excel behavior)
    const showIndicator = isFiltered || isSorted;
    const indicator = isSorted
      ? (sortState.dir === 'asc' ? '↑' : '↓')
      : (isFiltered ? '▼●' : '');
    colHeaderCells.push(
      <div
        key={c}
        role="columnheader"
        aria-colindex={c + 1}
        aria-label={`Column ${colLabel(c)}${isSorted ? `, sorted ${sortState.dir === 'asc' ? 'ascending' : 'descending'}` : ''}${isFiltered ? ', filtered' : ''}`}
        className={
          effSel.shape === 'all' ||
          (effSel.shape === 'cols'
            ? effSel.colSpans.some((s) => c >= s.start && c <= s.end)
            : selBounds.startCol <= c && c <= selBounds.endCol)
            ? 'col-header active'
            : 'col-header'
        }
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest('button')) return;
          const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
          emitSel(headerSelect(effSel, 'cols', c, mods, MAX_ROWS - 1, MAX_COLS - 1));
          headerDragRef.current = {
            kind: 'cols',
            startIndex: c,
            baseSpans: mods.ctrl ? effSel.colSpans : [],
            additive: mods.ctrl,
          };
        }}
        onMouseEnter={() => {
          const d = headerDragRef.current;
          if (!d || d.kind !== 'cols') return;
          emitSel({
            shape: 'cols',
            anchorRow: 0,
            anchorCol: d.startIndex,
            focusRow: 0,
            focusCol: d.startIndex,
            rowSpans: [],
            colSpans: headerDragSpans(d.baseSpans, d.startIndex, c),
          });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // D-SEL-2: only re-point when right-clicking outside the
          // current selection; inside it the menu acts on the selection.
          // The re-point is a plain header click (whole column), matching
          // left-click and Excel — so the column menu's Copy/Clear/Delete
          // act on the column, not a single cell.
          if (!headerCtxKeepsSelection('cols', c)) {
            emitSel(headerSelect(effSel, 'cols', c, { shift: false, ctrl: false }, MAX_ROWS - 1, MAX_COLS - 1));
          }
          onContextMenu(e.clientX, e.clientY, getColumnMenu(c));
        }}
        style={{
          position: 'absolute',
          top: 0,
          left: colLeft(c),
          width: cw(c),
          height: CHH,
          lineHeight: `${CHH}px`,
          boxSizing: 'border-box',
          textAlign: 'center',
          borderTop: '1px solid var(--line-soft)',
          borderRight: '1px solid var(--line-soft)',
          borderBottom: '1px solid var(--line-soft)',
          background: isFiltered ? '#dbeafe' : undefined,
        }}
      >
        {colLabel(c)}
        {showIndicator && (
        <button
          title={isSorted ? `Sorted ${sortState.dir === 'asc' ? 'ascending' : 'descending'}` : "Filter column"}
          onClick={(e) => {
            e.stopPropagation();
            onOpenFilter(c);
          }}
          style={{
            marginLeft: 4,
            fontSize: 10,
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {indicator}
        </button>
        )}
      </div>,
    );
  }

  // ---- Row headers ----
  const rowHeaders: React.ReactNode[] = [];
  for (let r = startRow; r <= endRow; r++) {
    if (!isRowVisible(r)) continue;
    rowHeaders.push(
      <div key={`rh-row-${r}`} role="row" aria-rowindex={r + 1} style={{ display: 'contents' }}>
      <div
        role="rowheader"
        aria-label={`Row ${r + 1}`}
        className={
          effSel.shape === 'all' ||
          (effSel.shape === 'rows'
            ? effSel.rowSpans.some((s) => r >= s.start && r <= s.end)
            : selBounds.startRow <= r && r <= selBounds.endRow)
            ? 'row-header active'
            : 'row-header'
        }
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
          emitSel(headerSelect(effSel, 'rows', r, mods, MAX_ROWS - 1, MAX_COLS - 1));
          headerDragRef.current = {
            kind: 'rows',
            startIndex: r,
            baseSpans: mods.ctrl ? effSel.rowSpans : [],
            additive: mods.ctrl,
          };
        }}
        onMouseEnter={() => {
          const d = headerDragRef.current;
          if (!d || d.kind !== 'rows') return;
          emitSel({
            shape: 'rows',
            anchorRow: d.startIndex,
            anchorCol: 0,
            focusRow: d.startIndex,
            focusCol: 0,
            rowSpans: headerDragSpans(d.baseSpans, d.startIndex, r),
            colSpans: [],
          });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // D-SEL-2: only re-point when right-clicking outside the
          // current selection; inside it the menu acts on the selection.
          // The re-point is a plain header click (whole row), matching
          // left-click and Excel — so the row menu's Copy/Clear/Delete
          // act on the row, not a single cell.
          if (!headerCtxKeepsSelection('rows', r)) {
            emitSel(headerSelect(effSel, 'rows', r, { shift: false, ctrl: false }, MAX_ROWS - 1, MAX_COLS - 1));
          }
          onContextMenu(e.clientX, e.clientY, getRowMenu(r));
        }}
        style={{
          position: 'absolute',
          top: rowTop(r) - CHH,
          left: 0,
          width: RHW,
          height: rh(r),
          lineHeight: `${rh(r)}px`,
          boxSizing: 'border-box',
          textAlign: 'center',
          borderLeft: '1px solid var(--line-soft)',
          borderRight: '1px solid var(--line-soft)',
          borderBottom: '1px solid var(--line-soft)',
        }}
      >
        {r + 1}
      </div>
      </div>,
    );
  }

  // ---- Body cells ----
  /**
   * Render a sparkline's SVG for its host cell. Values are read live from
   * the engine so sparklines update when the data range changes.
   */
  const sparklineSvg = useCallback(
    (spark: SparklinePlacement, w: number, h: number): string => {
      const vals = sparklineValues(spark.range, (rr, cc) => {
        const tv = host.readCell(cellRef(sheet, rr, cc));
        const v = tv.kind === 'number' ? tv.value : null;
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
      });
      return renderSparkline(spark.type, vals, Math.max(12, w - 4), Math.max(10, h - 4), spark.color);
    },
    [host, sheet],
  );

  // Body rows: each rendered row is wrapped in role="row" (display:contents
  // so the absolute layout is untouched). This satisfies the ARIA grid
  // pattern (axe aria-required-children / aria-required-parent).
  const bodyRows: React.ReactNode[] = [];
  const bodyCells: React.ReactNode[] = [];
  const flushBodyRow = (r: number) => {
    if (bodyCells.length === 0) return;
    bodyRows.push(
      <div key={`row-${r}`} role="row" aria-rowindex={r + 1} style={{ display: 'contents' }}>
        {bodyCells.splice(0, bodyCells.length)}
      </div>,
    );
  };
  for (let r = startRow; r <= endRow; r++) {
    if (!isRowVisible(r)) continue;
    // Skip rows covered by the frozen strip (rendered separately).
    if (freeze && r < freeze.row) continue;
    for (let c = startCol; c <= endCol; c++) {
      if (freeze && c < freeze.col) continue;
      // Merged cells: skip non-anchor cells; anchor spans the range.
      const merge = findMerge(merges, sheet, r, c);
      if (merge && !isMergeAnchor(merge, r, c)) continue;

      const isSel = sel.row === r && sel.col === c;
      const inSel = inSelection(effSel, r, c, MAX_ROWS - 1, MAX_COLS - 1);
      const isEditing = editing !== null && editing.row === r && editing.col === c;
      const value: TypedValue | undefined = values[r - startRow]?.[c - startCol];
      const cfColor = value ? cfColorFor(cfRules, sheet, r, c, value) : null;
      const hasValidation = findValidation(validations, sheet, r, c) !== null;
      const { text: cellText, css: fmtCss } = cellDisplay(r, c, value);
      const dtKey = `${sheet}:${r}:${c}`;
      const dtValue = dataTypeCells.get(dtKey);

      const width = merge ? colLeft(merge.endCol + 1) - colLeft(merge.startCol) : cw(c);
      const height = merge ? rowTop(merge.endRow + 1) - rowTop(merge.startRow) : rh(r);
      // Protection face d (§2 UI indicators): locked cells get a subtle
      // amber corner marker — SELECTION-ACTIVATED (user ruling
      // 2026-10-21, workbook-protection-and-encryption.md §2): the
      // badge + amber inset render ONLY on locked cells inside the
      // current selection, never across the whole sheet. "Inside the
      // selection" is inSelection() over the rich selection model
      // (features/selection.ts): cell, rectangular range, whole
      // row(s), whole column(s) and select-all shapes all plug in here
      // — a selected row shows badges on that row's locked cells only,
      // select-all on every locked cell. The aria-label "(locked)"
      // announcement below is NOT gated: screen readers keep announcing
      // locked state on focus regardless.
      // Hidden cells (face e) show NO marker to unauthorized viewers —
      // hidden means hidden; isCellHiddenVisible is true only for
      // principals allowed to see the hidden cell.
      const cellLocked = isCellLocked ? isCellLocked(r, c) : false;
      const lockBadgeVisible = cellLocked && inSel;
      const cellHiddenVisible = isCellHiddenVisible ? isCellHiddenVisible(r, c) : false;

      bodyCells.push(
        <div
          key={`${r}:${c}`}
          id={`cell-${r}-${c}`}
          role="gridcell"
          aria-rowindex={r + 1}
          aria-colindex={c + 1}
          aria-selected={inSel}
          aria-label={`${colLabel(c)}${r + 1}: ${cellText || 'empty'}${cellLocked ? ' (locked)' : ''}${cellHiddenVisible ? ' (hidden)' : ''}`}
          className={isSel ? (focusCell ? 'cell selected focus-cell' : 'cell selected') : inSel ? 'cell in-selection' : 'cell'}
          onClick={(e) => handleCellClick(r, c, e)}
          onMouseDown={(e) => beginCellDrag(e, r, c)}
          onMouseEnter={() => enterCellDrag(r, c)}
          onDoubleClick={() => startEdit(r, c)}
          onContextMenu={(e) => handleCellContext(e, r, c)}
          style={{
            position: 'absolute',
            left: colLeft(c),
            top: rowTop(r) - CHH,
            width,
            height,
            boxSizing: 'border-box',
            overflow: 'hidden',
            cursor: 'cell',
            zIndex: merge ? 1 : undefined,
            ...fmtCss,
            // Re-assert grid borders unless the format overrides them.
            borderRight: fmtCss.borderRight ?? '1px solid var(--line-soft)',
            borderBottom: fmtCss.borderBottom ?? '1px solid var(--line-soft)',
            background: cfColor ?? fmtCss.backgroundColor ?? undefined,
            boxShadow: lockBadgeVisible ? 'inset 3px 0 0 0 #f59e0b' : undefined,
          }}
        >
          {lockBadgeVisible && !isEditing && (
            <span
              className="cell-locked-marker"
              title="Locked cell — cannot be edited while the sheet is protected"
              aria-hidden="true"
              style={{
                position: 'absolute', top: 0, left: 1, fontSize: 8, lineHeight: 1,
                color: '#b45309', pointerEvents: 'none',
              }}
            >
              🔒
            </span>
          )}
          {cellHiddenVisible && !isEditing && (
            <span
              className="cell-hidden-marker"
              title="Hidden cell — visible to you because of your access level"
              aria-hidden="true"
              style={{
                position: 'absolute', bottom: 0, right: 1, fontSize: 8, lineHeight: 1,
                color: '#6b7280', pointerEvents: 'none',
              }}
            >
              🙈
            </span>
          )}
          {isEditing ? (
            <span className="cell-editor-wrap">
              <input
                className="cell-editor"
                autoFocus
                value={editing.draft}
                onChange={(e) => setEditing({ ...editing, draft: e.target.value, pristine: false })}
                onKeyDown={handleEditorKeyDown}
                onBlur={commitEdit}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              />
              {acOpen && (
                <AutocompleteDropdown
                  idPrefix="cell-editor-ac"
                  items={acSuggestions}
                  activeIndex={acIndex}
                  onPick={(item) => {
                    const { row, col } = editing;
                    commitEditingValue(row, col, item.value);
                    moveSel(row + 1, col);
                  }}
                  onHover={setAcIndex}
                />
              )}
            </span>
          ) : (
            <>
              {cellValueContent(value, cellText, { fontSize: fmtCss.fontSize, fontFamily: fmtCss.fontFamily, fontWeight: fmtCss.fontWeight, fontStyle: fmtCss.fontStyle, textDecoration: fmtCss.textDecoration, color: fmtCss.color })}
              {(() => {
                // In-cell sparkline (track 14): renders the bound data
                // range as SVG inside this cell.
                const spark = sparklineCells.get(`${sheet}:${r}:${c}`);
                if (!spark || isEditing) return null;
                return (
                  <span
                    className="cell-sparkline"
                    title={`Sparkline (${spark.type}) of ${spark.range}`}
                    dangerouslySetInnerHTML={{ __html: sparklineSvg(spark, width, height) }}
                    style={{ position: 'absolute', inset: 2, pointerEvents: 'none', overflow: 'hidden' }}
                  />
                );
              })()}
              {hasValidation && <span className="cell-validation">▼</span>}
              {dtValue && (
                <button
                  className="cell-datatype"
                  title={`${dtValue.kind === 'stock' ? 'Stock' : 'Geography'}: ${dtValue.display} — click for details`}
                  aria-label={`${dtValue.kind} data type ${dtValue.display}`}
                  onClick={(e) => { e.stopPropagation(); onToggleDataTypeCard(dtKey); }}
                  style={{
                    position: 'absolute', bottom: 1, right: 1, fontSize: 10,
                    background: dataTypeCardKey === dtKey ? '#1d4ed8' : '#dbeafe',
                    color: dataTypeCardKey === dtKey ? '#fff' : '#1d4ed8',
                    border: '1px solid #93c5fd', borderRadius: 3, padding: '0 3px',
                    cursor: 'pointer', lineHeight: 1.4,
                  }}
                >
                  {dtValue.kind === 'stock' ? '📈' : '🌍'}
                </button>
              )}
              {(() => {
                const chip = smartChipCells.get(dtKey);
                if (!chip) return null;
                return (
                  <button
                    className="cell-smartchip"
                    title={`${chip.kind} chip: ${chip.display} — click for details`}
                    aria-label={`${chip.kind} smart chip ${chip.display}`}
                    onClick={(e) => { e.stopPropagation(); onToggleSmartChipCard(dtKey); }}
                    style={{
                      position: 'absolute', bottom: 1, right: dtValue ? 24 : 1, fontSize: 10,
                      background: smartChipCardKey === dtKey ? '#7c3aed' : '#ede9fe',
                      color: smartChipCardKey === dtKey ? '#fff' : '#7c3aed',
                      border: '1px solid #c4b5fd', borderRadius: 3, padding: '0 3px',
                      cursor: 'pointer', lineHeight: 1.4,
                    }}
                  >
                    {chip.emoji}
                  </button>
                );
              })()}
              {hasComment(r, c) && (
                <span
                  className="cell-comment"
                  title={comments.get(`${sheet}:${r}:${c}`) ?? ''}
                  style={{
                    position: 'absolute', top: 0, right: 0, width: 0, height: 0,
                    borderTop: '8px solid #ff0000', borderLeft: '8px solid transparent',
                  }}
                />
              )}
            </>
          )}
        </div>,
      );
    }
    flushBodyRow(r);
  }

  // ---- Frozen strips ----
  const frozenRows: React.ReactNode[] = [];
  if (freeze && freeze.row > 0 && frozenRowValues) {
    for (let r = 0; r < freeze.row; r++) {
      const frCells: React.ReactNode[] = [];
      for (let c = startCol; c <= endCol; c++) {
        if (c < freeze.col) continue; // Corner handled by frozen cols strip.
        const value = frozenRowValues[r]?.[c - startCol];
        const cfColor = value ? cfColorFor(cfRules, sheet, r, c, value) : null;
        const isSel = sel.row === r && sel.col === c;
        const inSel = inSelection(effSel, r, c, MAX_ROWS - 1, MAX_COLS - 1);
        const { text: frText, css: frCss } = cellDisplay(r, c, value);
        frCells.push(
          <div
            key={`fr-${r}:${c}`}
            role="gridcell"
            aria-rowindex={r + 1}
            aria-colindex={c + 1}
            aria-selected={inSel}
            aria-label={`${colLabel(c)}${r + 1}: ${frText || 'empty'}`}
            className={isSel ? (focusCell ? 'cell selected focus-cell' : 'cell selected') : inSel ? 'cell in-selection' : 'cell'}
            onClick={(e) => handleCellClick(r, c, e)}
            onMouseDown={(e) => beginCellDrag(e, r, c)}
            onMouseEnter={() => enterCellDrag(r, c)}
            onContextMenu={(e) => handleCellContext(e, r, c)}
            style={{
              position: 'absolute',
              left: colLeft(c),
              top: rowTop(r) - CHH,
              width: cw(c),
              height: rh(r),
              boxSizing: 'border-box',
              overflow: 'hidden',
              cursor: 'cell',
              ...frCss,
              borderBottom: frCss.borderBottom ?? '2px solid var(--accent, #217346)',
              background: cfColor ?? frCss.backgroundColor ?? 'var(--bg, #fff)',
            }}
          >
            {cellValueContent(value, frText)}
          </div>,
        );
      }
      if (frCells.length > 0) {
        frozenRows.push(
          <div key={`fr-row-${r}`} role="row" aria-rowindex={r + 1} style={{ display: 'contents' }}>
            {frCells}
          </div>,
        );
      }
    }
  }

  // Frozen-strip gutter (sweep F-9): the frozen-rows strip needs its
  // OWN row headers. Without them the strip's gutter slot stays
  // transparent and the body's scrolled row headers bleed through it,
  // labeling the pinned row with whatever row is scrolled underneath
  // (the sweep's 38b shot showed "28" beside the pinned row 1). These
  // render in flow inside the strip (stacking to exactly the frozen
  // rows' heights) and stick left like the corner on horizontal scroll.
  const frozenGutter: React.ReactNode[] = [];
  if (freeze && freeze.row > 0) {
    for (let r = 0; r < freeze.row; r++) {
      const active =
        effSel.shape === 'all' ||
        (effSel.shape === 'rows'
          ? effSel.rowSpans.some((s) => r >= s.start && r <= s.end)
          : selBounds.startRow <= r && r <= selBounds.endRow);
      frozenGutter.push(
        <div
          key={`fg-${r}`}
          role="rowheader"
          aria-label={`Row ${r + 1}`}
          className={active ? 'row-header active' : 'row-header'}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            emitSel(headerSelect(effSel, 'rows', r, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }, MAX_ROWS - 1, MAX_COLS - 1));
          }}
          style={{
            position: 'sticky',
            left: 0,
            width: RHW,
            height: rh(r),
            lineHeight: `${rh(r)}px`,
            boxSizing: 'border-box',
            textAlign: 'center',
            borderLeft: '1px solid var(--line-soft)',
            borderRight: '1px solid var(--line-soft)',
            borderBottom: '1px solid var(--line-soft)',
            zIndex: 5,
          }}
        >
          {r + 1}
        </div>,
      );
    }
  }

  const frozenCols: React.ReactNode[] = [];
  if (freeze && freeze.col > 0 && frozenColValues) {
    for (let r = startRow; r <= endRow; r++) {
      if (r < freeze.row) continue; // Corner handled by frozen rows strip.
      if (!isRowVisible(r)) continue;
      const fcCells: React.ReactNode[] = [];
      for (let c = 0; c < freeze.col; c++) {
        const value = frozenColValues[r - startRow]?.[c];
        const cfColor = value ? cfColorFor(cfRules, sheet, r, c, value) : null;
        const isSel = sel.row === r && sel.col === c;
        const inSel = inSelection(effSel, r, c, MAX_ROWS - 1, MAX_COLS - 1);
        const { text: fcText, css: fcCss } = cellDisplay(r, c, value);
        fcCells.push(
          <div
            key={`fc-${r}:${c}`}
            role="gridcell"
            aria-rowindex={r + 1}
            aria-colindex={c + 1}
            aria-selected={inSel}
            aria-label={`${colLabel(c)}${r + 1}: ${fcText || 'empty'}`}
            className={isSel ? (focusCell ? 'cell selected focus-cell' : 'cell selected') : inSel ? 'cell in-selection' : 'cell'}
            onClick={(e) => handleCellClick(r, c, e)}
            onMouseDown={(e) => beginCellDrag(e, r, c)}
            onMouseEnter={() => enterCellDrag(r, c)}
            onContextMenu={(e) => handleCellContext(e, r, c)}
            style={{
              position: 'absolute',
              left: colLeft(c),
              top: rowTop(r) - CHH,
              width: cw(c),
              height: rh(r),
              boxSizing: 'border-box',
              overflow: 'hidden',
              cursor: 'cell',
              ...fcCss,
              borderRight: fcCss.borderRight ?? '2px solid var(--accent, #217346)',
              borderBottom: fcCss.borderBottom ?? '1px solid var(--line-soft)',
              background: cfColor ?? fcCss.backgroundColor ?? 'var(--bg, #fff)',
            }}
          >
            {cellValueContent(value, fcText)}
          </div>,
        );
      }
      if (fcCells.length > 0) {
        frozenCols.push(
          <div key={`fc-row-${r}`} role="row" aria-rowindex={r + 1} style={{ display: 'contents' }}>
            {fcCells}
          </div>,
        );
      }
    }
  }

  // Frozen corner (rows x cols intersection).
  const frozenCornerValues = useMemo(() => {
    if (!freeze || freeze.row <= 0 || freeze.col <= 0) return null;
    return host.readRange({ sheet, startRow: 0, startCol: 0, endRow: freeze.row - 1, endCol: freeze.col - 1 });
  }, [host, sheet, freeze, version]);

  const frozenCorner: React.ReactNode[] = [];
  if (frozenCornerValues) {
    for (let r = 0; r < (freeze?.row ?? 0); r++) {
      const fxCells: React.ReactNode[] = [];
      for (let c = 0; c < (freeze?.col ?? 0); c++) {
        const value = frozenCornerValues[r]?.[c];
        const { text: fxText, css: fxCss } = cellDisplay(r, c, value);
        fxCells.push(
          <div
            key={`fx-${r}:${c}`}
            role="gridcell"
            aria-rowindex={r + 1}
            aria-colindex={c + 1}
            aria-label={`${colLabel(c)}${r + 1}: ${fxText || 'empty'}`}
            className="cell"
            onClick={() => handleCellClick(r, c)}
            style={{
              position: 'absolute',
              left: colLeft(c),
              top: rowTop(r) - CHH,
              width: cw(c),
              height: rh(r),
              boxSizing: 'border-box',
              overflow: 'hidden',
              ...fxCss,
              borderRight: fxCss.borderRight ?? '2px solid var(--accent, #217346)',
              borderBottom: fxCss.borderBottom ?? '2px solid var(--accent, #217346)',
              background: fxCss.backgroundColor ?? 'var(--bg, #fff)',
            }}
          >
            {cellValueContent(value, fxText)}
          </div>,
        );
      }
      if (fxCells.length > 0) {
        frozenCorner.push(
          <div key={`fx-row-${r}`} role="row" aria-rowindex={r + 1} style={{ display: 'contents' }}>
            {fxCells}
          </div>,
        );
      }
    }
  }

  const freezeStripHeight = freeze && freeze.row > 0 ? rowTop(freeze.row) - CHH : 0;
  const freezeStripWidth = freeze && freeze.col > 0 ? colLeft(freeze.col) - RHW : 0;

  return (
    <div
      className="grid-wrap"
      id="grid-region"
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onScroll={onScroll}
      onClick={() => {
        // D-SEL-1: a completed body-cell drag (press and release on
        // different cells) ends with the browser firing the trailing
        // click on this container — the nearest common ancestor of the
        // press/release cells — which no cell onClick ever sees. Consume
        // the drag-swallow flag here so it cannot survive the drag and
        // eat the NEXT genuine cell click. (A drag that returns to its
        // press cell fires its click on the cell itself; that one is
        // still swallowed once by handleCellClick, so a drag never
        // starts an edit.)
        dragMovedRef.current = false;
      }}
      role="grid"
      aria-label={`Spreadsheet grid, sheet ${sheet}`}
      aria-rowcount={MAX_ROWS}
      aria-colcount={MAX_COLS}
      aria-activedescendant={`cell-${sel.row}-${sel.col}`}
    >
      <div style={{ position: 'relative', width: totalW, height: totalH }}>
        {/* Manual page-break lines (outer coordinates: rowTop/colLeft). */}
        {pageBreaks && hasPageBreaks(pageBreaks) && (
          <PageBreakLines
            breaks={pageBreaks}
            colX={colLeft}
            rowY={rowTop}
            width={totalW}
            height={totalH}
            maxRow={rowCount}
            maxCol={colCount}
          />
        )}
        {/* Page-break preview: "Page N" badges at each page's top-left. */}
        {printPages?.map((p) => (
          <div
            key={`pg-${p.pageNumber}`}
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: colLeft(p.startCol) + 2,
              top: rowTop(p.startRow) + 2,
              zIndex: 14,
              pointerEvents: 'none',
              fontSize: 11,
              fontWeight: 700,
              color: '#1a73e8',
              background: 'rgba(255,255,255,0.85)',
              border: '1px solid #1a73e8',
              borderRadius: 3,
              padding: '0 4px',
            }}
          >
            Page {p.pageNumber}
          </div>
        ))}
        {/* Phase 2 presence flags: remote users' selected cells (their
            sheet only) — colored outline + name tag, inside the scrollable
            content like the overlays so they scroll/clip with the grid. */}
        {(remoteSelections ?? [])
          .filter((p) => p.sheet === sheet)
          .map((p) => (
            <div
              key={`presence-${p.principal}`}
              className="remote-selection"
              data-principal={p.principal}
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: colLeft(p.col),
                // D8: rowTop() is in cell-area coordinates (row 0 = 0,
                // below the column header) and this layer's origin is
                // the content top ABOVE the header — the old
                // `- CHH` double-compensated and painted every flag
                // exactly one row too high (the user's "flag on C3,
                // my selection is C4"). No subtraction here.
                top: rowTop(p.row),
                width: cw(p.col),
                height: rh(p.row),
                boxSizing: 'border-box',
                border: `2px solid ${p.color}`,
                pointerEvents: 'none',
                zIndex: 15,
              }}
            >
              <span
                className="remote-selection-tag"
                style={{
                  position: 'absolute',
                  top: -16,
                  left: -2,
                  fontSize: 10,
                  lineHeight: '14px',
                  padding: '0 4px',
                  borderRadius: '3px 3px 3px 0',
                  background: p.color,
                  color: '#fff',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                }}
              >
                {presenceLabel(p)}
                {p.editing ? ' ✎' : ''}
              </span>
            </div>
          ))}
        {/* Floating overlays (charts, shapes, pictures, text boxes): inside
            the scrollable content so they move with the cells and are clipped
            by the grid viewport (overflow:auto on .grid-wrap). */}
        {overlays ? (
          <div
            className="overlays-layer"
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 20 }}
          >
            {overlays}
          </div>
        ) : null}
        {/* Column headers + frozen rows: sticky top. */}
        <div style={{ position: 'sticky', top: 0, zIndex: 4, height: CHH + freezeStripHeight }}>
          <div style={{ position: 'relative', height: CHH }}>
            <div
              className={effSel.shape === 'all' ? 'corner active' : 'corner'}
              onClick={() => emitSel(allSelection(sel.row, sel.col))}
              style={{
                position: 'sticky',
                left: 0,
                zIndex: 6,
                width: RHW + freezeStripWidth,
                height: CHH,
                boxSizing: 'border-box',
                border: '1px solid var(--line-soft)',
                background: 'var(--bg, #fff)',
              }}
            />
            <div role="row" aria-rowindex={1} style={{ display: 'contents' }}>
              {colHeaderCells}
            </div>
          </div>
          {freezeStripHeight > 0 && (
            <div style={{ position: 'relative', height: freezeStripHeight }}>
              {frozenRows}
              {frozenGutter}
            </div>
          )}
        </div>
        {/* Body: row headers + frozen cols stick left, cells absolutely positioned. */}
        <div style={{ position: 'relative', height: totalH - CHH - freezeStripHeight }}>
          <div
            style={{
              position: 'sticky',
              left: 0,
              zIndex: 3,
              width: RHW + freezeStripWidth,
              height: '100%',
            }}
          >
            {rowHeaders}
            {frozenCols}
            {frozenCorner}
          </div>
          {bodyRows}
        </div>
      </div>
    </div>
  );
}
